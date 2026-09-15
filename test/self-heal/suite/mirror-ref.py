#!/usr/bin/env python3
"""mirror-ref.py — the REFERENCE mirror reconcile (story selfheal.11), the
default `MIRROR_CMD` of the selfheal.2 suite.

    mirror-ref.py [--evidence <file>] [--passes N] <mountpoint> <band>

    exit 0 reconciled · 2 residual · 3 refused · 1 internal error
    MIRROR_REPORT=<path> writes a JSON sidecar.

COMPARE-LEGS ONLY, on purpose. The product's verb has two arms: arm A repeats
the ordinary btrfs scrub (which heals a mirror band through md when md's
read-balance serves the rotten leg — GT-22 UNEXPECTED(1)), and arm B compares
the legs directly. A reference that also ran arm A would make the suite's cases
prove the same thing twice and would hide arm B behind a coin flip: whether the
reference "passed" would depend on whether md happened to serve the rot. So
this implements the arm that is DETERMINISTIC, and accepts `--passes` only to
ignore it — one MIRROR_CMD string then runs against either implementation.

THE INVARIANT (RULED 2026-09-14): no code path here issues
`mdadm --action=repair`. On a mirror md's repair copies the first in-sync leg
over the other without looking at which one is right (GT-22(f), proven in both
directions on the rig), so the only verb this uses on md is `--action=check`,
and only to prove its own work.

What it does, per 4 KiB row of the band:
  · read the row off BOTH legs at each leg's OWN data offset (O_DIRECT);
  · if they agree, move on;
  · map the md byte BACK to a btrfs logical byte — md byte to LV byte through
    the dm segment, LV byte to logical through the covering chunk's own delta
    (the GT-2 hop, inverted; a DUP chunk's second copy answers too);
  · a row in NO chunk is free space: skipped, counted, never written;
  · a DATA row is arbitrated by the csum btrfs stored for that logical byte
    (crc32c per on-disk sector, GT-4); no stored csum (NOCOW, prealloc,
    nodatasum) is skipped and counted;
  · a METADATA or SYSTEM row is arbitrated by the containing 16 KiB node's own
    header checksum, exactly as btrfs checks it;
  · the leg that matches wins, and its bytes are written THROUGH md, which
    writes both legs;
  · neither leg matching is `unresolved`: nothing written, reported.

Then a whole-band `--action=check` must read `mismatch_cnt == 0`.
"""
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (BS, dm_segments, find_btrfs_dev, md_attr, md_geometry,
                    mdsys, read_direct, restore_sync_knobs, write_direct)
from crc32c import crc32c

NODE_BYTES = 16384
LEAF_HEADER = 101
WINDOW = 4 << 20

EXIT = {"reconciled": 0, "internal": 1, "residual": 2, "refused": 3}


def die(outcome: str, reason: str, code: str | None = None, **extra) -> int:
    report(outcome=outcome, reason=reason, reason_code=code, **extra)
    sys.stderr.write(f"{outcome}: {reason}\n")
    return EXIT[outcome]


_REPORT: dict = {}


def report(**fields) -> None:
    _REPORT.update(fields)
    path = os.environ.get("MIRROR_REPORT")
    if path:
        with open(path, "w") as fh:
            json.dump(_REPORT, fh, indent=1)


# ---------------------------------------------------------------- chunk tree

def all_chunks(srcdev: str) -> list[dict]:
    """Every CHUNK_ITEM, with EVERY stripe's device offset.

    The forward hop walks the chunk tree by key because it starts from a
    logical byte. This starts from a device offset, which nothing in the tree
    is keyed by, so the whole (small) tree is read once."""
    dump = subprocess.run(["btrfs", "inspect-internal", "dump-tree", "-t", "3", srcdev],
                          capture_output=True, text=True, check=True,
                          stdin=subprocess.DEVNULL).stdout
    out = []
    for item in dump.split("\n\titem "):
        if "CHUNK_ITEM" not in item:
            continue
        lo = int(re.search(r"CHUNK_ITEM (\d+)", item).group(1))
        m = re.search(r"length (\d+) owner \d+ stripe_len \d+ type (\S+)", item)
        if not m:
            continue
        stripes = [int(o) for o in re.findall(r"stripe \d+ devid \d+ offset (\d+)", item)]
        out.append({"logical": lo, "length": int(m.group(1)), "type": m.group(2),
                    "stripes": stripes})
    return out


def logical_for_lv(chunks: list[dict], lv_byte: int):
    """(logical, chunk) for an LV byte, or None when it is in no chunk."""
    for c in chunks:
        for off in c["stripes"]:
            if off <= lv_byte < off + c["length"]:
                return lv_byte - off + c["logical"], c
    return None


# ---------------------------------------------------------------- csum tree

