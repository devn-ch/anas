#!/usr/bin/env python3
"""01-markers.py — write seeded marker files into /mnt/gtsh/@data, stash
SHA-256 + block-300 bytes under /root/gtsh/keep BEFORE any corruption.
Run on the node: python3 /root/gtsh/01-markers.py [f1 f2 f4 f5]  (default all).
f3 is written later by 07-coldread.sh on a compress=zstd remount."""
import hashlib
import os
import random
import sys

WORK = "/mnt/gtsh/@data"
KEEP = "/root/gtsh/keep"
BS = 4096
SIG = {n: f"ANASGT-{n.upper()}-MARKER-0123456789abcdef".encode() for n in ("f1", "f2", "f3", "f4", "f5")}
# UNEXPECTED(brief): the literal "ANASGT-F1-MARKER-0123456789abcdef" is 33 chars,
# not 32 as the brief states; we use the literal verbatim (oracle scans it).
assert all(len(s) == 33 for s in SIG.values()), {n: len(s) for n, s in SIG.items()}


def body(name: str) -> bytes:
    if name == "f4":
        buf = bytearray(4 * 1024 * 1024)
    elif name == "f3":  # stage 07: highly compressible text
        buf = bytearray((b"anas selfheal gt\n" * (4 * 1024 * 1024 // 17 + 1))[: 4 * 1024 * 1024])
    else:
        seed = int(name[1])
        size = 8 * 1024 * 1024 if name == "f5" else 4 * 1024 * 1024
        buf = bytearray(random.Random(seed).randbytes(size))
    buf[300 * BS : 300 * BS + len(SIG[name])] = SIG[name]
    return bytes(buf)


def main() -> None:
    os.makedirs(KEEP, exist_ok=True)
    names = sys.argv[1:] or ["f1", "f2", "f4", "f5"]
    for name in names:
        data = body(name)
        path = os.path.join(WORK, f"{name}.bin")
        with open(path, "wb") as fh:
            fh.write(data)
        os.sync()
        digest = hashlib.sha256(data).hexdigest()
        with open(os.path.join(KEEP, f"{name}.sha256"), "w") as fh:
            fh.write(digest + "\n")
        with open(os.path.join(KEEP, f"{name}.blk300"), "wb") as fh:
            fh.write(data[300 * BS : 301 * BS])
        # seeded regeneration copy for stage 05/06 comparisons
        with open(os.path.join(KEEP, f"{name}.regen"), "wb") as fh:
            fh.write(data)
        blk = data[300 * BS : 300 * BS + len(SIG[name])]
        ok = blk == SIG[name]
        print(f"{name}.bin sha256={digest} blk300_sig={'ok' if ok else 'MISMATCH'}")


if __name__ == "__main__":
    main()
