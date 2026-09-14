#!/usr/bin/env python3
"""09-gt18-xor.py <row_moff> <n> <parity_disk> — GT-18 (d)/(e) final check:
read the 4 KiB stripe row from every member and test whether the parity
member's row equals the XOR of the data members' rows (left-symmetric RAID5
row identity). Reads the /root/gtsh/m? files directly, behind md."""
import hashlib
import sys

sys.path.insert(0, '/root/gtsh/suite')
from common import read_direct  # noqa: E402

moff, n, pd = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
rows = [read_direct(f"/root/gtsh/m{i}", moff, 4096) for i in range(n)]
xor = bytearray(4096)
for i in range(n):
    if i == pd:
        continue
    r = rows[i]
    for j in range(4096):
        xor[j] ^= r[j]
for i in range(n):
    tag = "PARITY" if i == pd else "data"
    print(f"  m{i} [{tag}]: sha256[:16]={hashlib.sha256(rows[i]).hexdigest()[:16]}")
print(f"  parity row == XOR(data rows): {bytes(xor) == rows[pd]}")
