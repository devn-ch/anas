#!/usr/bin/env python3
"""parity-ref.py <mountpoint> <band> [--ignored-flags] — the REFERENCE parity
rewrite (story selfheal.10, case 8), the default `PARITY_CMD`.

The verb, in the order the story fixes it:

  1. a FRESH btrfs scrub of the whole filesystem — ANY finding aborts (exit 3).
     md repair recomputes parity from the data as it stands, so data rot has to
     be found first or `repair` blesses it (GT-18's negative control: parity
     rewritten to match the junk, mismatch_cnt 0, the file still EIO).
  2. the band's gates: idle, not degraded, not mid-reshape, sync_max at max.
  3. `mdadm --action=repair <band device>` over the WHOLE band — md counts
     mismatches, it does not locate them, so the band is the only honest scope.
  4. wait for idle, never writing anything: an action that is not ours replacing
     it means md took an operation of its own (a member failed), and the only
     correct move is to walk away (exit 3).
  5. `mdadm --action=check` over the whole band, wait idle, settle, and read
     `mismatch_cnt` — it must be 0 (exit 0), or the rewrite is unproven (exit 2).

Exit codes: 0 rewritten · 2 still-mismatched · 3 refused · 1 internal error.
`PARITY_REPORT=<path>` writes the JSON sidecar the suite cross-checks.

Unknown `--flags` are accepted and ignored, so a PARITY_CMD carrying the ANAS
dev entry's `--assume-mismatch` (which stands in for the completed-scrub
evidence a rig has no job queue for) runs against this reference unchanged.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (dm_segments, find_btrfs_dev, md_attr, md_attr_or_none,  # noqa: E402
                    mdsys, run)

EXIT_REWRITTEN = 0
EXIT_INTERNAL = 1
EXIT_STILL_MISMATCHED = 2
EXIT_REFUSED = 3

SETTLE_S = 1
POLL_S = 0.5
START_TIMEOUT_S = 15
FINISH_TIMEOUT_S = 900

ERROR_SUMMARY_RE = re.compile(r"^Error summary:\s+(\S.*)$", re.M)

report = {"outcome": None, "reason": "", "reason_code": None, "band": None,
          "array": None, "mismatch_before": None, "mismatch_after": None,
          "btrfs_errors": None, "phases": []}


def emit(code: int) -> int:
    path = os.environ.get("PARITY_REPORT")
    if path:
        with open(path, "w") as fh:
            json.dump(report, fh, indent=1)
    print(json.dumps(report, indent=1))
    return code


def refuse(reason: str, reason_code: str) -> int:
    report["outcome"] = "refused"
    report["reason"] = reason
    report["reason_code"] = reason_code
    return emit(EXIT_REFUSED)


def btrfs_scrub(mountpoint: str) -> str | None:
    """One blocking btrfs scrub; the `Error summary:` line, or None when clean."""
    run(["btrfs", "scrub", "start", "-B", mountpoint], check=False)
    status = run(["btrfs", "scrub", "status", mountpoint], check=False).stdout
    m = ERROR_SUMMARY_RE.search(status)
    summary = m.group(1).strip() if m else None
    return None if summary in (None, "no errors found") else summary


def wait_for_op(mddev: str, expect: str) -> str | None:
    """Wait out an op this run issued. Returns None when it ended, or the
    foreign action md replaced it with. Nothing is ever WRITTEN here: both ops
    are whole-band with sync_max at max, so md ends them itself."""
    m = mdsys(mddev)
    deadline = time.time() + START_TIMEOUT_S
    started = False
    while time.time() < deadline:
        action = open(f"{m}/sync_action").read().strip()
        if action == expect:
            started = True
            break
        if action not in ("idle", "none"):
            return action
        time.sleep(POLL_S)
    if not started:
        # It can have run to the end between two polls — a 200 MiB rig does
        # exactly that. md's own record is the discriminator.
        if md_attr(mddev, "last_sync_action") == expect:
            return None
        raise RuntimeError(f"md never started the {expect} on {mddev}")
    finish = time.time() + FINISH_TIMEOUT_S
    while time.time() < finish:
        action = open(f"{m}/sync_action").read().strip()
        if action in ("idle", "none"):
            return None
        if action != expect:
            return action
        time.sleep(POLL_S)
    raise RuntimeError(f"the {expect} on {mddev} did not finish in {FINISH_TIMEOUT_S}s")


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2 or not args[1].isdigit():
        sys.stderr.write("usage: parity-ref.py <mountpoint> <band>\n")
        return EXIT_INTERNAL
    mountpoint, band = args[0], int(args[1])
    report["band"] = band

    # --- phase 1/3: the fresh scrub
    errors = btrfs_scrub(mountpoint)
    report["phases"].append("scrub")
    if errors is not None:
        report["btrfs_errors"] = errors
        return refuse(f"refused: data corruption found; repair data first "
                      f"(selfheal.6) — the fresh btrfs scrub reported: {errors}",
                      "data-corruption-found")

    segs = dm_segments(find_btrfs_dev(mountpoint))
    if band < 1 or band > len(segs):
        return refuse(f"there is no band r{band} here ({len(segs)} band(s))", "array-busy")
    mddev = segs[band - 1]["dev"]
    report["array"] = mddev

    # --- the gates, immediately before the md write
    action = md_attr(mddev, "sync_action")
    if action not in ("idle", "none"):
        return refuse(f"{mddev} is running {action}", "array-busy")
    if md_attr_or_none(mddev, "degraded") not in (None, "0"):
        return refuse(f"{mddev} is degraded", "array-busy")
    if md_attr_or_none(mddev, "reshape_position") not in (None, "none"):
        return refuse(f"{mddev} is mid-reshape", "array-busy")
    if md_attr(mddev, "sync_max") != "max" or md_attr(mddev, "sync_min") != "0":
        return refuse(f"{mddev}'s sync window is still bounded", "array-busy")
    report["mismatch_before"] = int(md_attr(mddev, "mismatch_cnt"))

    # --- phase 2/3: the whole-band repair
    run(["mdadm", "--action=repair", mddev])
    report["phases"].append("repair")
    foreign = wait_for_op(mddev, "repair")
    if foreign:
        return refuse(f"md is running {foreign} on {mddev}; not touched", "foreign-sync-op")

    # --- phase 3/3: the verifying check
    run(["mdadm", "--action=check", mddev])
    report["phases"].append("check")
    foreign = wait_for_op(mddev, "check")
    if foreign:
        report["outcome"] = "still-mismatched"
        report["reason"] = f"md is running {foreign} on {mddev}; the check did not finish"
        report["reason_code"] = "foreign-sync-op"
        return emit(EXIT_STILL_MISMATCHED)

    time.sleep(SETTLE_S)   # mismatch_cnt finalises after sync_action goes idle
    after = int(md_attr(mddev, "mismatch_cnt"))
    report["mismatch_after"] = after
    if after != 0:
        report["outcome"] = "still-mismatched"
        report["reason"] = f"{mddev} still counts {after} mismatch(es) after the repair"
        return emit(EXIT_STILL_MISMATCHED)
    report["outcome"] = "rewritten"
    return emit(EXIT_REWRITTEN)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:          # noqa: BLE001 — the contract's exit 1
        report["outcome"] = "error"
        report["reason"] = f"{type(exc).__name__}: {exc}"
        sys.exit(emit(EXIT_INTERNAL))
