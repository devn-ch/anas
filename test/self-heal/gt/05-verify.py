#!/usr/bin/env python3
"""05-verify.py <mddev> <stripe> <n> <chunk> — read the whole stripe through md
(after a member failure) and compare every 4 KiB block against the regenerated
f5 content at the mapped file offset. Chunks outside f5's extents are skipped
and reported."""
import json
import os
import subprocess
import sys

MD, STRIPE, N, CHUNK = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
LOC = json.load(open("/root/gtsh/state/locate_f5.json"))
START_SECTOR = LOC["start_sector"]
CLOG, CDEV = LOC["chunk_logical"], LOC["chunk_device"]
REG = open("/root/gtsh/keep/f5.regen", "rb").read()
BS = 4096

stripe_byte = STRIPE * (N - 1) * CHUNK          # md space start of this stripe
PLO = None
# f5 extent from the stage-02 filefrag dump: physical_offset col = btrfs LOGICAL
# bytenr blocks; file block = btrfs logical block - physical_start.
import re
for line in open("/root/gtsh/out/02-f5-filefrag.txt"):
    m = re.match(r"\s*\d+:\s*(\d+)\.\.\s*(\d+):\s*(\d+)\.\.\s*(\d+):\s*(\d+)", line)
    if m and PLO is None:
        PLO = int(m.group(3))
if PLO is None:
    raise SystemExit("no f5 extent in 02-f5-filefrag.txt")

fd = os.open(MD, os.O_RDONLY)
total_bad = 0
per_chunk = []
for d in range(N - 1):
    md_off = stripe_byte + d * CHUNK
    os.lseek(fd, md_off, 0)
    data = os.read(fd, CHUNK)
    # md byte -> LV device byte -> btrfs logical byte -> file block
    lv = md_off - START_SECTOR * 512
    logical = lv - CDEV + CLOG
    blk0 = logical // BS - PLO
    if blk0 < 0 or (blk0 + CHUNK // BS) * BS > len(REG):
        per_chunk.append(f"chunk {d} (md {md_off}): NOT f5 — skipped (logical {logical}, blk0 {blk0})")
        continue
    bad = 0
    for i in range(CHUNK // BS):
        fb = blk0 + i
        want = REG[fb * BS : (fb + 1) * BS]
        got = data[i * BS : (i + 1) * BS]
        if want != got:
            bad += 1
    per_chunk.append(f"chunk {d} (md {md_off}, file blocks {blk0}..{blk0+CHUNK//BS-1}): {bad} wrong of {CHUNK//BS}")
    total_bad += bad
print("\n".join(per_chunk))
print(f"TOTAL wrong 4K blocks in stripe: {total_bad}")
