#!/usr/bin/env python3
"""cases.py — the selfheal.2 cases, each with its negative control,
against a freshly built rig. The suite (suite.py) builds the rig, writes the
marker files, and calls the case functions with a recorder. Cases 1–5 run on
RAID5/6 loop rigs; case 6 is the RAID1 case (hardening round, F4/GT-16), and
the parity case also runs once on a 512 KiB-chunk rig — the AHR band shape —
to prove no chunk is hardcoded. Case 8 is the parity rewrite (selfheal.10) and
case 9 the mirror reconcile (selfheal.11), each on a rig of its own because
both verbs scrub the WHOLE filesystem.

Injected-fault placement is ALWAYS via oracle.py (raw signature scan). The
mapping helpers are used only for verification and by the negative-control
drivers (which, like the drill, are allowed to know the layout — the binding
rule constrains the injector, not the controls).
"""
import hashlib
import json
import os

from common import (BS, LOGS, PARITY_CMD, SUITE_OUT, bounded_end_check,
                    bounded_window_check, btrfs_chunk_ranges,
                    btrfs_metadata_ranges, call_mirror, call_parity, call_repair,
                    components, dm_segments, drop_caches, evict_stripe_cache,
                    fail_member, file_sector_digests, find_btrfs_dev, full_check,
                    kernel_md_log, locate_block, make_marker, make_snap, md_attr,
                    md_attr_or_none, md_geometry, md_repair_lines, mdsys,
                    readd_member, read_direct, regen, remove_snap,
                    restore_sync_knobs, reverse_predict, sig_for, snapshot_read,
                    subvolume_names, write_direct)
from oracle import (ORACLE_SNAP, corrupt_block, disambiguate_data_slot,
                    scan_device, scan_members)

REPAIR_SNAP = ".anas-repair-snap"
TX_PROBE_SNAP = ".anas-tx-probe"
REPORT_PATH = f"{SUITE_OUT}/last-repair.json"
PARITY_REPORT_PATH = f"{SUITE_OUT}/last-parity.json"
# F7: the bounded check's evidence file the parity verb gates on (case 8
# writes it, the suite is what produces it — a rig has no job queue).
PARITY_EVIDENCE_PATH = f"{SUITE_OUT}/parity-evidence.json"

STEPS = ["pin", "resolve", "reverify", "precheck", "rmw", "reconstruct",
         "arbitrate", "guard", "write", "postcheck", "coldread"]


class Recorder:
    def __init__(self):
        self.cases = []
        self.controls = []

    def add(self, kind: str, cid: str, name: str, ok: bool, detail: str):
        entry = {"kind": kind, "id": cid, "name": name,
                 "verdict": "PASS" if ok else "FAIL", "detail": detail}
        (self.cases if kind == "case" else self.controls).append(entry)
        print(f"[{entry['verdict']}] {cid}: {name} — {detail}", flush=True)


