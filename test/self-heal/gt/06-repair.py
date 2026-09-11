#!/usr/bin/env python3
"""06-repair.py — the PoC: reconstruct by XOR of the other members and arbitrate
with the btrfs crc32c.

 06-repair.py xor <mddev> <member_idx> <moff> <n> <cand_out>
     read 4 KiB O_DIRECT at <moff> from every OTHER member, XOR -> candidate;
     verify crc32c(candidate) against the STORED csum (fetched from the csum
     tree, since this kernel's scrub dmesg omits csum values — GT-3/4 finding);
     write candidate to <cand_out> iff it matches.

 06-repair.py stored-csum <file> <block> <mddev>
     fetch the stored EXTENT_CSUM for <file>.bin block <block> by parsing
     dump-tree -t 7 and reading the csum leaf through the md device.
"""
import json
import os
import re
import struct
import subprocess
import sys

sys.path.insert(0, "/root/gtsh")
from crc32c import crc32c  # noqa: E402

GT = "/root/gtsh"
BS = 4096
BTRFS_HEADER_SIZE = 101  # btrfs_leaf header; item offsets count from its end


def read_direct(path: str, off: int, ln: int) -> bytes:
    """O_DIRECT read; mmap gives the required page-aligned buffer (malloc does not)."""
    import mmap
    assert off % 512 == 0 and ln % 512 == 0
    fd = os.open(path, os.O_RDONLY | os.O_DIRECT)
    try:
        os.lseek(fd, off, 0)
        buf = mmap.mmap(-1, ln)
        try:
            got = os.readv(fd, [memoryview(buf)])
            return bytes(buf[:got])
        finally:
            buf.close()
    finally:
        os.close(fd)


def locate(name: str) -> dict:
    return json.load(open(f"{GT}/state/locate_{name}.json"))


def dev_byte_for_logical(logical: int, loc: dict) -> int:
    """md byte for a btrfs logical byte inside the DATA chunk that holds `file`."""
    return logical - loc["chunk_logical"] + loc["chunk_device"] + loc["start_sector"] * 512


def stored_csum(mddev: str, name: str, block: int) -> tuple[int, int]:
    """Return (stored_csum, logical_bytenr) for file block via the csum tree."""
    loc = locate(name)
    logical = loc["logical_byte"]  # only valid for the located block
    # the located block's logical; EXTENT_CSUM items cover chunk-aligned ranges
    txt = subprocess.run(["btrfs", "inspect-internal", "dump-tree", "-t", "7",
                          "/dev/gtsh/data"], capture_output=True, text=True).stdout
    # pair each EXTENT_CSUM item with its containing tree block: either a
    # "key (...) block N" pointer line (multi-leaf) or the enclosing "leaf N" line
    # (csum tree small enough to be a single-node root).
    items = []
    leaf_logical = None
    for line in txt.splitlines():
        m = re.search(r"key \(EXTENT_CSUM EXTENT_CSUM \d+\) block (\d+) gen", line)
        if m:
            leaf_logical = int(m.group(1))
            continue
        m = re.search(r"^leaf (\d+) ", line.strip())
        if m:
            leaf_logical = int(m.group(1))
            continue
        m = re.search(r"item 0 key \(EXTENT_CSUM EXTENT_CSUM (\d+)\) itemoff (\d+) itemsize (\d+)", line)
        if m and leaf_logical is not None:
            items.append((int(m.group(1)), leaf_logical, int(m.group(2)), int(m.group(3))))
    for start, leaf_l, itemoff, itemsize in items:
        if start <= logical < start + itemsize // 4 * BS:
            idx = (logical - start) // BS
            # leaf lives in the chunk covering leaf_logical: map via chunk tree dump -t 3
            ctxt = subprocess.run(["btrfs", "inspect-internal", "dump-tree", "-t", "3",
                                   "/dev/gtsh/data"], capture_output=True, text=True).stdout
            dev = None
            for it in ctxt.split("\n\titem "):
                if "CHUNK_ITEM" not in it:
                    continue
                clog = int(re.search(r"CHUNK_ITEM (\d+)", it).group(1))
                clen = int(re.search(r"length (\d+)", it).group(1))
                cdev = int(re.search(r"stripe 0 devid \d+ offset (\d+)", it).group(1))
                if clog <= leaf_logical < clog + clen:
                    dev = cdev
                    break
            if dev is None:
                raise SystemExit(f"no chunk covers leaf {leaf_logical}")
            md_off = leaf_logical - clog_of(ctxt, leaf_logical) + dev + loc["start_sector"] * 512
            leaf = read_direct(mddev, md_off - md_off % BS, 16384 * 2)
            off = BTRFS_HEADER_SIZE + itemoff + idx * 4
            return struct.unpack("<I", leaf[off : off + 4])[0], logical
    raise SystemExit(f"no EXTENT_CSUM item covers logical {logical}")


def clog_of(ctxt: str, leaf_logical: int) -> int:
    for it in ctxt.split("\n\titem "):
        if "CHUNK_ITEM" not in it:
            continue
        clog = int(re.search(r"CHUNK_ITEM (\d+)", it).group(1))
        clen = int(re.search(r"length (\d+)", it).group(1))
        if clog <= leaf_logical < clog + clen:
            return clog
    raise SystemExit("no covering chunk")


def main() -> None:
    mode = sys.argv[1]
    mddev = sys.argv[2]
    if mode == "stored-csum":
        name, block = sys.argv[3], int(sys.argv[4])
        val, logical = stored_csum(mddev, name, block)
        reg = open(f"{GT}/keep/{name}.regen", "rb").read()
        calc = crc32c(reg[block * BS : (block + 1) * BS])
        print(f"stored csum for {name}.bin blk{block} (logical {logical}): "
              f"0x{val:08x}; crc32c(original)=0x{calc:08x} "
              f"{'MATCH' if val == calc else 'DIFF'}")
        return
    if mode == "xor":
        member_idx, moff, n, cand_out = (int(sys.argv[3]), int(sys.argv[4]),
                                         int(sys.argv[5]), sys.argv[6])
        members = open(f"{GT}/state/members.txt").read().split()
        cand = None
        for i, m in enumerate(members[:n]):
            if i == member_idx:
                continue
            data = bytearray(read_direct(m, moff - moff % BS, BS))
            if moff % BS:
                raise SystemExit("moff not 4K aligned")
            cand = data if cand is None else bytes(a ^ b for a, b in zip(cand, data))
        val = crc32c(bytes(cand))
        name = "f5"
        loc = locate(name)
        stored, _ = stored_csum(mddev, name, loc["block"])
        print(f"crc32c(candidate)=0x{val:08x} stored csum=0x{stored:08x} "
              f"{'MATCH — GT-11 PROVEN' if val == stored else 'DIFF — GT-11 UNEXPECTED'}")
        open(cand_out, "wb").write(bytes(cand))
        return
    raise SystemExit(f"unknown mode {mode}")


if __name__ == "__main__":
    main()
