#!/usr/bin/env python3
"""cases.py — the selfheal.2 cases, each with its negative control,
against a freshly built rig. The suite (suite.py) builds the rig, writes the
marker files, and calls the case functions with a recorder. Cases 1–5 run on
RAID5/6 loop rigs; case 6 is the RAID1 case (hardening round, F4/GT-16), and
the parity case also runs once on a 512 KiB-chunk rig — the AHR band shape —
to prove no chunk is hardcoded.

Injected-fault placement is ALWAYS via oracle.py (raw signature scan). The
mapping helpers are used only for verification and by the negative-control
drivers (which, like the drill, are allowed to know the layout — the binding
rule constrains the injector, not the controls).
"""
import hashlib
import json
import os

from common import (BS, LOGS, SUITE_OUT, array_end_sectors, bounded_end_check,
                    bounded_range_check, bounded_window_check, btrfs_chunk_ranges,
                    btrfs_metadata_ranges, call_parity, call_repair, chunk_sectors,
                    components,
                    drop_caches, fail_member, file_sector_digests, full_check,
                    locate_block, make_marker, make_snap, md_attr, md_attr_or_none,
                    md_geometry, readd_member, read_direct, regen, remove_snap,
                    restore_sync_knobs, reverse_predict, sig_for, snapshot_read,
                    write_direct)
from oracle import (ORACLE_SNAP, corrupt_block, disambiguate_data_slot,
                    scan_device, scan_members)

