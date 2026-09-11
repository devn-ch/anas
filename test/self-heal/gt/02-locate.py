#!/usr/bin/env python3
"""02-locate.py — the GT-2 mapping chain + independent oracle.
Reads stage-02 raw outputs under /root/gtsh/out/, writes the chain + scan
comparison to stdout and per-file mapping JSON to /root/gtsh/state/.
shares NO code with anything else: the oracle is a raw windowed byte scan."""
import json
import os
import re
import subprocess
import sys

GT = "/root/gtsh"
OUT = f"{GT}/out"
STATE = f"{GT}/state"
WORKDIR = open(f"{GT}/state/workdir.txt").read().strip()
BS = 4096
SIG = lambda n: f"ANASGT-{n.upper()}-MARKER-0123456789abcdef".encode()


def parse_filefrag(path: str, block: int, want: str) -> tuple[int, int, int]:
    """Return (logical_start, length_blocks, physical_start_blocks) of the extent
    containing logical `block` for file `want`, from a multi-file filefrag -v dump."""
    extents: list[tuple[int, int, int]] = []
    current = None
    for line in open(path):
        m = re.match(r"File size of (\S+) is", line)
        if m:
            current = m.group(1)
            continue
        if current != want:
            continue
        m = re.match(r"\s*\d+:\s*(\d+)\.\.\s*(\d+):\s*(\d+)\.\.\s*(\d+):\s*(\d+)", line)
        if m:
            extents.append(tuple(int(x) for x in m.groups()))
    if not extents:
        raise SystemExit(f"no filefrag extents parsed for {want} from {path}")
    for lo, hi, plo, _phi, _ln in extents:
        if lo <= block <= hi:
            return lo, hi - lo + 1, plo
    raise SystemExit(f"logical block {block} not in any filefrag extent of {want}")


def parse_dmtable(path: str) -> int:
    """Return LV start_sector (512-byte units) from dmsetup table."""
    for line in open(path):
        parts = line.split()
        if len(parts) >= 5 and parts[2] == "linear":
            return int(parts[4])
    raise SystemExit(f"no linear target in {path}")


def chunk_data_map(path: str, logical_byte: int) -> tuple[int, int, int]:
    """UNEXPECTED(brief) hop: return (logical_start, device_offset, length) of the
    DATA chunk COVERING logical_byte. There can be several DATA chunks; the delta
    differs per chunk. device_byte = logical_byte - logical_start + device_offset."""
    txt = open(path).read()
    for item in txt.split("\n\titem "):
        if "CHUNK_ITEM" not in item or not re.search(r"type .*\bDATA\b", item):
            continue
        logical = int(re.search(r"CHUNK_ITEM (\d+)", item).group(1))
        length = int(re.search(r"length (\d+)", item).group(1))
        dev = int(re.search(r"stripe 0 devid \d+ offset (\d+)", item).group(1))
        if logical <= logical_byte < logical + length:
            return logical, dev, length
    raise SystemExit(f"no DATA chunk covers logical_byte {logical_byte} in {path}")


def md_geometry(base: str) -> tuple[int, int, str, int, int]:
    """Return (chunk, n, layout, data_offset_bytes, stripe_cache_pages... no—) ->
    (chunk, n, layout, data_offset_bytes, sync_max_default?) — only first four used."""
    lines = [l.strip() for l in open(f"{base}-mdsys.txt") if l.strip()]
    level, chunk, layout, n = lines[0], int(lines[1]), int(lines[2]), int(lines[3])
    # sysfs layout is numeric: 0 left-asymmetric, 1 right-asymmetric, 2 left-symmetric, 3 right-symmetric
    layout = {0: "left-asymmetric", 2: "left-symmetric"}.get(layout, f"raw{layout}")
    assert level in ("raid5", "raid6"), level
    # data offset from mdadm --examine of member 0 (same for all, metadata 1.2)
    txt = open(f"{base}-examine.txt").read()
    m = re.search(r"Data Offset\s*:\s*(\d+) sectors", txt)
    if not m:
        raise SystemExit(f"no Data Offset in examine output:\n{txt[:800]}")
    return chunk, n, layout, int(m.group(1)) * 512


