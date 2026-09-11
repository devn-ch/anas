#!/usr/bin/env python3
"""03-crc-check.py <file> <dmesg-txt> — GT-4: compare crc32c(keep/<file>.blk300
first 4K) with the `expected csum 0x...` found in the scrub dmesg line.
Tries both byte orders; btrfs stores crc32c little-endian on disk."""
import re
import sys
sys.path.insert(0, "/root/gtsh")
from crc32c import crc32c  # noqa: E402

name, dmesg_path = sys.argv[1], sys.argv[2]
blk = open(f"/root/gtsh/keep/{name}.blk300", "rb").read()[:4096]
val = crc32c(blk)
le = val.to_bytes(4, "little").hex()
be = val.to_bytes(4, "big").hex()
print(f"computed crc32c of {name}.blk300: value=0x{val:08x} le={le} be={be}")

txt = open(dmesg_path).read()
expected = re.findall(r"expected csum 0x([0-9a-fA-F]+)", txt)
found = re.findall(r"csum 0x([0-9a-fA-F]+)", txt)
print(f"dmesg csum fields: found={sorted(set(found))} expected={sorted(set(expected))}")
match = None
for e in set(expected):
    e = e.lower().lstrip("0x")
    if e == le:
        match = "little-endian"
    elif e == be:
        match = "big-endian"
    elif len(e) >= 8 and e[:8] == le[:8]:
        match = f"le (as written, first8)"
print(f"GT-4: {'MATCH (' + match + ')' if match else 'UNEXPECTED: no byte-order match'}")