REPAIR_SNAP = ".anas-repair-snap"
TX_PROBE_SNAP = ".anas-tx-probe"
REPORT_PATH = f"{SUITE_OUT}/last-repair.json"
PARITY_REPORT_PATH = f"{SUITE_OUT}/last-parity.json"

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

    def corrupt_through_md(self, path: str) -> int:
        """Injector for above-md rot: raw scan of the MD DEVICE itself, then a
        4K junk write through md. No mapping code involved."""
        sig = sig_for(os.path.basename(path).removesuffix(".bin"), 300)
        hits = scan_device(self.mddev, sig)
        if len(hits) != 1:
            raise RuntimeError(f"md-device scan for {path}: {len(hits)} hits, expected 1")
        corrupt_block(self.mddev, hits[0])
        return hits[0] - hits[0] % BS

    def naive_write_through_md(self, path: str, block: int) -> None:
        """Negative-control driver: write the ORIGINAL block through md at the
        default rmw_level (the drill's GT-7 naive repair)."""
        loc = locate_block(self.mddev, self.mp, path, block)
        assert md_attr(self.mddev, "rmw_level") == "1", "rmw_level not at default"
        name = os.path.basename(path).removesuffix(".bin")
        orig = regen(name)[block * BS:(block + 1) * BS]
        write_direct(self.mddev, loc["md_byte"] - loc["md_byte"] % BS, orig)

    def verify_stripe(self, path: str, loc: dict) -> tuple[int, int]:
        """Fail a member (caller does this), cold-read the whole stripe through
        md, compare every 4K block to the regen content. Returns (wrong, total).
        loc: mapping dict with stripe/parity_disk/q_disk/extent info.
        The md stripe cache must be evicted first: a stripe freshly read by a
        bounded check is served from cache afterwards — a degraded read of a
        cached stripe skips parity reconstruction and hides the poison
        (probed live: stale-correct read with no sweep, wrong after a sweep)."""
        raid6 = self.geo["raid6"]
        n, chunk = self.geo["n"], self.geo["chunk"]
        dc = n - (2 if raid6 else 1)
        cs = chunk_sectors(self.geo)
        t = loc["stripe"]
        last = array_end_sectors(self.mddev) // cs
        for s in list(range(max(0, t - 200), t)) + \
                 list(range(t + 1, min(t + 201, last))):
            read_direct(self.mddev, s * dc * chunk, chunk)
        wrong = total = 0
        rows = []
        for d in range(dc):
            md_off = loc["stripe"] * dc * chunk + d * chunk
            data = read_direct(self.mddev, md_off, chunk)
            lv = md_off - loc["start_sector"] * 512
            logical = lv - loc["chunk_device"] + loc["chunk_logical"]
            e = loc["extent"]
            blk0 = (logical - e["disk"]) // BS + e["foff"] // BS
            off_in = logical - e["disk"]
            if off_in < 0 or off_in + chunk > e.get("nr", e["ram"]):
                rows.append(f"chunk {d} (md {md_off}): outside extent — skipped")
                continue
            name = os.path.basename(path).removesuffix(".bin")
            want = regen(name)
            bad = 0
            for i in range(chunk // BS):
                fb = blk0 + i
                if fb * BS >= len(want):
                    break
                if want[fb * BS:(fb + 1) * BS] != data[i * BS:(i + 1) * BS]:
                    bad += 1
            wrong += bad
            total += chunk // BS
            rows.append(f"chunk {d} (md {md_off}, blocks {blk0}..{blk0 + chunk // BS - 1}): "
                        f"{bad} wrong of {chunk // BS}")
        return wrong, total


def run_repair(ctx: CaseCtx, path: str, block: int, fail_at: str | None = None,
               tag: str = "r") -> tuple[int, dict, str]:
    log = f"{LOGS}/{ctx.tag}-{tag}.log"
    rc, out = call_repair(ctx.mp, path, block, fail_at=fail_at,
                          report=REPORT_PATH, log=log)
    rep = json.load(open(REPORT_PATH)) if os.path.exists(REPORT_PATH) else {}
    return rc, rep, out


def run_parity(ctx: CaseCtx, band: int = 1, tag: str = "p") -> tuple[int, dict, str]:
    """Invoke the parity-rewrite verb under test (PARITY_CMD, story
    selfheal.10). The sidecar is removed first so a crashed run can never be
    read as this one's report."""
    if os.path.exists(PARITY_REPORT_PATH):
        os.unlink(PARITY_REPORT_PATH)
    log = f"{LOGS}/{ctx.tag}-{tag}.log"
    rc, out = call_parity(ctx.mp, band, report=PARITY_REPORT_PATH, log=log)
    rep = json.load(open(PARITY_REPORT_PATH)) if os.path.exists(PARITY_REPORT_PATH) else {}
    return rc, rep, out


def assert_snap_absent(ctx: CaseCtx, rec: Recorder, what: str) -> None:
    for name in (REPAIR_SNAP, ORACLE_SNAP):
        p = os.path.join(os.path.dirname(ctx.mp.rstrip("/")), name)
        if os.path.exists(p):
            raise AssertionError(f"{what}: transient snapshot {p} still exists")


def knobs(ctx: CaseCtx) -> dict:
    # md_attr_or_none: a RAID1 array has no rmw_level at all (GT-16) — absent
    # knobs are recorded as absent, not fabricated.
    return {k: md_attr_or_none(ctx.mddev, k) for k in
            ("rmw_level", "sync_min", "sync_max", "sync_action")}


def assert_knobs_default(ctx: CaseCtx, what: str) -> None:
    k = knobs(ctx)
    if not (k.get("rmw_level", "1") == "1" and k["sync_min"] == "0"
            and k["sync_max"] == "max" and k["sync_action"] == "idle"):
        raise AssertionError(f"{what}: knobs not restored: {k}")


def wait_a_moment():
    import time
    time.sleep(1)


# ---------------------------------------------------------------- case 1

def case1_parity_trap(ctx: CaseCtx, rec: Recorder, level: int) -> None:
    """Corrupt a data block on a member -> repair -> fail a DIFFERENT member
    -> every sibling block in the stripe reads back correctly."""
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
    wrong, total = ctx.verify_stripe(path, m)
    ok = wrong == 0
    rec.add("case", f"1{ctx.tag}-a2", f"sibling blocks correct with m{victim} failed "
            f"({level_label(level)})", ok,
            f"stripe {rep['stripe']}: {wrong} wrong of {total} 4K blocks")
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
    wrong, total = ctx.verify_stripe(path, m)
    ok = wrong == 0
    rec.add("case", "1r6-b2", f"sibling blocks correct with P member m{rep['parity_disk']} "
            f"failed (Q reconstruction)", ok,
            f"stripe {rep['stripe']}: {wrong} wrong of {total} 4K blocks")
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
    sibling blocks (GT-7 / GT-12)."""
    path = ctx.files["c1"] if level == 5 else ctx.files["r1"]
    block = 300 if level == 5 else 1400
    # fresh corruption (scan-located)
    dev, off, boff = ctx.corrupt_below_md(path, block)
    loc = locate_block(ctx.mddev, ctx.mp, path, block)
    ctx.naive_write_through_md(path, block)     # original bytes through md, rmw default
    mm = bounded_window_check(ctx.mddev, loc["stripe"])
    ok1 = mm > 0
    rec.add("control", f"1{ctx.tag}-n1", f"naive repair at default rmw_level poisons "
            f"parity ({level_label(level)})", ok1,
            f"bounded check stripe {loc['stripe']}: mismatch_cnt={mm} (expected >0)")
    # fail a different data member: sibling blocks must read back WRONG
    rep = {"stripe": loc["stripe"], "disk": loc["disk"],
           "parity_disk": loc["parity_disk"], "q_disk": loc.get("q_disk")}
    victim = pick_victim(rep, ctx.geo)
    fail_member(ctx.mddev, ctx.members[victim])
    drop_caches()
    wrong, total = ctx.verify_stripe(path, loc)
    ok2 = wrong > 0
    rec.add("control", f"1{ctx.tag}-n2", f"sibling blocks BROKEN with m{victim} failed "
            f"({level_label(level)}, default rmw)", ok2,
            f"stripe {loc['stripe']}: {wrong} wrong of {total} 4K blocks (expected >0)")
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
            "(zeros file)", same,
            f"scan hit {dev}@{off - off % BS} vs mapped m{loc300['disk']}@"
            f"{loc300['moff']} (cross-check only)")
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
    from common import find_btrfs_dev, file_extents, reverse_locate
    srcdev = find_btrfs_dev(ctx.mp)
    disk = ctx.members.index(dev)
    m = reverse_locate(ctx.mddev, ctx.mp, disk, boff, [path])
    blk = m["block"]
    rec.add("case", "3-map", "corrupted compressed sector mapped back to a file block "
            "(verification side)", True,
            f"m{disk}@{boff} -> {os.path.basename(path)} block {blk} "
            f"(compressed={m['compressed']}, extent disk {m['extent']['disk']} "
            f"nr {m['extent']['disknr']} ram {m['extent']['ram']})")

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
    sync_max restored and no transient snapshot remains; then a full md check
    covers the whole array again."""
    path = ctx.files["c4"]

    fails = []
    for step in STEPS:
        ctx.corrupt_below_md(path, 300)          # fresh rot before every run
        remove_snap(ctx.mp, REPAIR_SNAP)
        rc, rep, out = run_repair(ctx, path, 300, fail_at=step, tag=f"c4-{step}")
        detail = f"rc={rc} (expected 70)"
        ok = rc == 70
        try:
            assert_knobs_default(ctx, f"after REPAIR_FAIL_AT={step}")
            assert_snap_absent(ctx, rec, f"after REPAIR_FAIL_AT={step}")
            detail += f" knobs={knobs(ctx)} snapshots=absent"
        except AssertionError as e:
            ok = False
            detail += f" {e}"
        if not ok:
            fails.append(step)
        rec.add("case", f"4-{step}", f"REPAIR_FAIL_AT={step}: exit 70, knobs restored, "
                "no transient snapshot", ok, detail)

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
    rc, rep, out = run_repair(ctx, path, 300, tag="c4-clean")
    ok = rc == 0 and rep.get("postcheck_mismatch") == 0
    try:
        assert_knobs_default(ctx, "clean run")
        assert_snap_absent(ctx, rec, "clean run")
        ok = ok and True
    except AssertionError as e:
        ok = False
        out += f" {e}"
    rec.add("control", "4-neg", "clean run (no injection) repairs, restores knobs, "
            "removes its snapshot", ok,
            f"rc={rc} postcheck={rep.get('postcheck_mismatch')}")


# ---------------------------------------------------------------- case 5

def case5_above_md(ctx: CaseCtx, rec: Recorder) -> None:
    """Rot written THROUGH md: pre-check diagnosis (exit 3), not a failed
    repair; pre-check mismatch_cnt==0."""
    path = ctx.files["c5"]
    md_off = ctx.corrupt_through_md(path)
    loc = locate_block(ctx.mddev, ctx.mp, path, 300)
    same = md_off == loc["md_byte"] - loc["md_byte"] % BS
    rec.add("case", "5-scan", "md-device scan located the through-md rot", same,
            f"scan md@{md_off} vs mapped {loc['md_byte']} (cross-check only)")
    if not same:
        return
    # sanity: md sees nothing (GT-6)
    mm = bounded_window_check(ctx.mddev, loc["stripe"])
    rec.add("case", "5-sanity", "bounded check over the stripe sees mismatch_cnt==0 "
            "(rot arrived through md)", mm == 0, f"mismatch_cnt={mm} (expected 0)")
    if mm != 0:
        return

    rc, rep, out = run_repair(ctx, path, 300, tag="c5a")
    ok = rc == 3 and rep.get("precheck_mismatch") == 0 and rep.get("outcome") == "above-md"
    rec.add("case", "5-diag", "repair diagnoses above-md corruption (exit 3, "
            "mismatch_cnt==0 in pre-check, nothing written)", ok,
            f"rc={rc} precheck_mismatch={rep.get('precheck_mismatch')} "
            f"outcome={rep.get('outcome')} steps={len(rep.get('steps_done', []))} "
            f"reason={rep.get('reason', out)[:140]}")

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

    Negative control BEFORE the repair: with one leg rotten, a cold read
    through md may be served either leg — record which leg md served and
    whether the btrfs read EIOs accordingly. Both outcomes are legitimate;
    what is asserted is only that the recorded pair is coherent (EIO iff md
    served the corrupt bytes) and that the rot is real on the member."""
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

    # --- negative control (before the repair): record what md serves, assert
    # only coherence — never a specific leg
    want = regen(name)[300 * BS:(300 + 1) * BS]
    rot_real = read_direct(leg_dev, boff, BS) != want
    drop_caches()
    snap = make_snap(ctx.mp, ORACLE_SNAP)
    try:
        r = snapshot_read(os.path.join(snap, f"{name}.bin"), [300])
    finally:
        remove_snap(ctx.mp, ORACLE_SNAP)
    if 300 in r["eio"]:
        served = "the corrupt leg (btrfs read EIOs)"
        coherent = rot_real
    else:
        served = "the good leg (btrfs read succeeds)"
        coherent = rot_real and r["data"].get(300) == want
    rec.add("control", "6-neg", f"cold read through md with leg m{leg} rotten: md "
            "served " + served, coherent,
            f"rot_on_m{leg}={rot_real} eio={r['eio']} (either leg is a "
            "legitimate serving; recorded, not asserted)")

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
    stripe reads 0 and a cold snapshot read matches."""
    bl = _tb_blocks(ctx)
    path, block = bl["seg2"]
    name = os.path.basename(path).removesuffix(".bin")
    m = bl["maps"][(name, block)]
    band_a_devs = components(ctx.mddevs[0])
    segA = m["segs"][0]
    assert segA["dev"] == ctx.mddevs[0], \
        f"rig: the first dm segment is {segA['dev']}, expected band A {ctx.mddevs[0]}"

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
    probe_b = {d: file_sector_digests(d) for d in band_a_devs}
    make_snap(ctx.mp, TX_PROBE_SNAP)
    remove_snap(ctx.mp, TX_PROBE_SNAP)
    probe_a = {d: file_sector_digests(d) for d in band_a_devs}
    tx_blocks: set[int] = set()
    for i, d in enumerate(band_a_devs):
        for s, (pb, pa) in enumerate(zip(probe_b[d], probe_a[d])):
            if pb != pa:
                moff = s * BS
                if moff < ctx.geo["data_offset"]:
                    continue        # md's own super region — carved out below
                tx_blocks.add(reverse_predict(i, moff, ctx.geo)
                              - segA["ss"] * 512 + segA["start"])

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

    before = probe_a   # nothing changes between the probe and the repair
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
    doff = ctx.geo["data_offset"]
    housekeeping = data = 0
    bad_sectors = []
    for i, d in enumerate(band_a_devs):
        b, a = before[d], after[d]
        if b == a:
            continue
        for s, (hb, ha) in enumerate(zip(b, a)):
            if hb == ha:
                continue
            moff = s * BS
            if moff < doff:
                housekeeping += 1      # md's own superblock region: never file data
                continue
            lv = reverse_predict(i, moff, ctx.geo) - segA["ss"] * 512 + segA["start"]
            if lv in tx_blocks or any(lo <= lv < hi for lo, hi in excl):
                housekeeping += 1
            else:
                data += 1
                if len(bad_sectors) < 5:
                    bad_sectors.append(f"{os.path.basename(d)}@{moff} (LV {lv})")
    rec.add("case", "7-bandA-untouched", "no DATA write on band A: every changed "
            "band-A sector is btrfs superblock/metadata housekeeping (the R1 "
            "assertion)", data == 0,
            f"changed sectors: {housekeeping + data} — housekeeping={housekeeping} "
            f"data={data}" + (f" — DATA CHANGED: {bad_sectors}" if data else ""))

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
    want = regen(name)[block * BS:(block + 1) * BS]
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
    verification side. That is the same construction GT-18 used."""
    path = ctx.files["p1"]
    dev, off = ctx.scan_locate(path, 300)
    boff = off - off % BS
    loc = locate_block(ctx.mddev, ctx.mp, path, 300)
    parity_dev = ctx.members[loc["parity_disk"]]
    kept = _cold_block(path, 300)
    if kept is None:
        rec.add("case", "8-precondition", "the marker block reads before the rot", False,
                "the cold read EIO'd before anything was injected")
        return
    corrupt_block(parity_dev, boff)
    drop_caches()
    rec.add("case", "8-inject", "parity member's stripe row corrupted behind md "
            "(data members untouched)", True,
            f"data m{loc['disk']}({os.path.basename(dev)}) scan-located at {boff}; "
            f"rot injected on PARITY m{loc['parity_disk']}({os.path.basename(parity_dev)})@{boff}, "
            f"stripe {loc['stripe']}")

    # md sees it, btrfs does not — the whole reason this case exists (GT-18 a/b).
    mm = bounded_window_check(ctx.mddev, loc["stripe"])
    rec.add("case", "8-md-sees-it", "bounded md check over the stripe counts mismatches",
            mm > 0, f"mismatch_cnt={mm} (expected > 0)")
    before = _cold_block(path, 300)
    rec.add("case", "8-data-intact", "the file still reads correctly through btrfs "
            "(parity rot is invisible above md)", before == kept,
            "cold read MATCH" if before == kept else "cold read differs or EIO'd")
    if mm == 0 or before != kept:
        return

    rc, rep, out = run_parity(ctx, band=1, tag="p8")
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
    rec.add("case", "8-match", "the file still reads MATCH after the rewrite",
            after == kept, "cold read MATCH" if after == kept else "cold read differs or EIO'd")
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
    ran a repair (`last_sync_action` is untouched)."""
    path = ctx.files["p2"]
    dev, off, boff = ctx.corrupt_below_md(path, 300)
    drop_caches()
    loc = locate_block(ctx.mddev, ctx.mp, path, 300)
    mm = bounded_window_check(ctx.mddev, loc["stripe"])
    rec.add("control", "8-neg-inject", "data-member rot injected below md", mm > 0,
            f"m{loc['disk']}({os.path.basename(dev)})@{boff} stripe {loc['stripe']}: "
            f"mismatch_cnt={mm}")
    if mm == 0:
        return

    last_before = md_attr(ctx.mddev, "last_sync_action")
    rc, rep, out = run_parity(ctx, band=1, tag="p8neg")
    refused = rc == 3 and rep.get("reason_code") == "data-corruption-found"
    rec.add("control", "8-neg", "the verb REFUSES data rot (exit 3, "
            "data-corruption-found) instead of blessing it", refused,
            f"rc={rc} outcome={rep.get('outcome')} code={rep.get('reason_code')} "
            f"reason={rep.get('reason', out)[:160]}")
    last_after = md_attr(ctx.mddev, "last_sync_action")
    rec.add("control", "8-neg-no-repair", "md never ran a repair on the band",
            last_after == last_before and last_after != "repair",
            f"last_sync_action {last_before} -> {last_after}")
