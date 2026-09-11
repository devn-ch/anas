#!/usr/bin/env python3
"""suite.py — the selfheal.2 loop-device suite driver. Run ON THE NODE
(python3 /root/gtsh/suite/suite.py); test/self-heal/suite/run-suite.sh is the
dev-box entry that pushes the files and runs this over ssh.

Builds a RAID5 rig (6 members), runs the cases that need it, tears it down,
builds a RAID6 rig (7 members), runs the parity cases there, tears down, then
writes report.md + report.json under /root/gtsh/suite-out/ and prints the
final `SUITE: ...` line. Exit 0 iff every case AND every negative control
passed.

Safety: only loop devices from /root/gtsh/m? (teardown_all at start, between
rigs, and at the end); md arrays named /dev/md/gtsh5|gtsh6; VG gtsh; mount
/mnt/gtsh. /root/gtsh/suite-out/ holds all outputs (context economy).
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

from common import (GT, KEEP, LOGS, SUITE_OUT, md_attr, make_marker, mddev_workdir,
                    rig_up, teardown_all, remove_snap)
from oracle import ORACLE_SNAP
import cases as C
from cases import Recorder, REPAIR_SNAP

RIG5_FILES = [("c1", "random", 8 * 1024 * 1024, 1, [300]),
              ("z1", "zeros", 4 * 1024 * 1024, None, [300]),
              ("c4", "random", 4 * 1024 * 1024, 4, [300]),
              ("c5", "random", 4 * 1024 * 1024, 5, [300, 700])]
RIG6_FILES = [("r1", "random", 8 * 1024 * 1024, 1, [300, 1000, 1400])]


def write_markers(ctx, specs):
    for name, kind, size, seed, blocks in specs:
        ctx.files[name] = make_marker(name, kind, size, seed=seed, blocks=blocks)


def run_rig(level: int, rec: Recorder, notes: list[str]) -> None:
    try:
        mddev = rig_up(level)
    except Exception:
        notes.append(f"rig {level}: FAILED to build:\n{traceback.format_exc()[-600:]}")
        raise
    md, work = mddev_workdir()
    ctx = C.CaseCtx(md, work, f"r{level}")
    from common import find_btrfs_dev
    srcdev = find_btrfs_dev(work)

    if level == 5:
        write_markers(ctx, RIG5_FILES)
        # the compress marker is written on the zstd remount (remount the
        # mount root, not the subvolume path — a remount target must be a
        # mountpoint)
        run(["mount", "-o", "remount,compress=zstd",
             os.path.dirname(work.rstrip("/"))])
        ctx.files["c3"] = make_marker("c3", "text", 4 * 1024 * 1024)
    else:
        write_markers(ctx, RIG6_FILES)

    guard = [
        ("1a/1b", lambda: C.case1_parity_trap(ctx, rec, level)),
        ("1-neg", lambda: C.control1_parity_trap(ctx, rec, level)),
        ("2", lambda: C.case2_zero_block_abort(ctx, rec)),
        ("3", lambda: C.case3_compressed_coldread(ctx, rec)),
        ("4", lambda: C.case4_knob_restore(ctx, rec)),
        ("5", lambda: C.case5_above_md(ctx, rec)),
    ]
    skip = set()
    if level == 6:
        skip = {"2", "3", "4", "5"}       # parity cases on BOTH levels; rest once
    for cid, fn in guard:
        if cid in skip:
            continue
        try:
            fn()
        except Exception:
            rec.add("case", cid, f"case {cid} ({level_label(level)}) crashed",
                    False, traceback.format_exc()[-500:])
            notes.append(f"case {cid} on rig {level}: crashed:\n"
                         f"{traceback.format_exc()[-800:]}")
    remove_snap(work, REPAIR_SNAP)
    remove_snap(work, ORACLE_SNAP)
    teardown_all()


def run(cmd):
    subprocess.run(cmd, check=True, stdin=subprocess.DEVNULL)


def level_label(level):
    return "RAID5" if level == 5 else "RAID6"


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
        "- rigs: RAID5 (6 × 200 MiB loops) and RAID6 (7 × 200 MiB loops),"
        " built fresh per run, torn down after (see test/self-heal/gt/00-rig.sh)",
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
    try:
        teardown_all()
        run_rig(5, rec, notes)
        run_rig(6, rec, notes)
    finally:
        teardown_all()
        # the gt teardown_all swallows a busy mdadm --stop (|| true) and its
        # losetup -j match misses loops whose backing file is already
        # "(deleted)"; a lingering loop lets mdadm auto-reassemble the array.
        # Observed live: after a green run /proc/mdstat still listed md127.
        # Retry teardown, then sweep anything left.
        time.sleep(2)
        teardown_all()
        if os.path.exists("/dev/md127"):
            subprocess.run(["mdadm", "--stop", "/dev/md127"],
                           stdin=subprocess.DEVNULL,
                           capture_output=True)
        for line in subprocess.run(["losetup", "-a"], capture_output=True,
                                   text=True).stdout.splitlines():
            if "/root/gtsh" in line:
                subprocess.run(["losetup", "-d", line.split(":")[0]],
                               stdin=subprocess.DEVNULL, capture_output=True)
        for name in ("gtsh5", "gtsh6"):
            p = f"/dev/md/{name}"
            if os.path.lexists(p) and not os.path.exists(p):
                os.unlink(p)   # dangling symlink to a stopped array
    md, final, ok = write_report(rec, notes)
    print(final, flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
