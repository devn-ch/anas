#!/usr/bin/env python3
"""07-f3locate.py — locate f3's extent on the members using the stage-02 chain.
Reuses 02-locate.py's parsing (single source) — no duplicated mapping code.
Prints member+offset of the FIRST 4 KiB of f3's first extent, or 'COMPRESSED-NOSIG'
if the raw-member scan cannot find f3's signature (it is compressed on disk)."""
import importlib.util
import os
import sys

GT = "/root/gtsh"
spec = importlib.util.spec_from_file_location("loc02", f"{GT}/02-locate.py")
loc02 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loc02)

name = "f3"
ff = f"{GT}/out/07-f3-filefrag.txt"
lo, ln, plo = loc02.parse_filefrag(ff, 0, os.path.join(loc02.WORKDIR, "f3.bin"))
logical_byte = plo * 4096
clog, cdev, _ = loc02.chunk_data_map(f"{GT}/out/07-f3-chunktree.txt", logical_byte)
lv_byte = logical_byte - clog + cdev
md_byte = lv_byte + loc02.parse_dmtable(f"{GT}/out/07-f3-dmtable.txt") * 512
ndisks = int(open(f"{GT}/state/ndisks.txt").read())
chunk, n, layout, data_offset = loc02.md_geometry(f"{GT}/out/07-f3")
is6 = ndisks == 7
p = loc02.predict(md_byte, chunk, n, layout, data_offset, is6)
disk, moff = p["left-symmetric"]
print(f"f3 extent: filefrag logical {lo}..{lo+ln-1} physical_start {plo} (4K blocks)")
print(f"chain: logical {logical_byte} -> LV {lv_byte} -> md {md_byte} -> (m{disk}, {moff})")
sig = loc02.SIG(name)
hits = loc02.oracle_scan(sig)
print(f"signature scan on members: {hits if hits else 'COMPRESSED-NOSIG'}")
print(f"FIRST4K m{disk} {moff}")