def predict(md_byte: int, chunk: int, n: int, layout: str, data_offset: int, raid6: bool):
    """Return [(disk_index, member_offset), ...] candidates for each layout."""
    chunk_index = md_byte // chunk
    in_chunk = md_byte % chunk
    stripe = chunk_index // (n - (2 if raid6 else 1))
    d = chunk_index % (n - (2 if raid6 else 1))
    parity_disk = (n - 1) - (stripe % n)
    res = {}
    if not raid6:
        if layout == "left-symmetric":
            disk = (parity_disk + 1 + d) % n
        elif layout == "left-asymmetric":
            # data disks = all disks in order skipping parity_disk
            disk = d if d < parity_disk else d + 1
        else:
            raise SystemExit(f"unhandled layout {layout}")
        res[layout] = (disk, data_offset + stripe * chunk + in_chunk)
        res["_parity_disk"] = parity_disk
    else:
        # left-symmetric RAID6: P at parity_disk, Q at (parity_disk+1)%n, data follows Q
        q_disk = (parity_disk + 1) % n
        res["left-symmetric"] = ((q_disk + 1 + d) % n, data_offset + stripe * chunk + in_chunk)
        res["_parity_disk"] = parity_disk
        res["_q_disk"] = q_disk
    res["_stripe"] = stripe
    res["_chunk_index"] = chunk_index
    res["_in_chunk"] = in_chunk
    return res


def oracle_scan(sig: bytes) -> list[tuple[str, int]]:
    """Independent: scan each /root/gtsh/m* raw file for the 32-byte signature
    in 1 MiB windows with full overlap. Shares no code with predict()."""
    hits = []
    for i in range(7):
        path = f"{GT}/m{i}"
        if not os.path.exists(path):
            continue
        size = os.path.getsize(path)
        WIN = 1 << 20
        off = 0
        prev_tail = b""
        with open(path, "rb") as fh:
            while off < size:
                buf = prev_tail + fh.read(WIN)
                idx = 0
                while True:
                    j = buf.find(sig, idx)
                    if j < 0:
                        break
                    hits.append((f"m{i}", off - len(prev_tail) + j))
                    idx = j + 1
                prev_tail = buf[-(len(sig) - 1):]
                off += WIN
    return hits


