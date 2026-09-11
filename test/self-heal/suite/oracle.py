#!/usr/bin/env python3
"""oracle.py — the injector oracle for the selfheal.2 suite.

BINDING HARNESS RULE (story selfheal.2): the injector locates bytes to corrupt
ONLY by a raw signature scan of the member files (or, for above-md rot, of the
md device itself) — it shares NO code with the mapping helper (common.py's
predict/locate_block) and never computes a member offset from a file block.
On a zeros file the scan also hits the parity slot; disambiguation is by a
one-byte member flip + COLD btrfs read through a fresh snapshot (EIO => data
slot), then restoring the byte — never by the formula.

Device discovery (which members back this mountpoint) is topology, not layout
math, and is the only function imported from common.
"""
import os

from common import BS, drop_caches, make_snap, read_direct, remove_snap, write_direct

ORACLE_SNAP = ".anas-oracle-snap"
WIN = 1 << 20


def scan_device(dev: str, sig: bytes, size: int | None = None) -> list[int]:
    """Raw windowed scan of `dev` for `sig`; returns byte offsets. Overlapping
    windows so boundary hits are never lost. Shares no code with the mapper."""
    if size is None:
        size = os.lseek(os.open(dev, os.O_RDONLY), 0, os.SEEK_END)
    hits = []
    off = 0
    prev_tail = b""
    with open(dev, "rb") as fh:
        while off < size:
            buf = prev_tail + fh.read(WIN)
            idx = 0
            while True:
                j = buf.find(sig, idx)
                if j < 0:
                    break
                hits.append(off - len(prev_tail) + j)
                idx = j + 1
            prev_tail = buf[-(len(sig) - 1):]
            off += WIN
    return hits


def scan_members(member_devs: list[str], sig: bytes) -> list[tuple[str, int]]:
    """Scan every member; return [(dev, offset)]."""
    hits = []
    for dev in member_devs:
        for off in scan_device(dev, sig):
            hits.append((dev, off))
    return hits


def flip_byte(dev: str, off: int) -> bytes:
    """Flip one byte at `off` (sector-aligned 512 window), return the original
    512-byte sector for restore."""
    soff = off - off % 512
    sector = bytearray(read_direct(dev, soff, 512))
    orig = bytes(sector)
    sector[off - soff] ^= 0xFF
    write_direct(dev, soff, bytes(sector))
    return orig


def restore_byte(dev: str, off: int, sector: bytes) -> None:
    write_direct(dev, off - off % 512, sector)


def read_file_cold(mountpoint: str, path: str) -> bool:
    """COLD read of the whole `path` through a fresh ro snapshot; True if any
    block EIOs (checksum error surfaced). Snapshot is always removed."""
    snap = make_snap(mountpoint, ORACLE_SNAP)
    try:
        rel = os.path.relpath(path, mountpoint)
        drop_caches()
        from common import snapshot_read
        r = snapshot_read(os.path.join(snap, rel))
        return len(r["eio"]) > 0
    finally:
        remove_snap(mountpoint, ORACLE_SNAP)


def disambiguate_data_slot(hits: list[tuple[str, int]], mountpoint: str,
                           path: str) -> tuple[str, int]:
    """For each scan hit: flip one byte on the member, cold btrfs read via a
    fresh snapshot, restore. EIO => that hit is the data slot."""
    if len(hits) == 1:
        # A lone hit can still be a parity slot in principle; prove it.
        pass
    data_slots = []
    for dev, off in hits:
        orig = flip_byte(dev, off)
        try:
            if read_file_cold(mountpoint, path):
                data_slots.append((dev, off))
        finally:
            restore_byte(dev, off, orig)
    if len(data_slots) != 1:
        raise RuntimeError(f"oracle: expected exactly 1 data slot among {hits}, "
                           f"got {data_slots}")
    return data_slots[0]


def corrupt_block(dev: str, off: int, junk: bytes | None = None) -> bytes:
    """Overwrite the 4 KiB block containing `off` with junk (scan-located)."""
    boff = off - off % BS
    if junk is None:
        junk = os.urandom(BS)
    write_direct(dev, boff, junk)
    return junk