def csum_items(srcdev: str) -> list[tuple[int, int, int, int]]:
    """(start, itemoff, itemsize, leaf) of every EXTENT_CSUM item.

    A whole dump is fine on a rig and impossible on a real pool — the product
    walks the tree by key instead. The harness rule only binds the injector."""
    dump = subprocess.run(["btrfs", "inspect-internal", "dump-tree", "-t", "7", srcdev],
                          capture_output=True, text=True, check=True,
                          stdin=subprocess.DEVNULL).stdout
    items, leaf = [], None
    for line in dump.splitlines():
        m = re.search(r"key \(EXTENT_CSUM EXTENT_CSUM \d+\) block (\d+) gen", line)
        if m:
            leaf = int(m.group(1))
            continue
        m = re.match(r"leaf (\d+) ", line.strip())
        if m:
            leaf = int(m.group(1))
            continue
        m = re.search(r"item \d+ key \(EXTENT_CSUM EXTENT_CSUM (\d+)\) "
                      r"itemoff (\d+) itemsize (\d+)", line)
        if m and leaf is not None:
            items.append((int(m.group(1)), int(m.group(2)), int(m.group(3)), leaf))
    return items


def stored_csum(srcdev, chunks, items, logical) -> int | None:
    """The stored crc32c for a logical byte, or None when btrfs stored none."""
    best = None
    for start, itemoff, itemsize, leaf in items:
        if start <= logical and (best is None or start > best[0]):
            best = (start, itemoff, itemsize, leaf)
    if best is None:
        return None
    start, itemoff, itemsize, leaf = best
    if logical >= start + (itemsize // 4) * BS:
        return None
    idx = (logical - start) // BS
    hit = logical_for_lv_of(chunks, leaf)
    if hit is None:
        return None
    leaf_dev = hit
    aligned = leaf_dev - leaf_dev % BS
    skew = leaf_dev - aligned
    raw = read_direct(srcdev, aligned, NODE_BYTES + BS)
    node = raw[skew:skew + NODE_BYTES]
    if not node_ok(node, leaf):
        return None
    off = skew + LEAF_HEADER + itemoff + idx * 4
    return int.from_bytes(raw[off:off + 4], "little")


def logical_for_lv_of(chunks: list[dict], logical: int):
    """The LV byte of a logical bytenr (copy 0) — the FORWARD hop, needed to
    read the csum leaf itself off the LV."""
    for c in chunks:
        if c["logical"] <= logical < c["logical"] + c["length"]:
            return logical - c["logical"] + c["stripes"][0]
    return None


def node_ok(node: bytes, bytenr: int) -> bool:
    """Does a tree node vouch for itself? The stored crc32c is the low four
    bytes of the 32-byte csum field, over bytes 32..nodesize, and `bytenr` at
    offset 48 has to be the block that was asked for (GT-4/D3)."""
    if len(node) < NODE_BYTES:
        return False
    stored = int.from_bytes(node[0:4], "little")
    if stored != crc32c(node[32:NODE_BYTES]):
        return False
    return int.from_bytes(node[48:56], "little") == bytenr


# ---------------------------------------------------------------- md

def whole_band_check(mddev: str, cap: int = 900) -> int | None:
    """A whole-band `--action=check`, and the count it leaves behind.

    NEVER `--action=repair` — see the module docstring."""
    m = mdsys(mddev)
    restore_sync_knobs(mddev)
    subprocess.run(["mdadm", "--action=check", mddev], check=True,
                   stdin=subprocess.DEVNULL, capture_output=True)
    for _ in range(cap):
        if open(f"{m}/sync_action").read().strip() == "idle":
            break
        time.sleep(0.5)
    else:
        return None
    time.sleep(1)                       # mismatch_cnt settles after sync_action
    return int(open(f"{m}/mismatch_cnt").read().strip())


def main() -> int:
    argv = sys.argv[1:]
    evidence = None
    passes = None
    rest = []
    i = 0
    while i < len(argv):
        if argv[i] == "--evidence" and i + 1 < len(argv):
            evidence = argv[i + 1]
            i += 2
            continue
        if argv[i] == "--passes" and i + 1 < len(argv):
            passes = argv[i + 1]          # accepted and IGNORED (see docstring)
            i += 2
            continue
        if argv[i].startswith("--"):
            i += 1                        # unknown flags are tolerated
            continue
        rest.append(argv[i])
        i += 1
    if len(rest) != 2:
        sys.stderr.write("usage: mirror-ref.py [--evidence <file>] [--passes N] "
                         "<mountpoint> <band>\n")
        return EXIT["internal"]
    mountpoint, band = rest[0], int(rest[1])
    del passes

    # --- the evidence gate -------------------------------------------------
    mismatch_before = None
    if evidence:
        try:
            mismatch_before = json.load(open(evidence)).get("mismatch_cnt")
        except Exception:
            mismatch_before = None
    if not isinstance(mismatch_before, int) or mismatch_before <= 0:
        return die("refused", "no completed scrub records a mismatch on this band "
                              "(pass --evidence <file> with a bounded check's count)",
                   "no-mirror-mismatch")
    report(pool="rig", band=band, mismatch_before=mismatch_before, arm="compare")

    srcdev = find_btrfs_dev(mountpoint)
    segs = dm_segments(srcdev)
    if band < 1 or band > len(segs):
        return die("refused", f"no band r{band}: the LV has {len(segs)} segment(s)",
                   "no-such-band")
    seg = segs[band - 1]
    mddev = seg["dev"]
    geo = md_geometry(mddev)
    report(array=mddev)
    if not geo["raid1"]:
        return die("refused", f"{mddev} is a {geo['level']} band, not a mirror",
                   "not-a-mirror-band")
    if md_attr(mddev, "degraded") != "0" or md_attr(mddev, "sync_action") != "idle":
        return die("refused", f"{mddev} is degraded or busy", "array-busy")

    members = []
    base = mdsys(mddev)
    for d in sorted(os.listdir(base)):
        if re.fullmatch(r"rd\d+", d):
            majmin = open(f"{base}/{d}/block/dev").read().strip()
            members.append((int(d[2:]),
                            f"/dev/{os.path.basename(os.path.realpath(f'/sys/dev/block/{majmin}'))}",
                            int(open(f"{base}/{d}/offset").read()) * 512))
    if len(members) != 2:
        return die("refused", f"{mddev} has {len(members)} legs, not two",
                   "not-a-mirror-band")

    # `rd<n>/size` is in KiB and is already net of the data offset (the engine's
    # `memberDataSectors` note: the RAID5 rig's 203776 is the 200 MiB member
    # minus its 1 MiB offset, and md's own sync_completed counts out of exactly
    # 407,552 sectors).
    span = int(open(f"{base}/rd{members[0][0]}/size").read()) * 1024
    span -= span % BS

    chunks = all_chunks(srcdev)
    items = csum_items(srcdev)

    rows_compared = rows_differing = free_rows = unchecked = unresolved = 0
    written = {"leg0": 0, "leg1": 0}
    notes = []
    node_verdict: dict[int, int | None] = {}

    for base_off in range(0, span, WINDOW):
        length = min(WINDOW, span - base_off)
        bufs = {role: read_direct(dev, doff + base_off, length)
                for role, dev, doff in members}
        for at in range(0, length, BS):
            rows_compared += 1
            a = bufs[members[0][0]][at:at + BS]
            b = bufs[members[1][0]][at:at + BS]
            if a == b:
                continue
            rows_differing += 1
            md_byte = base_off + at
            lv_byte = md_byte + seg["start"] - seg["ss"] * 512
            hit = logical_for_lv(chunks, lv_byte)
            if hit is None:
                free_rows += 1
                continue
            logical, chunk = hit
            rows = {members[0][0]: a, members[1][0]: b}
            if re.search(r"\b(METADATA|SYSTEM)\b", chunk["type"]):
                within = logical % NODE_BYTES
                node_lo = logical - within
                if node_lo in node_verdict:
                    winner = node_verdict[node_lo]
                else:
                    passing = []
                    for role, dev, doff in members:
                        node = read_direct(dev, doff + md_byte - within, NODE_BYTES)
                        if node_ok(node, node_lo):
                            passing.append(role)
                    winner = passing[0] if len(passing) == 1 else None
                    node_verdict[node_lo] = winner
                if winner is None:
                    unresolved += 1
                    notes.append(f"metadata node {node_lo}: no single leg vouches for it")
                    continue
            elif re.search(r"\bDATA\b", chunk["type"]):
                want = stored_csum(srcdev, chunks, items, logical)
                if want is None:
                    unchecked += 1
                    notes.append(f"logical {logical}: no stored checksum")
                    continue
                matched = [role for role, _d, _o in members if crc32c(rows[role]) == want]
                if len(matched) != 1:
                    unresolved += 1
                    notes.append(f"logical {logical}: {len(matched)} leg(s) match "
                                 f"the stored checksum {want:#010x}")
                    continue
                winner = matched[0]
            else:
                unchecked += 1
                notes.append(f"logical {logical}: chunk type {chunk['type']}")
                continue
            # THROUGH md: md writes both legs.
            write_direct(mddev, md_byte, rows[winner])
            written[f"leg{winner}"] += 1

    mismatch_after = whole_band_check(mddev)
    report(rows_compared=rows_compared, rows_differing=rows_differing,
           rows_written=written, free_space_rows=free_rows,
           unchecked_rows=unchecked, unresolved_rows=unresolved,
           mismatch_after=mismatch_after, notes=notes[:10])
    if unresolved > 0:
        return die("residual",
                   f"{unresolved} row(s) could not be arbitrated: neither leg "
                   f"satisfies the checksum btrfs stored for them", None)
    if mismatch_after is None or mismatch_after > 0:
        return die("residual",
                   f"the band still counts {mismatch_after} mismatch(es) after "
                   f"{written['leg0'] + written['leg1']} row(s) were written", None)
    report(outcome="reconciled", reason="", reason_code=None)
    print(json.dumps(_REPORT, indent=1))
    return EXIT["reconciled"]


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:            # noqa: BLE001 — the contract's exit 1
        import traceback
        traceback.print_exc()
        report(outcome="error", reason=str(exc))
        sys.exit(EXIT["internal"])
