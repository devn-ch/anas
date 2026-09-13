#!/usr/bin/env python3
"""suite.py — the selfheal.2 loop-device suite driver. Run ON THE NODE
(python3 /root/gtsh/suite/suite.py); test/self-heal/suite/run-suite.sh is the
dev-box entry that pushes the files and runs this over ssh.

Builds a RAID5 rig (6 members), runs the cases that need it, tears it down,
builds a RAID6 rig (7 members), runs the parity cases there, tears down; the
hardening round adds a 512 KiB-chunk RAID5 rig (the AHR band shape — the
parity case only, proving no chunk is hardcoded, F4) and a 2-member RAID1 rig
for case 6 (GT-16: RAID1 has no stripe knobs at all). Then it writes
report.md + report.json under /root/gtsh/suite-out/ and prints the final
`SUITE: ...` line. Exit 0 iff every case AND every negative control passed.

Safety: only loop devices from /root/gtsh/m? (teardown_all at start, between
rigs, and at the end); md arrays named /dev/md/gtsh1|gtsh5|gtsh6; VG gtsh;
mount /mnt/gtsh. /root/gtsh/suite-out/ holds all outputs (context economy).
"""
import datetime
import json
import os
import re
import subprocess
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (GT, KEEP, LOGS, SUITE_OUT, build_two_band_rig, md_attr,
                    make_marker, mddev_workdir, rig_up, teardown_all, remove_snap)
from oracle import ORACLE_SNAP
import cases as C
from cases import Recorder, REPAIR_SNAP

RIG5_FILES = [("c1", "random", 8 * 1024 * 1024, 1, [300]),
              ("z1", "zeros", 4 * 1024 * 1024, None, [300]),
              ("c4", "random", 4 * 1024 * 1024, 4, [300]),
              ("c5", "random", 4 * 1024 * 1024, 5, [300, 700])]
RIG6_FILES = [("r1", "random", 8 * 1024 * 1024, 1, [300, 1000, 1400])]
RIG1_FILES = [("l1", "random", 4 * 1024 * 1024, 7, [300])]
# Two-band rig: plain filler (no signatures — an explicit empty block list) to
# push the data past band A's segment, then the marker whose signature blocks
# must land in BOTH segments (case 7 maps them from the dm table).
TWOBAND_FILES = [("f1", "random", 300 * 1024 * 1024, 11, []),
                 ("b1", "random", 500 * 1024 * 1024, 12, [300, 40000, 80000, 120000])]


def write_markers(ctx, specs):
    for name, kind, size, seed, blocks in specs:
        ctx.files[name] = make_marker(name, kind, size, seed=seed, blocks=blocks)


def case_fn(cid: str, ctx, rec: Recorder, level: int) -> None:
    if cid == "1":
        return C.case1_parity_trap(ctx, rec, level)
    if cid == "1-neg":
        return C.control1_parity_trap(ctx, rec, level)
    if cid == "2":
        return C.case2_zero_block_abort(ctx, rec)
    if cid == "3":
        return C.case3_compressed_coldread(ctx, rec)
    if cid == "4":
        return C.case4_knob_restore(ctx, rec)
    if cid == "5":
        return C.case5_above_md(ctx, rec)
    if cid == "6":
        return C.case6_raid1(ctx, rec)
    if cid == "7":
        return C.case7_two_band(ctx, rec)
    if cid == "7-neg":
        return C.control7_two_band(ctx, rec)
    raise KeyError(cid)


def run_two_band_rig(rec: Recorder, notes: list[str]) -> None:
    """The AHR pool shape (review finding R1's missing case): two md arrays
    (bands) as the PVs of one VG, one LV spanning both in band order, DIFFERENT
    chunk sizes. Case 7 corrupts a segment-2 (band B) marker block and the
    repair must not touch band A; the control repairs a segment-1 block."""
    try:
        mda, mdb, work, segs = build_two_band_rig()
    except Exception:
        notes.append("two-band rig: FAILED to build:\n"
                     f"{traceback.format_exc()[-600:]}")
        raise
    ctx = C.CaseCtx([mda, mdb], work, "tb")
    # record the dm table's segment layout (the rig's defining fact)
    notes.append(
        f"two-band rig: LV is {len(segs)} linear segments from the dm table — "
        f"band A {mda} (RAID5 6×200 MiB, 64K) LV [0, "
        f"{segs[0]['length'] // (1024 * 1024)} MiB), band B {mdb} (RAID5 4×200 MiB, "
        f"512K) LV [{segs[1]['start'] // (1024 * 1024)}, "
        f"{(segs[1]['start'] + segs[1]['length']) // (1024 * 1024)} MiB)")
    write_markers(ctx, TWOBAND_FILES)
    for cid in ("7", "7-neg"):
        kind = "case" if cid == "7" else "control"
        try:
            case_fn(cid, ctx, rec, 5)
        except Exception:
            rec.add(kind, cid, f"case {cid} (two-band rig) crashed", False,
                    traceback.format_exc()[-500:])
            notes.append(f"case {cid} on the two-band rig: crashed:\n"
                         f"{traceback.format_exc()[-800:]}")
    remove_snap(work, REPAIR_SNAP)
    remove_snap(work, ORACLE_SNAP)
    teardown_retry()


