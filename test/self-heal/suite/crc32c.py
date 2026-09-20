#!/usr/bin/env python3
"""crc32c.py — Castagnoli CRC-32C (btrfs checksum) implemented from the spec:
poly 0x82F63B78 (reflected), init 0xFFFFFFFF, final xor 0xFFFFFFFF.
Suite-local copy of test/self-heal/gt/crc32c.py so repair-ref.py (the pluggable
REPAIR_CMD) is self-contained; both derive from the spec, not from each other.
The injector oracle does NOT use this module (it is a raw byte scan)."""

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
