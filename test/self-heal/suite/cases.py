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
import json
import os

from common import (BS, LOGS, SUITE_OUT, array_end_sectors, bounded_end_check,
                    bounded_range_check, bounded_window_check, call_repair,
                    chunk_sectors, components, drop_caches, fail_member,
                    full_check, locate_block, make_snap, md_attr,
                    md_attr_or_none, md_geometry, readd_member, read_direct,
                    regen, remove_snap, restore_sync_knobs, sig_for,
                    snapshot_read, write_direct)
from oracle import (ORACLE_SNAP, corrupt_block, disambiguate_data_slot,
                    scan_device, scan_members)

REPAIR_SNAP = ".anas-repair-snap"
REPORT_PATH = f"{SUITE_OUT}/last-repair.json"

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
    """Per-rig context: md array, mountpoint, members, marker files."""

    def __init__(self, mddev: str, mountpoint: str, tag: str):
        self.mddev = mddev
        self.mp = mountpoint
        self.tag = tag
        self.members = components(mddev)
        self.geo = md_geometry(mddev)
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