def run_rig(level: int, rec: Recorder, notes: list[str], chunk: str = "64K",
            tag: str | None = None, files=None, cases=(), compress: bool = False) -> None:
    try:
        mddev = rig_up(level, chunk)
    except Exception:
        notes.append(f"rig {level} ({chunk}): FAILED to build:\n"
                     f"{traceback.format_exc()[-600:]}")
        raise
    md, work = mddev_workdir()
    ctx = C.CaseCtx([md], work, tag or f"r{level}")

    write_markers(ctx, files or [])
    if compress:
        # the compress marker is written on the zstd remount (remount the
        # mount root, not the subvolume path — a remount target must be a
        # mountpoint)
        run(["mount", "-o", "remount,compress=zstd",
             os.path.dirname(work.rstrip("/"))])
        ctx.files["c3"] = make_marker("c3", "text", 4 * 1024 * 1024)

    for cid in cases:
        try:
            case_fn(cid, ctx, rec, level)
        except Exception:
            rec.add("case", cid, f"case {cid} ({level_label(level, chunk)}) crashed",
                    False, traceback.format_exc()[-500:])
            notes.append(f"case {cid} on rig {level} ({chunk}): crashed:\n"
                         f"{traceback.format_exc()[-800:]}")
    remove_snap(work, REPAIR_SNAP)
    remove_snap(work, ORACLE_SNAP)
    teardown_retry()


def run(cmd):
    subprocess.run(cmd, check=True, stdin=subprocess.DEVNULL)


def _gtsh_loop_names() -> set[str]:
    """The /dev/loopN nodes still backed by a file under /root/gtsh."""
    names = set()
    out = subprocess.run(["losetup", "-a"], capture_output=True,
                         text=True).stdout
    for line in out.splitlines():
        if "/root/gtsh" in line:
            names.add(line.split(":", 1)[0])
    return names


def stop_stale_gtsh_arrays() -> None:
    """Stop any md array that still holds one of OUR loops, by node. The
    documented teardown race lets `mdadm --stop /dev/md/gtshN` fail busy; a
    surviving array keeps its metadata name and the next rig built under the
    same name is refused outright (observed live: `mdadm: Array name
    /dev/md/gtsh5 is in use already.` when the 512K rig followed the first
    RAID5 rig — the RAID6 and RAID1 rigs, with unique names, never hit it).
    Members are matched against the loops still backed under /root/gtsh, so
    a foreign array is never touched."""
    gtsh = _gtsh_loop_names()
    if not gtsh:
        return
    for m in re.finditer(r"^(md\d+)\s*:(.*)$", open("/proc/mdstat").read(), re.M):
        node = f"/dev/{m.group(1)}"
        members = {f"/dev/{t}" for t in re.findall(r"(loop\d+)\[\d+\]", m.group(2))}
        if members & gtsh:
            subprocess.run(["mdadm", "--stop", node],
                           stdin=subprocess.DEVNULL, capture_output=True)


def teardown_retry() -> None:
    """teardown_all, then the documented second pass: the gt teardown_all
    swallows a busy `mdadm --stop` (|| true) and its `losetup -j` match misses
    loops whose backing file is already "(deleted)"; a lingering array makes
    the NEXT rig's `mdadm --create` fail. Observed live in the hardening
    round: the 512K rig died this way immediately after a green RAID5 rig.
    One retry between rigs is what the end-of-run path always did, so it is
    applied between rigs too."""
    teardown_all()
    time.sleep(2)
    teardown_all()
    stop_stale_gtsh_arrays()
    for line in subprocess.run(["losetup", "-a"], capture_output=True,
                               text=True).stdout.splitlines():
        if "/root/gtsh" in line:
            subprocess.run(["losetup", "-d", line.split(":")[0]],
                           stdin=subprocess.DEVNULL, capture_output=True)
    for name in ("gtsh1", "gtsh5", "gtsh6", "gtshA", "gtshB"):
        p = f"/dev/md/{name}"
        if os.path.lexists(p) and not os.path.exists(p):
            os.unlink(p)   # dangling symlink to a stopped array


def level_label(level, chunk: str = "64K"):
    label = {1: "RAID1", 5: "RAID5", 6: "RAID6"}[level]
    return label if chunk == "64K" else f"{label} {chunk} chunk"


def meta() -> dict:
    def out(cmd):
        r = subprocess.run(cmd, capture_output=True, text=True)
        return (r.stdout + r.stderr).strip()
    mdadm_v = re.search(r"mdadm - v(\S+)", out(["mdadm", "--version"]))
    btrfs_v = re.search(r"btrfs-progs v(\S+)", out(["btrfs", "--version"]))
    return {
        "date": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "node": out(["hostname"]),
        "kernel": out(["uname", "-r"]),
        "mdadm": mdadm_v.group(1) if mdadm_v else "?",
        "btrfs_progs": btrfs_v.group(1) if btrfs_v else "?",
        "repair_cmd": os.environ.get("REPAIR_CMD") or
                      f"python3 {GT}/suite/repair-ref.py",
    }