class CaseCtx:
    """Per-rig context: md array(s), mountpoint, members, marker files.
    Single-band rigs pass one md device; the two-band rig (case 7, the AHR
    pool shape) passes both band arrays — `mddev` is the first (band A) and
    `members` spans every band, which is what the oracle scans."""

    def __init__(self, mddevs: list[str], mountpoint: str, tag: str):
        self.mddevs = mddevs
        self.mddev = mddevs[0]
        self.mp = mountpoint
        self.tag = tag
        self.members = [m for md in mddevs for m in components(md)]
        self.geo = md_geometry(self.mddev)
        self.files = {}          # marker name -> path
        self.located = {}        # (file, block) -> (dev, off) — scan-located only

    def scan_locate(self, path: str, block: int | None) -> tuple[str, int]:
        """Injector: raw signature scan -> (member dev, offset). The corruption
        destroys the signature, so the first scan's result is recorded and
        reused — still scan-derived, never mapping-derived."""
        key = (os.path.basename(path), block)
        if key in self.located:
            return self.located[key]
        sig = sig_for(os.path.basename(path).removesuffix(".bin"),
                      block if block is not None else 300)
        hits = scan_members(self.members, sig)
        dev, off = disambiguate_data_slot(hits, self.mp, path)
        self.located[key] = (dev, off)
        return dev, off

    def corrupt_below_md(self, path: str, block: int | None = None) -> tuple[str, int, int]:
        """Injector: scan -> flip-disambiguate -> junk the 4K block.
        Returns (dev, member_offset, block_off)."""
        dev, off = self.scan_locate(path, block)
        corrupt_block(dev, off)
        return dev, off, off - off % BS

    def corrupt_through_md(self, path: str) -> tuple[int, bytes]:
        """Injector for above-md rot: raw scan of the MD DEVICE itself, then a
        4K junk write through md. No mapping code involved. Returns (md block
        offset, junk bytes) — the junk is the on-disk ground truth for the
        nothing-written assertion (F3)."""
        sig = sig_for(os.path.basename(path).removesuffix(".bin"), 300)
        hits = scan_device(self.mddev, sig)
        if len(hits) != 1:
            raise RuntimeError(f"md-device scan for {path}: {len(hits)} hits, expected 1")
        junk = corrupt_block(self.mddev, hits[0])
        return hits[0] - hits[0] % BS, junk

    def naive_write_through_md(self, path: str, block: int) -> None:
        """Negative-control driver: write the ORIGINAL block through md at the
        default rmw_level (the drill's GT-7 naive repair)."""
        loc = locate_block(self.mddev, self.mp, path, block)
        assert md_attr(self.mddev, "rmw_level") == "1", "rmw_level not at default"
        name = os.path.basename(path).removesuffix(".bin")
        orig = regen(name)[block * BS:(block + 1) * BS]
        write_direct(self.mddev, loc["md_byte"] - loc["md_byte"] % BS, orig)

    def verify_stripe(self, path: str, loc: dict) -> tuple[int, int, list[str]]:
        """Fail a member (caller does this), cold-read the whole stripe through
        md, compare every 4K block of `path` that sits in the stripe to the
        regen content. Returns (wrong, total, rows).

        Vacuity review F4: the old version skipped a whole CHUNK when any part
        of it fell outside the file's extent, counted the skipped blocks as
        compared, and the callers asserted `wrong == 0` with no `total > 0`
        guard — on the 512K rig it compared 512 of 640 row blocks and the gap
        was invisible (an all-skipped row would have passed vacuously). Now a
        block outside the extent (or past EOF) is not counted and is named in
        `rows`; the callers assert `wrong == 0 AND total > 0`.

        loc: mapping dict with stripe/parity_disk/q_disk/extent info.
        The md stripe cache must be evicted first — the SHARED
        common.evict_stripe_cache (F5): the old inline sweep here ran at the
        DEFAULT cache size, which common.py documents as insufficient (at 256
        slots a sequential sweep never evicts the target, so a degraded read
        of a cached stripe skips parity reconstruction and hides the poison —
        probed live: stale-correct read with no sweep, wrong after a sweep)."""
        raid6 = self.geo["raid6"]
        n, chunk = self.geo["n"], self.geo["chunk"]
        dc = n - (2 if raid6 else 1)
        evict_stripe_cache(self.mddev, loc["stripe"])
        name = os.path.basename(path).removesuffix(".bin")
        want = regen(name)
        e = loc["extent"]
        nr = e.get("nr", e["ram"])
        wrong = total = 0
        rows = []
        for d in range(dc):
            md_off = loc["stripe"] * dc * chunk + d * chunk
            data = read_direct(self.mddev, md_off, chunk)
            lv = md_off - loc["start_sector"] * 512
            logical = lv - loc["chunk_device"] + loc["chunk_logical"]
            compared = bad = 0
            for i in range(chunk // BS):
                off_in = logical + i * BS - e["disk"]
                if off_in < 0 or off_in + BS > nr:
                    continue              # this block is not in the file's extent
                fb = e["foff"] // BS + off_in // BS
                if fb * BS >= len(want):
                    continue              # past the file's end
                compared += 1
                if want[fb * BS:(fb + 1) * BS] != data[i * BS:(i + 1) * BS]:
                    bad += 1
            total += compared
            wrong += bad
            row = f"chunk {d}: {bad} wrong of {compared}"
            if compared < chunk // BS:
                row += (f" ({chunk // BS - compared} row blocks outside the "
                        f"file's extent or past EOF — not counted)")
            rows.append(row)
        return wrong, total, rows


def run_repair(ctx: CaseCtx, path: str, block: int, fail_at: str | None = None,
               tag: str = "r") -> tuple[int, dict, str]:
    log = f"{LOGS}/{ctx.tag}-{tag}.log"
    rc, out = call_repair(ctx.mp, path, block, fail_at=fail_at,
                          report=REPORT_PATH, log=log)
    rep = json.load(open(REPORT_PATH)) if os.path.exists(REPORT_PATH) else {}
    return rc, rep, out


def run_parity(ctx: CaseCtx, band: int = 1, tag: str = "p",
               evidence: str | None = None,
               command: str | None = None) -> tuple[int, dict, str]:
    """Invoke the parity-rewrite verb under test (PARITY_CMD, story
    selfheal.10). The sidecar is removed first so a crashed run can never be
    read as this one's report. `evidence` (a bounded-check's JSON file) is
    passed as `--evidence <file>` — both implementations gate on it (F7);
    `command` overrides the PARITY_CMD string (the 8-no-evidence control
    passes it with the dev-only `--assume-mismatch` stripped)."""
    if os.path.exists(PARITY_REPORT_PATH):
        os.unlink(PARITY_REPORT_PATH)
    log = f"{LOGS}/{ctx.tag}-{tag}.log"
    rc, out = call_parity(ctx.mp, band, report=PARITY_REPORT_PATH, log=log,
                          evidence=evidence, command=command)
    rep = json.load(open(PARITY_REPORT_PATH)) if os.path.exists(PARITY_REPORT_PATH) else {}
    return rc, rep, out


def parity_cmd_without_assume() -> str:
    """PARITY_CMD with the dev-only `--assume-mismatch` stripped — the
    8-no-evidence control's command (F7). When the string carries no flag
    (the reference), it is returned unchanged: the control then relies on
    the reference's own evidence gate, which REQUIRES `--evidence <file>`
    and the control passes none."""
    import shlex
    toks = [t for t in shlex.split(PARITY_CMD) if t != "--assume-mismatch"]
    return " ".join(shlex.quote(t) for t in toks)


def _digest12(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()[:12]


def assert_subvolumes_unchanged(ctx: CaseCtx, baseline: set[str], what: str) -> None:
    """No transient pin may SURVIVE the repair — implementation-agnostic
    (vacuity review F2). The old check looked only for the REFERENCE's names
    (`.anas-repair-snap`, `.anas-oracle-snap`) in the mountpoint's PARENT;
    the engine names its pins `anas-selfheal-<epoch>` and, on these flat
    rigs, places them INSIDE the mountpoint — a leaked pin passed it. Every
    pin is a subvolume of the filesystem, so the set from `btrfs subvolume
    list` is the check that cannot miss a naming or placement scheme: the
    set after the run must equal the set before it (a leak adds an entry, a
    stray deletion removes one — both fail)."""
    now = subvolume_names(ctx.mp)
    leaked = sorted(now - baseline)
    if leaked:
        raise AssertionError(f"{what}: subvolumes leaked: {leaked}")
    gone = sorted(baseline - now)
    if gone:
        raise AssertionError(f"{what}: subvolumes removed: {gone}")


def knobs(ctx: CaseCtx) -> dict:
    # md_attr_or_none: a RAID1 array has no rmw_level at all (GT-16) — absent
    # knobs are recorded as absent, not fabricated.
    return {k: md_attr_or_none(ctx.mddev, k) for k in
            ("rmw_level", "sync_min", "sync_max", "sync_action")}


def assert_knobs_default(ctx: CaseCtx, what: str) -> None:
    k = knobs(ctx)
    # F12: `or "1"` — on RAID1 the rmw_level knob is ABSENT (GT-16), knobs()
    # records it as None, and the old `.get(key, "1")` default only applied
    # to missing keys, so this assertion could never pass on a RAID1 array
    # even though there is nothing to restore there.
    if not ((k.get("rmw_level") or "1") == "1" and k["sync_min"] == "0"
            and k["sync_max"] == "max" and k["sync_action"] == "idle"):
        raise AssertionError(f"{what}: knobs not restored: {k}")


def wait_a_moment():
    import time
    time.sleep(1)


# ---------------------------------------------------------------- case 1

def case1_parity_trap(ctx: CaseCtx, rec: Recorder, level: int) -> None:
    """Corrupt a data block on a member -> repair -> fail a DIFFERENT member
    -> every sibling block in the stripe reads back correctly.

    Vacuity review F4: the sibling check (`verify_stripe`) counts the blocks
    it actually compares (a block outside the file's extent or past EOF is
    not counted and is named in the detail line) and the assertion is
    `wrong == 0 AND total > 0` — the old chunk-granular skip compared 512 of
    640 row blocks on the 512K rig with the gap invisible, and `wrong == 0`
    alone would pass an all-skipped row vacuously."""
    path = ctx.files["c1"] if level == 5 else ctx.files["r1"]
    name = os.path.basename(path).removesuffix(".bin")

    # --- RAID5 variant: different data member failed
    dev, off, boff = ctx.corrupt_below_md(path, 300)
    rc, rep, out = run_repair(ctx, path, 300, tag="c1a")
    pre = rep.get("precheck_mismatch")
    post = rep.get("postcheck_mismatch")
    ok = rc == 0 and pre and pre > 0 and post == 0
    rec.add("case", f"1{ctx.tag}-a", f"parity trap repair ({level_label(level)}, block 300)",
            ok, f"rc={rc} precheck_mismatch={pre} postcheck={post} disk=m{rep.get('disk')} "
                f"stripe={rep.get('stripe')} reason={rep.get('reason', '')[:120]}")
    if not ok:
        return

    # fail a DIFFERENT data member of that stripe and read the stripe
    m = locate_block(ctx.mddev, ctx.mp, path, 300)   # verification-side mapping
    if m["stripe"] != rep.get("stripe") or m["disk"] != rep.get("disk"):
        rec.add("case", "1r5-x", "repair's mapping matches the suite's verification "
                "mapping", False, f"repair: stripe={rep.get('stripe')} disk=m{rep.get('disk')}; "
                f"suite: stripe={m['stripe']} disk=m{m['disk']}")
        return
    victim = pick_victim(rep, ctx.geo)
    fail_member(ctx.mddev, ctx.members[victim])
    drop_caches()
    wrong, total, rows = ctx.verify_stripe(path, m)
    # F4: total > 0 — an all-skipped row must not pass `wrong == 0` vacuously
    ok = wrong == 0 and total > 0
    rec.add("case", f"1{ctx.tag}-a2", f"sibling blocks correct with m{victim} failed "
            f"({level_label(level)})", ok,
            f"stripe {rep['stripe']}: {wrong} wrong of {total} 4K blocks — "
            + "; ".join(rows))
    readd_member(ctx.mddev, ctx.members[victim])

    # --- RAID6 P-member variant
    if level == 6:
        p_fail_variant(ctx, rec)


def p_fail_variant(ctx: CaseCtx, rec: Recorder) -> None:
    path = ctx.files["r1"]
    block = 1000
    dev, off, boff = ctx.corrupt_below_md(path, block)
    rc, rep, out = run_repair(ctx, path, block, tag="c1b")
    ok = rc == 0 and rep.get("postcheck_mismatch") == 0
    rec.add("case", "1r6-b", "parity trap repair (RAID6, block 1000)", ok,
            f"rc={rc} postcheck={rep.get('postcheck_mismatch')} P=m{rep.get('parity_disk')} "
            f"Q=m{rep.get('q_disk')} reason={rep.get('reason', '')[:120]}")
    if not ok:
        return
    fail_member(ctx.mddev, ctx.members[rep["parity_disk"]])   # fail the P member
    drop_caches()
    m = locate_block(ctx.mddev, ctx.mp, path, block)   # verification-side mapping
    wrong, total, rows = ctx.verify_stripe(path, m)
    ok = wrong == 0 and total > 0
    rec.add("case", "1r6-b2", f"sibling blocks correct with P member m{rep['parity_disk']} "
            f"failed (Q reconstruction)", ok,
            f"stripe {rep['stripe']}: {wrong} wrong of {total} 4K blocks — "
            + "; ".join(rows))
    readd_member(ctx.mddev, ctx.members[rep["parity_disk"]])


def pick_victim(rep: dict, geo: dict) -> int:
    """A data member of the stripe != the repaired member."""
    n, stripe = geo["n"], rep["stripe"]
    p = rep["parity_disk"]
    q = rep.get("q_disk")
    for i in range(n):
        if i in (rep["disk"], p, q):
            continue
        return i
    raise RuntimeError("no other data member to fail")


def level_label(level: int) -> str:
    return "RAID5" if level == 5 else "RAID6"


def control1_parity_trap(ctx: CaseCtx, rec: Recorder, level: int) -> None:
    """Negative control: the same repair at DEFAULT rmw_level MUST break
    sibling blocks (GT-7 / GT-12).

    Vacuity review F5 — the canary, rebuilt during the 2026-09-14 node re-run
    on kernel 7.0.14-17 (probe rounds in the run log): the ORIGINAL canary
    checked the stripe the naive write had JUST written through md and
    expected a no-eviction check over it to read "cached pre-corruption
    content" and report 0 — but the write poisons the CACHED copy along with
    the member (GT-14's mechanism leaves the post-write stripe in the cache),
    so that check can only ever report the poison (probed: 8 on every rig,
    every order). A cache hides only rot that landed BEHIND md AFTER the
    stripe was last written through it.

    The canary now proves exactly that, on a second signed block of its own
    while the array is otherwise clean (so the reveal counts the canary's rot
    and nothing else — non-vacuous):

    - a CLEAN write through md at rmw_level=0 (reconstruct — parity
      recomputed correct) caches the stripe correct;
    - the canary block is junked BEHIND md;
    - a no-eviction check over the stripe MUST report 0 — the stale cache
      hid the rot (probed deterministic on this kernel);
    - a whole-array check MUST report > 0 — the wide window recycles md's
      stripe cache and forces the member read. The shrink+sweep eviction
      CANNOT be used for this on kernel 7.0.14-17: a recently touched stripe
      survives it (probed: evicted check reads the stale cache and reports 0
      with the rot sitting on the member), so the wide window is the only
      deterministic cache-buster the suite has.

    The wide check also churns the cache past the poison half's stripe,
    which helps keep the naive write below cache-cold (GT-14: a warm-cache
    naive write takes md's reconstruct path and does NOT poison)."""
    path = ctx.files["c1"] if level == 5 else ctx.files["r1"]
    block = 300 if level == 5 else 1400
    canary_block = 1900 if level == 6 else 1500

    # --- the staleness canary (array otherwise clean at this point) ---------
    loc_c = locate_block(ctx.mddev, ctx.mp, path, canary_block)
    cname = os.path.basename(path).removesuffix(".bin")
    orig_c = regen(cname)[canary_block * BS:(canary_block + 1) * BS]
    assert md_attr(ctx.mddev, "rmw_level") == "1", "rmw_level not at default"
    with open(f"{mdsys(ctx.mddev)}/rmw_level", "w") as fh:
        fh.write("0")     # reconstruct write: parity recomputed, stripe cached CORRECT
    write_direct(ctx.mddev, loc_c["md_byte"] - loc_c["md_byte"] % BS, orig_c)
    with open(f"{mdsys(ctx.mddev)}/rmw_level", "w") as fh:
        fh.write("1")
    restore_sync_knobs(ctx.mddev)
    ctx.corrupt_below_md(path, canary_block)          # rot BEHIND md
    mm_stale = bounded_window_check(ctx.mddev, loc_c["stripe"], evict=False)
    restore_sync_knobs(ctx.mddev)
    mm_reveal = full_check(ctx.mddev)["mismatch_cnt"]  # wide window recycles
    restore_sync_knobs(ctx.mddev)

    # --- the poison half (GT-7 / GT-12, unchanged) ---------------------------
    dev, off, boff = ctx.corrupt_below_md(path, block)
    loc = locate_block(ctx.mddev, ctx.mp, path, block)
    ctx.naive_write_through_md(path, block)     # original bytes through md, rmw default
    mm = bounded_window_check(ctx.mddev, loc["stripe"])
    restore_sync_knobs(ctx.mddev)
    ok1 = mm > 0 and mm_stale == 0 and mm_reveal > 0
    rec.add("control", f"1{ctx.tag}-n1", f"naive repair at default rmw_level poisons "
            f"parity; the no-eviction canary proves the cache can hide rot "
            f"({level_label(level)})", ok1,
            f"bounded check stripe {loc['stripe']}: mismatch_cnt={mm} (evicted, "
            f"expected >0); canary block {canary_block}, stripe {loc_c['stripe']}: "
            f"no-eviction mismatch_cnt={mm_stale} (expected 0 — the stale cache hid "
            f"the rot behind md); whole-array check mismatch_cnt={mm_reveal} "
            f"(expected >0 — the wide window recycles the cache and reveals it)")
    # fail a different data member: sibling blocks must read back WRONG
    rep = {"stripe": loc["stripe"], "disk": loc["disk"],
           "parity_disk": loc["parity_disk"], "q_disk": loc.get("q_disk")}
    victim = pick_victim(rep, ctx.geo)
    fail_member(ctx.mddev, ctx.members[victim])
    drop_caches()
    wrong, total, rows = ctx.verify_stripe(path, loc)
    ok2 = wrong > 0
    rec.add("control", f"1{ctx.tag}-n2", f"sibling blocks BROKEN with m{victim} failed "
            f"({level_label(level)}, default rmw)", ok2,
            f"stripe {loc['stripe']}: {wrong} wrong of {total} 4K blocks (expected >0) "
            + "— " + "; ".join(rows))
    readd_member(ctx.mddev, ctx.members[victim])
    restore_sync_knobs(ctx.mddev)


# ---------------------------------------------------------------- case 2

def case2_zero_block_abort(ctx: CaseCtx, rec: Recorder) -> None:
    """Zeros file with a marker: repair invoked with a deliberately wrong
    block index that maps onto a healthy zero block must exit 4."""
    path = ctx.files["z1"]
    # injector: scan hits data AND parity slot on a zeros file; disambiguate
    dev, off = ctx.scan_locate(path, 300)   # zeros file: scan hits data AND parity
    junk = corrupt_block(dev, off)
    loc300 = locate_block(ctx.mddev, ctx.mp, path, 300)
    same = (dev == ctx.members[loc300["disk"]] and
            off - off % BS == loc300["moff"] - loc300["moff"] % BS)
    rec.add("case", "2-scan", "oracle scan+flip disambiguation picked the data slot "
            "(zeros file) — LOAD-BEARING: the rest of the case repairs the block "
            "the scan hit, so a wrong-slot pick stops the case here", same,
            f"scan hit {dev}@{off - off % BS} vs mapped m{loc300['disk']}@"
            f"{loc300['moff']}")
    if not same:
        return

    # wrong index: a healthy zero block in the same extent
    rc2, rep2, out2 = run_repair(ctx, path, 200, tag="c2w")
    ok = rc2 == 4
    detail = f"rc={rc2} (expected 4) reason={rep2.get('reason', out2)[:140]}"
    rec.add("case", "2-wrong-index", "repair at healthy zero block 200 aborts "
            "(exit 4 mapping-abort)", ok, detail)

    # negative control: the CORRECT index must repair, not abort
    rc3, rep3, out3 = run_repair(ctx, path, 300, tag="c2r")
    ok3 = rc3 == 0 and rep3.get("postcheck_mismatch") == 0
    rec.add("control", "2-neg", "repair at the actually corrupt block 300 succeeds "
            "(exit 0, not a blanket abort)", ok3,
            f"rc={rc3} postcheck={rep3.get('postcheck_mismatch')} "
            f"candidate={rep3.get('candidate_csum')} stored={rep3.get('stored_csum')}")
    if ok3:
        snap = make_snap(ctx.mp, REPAIR_SNAP)
        try:
            r = snapshot_read(os.path.join(snap, "z1.bin"), [300])
            want = regen("z1")[300 * BS:(300 + 1) * BS]
            okc = 300 in r["ok"] and r["data"][300] == want
            rec.add("control", "2-neg2", "post-repair cold snapshot read of z1 block 300 "
                    "matches the original (marker intact)", okc,
                    f"eio={r['eio']} content_match={okc}")
        finally:
            remove_snap(ctx.mp, REPAIR_SNAP)


# ---------------------------------------------------------------- case 3

def case3_compressed_coldread(ctx: CaseCtx, rec: Recorder) -> None:
    """compress=zstd, page-cached BEFORE the rot: repair's end-to-end read must
    go cold through the fresh snapshot."""
    path = ctx.files["c3"]
    dev, off = ctx.scan_locate(path, None)   # scan hit inside the zstd stream
    # WARM the page cache after locating, before corrupting (the drill's GT-9
    # order): the oracle's flip test has just dropped caches, and a live read
    # of the file is healthy right now — after the corruption it can only be
    # served stale.
    import subprocess as _sp
    _sp.run(["dd", f"if={path}", "bs=4096", "of=/dev/null", "status=none"],
            stdin=_sp.DEVNULL, check=True)
    boff = off - off % BS
    corrupt_block(dev, off)

    # negative control FIRST: warm live read succeeds, snapshot path EIOs
    live_rc = os.system(f"dd if='{path}' bs=4096 iflag=direct of=/dev/null status=none "
                        f"2>/dev/null")
    live_ok = live_rc == 0
    snap = make_snap(ctx.mp, ORACLE_SNAP)
    r = snapshot_read(os.path.join(snap, "c3.bin"))
    snap_eio = len(r["eio"]) > 0
    remove_snap(ctx.mp, ORACLE_SNAP)
    rec.add("control", "3-neg", "warm live read succeeds while snapshot path EIOs",
            live_ok and snap_eio,
            f"live_direct={'SUCCESS' if live_ok else 'FAILED'} "
            f"snapshot_eio_blocks={len(r['eio'])} of {len(r['ok']) + len(r['eio'])} "
            f"(expected: live ok, snapshot EIO)")
    if not (live_ok and snap_eio):
        return

    # which file block did the scan-located corruption land in? (verification side)
    from common import reverse_locate
    disk = ctx.members.index(dev)
    m = reverse_locate(ctx.mddev, ctx.mp, disk, boff, [path])
    blk = m["block"]
    # F9: this row used to pass `True` unconditionally (informational). Now it
    # asserts a round trip: the FORWARD mapping (file block -> member) of the
    # block the reverse mapping computed must land on the very member sector
    # the scan found — the scan's sector must sit inside the forward map's
    # blob span. On this rig the compressed blob is a single 4K sector
    # (disknr == BS), so that is an equality. A mapping that sent the repair
    # to the wrong sector would make it exit 4 at reverify; this row proves
    # the two mapping directions agree before the repair runs.
    locm = locate_block(ctx.mddev, ctx.mp, path, blk)
    same_loc = (locm["disk"] == disk
                and locm["moff"] <= boff < locm["moff"] + locm["blob_sectors"] * BS)
    rec.add("case", "3-map", "corrupted compressed sector mapped back to a file block "
            "(verification side); the forward mapping of that block lands on the "
            "scan's member sector", same_loc,
            f"m{disk}@{boff} -> {os.path.basename(path)} block {blk} -> "
            f"m{locm['disk']}@{locm['moff']} (blob {locm['blob_sectors']} sector(s); "
            f"compressed={m['compressed']}, extent disk {m['extent']['disk']} "
            f"nr {m['extent']['disknr']} ram {m['extent']['ram']})")
    if not same_loc:
        return

    rc, rep, out = run_repair(ctx, path, blk, tag="c3r")
    ok = rc == 0 and rep.get("postcheck_mismatch") == 0
    rec.add("case", "3-repair", f"repair of compressed extent (block {blk}) "
            "arbitrated against the on-disk-sector csum", ok,
            f"rc={rc} postcheck={rep.get('postcheck_mismatch')} "
            f"candidate={rep.get('candidate_csum')} stored={rep.get('stored_csum')} "
            f"reason={rep.get('reason', out)[:140]}")
    if not ok:
        return

    # the repair's cold read went through the pin snapshot; prove it cold again
    snap = make_snap(ctx.mp, REPAIR_SNAP)
    try:
        drop_caches()
        e = m["extent"]
        blocks = list(range(e["foff"] // BS, (e["foff"] + e["ram"]) // BS))
        r = snapshot_read(os.path.join(snap, "c3.bin"), blocks)
        want = regen("c3")
        mism = [b for b in r["ok"]
                if r["data"][b] != want[b * BS:(b + 1) * BS]]
        ok2 = not r["eio"] and not mism
        rec.add("case", "3-cold", "fresh-snapshot cold read of the whole extent matches "
                "the original content", ok2,
                f"blocks {blocks[0]}..{blocks[-1]}: eio={r['eio']} content_mismatch={mism}")
    finally:
        remove_snap(ctx.mp, REPAIR_SNAP)


# ---------------------------------------------------------------- case 4

def case4_knob_restore(ctx: CaseCtx, rec: Recorder) -> None:
    """Inject an exception at EVERY step boundary; assert rmw_level, sync_min,
    sync_max restored and no transient pin survives (the subvolume set of the
    filesystem is UNCHANGED after each run — the implementation-agnostic
    check, F2), then a full md check covers the whole array again."""
    path = ctx.files["c4"]

    fails = []
    for step in STEPS:
        ctx.corrupt_below_md(path, 300)          # fresh rot before every run
        remove_snap(ctx.mp, REPAIR_SNAP)
        base = subvolume_names(ctx.mp)           # F2: baseline before the run
        rc, rep, out = run_repair(ctx, path, 300, fail_at=step, tag=f"c4-{step}")
        detail = f"rc={rc} (expected 70)"
        ok = rc == 70
        try:
            assert_knobs_default(ctx, f"after REPAIR_FAIL_AT={step}")
            assert_subvolumes_unchanged(ctx, base, f"after REPAIR_FAIL_AT={step}")
            detail += f" knobs={knobs(ctx)} subvolumes=unchanged"
        except AssertionError as e:
            ok = False
            detail += f" {e}"
        if not ok:
            fails.append(step)
        rec.add("case", f"4-{step}", f"REPAIR_FAIL_AT={step}: exit 70, knobs restored, "
                "no transient pin survives (subvolume set unchanged)", ok, detail)

    # full md check covers the whole array again: a check bounded one stripe
    # short of the end must SUSPEND there (GT-5) — deterministic proof the
    # op covered 0..end-1-stripe — then a full check with the knob at max
    # reaches idle (md cannot stop early with sync_max=max)
    ctx.corrupt_below_md(path, 300)             # leave the rot in place
    b = bounded_end_check(ctx.mddev)
    ok1 = b["suspended"] and b["completed"] == b["end"] - b["cs"]
    rec.add("case", "4-endcheck", "bounded check suspends one stripe short of the "
            "array end (coverage 0..end-1 stripe proven)", ok1,
            f"suspended={b['suspended']} completed={b['completed']}/{b['end']} "
            f"(stripe={b['cs']} sectors) mismatch_cnt={b['mismatch_cnt']}")
    f = full_check(ctx.mddev)
    ok2 = f["final_action"] == "idle"
    rec.add("case", "4-fullcheck", "full md check (sync_max=max) reaches idle — "
            "the whole array is covered again", ok2,
            f"final={f['final_action']} sampled_completed={f['peak_completed']}"
            f"/{f['total']} mismatch_cnt={f['mismatch_cnt']}")

    # negative control: a clean run repairs and restores
    base = subvolume_names(ctx.mp)
    rc, rep, out = run_repair(ctx, path, 300, tag="c4-clean")
    ok = rc == 0 and rep.get("postcheck_mismatch") == 0
    try:
        assert_knobs_default(ctx, "clean run")
        assert_subvolumes_unchanged(ctx, base, "clean run")
    except AssertionError as e:
        ok = False
        out += f" {e}"
    rec.add("control", "4-neg", "clean run (no injection) repairs, restores knobs, "
            "leaves the subvolume set unchanged", ok,
            f"rc={rc} postcheck={rep.get('postcheck_mismatch')}")


# ---------------------------------------------------------------- case 5

def measure_tx_blocks(ctx: CaseCtx, devs: list[str], seg: dict) -> tuple[dict, dict, set[int]]:
    """Run the SAME transaction the repair runs (RO snapshot create + delete)
    and measure the 4K member blocks it writes, mapped to LV bytes through
    `seg`'s array geometry. Returns (pre-digests, post-digests, tx LV-byte
    set). btrfs's superblock mirrors are not stable across mkfs runs
    (measured: a live super at 64 KiB + 64 MiB, a magic-less csum block at
    1 MiB, an all-zero 320 KiB mirror a later transaction fills), so the set
    is MEASURED every run, never a fixed list — and it is re-measured here
    rather than guessed because any later "which member sectors may change"
    assertion would have a blind spot at an unmeasured mirror (the
    tx-probe). The post-digests double as the baseline: nothing changes
    between the probe and the operation under test."""
    pre = {d: file_sector_digests(d) for d in devs}
    make_snap(ctx.mp, TX_PROBE_SNAP)
    remove_snap(ctx.mp, TX_PROBE_SNAP)
    post = {d: file_sector_digests(d) for d in devs}
    blocks: set[int] = set()
    for i, d in enumerate(devs):
        for s, (hb, ha) in enumerate(zip(pre[d], post[d])):
            if hb != ha:
                moff = s * BS
                if moff < ctx.geo["data_offset"]:
                    continue        # md's own super region — never file data
                blocks.add(reverse_predict(i, moff, ctx.geo)
                           - seg["ss"] * 512 + seg["start"])
    return pre, post, blocks


# btrfs's superblock offsets are FIXED by the on-disk format — 64 KiB, 64 MiB,
# 256 GiB, 1 PiB — and a superblock is never inside a chunk, so a byte at one of
# them can never be file data. The tx-probe MEASURES which of them a given
# transaction rewrites, and that is still what governs everything else; what it
# cannot do is bound the NEXT transaction. Observed 2026-09-15 on the two-band
# rig, twice: the repair's own transaction rewrote band A's PRIMARY super at
# LV 65536 while the probe's had not, and `7-bandA-untouched` reported `data=1`
# on a block that is a superblock by definition. These four offsets are
# housekeeping by construction; the CONTENT check runs BEFORE this and is
# unaffected, so a candidate copy landing on a super is still caught.
BTRFS_SUPER_OFFSETS = (0x10000, 0x4000000, 0x4000000000, 0x4000000000000)


def classify_member_changes(devs: list[str], before: dict, after: dict,
                            geo: dict, seg: dict, tx_blocks: set[int],
                            excl: list[tuple[int, int]],
                            content_digest: str | None = None) -> tuple[int, int, int, list[str]]:
    """Classify every changed 4K member sector (per-sector before/after
    digests) as housekeeping or a data write. Housekeeping = md's own
    superblock region (below the data offset), a MEASURED superblock-mirror
    block (tx_blocks), one of btrfs's FIXED superblock offsets
    (BTRFS_SUPER_OFFSETS), or a non-DATA (SYSTEM/METADATA) chunk range
    — btrfs commits its own transactions there on ANY repair, even a correct
    one.
    With `content_digest` set, a changed sector whose AFTER digest equals it
    is counted separately as CONTENT: a byte-for-byte copy of a known block
    that landed in a whitelisted range — the classification-independent
    assertion, because the range whitelist alone would excuse it (a wrong-
    band write of the repair's candidate landing in a metadata chunk, vacuity
    review F6; in case 5, a false "repair" writing the reconstructed junk at
    a wrong offset). Returns (housekeeping, data, content, bad sectors)."""
    doff = geo["data_offset"]
    housekeeping = data = content = 0
    bad: list[str] = []
    for i, d in enumerate(devs):
        b, a = before[d], after[d]
        if b == a:
            continue
        for s, (hb, ha) in enumerate(zip(b, a)):
            if hb == ha:
                continue
            moff = s * BS
            if content_digest is not None and ha == content_digest:
                content += 1
                if len(bad) < 5:
                    bad.append(f"{os.path.basename(d)}@{moff} (candidate/junk content)")
                continue
            if moff < doff:
                housekeeping += 1      # md's own superblock region
                continue
            lv = reverse_predict(i, moff, geo) - seg["ss"] * 512 + seg["start"]
            if (lv in tx_blocks or lv in BTRFS_SUPER_OFFSETS
                    or any(lo <= lv < hi for lo, hi in excl)):
                housekeeping += 1
            else:
                data += 1
                if len(bad) < 5:
                    bad.append(f"{os.path.basename(d)}@{moff} (LV {lv})")
    return housekeeping, data, content, bad


def case5_above_md(ctx: CaseCtx, rec: Recorder) -> None:
    """Rot written THROUGH md: pre-check diagnosis (exit 3), not a failed
    repair; pre-check mismatch_cnt==0.

    Vacuity review F3: "nothing written" used to be proven by the sidecar
    alone (the repair says it wrote nothing, so it did). It is now proven on
    disk: the rot's bytes are exactly what the injector wrote (undisturbed —
    note a false "repair" would reconstruct the junk itself, since md parity
    agrees with it, so the bytes cannot prove the fix; what they DO prove is
    that nothing was "repaired" or moved), and no member sector changed
    outside btrfs housekeeping. A correct exit-3 run still commits btrfs
    transactions (its pin snapshot), so the changed sectors are classified
    exactly as case 7 does: md's super region, MEASURED superblock-mirror
    blocks, or SYSTEM/METADATA chunk ranges — anything else is a data write
    and fails, and a copy of the junk at a wrong offset fails as CONTENT even
    inside a whitelisted range."""
    path = ctx.files["c5"]
    md_off, junk = ctx.corrupt_through_md(path)
    loc = locate_block(ctx.mddev, ctx.mp, path, 300)
    same = md_off == loc["md_byte"] - loc["md_byte"] % BS
    rec.add("case", "5-scan", "md-device scan located the through-md rot — "
            "LOAD-BEARING: every later assertion is about the block the scan "
            "found, so a wrong hit stops the case here", same,
            f"scan md@{md_off} vs mapped {loc['md_byte']}")
    if not same:
        return
    # sanity: md sees nothing (GT-6)
    mm = bounded_window_check(ctx.mddev, loc["stripe"])
    rec.add("case", "5-sanity", "bounded check over the stripe sees mismatch_cnt==0 "
            "(rot arrived through md)", mm == 0, f"mismatch_cnt={mm} (expected 0)")
    if mm != 0:
        return

    # F3 baseline, immediately before the run: the tx probe measures this
    # run's superblock-mirror writes (the repair's pin snapshot commits a
    # btrfs transaction, so members DO change even on a correct exit-3 run)
    srcdev = find_btrfs_dev(ctx.mp)
    seg = dm_segments(srcdev)[0]
    _, before, tx_blocks = measure_tx_blocks(ctx, ctx.members, seg)
    excl = btrfs_metadata_ranges(srcdev)

    rc, rep, out = run_repair(ctx, path, 300, tag="c5a")
    ok = rc == 3 and rep.get("precheck_mismatch") == 0 and rep.get("outcome") == "above-md"
    rec.add("case", "5-diag", "repair diagnoses above-md corruption (exit 3, "
            "mismatch_cnt==0 in pre-check)", ok,
            f"rc={rc} precheck_mismatch={rep.get('precheck_mismatch')} "
            f"outcome={rep.get('outcome')} steps={len(rep.get('steps_done', []))} "
            f"reason={rep.get('reason', out)[:140]}")

    # F3 on-disk assertion, run regardless of the exit: nothing was written.
    after = {d: file_sector_digests(d) for d in ctx.members}
    h, data, content, badsect = classify_member_changes(
        ctx.members, before, after, ctx.geo, seg, tx_blocks, excl,
        content_digest=hashlib.sha256(junk).hexdigest())
    junk_now = read_direct(ctx.mddev, md_off, BS)
    okd = data == 0 and content == 0 and junk_now == junk
    rec.add("case", "5-disk", "nothing was written: the rot's bytes are exactly "
            "the injector's (undisturbed) and every changed member sector is "
            "btrfs housekeeping (measured mirrors + non-DATA chunks)", okd,
            f"rot at md@{md_off} unchanged={junk_now == junk}; changed sectors "
            f"classified: housekeeping={h} data={data} content={content}"
            + (f" — {badsect}" if (data or content) else ""))

    # negative control: below-md rot must NOT be diagnosed as above-md
    dev, off, boff = ctx.corrupt_below_md(path, 700)
    loc7 = locate_block(ctx.mddev, ctx.mp, path, 700)
    mm = bounded_window_check(ctx.mddev, loc7["stripe"])
    rec.add("case", "5-sanity2", "below-md rot shows mismatch_cnt>0 in its own stripe",
            mm > 0, f"stripe {loc7['stripe']}: mismatch_cnt={mm}")
    if mm == 0:
        return
    rc2, rep2, out2 = run_repair(ctx, path, 700, tag="c5b")
    ok2 = rc2 == 0 and rep2.get("postcheck_mismatch") == 0
    rec.add("control", "5-neg", "below-md rot proceeds to repair (exit 0, not exit 3)",
            ok2, f"rc={rc2} postcheck={rep2.get('postcheck_mismatch')} "
                 f"reason={rep2.get('reason', out2)[:140]}")


# ---------------------------------------------------------------- case 6

def case6_raid1(ctx: CaseCtx, rec: Recorder) -> None:
    """RAID1 (GT-16: no rmw_level, no stripe_cache_size, chunk_size reads 0):
    corrupt the marker block on ONE leg behind md — the signature is on BOTH
    legs, the injector picks one hit and records which — repair, and the block
    must read back correct on BOTH legs afterwards (md writes every leg); the
    post-repair cold snapshot read matches.

    Negative control AFTER the repair (vacuity review F8): the old control
    "recorded which leg md served" and asserted only coherence — with a
    one-leg rot, md may serve EITHER leg, so both outcomes were legitimate
    and the control proved the state, not the serving. Now: the repair
    restored the original bytes, so the signature is back on EVERY leg and
    the oracle's scan re-locates the block; corrupt one leg behind md and
    FAIL THE OTHER — with only the corrupt leg left, md has no choice but to
    serve it, and the cold btrfs read of the block MUST EIO (stored csum vs
    the junk). The EIO is asserted, not recorded. The failed leg is then
    re-added and the rebuild waited out; the rebuild re-propagates the fresh
    rot to the other leg, which is fine — the rig is torn down after the
    case."""
    path = ctx.files["l1"]
    name = "l1"

    # --- injector: the scan hits every leg; corrupt one and record which
    sig = sig_for(name, 300)
    hits = scan_members(ctx.members, sig)
    if len(hits) != len(ctx.members):
        rec.add("case", "6-scan", "oracle scan of the RAID1 marker block", False,
                f"{len(hits)} scan hits across {len(ctx.members)} legs, "
                f"expected one per leg: {hits}")
        return
    leg_dev, off = hits[0]
    leg = ctx.members.index(leg_dev)
    boff = off - off % BS
    same_off = all(h[1] - h[1] % BS == boff for h in hits)
    rec.add("case", "6-scan", "marker block found on every RAID1 leg at the same "
            "member offset; one leg corrupted behind md", same_off,
            f"rot injected on leg m{leg} ({leg_dev}@{boff}); hits: "
            + " ".join(f"{os.path.basename(d)}@{o - o % BS}" for d, o in hits))
    if not same_off:
        return
    corrupt_block(leg_dev, off)
    want = regen(name)[300 * BS:(300 + 1) * BS]

    # --- repair
    rc, rep, out = run_repair(ctx, path, 300, tag="c6r")
    ok = rc == 0 and rep.get("postcheck_mismatch") == 0
    rec.add("case", "6-repair", "repair of a one-leg corruption (RAID1, block 300)",
            ok, f"rc={rc} postcheck={rep.get('postcheck_mismatch')} "
                f"disk=m{rep.get('disk')} good_legs={rep.get('good_legs')} "
                f"reason={rep.get('reason', '')[:120]}")
    if not ok:
        return

    # --- BOTH legs must read back correct now (md writes all legs)
    legs = []
    for i, d in enumerate(ctx.members):
        got = read_direct(d, boff, BS)
        legs.append(f"m{i}={'ok' if got == want else 'BAD'}")
    ok2 = all(not s.endswith("BAD") for s in legs)
    rec.add("case", "6-legs", "block reads back correct on BOTH legs after repair "
            "(md wrote every leg)", ok2,
            f"rot was on m{leg}; now: " + " ".join(legs))
    if not ok2:
        return

    # --- cold read matches
    snap = make_snap(ctx.mp, REPAIR_SNAP)
    try:
        drop_caches()
        r = snapshot_read(os.path.join(snap, f"{name}.bin"), [300])
        okc = 300 in r["ok"] and r["data"].get(300) == want
        rec.add("case", "6-cold", "post-repair cold snapshot read of the block "
                "matches the original", okc,
                f"eio={r['eio']} content_match={okc}")
    finally:
        remove_snap(ctx.mp, REPAIR_SNAP)
    if not okc:
        return

    # --- negative control (AFTER the repair): deterministic leg observability.
    # The repair restored the original bytes, so the signature is back on
    # EVERY leg and the scan re-locates the block; corrupt one leg behind md
    # and FAIL THE OTHER. With only the corrupt leg left, md has no choice
    # but to serve it — the cold read MUST EIO. The failed leg is re-added
    # and the rebuild waited out; the rebuild re-propagates the fresh rot to
    # the other leg (harmless: the rig is torn down after the case).
    hits2 = scan_members(ctx.members, sig_for(name, 300))
    if len(hits2) != len(ctx.members):
        rec.add("control", "6-neg", "deterministic leg observability: scan re-located "
                "the repaired marker on every leg", False,
                f"{len(hits2)} hits, expected {len(ctx.members)}")
        return
    rot_dev, rot_off = hits2[0]
    rot_leg = ctx.members.index(rot_dev)
    good_leg = 1 - rot_leg
    corrupt_block(rot_dev, rot_off)
    fail_member(ctx.mddev, ctx.members[good_leg])
    drop_caches()
    snap = make_snap(ctx.mp, ORACLE_SNAP)
    try:
        r2 = snapshot_read(os.path.join(snap, f"{name}.bin"), [300])
    finally:
        remove_snap(ctx.mp, ORACLE_SNAP)
    readd_member(ctx.mddev, ctx.members[good_leg])
    rec.add("control", "6-neg", "with the other leg FAILED, md can only serve the "
            "corrupt leg — the cold read EIOs (deterministic observability)",
            300 in r2["eio"],
            f"rot re-injected on m{rot_leg}, m{good_leg} failed: eio={r2['eio']} "
            f"(expected [300]); m{good_leg} re-added, rebuild waited out (it "
            f"re-propagates the rot — the rig is torn down after)")


# ---------------------------------------------------------------- case 7

def _tb_map(ctx: CaseCtx, path: str, block: int) -> dict:
    """Verification-side mapping for the two-band rig: file block -> btrfs
    logical -> chunk hop -> LV byte -> the dm table segment that covers it ->
    THAT array's geometry. The segment comes from the dm table — never from a
    single-array predict — and each array's chunk is read from its own sysfs
    (F4, per array): the two bands of this rig disagree on purpose."""
    from common import (chunk_data_map, dm_segments, dump_tree,
                        extent_for_offset, file_extents, find_btrfs_dev,
                        md_geometry, predict, segment_for)
    srcdev = find_btrfs_dev(ctx.mp)
    exts = file_extents(srcdev, ctx.mp, path)
    e = extent_for_offset(exts, block * BS)
    assert e["comp"] == "none", f"case 7 markers are uncompressed, got {e['comp']}"
    logical = e["disk"] + (block * BS - e["foff"])
    clog, cdev, _ = chunk_data_map(dump_tree(srcdev, 3), logical)
    lv = logical - clog + cdev
    segs = dm_segments(srcdev)
    seg = segment_for(segs, lv)
    geo = md_geometry(seg["dev"])
    md_byte = lv - seg["start"] + seg["ss"] * 512
    p = predict(md_byte, geo)
    return {"srcdev": srcdev, "segs": segs, "segment": segs.index(seg),
            "mddev": seg["dev"], "geo": geo, "lv": lv, "md_byte": md_byte,
            "extent": e, "disk": p["disk"], "moff": p["moff"],
            "stripe": p["stripe"], "parity_disk": p["parity_disk"],
            "q_disk": p["q_disk"]}


def _tb_band(ctx: CaseCtx, dev: str) -> int:
    """Which band array owns member `dev` (0=A, 1=B) — records the scan hit."""
    for i, md in enumerate(ctx.mddevs):
        if dev in components(md):
            return i
    raise RuntimeError(f"member {dev} is in no band array of {ctx.mddevs}")


def _tb_blocks(ctx: CaseCtx) -> dict:
    """Find one signature marker block in EACH segment of the LV: the rig is
    filled past band A's segment (300 MiB of plain filler, then the 500 MiB
    marker b1), and the LV byte of each signature block is mapped to its
    segment from the dm table. If b1 did not cross into segment 2, a second
    400 MiB marker (b2) is written until it does. Cached on ctx — case 7 and
    its control share the same blocks. Returns
    {'seg1': (path, block), 'seg2': (path, block), 'maps': {(name, block): map}}."""
    if getattr(ctx, "tb_blocks", None) is not None:
        return ctx.tb_blocks
    marks = {"b1": (300, 40000, 80000, 120000)}
    found: dict[int, tuple[str, int]] = {}
    maps: dict[tuple[str, int], dict] = {}
    for fname, blocks in marks.items():
        path = ctx.files[fname]
        for b in blocks:
            m = _tb_map(ctx, path, b)
            maps[(fname, b)] = m
            found.setdefault(m["segment"], (path, b))
    if 1 not in found:
        # b1 did not cross into segment 2 — keep writing until one does
        ctx.files["b2"] = make_marker("b2", "random", 400 * 1024 * 1024,
                                      seed=13, blocks=(300, 50000, 90000))
        for b in (300, 50000, 90000):
            m = _tb_map(ctx, ctx.files["b2"], b)
            maps[("b2", b)] = m
            found.setdefault(m["segment"], (ctx.files["b2"], b))
    if 0 not in found or 1 not in found:
        raise RuntimeError(f"two-band rig: no marker block in segment "
                           f"{1 if 0 not in found else 2} of the LV: {found}")
    ctx.tb_blocks = {"seg1": found[0], "seg2": found[1], "maps": maps}
    return ctx.tb_blocks


def case7_two_band(ctx: CaseCtx, rec: Recorder) -> None:
    """TWO-BAND rig (the AHR pool shape: the LV is the linear concatenation of
    two md arrays — band A 64K chunk, band B 512K chunk, different on purpose).
    Corrupt the marker block that lives in SEGMENT 2 (band B) on its member —
    the oracle scans the members of BOTH arrays and records which — and repair.
    The repair must use the array that OWNS the byte (band B, its own
    chunk/geometry). The assertion that would have caught review finding R1 (a
    repair that places every block with the FIRST segment's geometry) runs
    regardless of the repair's exit: NO DATA on band A changed. The repair's
    own snapshot commits a btrfs transaction, and btrfs's transaction writes
    — the superblock mirrors and the SYSTEM/METADATA chunks — can all land in
    segment 1 of this rig, so band-A members legitimately change there. Every
    changed sector is mapped back through band A's geometry to its LV byte and
    must fall in: md's own superblock region, a measured superblock-mirror
    block (the mirrors are measured by running the repair's own transaction
    first — their positions are not stable across mkfs runs), or a
    SYSTEM/METADATA chunk stripe. Then an evicted bounded check over band B's
    stripe reads 0 and a cold snapshot read matches.

    Vacuity review F6: the range whitelist above is hundreds of MiB of
    legitimate housekeeping, and a wrong-band write of the repair's CANDIDATE
    landing in it would be carved out and pass. So there is a second,
    classification-independent assertion: no changed band-A 4K block may be a
    byte-for-byte copy of the candidate. The candidate a correct repair writes
    is exactly the original block content (it is arbitrated against the stored
    csum), so any changed sector whose digest equals sha256(original block) is
    counted as CONTENT and fails — wherever it landed, whitelist included."""
    bl = _tb_blocks(ctx)
    path, block = bl["seg2"]
    name = os.path.basename(path).removesuffix(".bin")
    m = bl["maps"][(name, block)]
    band_a_devs = components(ctx.mddevs[0])
    segA = m["segs"][0]
    assert segA["dev"] == ctx.mddevs[0], \
        f"rig: the first dm segment is {segA['dev']}, expected band A {ctx.mddevs[0]}"
    want = regen(name)[block * BS:(block + 1) * BS]
    cand_digest = hashlib.sha256(want).hexdigest()

    # R1 baseline: per-sector digests of every band-A member, plus btrfs's
    # housekeeping ranges from the chunk tree (re-read after the repair, in
    # case a transaction moved metadata), so the after-compare can classify
    # every changed sector.
    #
    # Superblock mirrors first: the repair's snapshot commits a transaction
    # whose super writes can land anywhere on segment 1, and the mirror
    # positions are NOT stable across mkfs runs (measured on identical rigs:
    # a live super at 64 KiB + 64 MiB, a magic-less csum block at 1 MiB, an
    # all-zero 320 KiB mirror a transaction later fills). No fixed list
    # survives that — so measure the set: run the SAME transaction the repair
    # runs (RO snapshot create + delete) and record the band-A 4K blocks it
    # writes, mapped to LV bytes through band A's geometry.
    _, before, tx_blocks = measure_tx_blocks(ctx, band_a_devs, segA)

    # a measured block inside a DATA chunk would be a BLIND SPOT for the R1
    # assertion below (a data write landing there would be carved out as
    # housekeeping). The probe ran right after the markers' sync, so btrfs
    # writes no data here — a hit is harness contamination and fails the
    # suite rather than silently weakening the assertion.
    data_ranges = btrfs_chunk_ranges(m["srcdev"], "DATA")
    probe_data = [b for b in tx_blocks
                  if any(lo <= b < hi for lo, hi in data_ranges)]
    rec.add("case", "7-txprobe", "the tx-probe transaction touched no DATA chunk "
            "(the measured housekeeping set has no blind spot for the R1 "
            "assertion)", not probe_data,
            f"{len(tx_blocks)} band-A blocks measured, {len(probe_data)} in a "
            f"data chunk" + (f": {probe_data[:8]}" if probe_data else ""))

    excl = btrfs_metadata_ranges(m["srcdev"])

    # --- injector: the oracle scans the members of BOTH arrays
    dev, off, boff = ctx.corrupt_below_md(path, block)
    band = _tb_band(ctx, dev)
    hit = (f"m{components(ctx.mddevs[band]).index(dev)} of band "
           f"{chr(65 + band)} ({os.path.basename(dev)})")
    rec.add("case", "7-scan", "oracle scan (members of both arrays) located the "
            "segment-2 block on a band-B member", band == 1,
            f"hit {hit}; verification-side map: m{m['disk']} of {m['mddev']}, "
            f"stripe {m['stripe']}, member offset {m['moff']}")

    rc, rep, out = run_repair(ctx, path, block, tag="c7r")

    # --- the R1 assertion, run regardless of rc: no DATA write on band A
    after = {d: file_sector_digests(d) for d in band_a_devs}
    excl += btrfs_metadata_ranges(m["srcdev"])
    housekeeping, data, content, bad_sectors = classify_member_changes(
        band_a_devs, before, after, ctx.geo, segA, tx_blocks, excl,
        content_digest=cand_digest)
    rec.add("case", "7-bandA-untouched", "no DATA write on band A: every changed "
            "band-A sector is btrfs superblock/metadata housekeeping, and none "
            "is a copy of the repair's candidate (the R1 assertion, incl. the "
            "F6 content check)", data == 0 and content == 0,
            f"changed sectors: {housekeeping + data + content} — "
            f"housekeeping={housekeeping} data={data} content={content}"
            + (f" — BAD: {bad_sectors}" if (data or content) else ""))

    ok = rc == 0 and rep.get("postcheck_mismatch") == 0
    same = (rep.get("stripe") == m["stripe"] and rep.get("disk") == m["disk"]
            and rep.get("n") == m["geo"]["n"])
    rec.add("case", "7-repair", "two-band: REPAIR_CMD of the segment-2 (band B) "
            "marker block exits 0 using band B's geometry", ok and same,
            f"rc={rc} postcheck={rep.get('postcheck_mismatch')} n={rep.get('n')} "
            f"(band B n={m['geo']['n']}) disk=m{rep.get('disk')} "
            f"stripe={rep.get('stripe')} reason={rep.get('reason', '')[:120]}")
    if not (ok and same):
        return

    # --- band B's member block equals the original
    got = read_direct(dev, boff, BS)
    rec.add("case", "7-member", "band-B member block equals the original after "
            "repair", got == want, f"{os.path.basename(dev)}@{boff} match={got == want}")

    # --- evicted bounded check over band B's stripe reads 0
    mm = bounded_window_check(m["mddev"], m["stripe"])
    rec.add("case", "7-bcheck", "evicted bounded check over band B's stripe reads 0",
            mm == 0, f"stripe {m['stripe']} of {os.path.basename(m['mddev'])}: "
                     f"mismatch_cnt={mm}")

    # --- cold snapshot read matches
    snap = make_snap(ctx.mp, REPAIR_SNAP)
    try:
        drop_caches()
        r = snapshot_read(os.path.join(snap, os.path.basename(path)), [block])
        okc = block in r["ok"] and r["data"][block] == want
        rec.add("case", "7-cold", "post-repair cold snapshot read of the "
                "segment-2 block matches the original", okc,
                f"eio={r['eio']} content_match={okc}")
    finally:
        remove_snap(ctx.mp, REPAIR_SNAP)


def control7_two_band(ctx: CaseCtx, rec: Recorder) -> None:
    """Negative control: a marker in SEGMENT 1 (band A) repairs normally —
    both segments of the concatenated LV are reachable, so the segment-2
    repair in case 7 is not a fluke of the rig. The scan hit must be on a
    band-A member; the post-repair cold snapshot read matches."""
    bl = _tb_blocks(ctx)
    path, block = bl["seg1"]
    name = os.path.basename(path).removesuffix(".bin")
    m = bl["maps"][(name, block)]
    dev, off, boff = ctx.corrupt_below_md(path, block)
    band = _tb_band(ctx, dev)
    want = regen(name)[block * BS:(block + 1) * BS]
    rc, rep, out = run_repair(ctx, path, block, tag="c7n")
    ok = rc == 0 and rep.get("postcheck_mismatch") == 0 and band == 0
    rec.add("control", "7-neg", "segment-1 (band A) marker repairs normally "
            "(both segments reachable)", ok,
            f"rc={rc} postcheck={rep.get('postcheck_mismatch')} scan hit band "
            f"{chr(65 + band)} m{components(ctx.mddevs[band]).index(dev)} "
            f"(band A expected), disk=m{rep.get('disk')} stripe={rep.get('stripe')} "
            f"reason={rep.get('reason', '')[:120]}")
    if not ok:
        return
    snap = make_snap(ctx.mp, REPAIR_SNAP)
    try:
        drop_caches()
        r = snapshot_read(os.path.join(snap, os.path.basename(path)), [block])
        okc = block in r["ok"] and r["data"][block] == want
        rec.add("control", "7-neg2", "post-repair cold snapshot read of the "
                "segment-1 block matches the original", okc,
                f"eio={r['eio']} content_match={okc}")
    finally:
        remove_snap(ctx.mp, REPAIR_SNAP)


# ---------------------------------------------------------------- case 8

def _xor_rows(members: list[str], moff: int, parity: int) -> tuple[bool, list[str]]:
    """Read the 4 KiB stripe ROW off every member behind md and test the RAID5
    row identity: the parity member's row is the XOR of the data members' rows
    (GT-18's 09-gt18-xor.py, the same check, on the suite's rig)."""
    rows = [read_direct(dev, moff, BS) for dev in members]
    acc = bytearray(BS)
    for i, row in enumerate(rows):
        if i == parity:
            continue
        for j in range(BS):
            acc[j] ^= row[j]
    digests = [f"m{i}[{'PARITY' if i == parity else 'data'}]="
               f"{hashlib.sha256(r).hexdigest()[:12]}" for i, r in enumerate(rows)]
    return bytes(acc) == rows[parity], digests


def _cold_block(path: str, block: int) -> bytes | None:
    """The block as it reads THROUGH btrfs with the caches dropped, or None on
    EIO (the checksum refused it)."""
    drop_caches()
    try:
        return read_direct(path, block * BS, BS)
    except OSError:
        return None


def case8_parity_rewrite(ctx: CaseCtx, rec: Recorder) -> None:
    """P-MEMBER ROT (GT-18's shape) — the one case `md repair` is the right
    verb for: the parity member's stripe row is junk, every data member is
    intact, btrfs sees nothing and md counts mismatches.

    The verb under test (PARITY_CMD) must: run a fresh btrfs scrub, find it
    clean, repair the whole band, check it, and come back with mismatch_cnt 0
    — after which the file still reads MATCH and the parity row is once again
    the XOR of the data rows.

    Injector note: the rot goes on the PARITY member, which carries no
    signature to scan for — it is the XOR of the others. The OFFSET is
    scan-derived exactly as everywhere else in this suite (the oracle finds the
    data block's member offset, and every member of a stripe row shares it);
    only WHICH member is parity comes from the mapping helper, which is the
    verification side. That is the same construction GT-18 used.

    Vacuity review fixes:
    - F13: the two "the file still reads MATCH" rows compared the later read
      to the EARLIER read (`kept`). A cold-read path broken the same way both
      times (always the same bytes, always EIO, ...) would have passed both.
      Both now compare against the regen("p1") ground truth.
    - F9: 8-inject passed `True` unconditionally (informational). It now
      asserts the parity row on disk actually differs from its pre-injection
      digest — the rot is on disk, not merely intended.
    - F7: the 8-no-evidence control (below) proves the evidence gate: with
      the dev-only --assume-mismatch stripped and no --evidence file, the verb
      must exit 3 with no-parity-mismatch and issue NO md action."""
    path = ctx.files["p1"]
    name = "p1"
    want = regen(name)[300 * BS:301 * BS]
    dev, off = ctx.scan_locate(path, 300)
    boff = off - off % BS
    loc = locate_block(ctx.mddev, ctx.mp, path, 300)
    parity_dev = ctx.members[loc["parity_disk"]]
    kept = _cold_block(path, 300)
    if kept != want:
        rec.add("case", "8-precondition", "the marker block reads back the original "
                "content before the rot (not merely readable)", False,
                "cold read differs from regen or EIO'd before anything was injected")
        return
    par_pre = read_direct(parity_dev, boff, BS)
    corrupt_block(parity_dev, boff)
    drop_caches()
    par_post = read_direct(parity_dev, boff, BS)
    rec.add("case", "8-inject", "parity member's stripe row corrupted behind md "
            "(data members untouched) — the row on disk actually changed",
            par_post != par_pre,
            f"data m{loc['disk']}({os.path.basename(dev)}) scan-located at {boff}; "
            f"rot injected on PARITY m{loc['parity_disk']}({os.path.basename(parity_dev)})@{boff}, "
            f"stripe {loc['stripe']}; parity row {_digest12(par_pre)} -> {_digest12(par_post)}")
    if par_post == par_pre:
        return

    # md sees it, btrfs does not — the whole reason this case exists (GT-18 a/b).
    mm = bounded_window_check(ctx.mddev, loc["stripe"])
    rec.add("case", "8-md-sees-it", "bounded md check over the stripe counts mismatches",
            mm > 0, f"mismatch_cnt={mm} (expected > 0)")
    before = _cold_block(path, 300)
    rec.add("case", "8-data-intact", "the file still reads correctly through btrfs "
            "(parity rot is invisible above md) — against the regen ground truth",
            before == want,
            "cold read MATCH" if before == want else "cold read differs or EIO'd")
    if mm == 0 or before != want:
        return

    # F7: the evidence file, produced by the bounded check just above — the
    # rig's stand-in for "the last completed scrub counted a parity mismatch
    # on this band" (a rig has no job queue to hold such a job). Both
    # implementations gate on it; the suite is what produces it.
    with open(PARITY_EVIDENCE_PATH, "w") as fh:
        json.dump({"band": 1, "stripe": loc["stripe"], "mismatch_cnt": mm}, fh)

    # --- 8-no-evidence: the evidence gate (negative control). The verb runs
    # with --assume-mismatch stripped and no --evidence: it must exit 3 with
    # no-parity-mismatch and issue NO md action — last_sync_action unchanged,
    # and the parity row on disk still byte-identical to the junk (a repair
    # would have rewritten it).
    last_before = md_attr(ctx.mddev, "last_sync_action")
    rc0, rep0, out0 = run_parity(ctx, band=1, tag="p8noev",
                                 command=parity_cmd_without_assume())
    last_after0 = md_attr(ctx.mddev, "last_sync_action")
    par_now0 = read_direct(parity_dev, boff, BS)
    rec.add("control", "8-no-evidence", "the verb REFUSES without the evidence gate "
            "(exit 3, no-parity-mismatch) and issues no md action",
            rc0 == 3 and rep0.get("reason_code") == "no-parity-mismatch"
            and last_after0 == last_before and par_now0 == par_post,
            f"rc={rc0} code={rep0.get('reason_code')} reason={rep0.get('reason', out0)[:120]}; "
            f"last_sync_action {last_before} -> {last_after0}; parity row "
            f"unchanged={par_now0 == par_post}")

    rc, rep, out = run_parity(ctx, band=1, tag="p8", evidence=PARITY_EVIDENCE_PATH)
    ok = rc == 0 and rep.get("outcome") == "rewritten" and rep.get("mismatch_after") == 0
    rec.add("case", "8-rewrite", "the verb rewrites the band's parity (exit 0, "
            "mismatch_cnt 0 afterwards)", ok,
            f"rc={rc} outcome={rep.get('outcome')} before={rep.get('mismatch_before')} "
            f"after={rep.get('mismatch_after')} reason={rep.get('reason', out)[:140]}")
    if not ok:
        return

    # The three facts GT-18(d) proved, re-proven independently of the verb.
    mm2 = bounded_window_check(ctx.mddev, loc["stripe"])
    rec.add("case", "8-clean", "an independent bounded check over the stripe reads 0",
            mm2 == 0, f"mismatch_cnt={mm2}")
    after = _cold_block(path, 300)
    rec.add("case", "8-match", "the file still reads MATCH after the rewrite — "
            "against the regen ground truth",
            after == want, "cold read MATCH" if after == want else "cold read differs or EIO'd")
    same, digests = _xor_rows(ctx.members, boff, loc["parity_disk"])
    rec.add("case", "8-xor", "the parity row is the XOR of the data rows again",
            same, f"parity row == XOR(data rows): {same} — " + " ".join(digests))
    assert_knobs_default(ctx, "case 8")


def control8_data_rot_refused(ctx: CaseCtx, rec: Recorder) -> None:
    """NEGATIVE CONTROL — DATA-member rot: the verb must REFUSE.

    This is the case `md repair` gets WRONG (GT-18's negative control: it
    rewrites parity to match the junk, the array goes clean, and the rot is
    blessed — invisible to every later check while btrfs still EIOs the file).
    The fresh btrfs scrub is what tells the two apart, so the control asserts
    both halves: the verb exits 3 with `data-corruption-found`, AND md never
    ran a repair.

    Vacuity review F1: the "never ran a repair" half used to assert only that
    `last_sync_action` was unchanged — but case 8 leaves it at `check`, so a
    verb that ran `repair` and then its own `check` before refusing would
    still pass. The refusal is now also asserted ON DISK: an evicted bounded
    check over the stripe must still count the mismatch (the parity was NOT
    rewritten to match the junk), and the parity member's row must be
    byte-identical to its pre-refusal digest."""
    path = ctx.files["p2"]
    dev, off, boff = ctx.corrupt_below_md(path, 300)
    drop_caches()
    loc = locate_block(ctx.mddev, ctx.mp, path, 300)
    parity_dev = ctx.members[loc["parity_disk"]]
    mm = bounded_window_check(ctx.mddev, loc["stripe"])
    rec.add("control", "8-neg-inject", "data-member rot injected below md", mm > 0,
            f"m{loc['disk']}({os.path.basename(dev)})@{boff} stripe {loc['stripe']}: "
            f"mismatch_cnt={mm}")
    if mm == 0:
        return

    last_before = md_attr(ctx.mddev, "last_sync_action")
    par_pre = read_direct(parity_dev, boff, BS)
    rc, rep, out = run_parity(ctx, band=1, tag="p8neg",
                              evidence=PARITY_EVIDENCE_PATH)
    refused = rc == 3 and rep.get("reason_code") == "data-corruption-found"
    rec.add("control", "8-neg", "the verb REFUSES data rot (exit 3, "
            "data-corruption-found) instead of blessing it", refused,
            f"rc={rc} outcome={rep.get('outcome')} code={rep.get('reason_code')} "
            f"reason={rep.get('reason', out)[:160]}")
    last_after = md_attr(ctx.mddev, "last_sync_action")
    mm_after = bounded_window_check(ctx.mddev, loc["stripe"])
    par_after = read_direct(parity_dev, boff, BS)
    ok_nr = (last_after == last_before and last_after != "repair"
             and mm_after > 0 and par_after == par_pre)
    rec.add("control", "8-neg-no-repair", "md never ran a repair on the band — on "
            "disk: the stripe still counts the mismatch and the parity row is "
            "byte-identical to its pre-refusal digest", ok_nr,
            f"last_sync_action {last_before} -> {last_after}; bounded check "
            f"mismatch_cnt={mm_after} (expected >0); parity row "
            f"unchanged={par_after == par_pre}")


# ---------------------------------------------------------------- case 9

MIRROR_REPORT_PATH = f"{SUITE_OUT}/last-mirror.json"
# The whole-band check's evidence file the mirror verb gates on — the rig's
# stand-in for "the pool's last completed scrub counted disagreeing legs on this
# band" (a rig has no daemon and no job queue).
MIRROR_EVIDENCE_PATH = f"{SUITE_OUT}/mirror-evidence.json"


def run_mirror(ctx: CaseCtx, band: int = 1, tag: str = "m",
               evidence: str | None = None, passes: int | None = None,
               command: str | None = None) -> tuple[int, dict, str]:
    """Invoke the mirror-reconcile verb under test (MIRROR_CMD, story
    selfheal.11). The sidecar is removed first so a crashed run can never be
    read as this one's report."""
    if os.path.exists(MIRROR_REPORT_PATH):
        os.unlink(MIRROR_REPORT_PATH)
    log = f"{LOGS}/{ctx.tag}-{tag}.log"
    rc, out = call_mirror(ctx.mp, band, report=MIRROR_REPORT_PATH, log=log,
                          evidence=evidence, passes=passes, command=command)
    rep = json.load(open(MIRROR_REPORT_PATH)) if os.path.exists(MIRROR_REPORT_PATH) else {}
    return rc, rep, out


def _mirror_evidence(ctx: CaseCtx) -> int:
    """A whole-band check, written out as the verb's evidence file."""
    mm = full_check(ctx.mddev)["mismatch_cnt"]
    with open(MIRROR_EVIDENCE_PATH, "w") as fh:
        json.dump({"band": 1, "mismatch_cnt": mm}, fh)
    return mm


def _place_rot(ctx: CaseCtx, name: str, block: int, on_served: bool):
    """Inject a 4 KiB rot on the leg md DOES (or does NOT) serve reads from.

    GT-22(d): md's read-balance served the rotten leg on every cold read of the
    probe rig — but that is an observation, not a contract, and the two arms of
    this verb are exactly the two sides of it. So the suite does not assume: it
    corrupts one leg and asks md (a COLD single-block read through btrfs EIOs
    only when md served the rotten copy — a single-device btrfs has one copy and
    cannot retry), and if the answer is the wrong way round it restores that leg
    and corrupts the other instead.

    Returns (dev, member offset, leg index, the block's original bytes)."""
    path = ctx.files[name]
    hits = scan_members(ctx.members, sig_for(name, block))
    if len(hits) != len(ctx.members):
        raise RuntimeError(f"scan for {name} block {block}: {len(hits)} hits "
                           f"across {len(ctx.members)} legs: {hits}")
    boff = hits[0][1] - hits[0][1] % BS
    if any(h[1] - h[1] % BS != boff for h in hits):
        raise RuntimeError(f"legs disagree about the member offset: {hits}")
    want = regen(name)[block * BS:(block + 1) * BS]

    corrupt_block(hits[0][0], hits[0][1])
    served_first = _cold_block(path, block) is None      # EIO => md served it
    if served_first == on_served:
        return hits[0][0], boff, ctx.members.index(hits[0][0]), want
    write_direct(hits[0][0], boff, want)                 # put that leg back
    corrupt_block(hits[1][0], hits[1][1])
    drop_caches()
    return hits[1][0], boff, ctx.members.index(hits[1][0]), want


def _legs_match(ctx: CaseCtx, boff: int, want: bytes) -> tuple[bool, str]:
    legs = []
    for i, d in enumerate(ctx.members):
        legs.append(f"m{i}={'ok' if read_direct(d, boff, BS) == want else 'BAD'}")
    return all(not s.endswith("BAD") for s in legs), " ".join(legs)


def case9a_mirror_scrub(ctx: CaseCtx, rec: Recorder) -> None:
    """ARM A — fresh rot on the leg md SERVES: the ordinary btrfs scrub heals
    the whole band through md (GT-22 UNEXPECTED(1)), and repeating the pass is
    what the verb does about md's read-balance not being contractual.

    The assertions are implementation-agnostic — the verb must come back
    `reconciled`, with BOTH legs holding the original block and the band's
    whole-band check reading 0 — because the reference MIRROR_CMD is
    compare-legs only and answers this case through arm B. WHICH arm answered is
    recorded in the detail line rather than asserted.

    The invariant rides every case-9 row: md's own `repair` must never have run
    on the band. That is asserted against the KERNEL's own log (md announces
    `md: repair of RAID array mdN` when it takes one), not against
    the verb's source, so it holds for any implementation."""
    name = "m1"
    dev, boff, leg, want = _place_rot(ctx, name, 300, on_served=True)
    ok0, legs0 = _legs_match(ctx, boff, want)
    rec.add("case", "9a-inject", "fresh rot on the leg md serves reads from "
            "(the cold read through btrfs EIOs)", not ok0,
            f"rot on m{leg} ({os.path.basename(dev)})@{boff}; legs now: {legs0}")
    if ok0:
        return

    mm = _mirror_evidence(ctx)
    rec.add("case", "9a-md-sees-it", "a whole-band md check counts the legs "
            "disagreeing", mm > 0, f"mismatch_cnt={mm} (expected > 0; GT-22: one "
            f"rotted 4 KiB block counts 128 on a mirror)")
    if mm == 0:
        return

    md_before = kernel_md_log()
    rc, rep, out = run_mirror(ctx, band=1, tag="c9a", evidence=MIRROR_EVIDENCE_PATH)
    repairs = md_repair_lines(md_before, ctx.mddev)
    ok = rc == 0 and rep.get("outcome") == "reconciled"
    rec.add("case", "9a-reconcile", "the verb reconciles the band (exit 0)", ok,
            f"rc={rc} outcome={rep.get('outcome')} arm={rep.get('arm')} "
            f"passes={rep.get('passes')} rows_written={rep.get('rows_written')} "
            f"reason={rep.get('reason', out)[:140]}")

    okl, legs = _legs_match(ctx, boff, want)
    rec.add("case", "9a-legs", "both legs hold the ORIGINAL block afterwards",
            okl, f"rot was on m{leg}; now: {legs}")

    after = full_check(ctx.mddev)["mismatch_cnt"]
    rec.add("case", "9a-clean", "an independent whole-band check reads 0",
            after == 0, f"mismatch_cnt={after}")

    rec.add("case", "9a-no-md-repair", "md NEVER ran a repair on the mirror band "
            "(the kernel's own log is the witness)", not repairs,
            "no `md: repair of RAID array` line for this array" if not repairs
            else f"kernel logged: {repairs}")
    assert_knobs_default(ctx, "case 9a")


def case9b_mirror_compare(ctx: CaseCtx, rec: Recorder) -> None:
    """ARM B — rot on the leg md does NOT serve: the scrub reads the good leg,
    finds nothing, and the band stays mismatched. That is the residual case the
    story names, and the only way out is to read both legs and arbitrate every
    differing row against the checksum btrfs stored for it.

    Arm A is held to ONE pass (`--passes 1`) so the fall-through is
    deterministic rather than a second roll of md's read-balance."""
    name = "m2"
    dev, boff, leg, want = _place_rot(ctx, name, 300, on_served=False)
    cold = _cold_block(ctx.files[name], 300)
    rec.add("case", "9b-inject", "rot on the leg md does NOT serve: the file "
            "still reads correctly, so a scrub has nothing to correct",
            cold == want,
            f"rot on m{leg} ({os.path.basename(dev)})@{boff}; cold read "
            f"{'MATCH' if cold == want else 'differs or EIO'}")
    if cold != want:
        return

    mm = _mirror_evidence(ctx)
    rec.add("case", "9b-md-sees-it", "md still counts the legs disagreeing, "
            "while btrfs sees nothing at all", mm > 0, f"mismatch_cnt={mm}")
    if mm == 0:
        return

    md_before = kernel_md_log()
    rc, rep, out = run_mirror(ctx, band=1, tag="c9b", passes=1,
                              evidence=MIRROR_EVIDENCE_PATH)
    repairs = md_repair_lines(md_before, ctx.mddev)
    written = rep.get("rows_written") or {}
    total = int(written.get("leg0", 0)) + int(written.get("leg1", 0))
    good = 1 - leg
    ok = (rc == 0 and rep.get("outcome") == "reconciled" and total == 1
          and int(written.get(f"leg{good}", 0)) == 1)
    rec.add("case", "9b-compare", "compare-legs wrote the GOOD leg's row back "
            "through md (exit 0, one row, from the leg that matched)", ok,
            f"rc={rc} outcome={rep.get('outcome')} arm={rep.get('arm')} "
            f"rows_compared={rep.get('rows_compared')} "
            f"rows_differing={rep.get('rows_differing')} rows_written={written} "
            f"(the good leg is m{good}); unchecked={rep.get('unchecked_rows')} "
            f"free={rep.get('free_space_rows')} "
            f"unresolved={rep.get('unresolved_rows')} "
            f"reason={rep.get('reason', out)[:140]}")

    okl, legs = _legs_match(ctx, boff, want)
    rec.add("case", "9b-legs", "both legs hold the ORIGINAL block afterwards "
            "(md wrote every leg)", okl, f"rot was on m{leg}; now: {legs}")

    after = full_check(ctx.mddev)["mismatch_cnt"]
    rec.add("case", "9b-clean", "an independent whole-band check reads 0",
            after == 0, f"mismatch_cnt={after}")

    rec.add("case", "9b-no-md-repair", "md NEVER ran a repair on the mirror band",
            not repairs, "no `md: repair of RAID array` line for this array" if not repairs
            else f"kernel logged: {repairs}")
    assert_knobs_default(ctx, "case 9b")


def control9_both_legs(ctx: CaseCtx, rec: Recorder) -> None:
    """NEGATIVE CONTROL — rot on BOTH legs, DIFFERENT junk on each.

    Neither copy satisfies the checksum btrfs stored for the row, so there is
    nothing to arbitrate and NOTHING may be written: writing either leg would be
    a coin flip, which is exactly what `mdadm --action=repair` does on a mirror
    and exactly why this epic refuses it. The verb must report the row as
    `unresolved`, come back `residual`, and leave both legs holding the junk
    that was injected."""
    name = "m3"
    hits = scan_members(ctx.members, sig_for(name, 300))
    if len(hits) != len(ctx.members):
        rec.add("control", "9-neg-scan", "the marker block is on every leg", False,
                f"{len(hits)} hits across {len(ctx.members)} legs")
        return
    boff = hits[0][1] - hits[0][1] % BS
    junk = [corrupt_block(hits[0][0], hits[0][1]), corrupt_block(hits[1][0], hits[1][1])]
    drop_caches()
    distinct = junk[0] != junk[1]
    rec.add("control", "9-neg-inject", "both legs corrupted, with DIFFERENT junk "
            "on each", distinct,
            f"m0={_digest12(junk[0])} m1={_digest12(junk[1])} @{boff}")
    if not distinct:
        return

    mm = _mirror_evidence(ctx)
    md_before = kernel_md_log()
    rc, rep, out = run_mirror(ctx, band=1, tag="c9neg", passes=1,
                              evidence=MIRROR_EVIDENCE_PATH)
    repairs = md_repair_lines(md_before, ctx.mddev)
    written = rep.get("rows_written") or {}
    total = int(written.get("leg0", 0)) + int(written.get("leg1", 0))
    ok = (rc == 2 and rep.get("outcome") == "residual"
          and rep.get("unresolved_rows") == 1 and total == 0)
    rec.add("control", "9-neg", "NEITHER leg can be proven, so nothing is written "
            "and the run is a RESIDUAL (exit 2)", ok,
            f"rc={rc} outcome={rep.get('outcome')} "
            f"unresolved={rep.get('unresolved_rows')} rows_written={written} "
            f"mismatch_before={mm} mismatch_after={rep.get('mismatch_after')} "
            f"reason={rep.get('reason', out)[:160]}")

    # On disk: both legs still hold exactly what was injected.
    now = [read_direct(ctx.members[0], boff, BS), read_direct(ctx.members[1], boff, BS)]
    untouched = now[0] == junk[0] and now[1] == junk[1]
    rec.add("control", "9-neg-untouched", "both legs are byte-identical to the "
            "junk that was injected — the verb wrote nothing at all", untouched,
            f"m0 {_digest12(junk[0])} -> {_digest12(now[0])}; "
            f"m1 {_digest12(junk[1])} -> {_digest12(now[1])}")

    rec.add("control", "9-neg-no-md-repair", "and md NEVER ran a repair on the "
            "band — a repair there would have copied leg 0's junk onto leg 1 "
            "and blessed it (GT-22(f))", not repairs,
            "no `md: repair of RAID array` line for this array" if not repairs
            else f"kernel logged: {repairs}")
