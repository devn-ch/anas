#!/usr/bin/env python3
"""crc32c.py — Castagnoli CRC-32C (btrfs checksum) implemented from the spec:
poly 0x82F63B78 (reflected), init 0xFFFFFFFF, final xor 0xFFFFFFFF, no sharing
with any other drill code path. Both byte orders exposed for the GT-4 check
(btrfs stores the csum little-endian on disk)."""

_POLY = 0x82F63B78
_TAB = []
for _i in range(256):
    _c = _i
    for _ in range(8):
        _c = (_c >> 1) ^ (_POLY if _c & 1 else 0)
    _TAB.append(_c)


def crc32c(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc = (crc >> 8) ^ _TAB[(crc ^ b) & 0xFF]
    return crc ^ 0xFFFFFFFF


if __name__ == "__main__":
    import sys
    for path in sys.argv[1:]:
        d = open(path, "rb").read()
        v = crc32c(d[:4096])
        print(f"{path}: crc32c(first4K)=0x{v:08x} le={v.to_bytes(4,'little').hex()} "
              f"be={v.to_bytes(4,'big').hex()}")