def write_report(rec: Recorder, notes: list[str]) -> tuple[str, str, bool]:
    os.makedirs(SUITE_OUT, exist_ok=True)
    m = meta()
    all_pass = all(e["verdict"] == "PASS" for e in rec.cases + rec.controls)
    nc = sum(e["verdict"] == "PASS" for e in rec.controls)
    nk = sum(e["verdict"] == "PASS" for e in rec.cases)
    final = (f"SUITE: {'PASS' if all_pass else 'FAIL'} "
             f"({nk}/{len(rec.cases)} cases, {nc}/{len(rec.controls)} negative controls)")

    lines = [
        "# AHR self-heal loop-device suite — report",
        "",
        f"- date: {m['date']}  node: {m['node']}  kernel: {m['kernel']}",
        f"- mdadm: {m['mdadm']}  btrfs-progs: {m['btrfs_progs']}",
        f"- REPAIR_CMD: `{m['repair_cmd']}`",
        "- rigs: RAID5 (6 × 200 MiB loops), RAID6 (7 × 200 MiB loops),"
        " RAID5 at md's 512 KiB chunk (6 × 200 MiB loops, parity case only),"
        " RAID1 (2 × 200 MiB loops), and the two-band AHR shape (RAID5"
        " 6 × 200 MiB @ 64K + RAID5 4 × 200 MiB @ 512K in one VG/LV, case 7)"
        " — built fresh per run, torn down after"
        " (see test/self-heal/gt/00-rig.sh and 00-rig-twoband.sh)",
        "",
        "## Cases",
        "",
        "| id | case | verdict | detail |",
        "|----|------|---------|--------|",
    ]
    for e in rec.cases:
        lines.append(f"| {e['id']} | {e['name']} | {e['verdict']} | {e['detail']} |")
    lines += ["", "## Negative controls", "",
              "| id | control | verdict | detail |",
              "|----|---------|---------|--------|"]
    for e in rec.controls:
        lines.append(f"| {e['id']} | {e['name']} | {e['verdict']} | {e['detail']} |")
    lines += ["", "## Notes", ""]
    lines += [f"- {n}" for n in notes] if notes else \
             ["- none — every stage behaved as expected"]
    lines += ["", f"**{final}**", ""]
    md = "\n".join(lines)

    with open(f"{SUITE_OUT}/report.md", "w") as fh:
        fh.write(md)
    with open(f"{SUITE_OUT}/report.json", "w") as fh:
        json.dump({"meta": m, "cases": rec.cases, "controls": rec.controls,
                   "notes": notes, "suite": "PASS" if all_pass else "FAIL",
                   "counts": {"cases_passed": nk, "cases_total": len(rec.cases),
                              "controls_passed": nc,
                              "controls_total": len(rec.controls)},
                   "final": final}, fh, indent=1)
    return md, final, all_pass


def main() -> int:
    os.makedirs(SUITE_OUT, exist_ok=True)
    os.makedirs(LOGS, exist_ok=True)
    os.makedirs(KEEP, exist_ok=True)
    for f in os.listdir(LOGS):
        os.unlink(os.path.join(LOGS, f))
    rec = Recorder()
    notes: list[str] = []
    rigs = [
        ("RAID5 64K", lambda: run_rig(5, rec, notes, files=RIG5_FILES,
                                      cases=("1", "1-neg", "2", "3", "4", "5"),
                                      compress=True)),
        ("RAID6 64K", lambda: run_rig(6, rec, notes, files=RIG6_FILES,
                                      cases=("1", "1-neg"))),
        # F4 proof: the parity case again on the AHR band shape — md's 512 KiB
        # default chunk, where a hardcoded 128-sector window is refused EINVAL
        ("RAID5 512K", lambda: run_rig(5, rec, notes, chunk="512K", tag="r5x",
                                       files=RIG5_FILES[:1], cases=("1", "1-neg"))),
        # GT-16: RAID1 has no rmw_level / stripe_cache_size and chunk_size
        # reads 0 — case 6 with its negative control
        ("RAID1", lambda: run_rig(1, rec, notes, files=RIG1_FILES,
                                  cases=("6",))),
        # the AHR pool shape (review finding R1): the LV is the linear
        # concatenation of TWO md arrays (bands) with different chunk sizes —
        # a segment-2 repair must not touch the other band
        ("two-band", lambda: run_two_band_rig(rec, notes)),
    ]
    try:
        teardown_retry()
        for label, rig in rigs:
            try:
                rig()
            except Exception:
                # a rig that will not build is a FAIL, not a crash that hides
                # the rigs after it — record it and move on
                rec.add("case", f"rig ({label})",
                        f"rig {label} FAILED to build — its cases could not run",
                        False, traceback.format_exc()[-500:])
                notes.append(f"rig {label}: FAILED to build:\n"
                             f"{traceback.format_exc()[-800:]}")
    finally:
        teardown_retry()
    md, final, ok = write_report(rec, notes)
    print(final, flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