def main() -> None:
    targets = sys.argv[1:] or ["f1", "f4", "f5"]
    base = os.environ.get("GT2_IN", f"{OUT}/02-{targets[0]}")
    for name in targets:
        block = int(os.environ.get(f"BLK_{name}", "300"))
        if name == "f5" and "BLK_f5" not in os.environ:
            pass  # f5 is located at block 300 too (its signature block); blk0 chain recorded separately
        ff = f"{base}-filefrag.txt"
        lo, ln, plo = parse_filefrag(ff, block, os.path.join(WORKDIR, f"{name}.bin"))
        # filefrag "physical" = btrfs LOGICAL bytenr (UNEXPECTED(brief)); map through
        # the DATA chunk to the device (LV) offset.
        logical_byte = plo * BS + (block - lo) * BS
        clog, cdev, _clen = chunk_data_map(f"{base}-chunktree.txt", logical_byte)
        lv_byte = logical_byte - clog + cdev
        start_sector = parse_dmtable(f"{base}-dmtable.txt")
        md_byte = lv_byte + start_sector * 512
        chunk, n, layout, data_offset = md_geometry(base)
        raid6 = subprocess.run(["cat", f"{STATE}/ndisks.txt"], capture_output=True).returncode == 0
        ndisks = int(open(f"{STATE}/ndisks.txt").read().strip())
        is6 = ndisks == 7
        p = predict(md_byte, chunk, n, layout, data_offset, is6)

        print(f"=== {name}.bin logical block {block} ===")
        print(f"filefrag: extent logical {lo}..{lo+ln-1} physical_start {plo} (4K blocks) = LOGICAL bytenr")
        print(f"btrfs chunk map: DATA logical {clog}+{_clen} -> device {cdev} (delta {cdev-clog})")
        print(f"LV byte   = logical_byte {logical_byte} - chunk_logical + chunk_device = {lv_byte}")
        print(f"dm start_sector = {start_sector} -> md byte = LV byte + start_sector*512 = {md_byte}")
        print(f"md: chunk={chunk} n={ndisks} layout={layout} data_offset={data_offset} "
              f"chunk_index={p['_chunk_index']} stripe={p['_stripe']} in_chunk={p['_in_chunk']}")
        for key in ("left-symmetric", "left-asymmetric"):
            if key in p:
                disk, moff = p[key]
                print(f"predict[{key}] = (m{disk}, {moff})")
        if is6:
            print(f"RAID6 formula: P=m{p['_parity_disk']} Q=m{p['_q_disk']} data follows Q")
        else:
            print(f"RAID5 formula: parity_disk=m{p['_parity_disk']}")
        hits = oracle_scan(SIG(name))
        print(f"oracle scan hits for {name} signature: {hits}")
        disk, moff = (p["left-symmetric"] if "left-symmetric" in p else p["left-asymmetric"]) if not is6 else p["left-symmetric"]
        matched = [k for k in ("left-symmetric", "left-asymmetric")
                   if k in p and (f"m{p[k][0]}", p[k][1]) in hits]
        status = "MATCH:" + ",".join(matched) if matched else "UNEXPECTED"
        print(f"GT-2 {name}: prediction==scan ? {status}")
        if len(hits) != 1:
            print(f"NOTE: {len(hits)} scan hits (expected 1)")
        # stash mapping for later stages
        j = {"file": name, "block": block, "logical_byte": logical_byte,
             "chunk_logical": clog, "chunk_device": cdev,
             "lv_byte": lv_byte, "start_sector": start_sector,
             "md_byte": md_byte, "chunk": chunk, "n": ndisks, "layout": layout,
             "data_offset": data_offset, "stripe": p["_stripe"],
             "chunk_index": p["_chunk_index"], "in_chunk": p["_in_chunk"],
             "parity_disk": p["_parity_disk"], "matched": matched or [],
             "scan_hits": hits, "status": status}
        if is6:
            j["q_disk"] = p["_q_disk"]
        json.dump(j, open(f"{STATE}/locate_{name}.json", "w"), indent=1)

    # f5 block 0 chain (context for stage 05/06 full-stripe reads; no signature at blk0)
    if "f5" in targets:
        lo, ln, plo = parse_filefrag(f"{base}-filefrag.txt", 0, os.path.join(WORKDIR, "f5.bin"))
        logical_byte = plo * BS
        clog, cdev, _clen = chunk_data_map(f"{base}-chunktree.txt", logical_byte)
        lv_byte = plo * BS - clog + cdev
        start_sector = parse_dmtable(f"{base}-dmtable.txt")
        j = json.load(open(f"{STATE}/locate_f5.json"))
        chunk, n, layout, data_offset = j["chunk"], j["n"], j["layout"], j["data_offset"]
        p = predict(lv_byte + start_sector * 512, chunk, n, layout, data_offset, n == 7)
        disk, moff = p["left-symmetric"]
        print(f"=== f5.bin logical block 0 (chain only, no signature to scan) ===")
        print(f"LV byte={lv_byte} md_byte={lv_byte + start_sector*512} "
              f"stripe={p['_stripe']} predict[left-symmetric]=(m{disk}, {moff})")


if __name__ == "__main__":
    main()
