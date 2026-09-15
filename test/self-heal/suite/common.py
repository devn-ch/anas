#!/usr/bin/env python3
"""common.py — node-side helpers for the selfheal.2 loop-device suite.

Two consumers with different trust levels:
  - repair-ref.py (the REPAIR_CMD under test) imports the mapping helpers here.
  - cases.py (verification + the negative-control drivers) uses everything.
The injector oracle (oracle.py) imports ONLY the device discovery below and the
raw scan it defines itself — never the layout math (binding harness rule).

Safety: only loop devices from /root/gtsh/m? are ever touched (teardown_all).
"""
import json
import mmap
import os
import re
import shutil
import subprocess
import sys

BS = 4096
GT = "/root/gtsh"
SUITE_OUT = f"{GT}/suite-out"
KEEP = f"{SUITE_OUT}/keep"
LOGS = f"{SUITE_OUT}/logs"
LIB = f"{GT}/lib.sh"

MDSYS_LAYOUT = {0: "left-asymmetric", 1: "right-asymmetric",
                2: "left-symmetric", 3: "right-symmetric"}


def run(cmd, check=True, input=None):
    # stdin=/dev/null: mdadm --create asks a bitmap y/N prompt when it thinks
    # it should; over an ssh exec channel that read blocks forever.
    r = subprocess.run(cmd, capture_output=True, text=True, input=input,
                       stdin=subprocess.DEVNULL)
    if check and r.returncode != 0:
        raise RuntimeError(f"cmd {' '.join(cmd)} rc={r.returncode}: "
                           f"{r.stdout[-400:]} {r.stderr[-400:]}")
    return r


def sh(script):
    """Run a bash snippet with the gt lib sourced (teardown_all, drop_caches...)."""
    return run(["bash", "-c", f"source {LIB}; {script}"])


def drop_caches():
    run(["sync"])
    with open("/proc/sys/vm/drop_caches", "w") as fh:
        fh.write("3\n")


# ---------------------------------------------------------------- devices

def components(mddev: str) -> list[str]:
    """Member /dev nodes of an md array, from sysfs (rd<i>/block/dev)."""
    base = mdsys(mddev)
    out = []
    for d in sorted(os.listdir(base)):
        if not re.fullmatch(r"rd\d+", d):
            continue
        majmin = open(f"{base}/{d}/block/dev").read().strip()
        out.append(f"/dev/{os.path.basename(os.path.realpath(f'/sys/dev/block/{majmin}'))}")
    return out


def mdsys(mddev: str) -> str:
    return f"/sys/block/{os.path.basename(os.path.realpath(mddev))}/md"


def md_attr(mddev: str, key: str) -> str:
    return open(f"{mdsys(mddev)}/{key}").read().strip()


def md_attr_or_none(mddev: str, key: str) -> str | None:
    """Read an md sysfs attribute, or None when the array has no such knob
    (GT-16: a RAID1 array has no rmw_level / stripe_cache_size at all — absent
    means absent, never an error)."""
    p = f"{mdsys(mddev)}/{key}"
    if not os.path.exists(p):
        return None
    return open(p).read().strip()


def _md_read(mddev: str, rel: str) -> str:
    """Read an md sysfs attribute, naming what actually exists when it is
    gone: a mid-case FileNotFoundError used to be a bare mystery, so the
    error now carries the array's own sysfs listing and mdstat line."""
    p = f"{mdsys(mddev)}/{rel}"
    try:
        return open(p).read().strip()
    except FileNotFoundError:
        import glob
        m = mdsys(mddev)
        have = sorted(os.path.basename(x) for x in glob.glob(f"{m}/*"))
        mdstat = [l for l in open("/proc/mdstat").read().splitlines()
                  if os.path.basename(mddev) in l or "blocks" in l]
        raise FileNotFoundError(f"{p} is gone: /sys/block md attrs={have} "
                                f"mdstat={mdstat}") from None


def _first_rd(mddev: str) -> str:
    """The first EXISTING rdN dir name. The kernel REMOVES a member's rdN
    from sysfs the moment it is marked faulty — proven live: after
    `mdadm --fail` of member 0, /proc/mdstat still shows `loop0[0](F)` while
    /sys/block/mdX/md/rd0 is already gone ([6/5] [_UUUUU]). Member geometry
    must therefore never be read from rd0 by name alone; on the suite's rigs
    every member has the same size and data offset, so any surviving rdN
    answers for all."""
    base = mdsys(mddev)
    for d in sorted(os.listdir(base)):
        if re.fullmatch(r"rd\d+", d):
            return d
    raise RuntimeError(f"{mddev}: no rdN left in sysfs")


def md_geometry(mddev: str) -> dict:
    m = mdsys(mddev)
    level = _md_read(mddev, "level")
    return {
        "level": level,
        # F4: the chunk is read live per array — 128 sectors was the loop rig's
        # 64 KiB chunk and EINVALs on an AHR band's 512 KiB default. GT-16: on
        # RAID1 chunk_size reads 0 and means "no stripe geometry".
        "chunk": int(_md_read(mddev, "chunk_size")),
        "n": int(_md_read(mddev, "raid_disks")),
        "layout": MDSYS_LAYOUT.get(int(_md_read(mddev, "layout")),
                                   f"raw{_md_read(mddev, 'layout')}"),
        "data_offset": int(_md_read(mddev, f"{_first_rd(mddev)}/offset")) * 512,
        "raid6": level == "raid6",
        "raid1": level == "raid1",
    }


def chunk_sectors(geo: dict) -> int:
    """Per-member sectors one stripe occupies. RAID1 has no stripe (GT-16):
    md accepts any sync window there, and the engine's convention — mirrored
    here — is a plain 128-sector (64 KiB) window."""
    if geo["raid1"]:
        return 128
    cs = geo["chunk"] // 512
    if cs < 1:
        raise RuntimeError(f"chunk_size {geo['chunk']} gives no stripe window")
    return cs


def find_btrfs_dev(mountpoint: str) -> str:
    """The btrfs device (LV in the rig) for a mountpoint."""
    r = run(["findmnt", "-n", "-o", "SOURCE", "-T", mountpoint])
    return r.stdout.strip()


def dm_start_sector(srcdev: str) -> int:
    r = run(["dmsetup", "table", srcdev])
    parts = r.stdout.split()
    if len(parts) >= 5 and parts[2] == "linear":
        return int(parts[4])
    raise RuntimeError(f"no linear target on {srcdev}: {r.stdout}")


def dm_segments(srcdev: str) -> list[dict]:
    """`dmsetup table <srcdev>` as its linear segments in LV order, one dict
    each: {dev: source block device, start/length: LV byte offset/size of the
    segment, ss: the source's start sector}. An AHR pool's LV is the linear
    concatenation of its band arrays (PVs are the md devices in band order) —
    one segment per band, each with its OWN geometry. A mapping must take the
    segment that covers the byte from this table, never one array's geometry
    for the whole LV (review finding R1)."""
    r = run(["dmsetup", "table", srcdev])
    segs = []
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[2] != "linear":
            continue
        dev = f"/dev/{os.path.basename(os.path.realpath(f'/sys/dev/block/{parts[3]}'))}"
        segs.append({"dev": dev, "start": int(parts[0]) * 512,
                     "length": int(parts[1]) * 512, "ss": int(parts[4])})
    if not segs:
        raise RuntimeError(f"no linear targets on {srcdev}: {r.stdout}")
    return segs


def segment_for(segs: list[dict], lv_byte: int) -> dict:
    """The segment (from the dm table) covering LV byte `lv_byte`."""
    for s in segs:
        end = s["start"] + s["length"] if s["length"] is not None else None
        if s["start"] <= lv_byte and (end is None or lv_byte < end):
            return s
    raise RuntimeError(f"no segment covers LV byte {lv_byte}: {segs}")


def subvol_id(mountpoint: str) -> int:
    r = run(["btrfs", "subvolume", "show", mountpoint])
    return int(re.search(r"Subvolume ID:\s*(\d+)", r.stdout).group(1))


# ---------------------------------------------------------------- raw I/O

def read_direct(path: str, off: int, ln: int) -> bytes:
    assert off % 512 == 0 and ln % 512 == 0, (path, off, ln)
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


def write_direct(path: str, off: int, data: bytes) -> None:
    assert off % 512 == 0 and len(data) % 512 == 0
    fd = os.open(path, os.O_WRONLY | os.O_DIRECT)
    try:
        os.lseek(fd, off, 0)
        buf = mmap.mmap(-1, len(data))
        try:
            buf.write(data)
            os.writev(fd, [memoryview(buf)])
            os.fsync(fd)
        finally:
            buf.close()
    finally:
        os.close(fd)


# ---------------------------------------------------------------- md layout

def predict(md_byte: int, geo: dict) -> dict:
    """md LBA -> (disk, member offset) for left-symmetric RAID5/6 (the md
    default; layout recorded per GT-2) or RAID1, where every leg stores the
    same bytes at data_offset + the LBA and no stripe geometry exists (GT-16).
    Ported from the drill's 02-locate.py."""
    chunk, n, doff = geo["chunk"], geo["n"], geo["data_offset"]
    if geo["raid1"]:
        return {"disk": 0, "moff": doff + md_byte, "stripe": None,
                "parity_disk": None, "q_disk": None,
                "chunk_index": md_byte // BS, "in_chunk": md_byte % BS,
                "mirrors": list(range(n))}
    dc = n - (2 if geo["raid6"] else 1)          # data chunks per stripe
    chunk_index = md_byte // chunk
    d = chunk_index % dc
    stripe = chunk_index // dc
    in_chunk = md_byte % chunk
    p_disk = (n - 1) - (stripe % n)
    q_disk = (p_disk + 1) % n
    if geo["raid6"]:
        assert geo["layout"] == "left-symmetric", geo["layout"]
        disk = (q_disk + 1 + d) % n
    else:
        assert geo["layout"] == "left-symmetric", geo["layout"]
        disk = (p_disk + 1 + d) % n
    return {"disk": disk, "moff": doff + stripe * chunk + in_chunk,
            "stripe": stripe, "parity_disk": p_disk, "q_disk": q_disk,
            "chunk_index": chunk_index, "in_chunk": in_chunk}


def reverse_predict(disk: int, moff: int, geo: dict) -> int:
    """(disk, member offset) -> md LBA (inverse of predict for left-symmetric)."""
    chunk, n, doff = geo["chunk"], geo["n"], geo["data_offset"]
    if geo["raid1"]:
        raise RuntimeError("reverse_predict is RAID5/6-only (RAID1 has no "
                           "stripe geometry to invert, GT-16)")
    dc = n - (2 if geo["raid6"] else 1)
    stripe = (moff - doff) // chunk
    in_chunk = (moff - doff) % chunk
    p_disk = (n - 1) - (stripe % n)
    q_disk = (p_disk + 1) % n
    anchor = q_disk if geo["raid6"] else p_disk
    d = (disk - anchor - 1) % n
    return (stripe * dc + d) * chunk + in_chunk


# ---------------------------------------------------------------- btrfs trees

def dump_tree(srcdev: str, tree: int) -> str:
    return run(["btrfs", "inspect-internal", "dump-tree", "-t", str(tree),
                srcdev]).stdout


def chunk_data_map(dump3: str, logical: int) -> tuple[int, int, int]:
    """(logical_start, device_offset, length) of the DATA chunk covering
    `logical` (GT-2: several DATA chunks may exist with per-chunk deltas)."""
    for item in dump3.split("\n\titem "):
        if "CHUNK_ITEM" not in item or not re.search(r"type .*\bDATA\b", item):
            continue
        lo = int(re.search(r"CHUNK_ITEM (\d+)", item).group(1))
        ln = int(re.search(r"length (\d+)", item).group(1))
        dev = int(re.search(r"stripe 0 devid \d+ offset (\d+)", item).group(1))
        if lo <= logical < lo + ln:
            return lo, dev, ln
    raise RuntimeError(f"no DATA chunk covers logical {logical}")


def chunk_any_map(dump3: str, logical: int) -> tuple[int, int, int]:
    """Same, for any chunk type (csum/metadata tree blocks)."""
    for item in dump3.split("\n\titem "):
        if "CHUNK_ITEM" not in item:
            continue
        lo = int(re.search(r"CHUNK_ITEM (\d+)", item).group(1))
        ln = int(re.search(r"length (\d+)", item).group(1))
        dev = int(re.search(r"stripe 0 devid \d+ offset (\d+)", item).group(1))
        if lo <= logical < lo + ln:
            return lo, dev, ln
    raise RuntimeError(f"no chunk covers logical {logical}")


def file_extents(srcdev: str, mountpoint: str, path: str) -> list[dict]:
    """EXTENT_DATA items of `path` from the subvol tree dump. Each:
    {foff, disk, disknr, nr, ram, comp}. Works for regular + compressed;
    `disk` is the btrfs logical bytenr of the on-disk data, `nr` its length.
    Body lines attach ONLY within their own item — with several files in the
    tree, the next item belongs to another inode and must close the body."""
    ino = run(["stat", "-c", "%i", path]).stdout.strip()
    sid = subvol_id(mountpoint)
    dump = dump_tree(srcdev, sid)
    exts, cur, in_body = [], None, False
    for line in dump.splitlines():
        m = re.match(r"\s*item \d+ key \((\d+) EXTENT_DATA (\d+)\) itemoff", line)
        if m:
            in_body = True
            cur = None
            if m.group(1) == ino:
                cur = {"foff": int(m.group(2))}
                exts.append(cur)
            continue
        if re.match(r"\s*item \d+ key \(", line):
            in_body = False                          # any other item closes it
            continue
        if not in_body or cur is None:
            continue
        m = re.search(r"extent data disk byte (\d+) nr (\d+)", line)
        if m:
            cur["disk"], cur["disknr"] = int(m.group(1)), int(m.group(2))
            continue
        m = re.search(r"extent data offset \d+ nr (\d+) ram (\d+)", line)
        if m:
            cur["nr"], cur["ram"] = int(m.group(1)), int(m.group(2))
            continue
        m = re.search(r"extent compression \d+ \((\w+)\)", line)
        if m:
            cur["comp"] = m.group(1)
    for e in exts:
        if "disk" not in e:
            raise RuntimeError(f"incomplete EXTENT_DATA parse for {path}: {e}")
    if not exts:
        raise RuntimeError(f"no EXTENT_DATA items for {path}")
    return exts


def extent_for_offset(exts: list[dict], file_off: int) -> dict:
    for e in exts:
        if e["foff"] <= file_off < e["foff"] + e.get("nr", 0):
            return e
    raise RuntimeError(f"file offset {file_off} not in any extent")


# ---------------------------------------------------------------- csum tree

def csum_lookup(srcdev: str, dump7: str, dump3: str, logical: int) -> int:
    """Stored crc32c for the btrfs logical byte, read from the csum tree.
    Semantics (probed live on kernel 7.0.14): one entry per ON-DISK sector
    (compressed extents included), entries keyed contiguously from each
    extent's logical start; lookup = greatest item start <= logical.
    Each item is paired with the leaf whose header preceded it in the dump
    (a multi-leaf tree must not map every item to the last leaf)."""
    items = []                               # (start, itemoff, itemsize, leaf)
    leaf = None
    for line in dump7.splitlines():
        m = re.search(r"key \(EXTENT_CSUM EXTENT_CSUM \d+\) block (\d+) gen", line)
        if m:
            leaf = int(m.group(1))          # node pointer (multi-leaf)
            continue
        m = re.match(r"leaf (\d+) ", line.strip())
        if m:
            leaf = int(m.group(1))          # current leaf
            continue
        m = re.search(r"item \d+ key \(EXTENT_CSUM EXTENT_CSUM (\d+)\) "
                      r"itemoff (\d+) itemsize (\d+)", line)
        if m and leaf is not None:
            items.append((int(m.group(1)), int(m.group(2)), int(m.group(3)), leaf))
    best = None
    for start, itemoff, itemsize, leaf_l in items:
        if start <= logical and (best is None or start > best[0]):
            best = (start, itemoff, itemsize, leaf_l)
    if best is None:
        raise LookupError(f"no EXTENT_CSUM item covers logical {logical}")
    start, itemoff, itemsize, leaf_l = best
    n = itemsize // 4
    if logical >= start + n * BS:
        raise LookupError(f"csum item at {start} ends before logical {logical}")
    idx = (logical - start) // BS
    _clog, cdev_l, _clen = chunk_any_map(dump3, leaf_l)
    leaf_dev = leaf_l - _clog + cdev_l
    leaf_dev -= leaf_dev % BS
    raw = read_direct(srcdev, leaf_dev, 16384 * 2)
    off = 101 + itemoff + idx * 4           # 101-byte leaf header (GT-4)
    return int.from_bytes(raw[off:off + 4], "little")


# ---------------------------------------------------------------- mapping

def locate_block(mddev: str, mountpoint: str, path: str, block: int) -> dict:
    """file block -> member (disk, moff) + md LBA, via the btrfs trees.
    The VERIFICATION/mapper path — the injector never calls this."""
    srcdev = find_btrfs_dev(mountpoint)
    geo = md_geometry(mddev)
    dump3 = dump_tree(srcdev, 3)
    exts = file_extents(srcdev, mountpoint, path)
    e = extent_for_offset(exts, block * BS)
    compressed = e["comp"] != "none"
    if compressed:
        blob_logical = e["disk"]
        blob_sectors = (e["disknr"] + BS - 1) // BS
        logical_byte = e["disk"] + (block * BS - e["foff"])  # within-ram offset
        target_logical = e["disk"]                            # blob start
    else:
        blob_logical = e["disk"]
        blob_sectors = e["disknr"] // BS
        logical_byte = e["disk"] + (block * BS - e["foff"])
        target_logical = logical_byte
    clog, cdev, _clen = chunk_data_map(dump3, target_logical)
    lv = target_logical - clog + cdev
    ss = dm_start_sector(srcdev)
    md_byte = lv + ss * 512
    p = predict(md_byte, geo)
    return {"mddev": mddev, "srcdev": srcdev, "mountpoint": mountpoint,
            "path": path, "block": block, "geo": geo,
            "extent": e, "compressed": compressed,
            "blob_logical": blob_logical, "blob_sectors": blob_sectors,
            "logical_byte": logical_byte, "target_logical": target_logical,
            "chunk_logical": clog, "chunk_device": cdev,
            "start_sector": ss, "md_byte": md_byte,
            "disk": p["disk"], "moff": p["moff"], "stripe": p["stripe"],
            "parity_disk": p["parity_disk"], "q_disk": p["q_disk"],
            "raid1": geo["raid1"],
            "mirrors": p.get("mirrors"),
            "exts": exts, "dump3": dump3}


def reverse_locate(mddev: str, mountpoint: str, disk: int, moff: int,
                   known_files: list[str]) -> dict:
    """(disk, member offset) -> file + block. Verification-side inverse."""
    srcdev = find_btrfs_dev(mountpoint)
    geo = md_geometry(mddev)
    md_byte = reverse_predict(disk, moff, geo)
    lv = md_byte - dm_start_sector(srcdev) * 512
    dump3 = dump_tree(srcdev, 3)
    hit = None
    for item in dump3.split("\n\titem "):
        if "CHUNK_ITEM" not in item:
            continue
        lo = int(re.search(r"CHUNK_ITEM (\d+)", item).group(1))
        ln = int(re.search(r"length (\d+)", item).group(1))
        dev = int(re.search(r"stripe 0 devid \d+ offset (\d+)", item).group(1))
        if dev <= lv < dev + ln:
            hit = (lo, dev, ln)
            break
    if hit is None:
        raise RuntimeError(f"no chunk covers LV byte {lv}")
    clog, cdev, _ = hit
    logical = lv - cdev + clog
    for f in known_files:
        exts = file_extents(srcdev, mountpoint, f)
        for e in exts:
            span = e.get("ram", e.get("nr", 0))
            if e["disk"] <= logical < e["disk"] + e["disknr"]:
                off_in = logical - e["disk"]
                blk = e["foff"] // BS + off_in // BS
                return {"path": f, "block": blk, "compressed": e["comp"] != "none",
                        "extent": e, "logical": logical, "md_byte": md_byte}
    raise RuntimeError(f"member (m{disk}, {moff}) -> logical {logical}: no known file extent")


# ---------------------------------------------------------------- md ops

def evict_stripe_cache(mddev: str, stripe: int, span: int = 200) -> None:
    """Deterministically evict md's stripe cache around `stripe` so a bounded
    check reads the MEMBERS, not cached pre-corruption content.

    Two live-probed facts make neither half sufficient alone:
    - a sequential sweep at the default cache size (256) never evicts the
      target: released stripes are reused LIFO, so only a few slots cycle;
    - shrinking stripe_cache_size (floor 17, probed) discards cached stripes
      but KEEPS the 17 most recent — a stripe just written through md survives
      the shrink.
    Shrink first, then sweep ±span stripes (excluding the target) while the
    cache is small: with 17 slots the sweep is forced through every slot and
    the target's entry is recycled. Restore the size afterwards.

    Kernel 7.0.14-17 caveat (probed 2026-09-14): a RECENTLY touched stripe —
    written or checked through md moments ago — survives the whole recipe
    (the shrink keeps it among the 17 most recent and the sweep's reads no
    longer recycle it), and the helper then silently reads the stale cache.
    Trusted only for stripes whose last through-md touch is in the past; the
    case-1 canary uses a whole-array check as its cache-buster instead
    (cases.control1_parity_trap).

    RAID1 (GT-16) has no stripe_cache_size knob and no stripe cache at all —
    an absent attribute is skipped, never an error.

    The shrink is asserted by reading the knob back: a write that silently
    did not take would make every downstream bounded check read the STALE
    cache and report 0 — a false pass indistinguishable from a clean array
    (vacuity review F5). This is the ONE eviction in the suite: bounded
    checks and the degraded stripe read (cases.verify_stripe) both call it."""
    m = mdsys(mddev)
    sz_path = f"{m}/stripe_cache_size"
    if not os.path.exists(sz_path):
        return                       # RAID1: no stripe cache to evict (GT-16)
    orig = open(sz_path).read().strip()
    with open(sz_path, "w") as fh:
        fh.write("17")
    if open(sz_path).read().strip() != "17":
        raise RuntimeError(f"{mddev}: stripe_cache_size write of 17 did not "
                           f"take — the eviction is a no-op and every bounded "
                           f"check below would read the stale cache")
    geo = md_geometry(mddev)
    cs = chunk_sectors(geo)
    dc = geo["n"] - (2 if geo["raid6"] else 1)
    chunk = geo["chunk"]
    last = array_end_sectors(mddev) // cs
    for s in list(range(max(0, stripe - span), stripe)) + \
             list(range(stripe + 1, min(stripe + 1 + span, last))):
        read_direct(mddev, s * dc * chunk, chunk)
    with open(sz_path, "w") as fh:
        fh.write(orig)


def bounded_window_check(mddev: str, stripe: int, cap: int = 180,
                         evict: bool = True) -> int:
    """md check bounded to `stripe` (sync_min/sync_max in per-member sectors,
    GT-5 convention). The stripe width comes from the array's own chunk_size
    (F4: it was hardcoded to the loop rig's 64 KiB / 128 sectors, which md
    refuses with EINVAL on a 512 KiB-chunk array). The stripe cache is evicted
    first (see evict_stripe_cache) so the check reads the members, not cached
    pre-corruption content — except with `evict=False`, which the case-1
    control's canary uses: over a stripe whose cached copy predates rot that
    landed BEHIND md, the check must read the stale cache and report 0 (the
    staleness premise), with a whole-array check after it proving the wide
    window reveals what the cache hid. On kernel 7.0.14-17 a recently
    WRITTEN stripe survives even the eviction (the shrink keeps the 17 most
    recent), which is why the canary's rot lands behind md after a clean
    write and never on the stripe a repair just wrote."""
    geo = md_geometry(mddev)
    cs = chunk_sectors(geo)
    if evict:
        evict_stripe_cache(mddev, stripe)
    return bounded_range_check(mddev, stripe * cs, (stripe + 1) * cs, cap=cap)


def bounded_range_check(mddev: str, lo: int, hi: int, cap: int = 180) -> int:
    """md check bounded to [lo, hi) per-member sectors — the primitive
    bounded_window_check derives its stripe window from. On RAID1 there is no
    stripe geometry (GT-16: chunk_size 0) and the window is a plain sector
    range; md accepts sync_min/sync_max there without the chunk-multiple rule,
    which only applies when chunk_sectors is non-zero. GT-5/GT-13 rule: a check
    reaching sync_max < end SUSPENDS with sync_action stuck on 'check'; once
    suspended (completed >= sync_max) `echo idle` is accepted and ends the op
    scoped to the window."""
    m = mdsys(mddev)
    with open(f"{m}/sync_min", "w") as fh:
        fh.write(str(lo))
    with open(f"{m}/sync_max", "w") as fh:
        fh.write(str(hi))
    with open(f"{m}/sync_action", "w") as fh:
        fh.write("check")
    ended = False
    for _ in range(cap):
        a = open(f"{m}/sync_action").read().strip()
        if a == "idle":
            ended = True
            break
        comp = open(f"{m}/sync_completed").read().split()[0]
        if not ended and comp.isdigit() and int(comp) >= hi:
            with open(f"{m}/sync_action", "w") as fh:
                try:
                    fh.write("idle")
                    ended = True
                except OSError:
                    pass
        import time
        time.sleep(0.5)
    if not ended:
        # (vacuity review F11: this interpolated an undefined `stripe` — the
        # NameError masked the real timeout when it fired)
        raise RuntimeError(f"bounded check {mddev} [{lo}, {hi}) did not "
                           f"settle in {cap * 0.5:g}s")
    # settle: sync_action flips to idle slightly before mismatch_cnt is
    # finalized for the op (probed live: reading immediately returned the
    # PREVIOUS check's count)
    import time
    time.sleep(1)
    mm = open(f"{m}/mismatch_cnt").read().strip()
    restore_sync_knobs(mddev)
    return int(mm)


def array_end_sectors(mddev: str) -> int:
    rd = _first_rd(mddev)
    size = int(_md_read(mddev, f"{rd}/size"))             # sectors per member
    doff = int(_md_read(mddev, f"{rd}/offset"))
    return size - doff


def bounded_end_check(mddev: str, cap: int = 300) -> dict:
    """Deterministic coverage proof (GT-5 rule): a check bounded to one stripe
    short of the array end SUSPENDS there with sync_completed == sync_max —
    it can only get there by having covered 0..end-1 stripe. Ends the suspended op
    with `idle` and restores the knobs."""
    import time
    m = mdsys(mddev)
    end = array_end_sectors(mddev)
    cs = chunk_sectors(md_geometry(mddev))
    hi = end - cs
    with open(f"{m}/sync_min", "w") as fh:
        fh.write("0")
    with open(f"{m}/sync_max", "w") as fh:
        fh.write(str(hi))
    with open(f"{m}/sync_action", "w") as fh:
        fh.write("check")
    suspended, completed = False, None
    for _ in range(cap):
        a = open(f"{m}/sync_action").read().strip()
        comp = open(f"{m}/sync_completed").read().split()
        nums = [p for p in comp if p.isdigit()]
        if a == "check" and nums and int(nums[0]) >= hi:
            suspended = True
            completed = int(nums[0])
            break
        if a == "idle":
            break
        time.sleep(0.5)
    with open(f"{m}/sync_action", "w") as fh:
        fh.write("idle")
    time.sleep(1)
    mm = int(open(f"{m}/mismatch_cnt").read().strip())
    restore_sync_knobs(mddev)
    return {"suspended": suspended, "completed": completed, "end": end,
            "cs": cs, "mismatch_cnt": mm}


def full_check(mddev: str, cap: int = 600) -> dict:
    """Full-array md check (sync_max=max): reaching idle means md covered the
    device end — md cannot stop early with the knob at max. sync_completed is
    sampled for the report only (the op can outrun the poll on loop devices)."""
    import time
    m = mdsys(mddev)
    restore_sync_knobs(mddev)
    with open(f"{m}/sync_action", "w") as fh:
        fh.write("check")
    peak, total = 0, None
    final = None
    for _ in range(cap):
        a = open(f"{m}/sync_action").read().strip()
        comp = open(f"{m}/sync_completed").read().split()
        nums = [p for p in comp if p.isdigit()]
        if nums:
            peak = max(peak, int(nums[0]))
            if len(nums) >= 2:
                total = int(nums[-1])
        if a == "idle":
            final = "idle"
            break
        time.sleep(0.2)
    mm = int(open(f"{m}/mismatch_cnt").read().strip())
    return {"peak_completed": peak, "total": total, "final_action": final,
            "mismatch_cnt": mm}


def restore_sync_knobs(mddev: str) -> None:
    m = mdsys(mddev)
    try:
        a = open(f"{m}/sync_action").read().strip()
        comp = open(f"{m}/sync_completed").read().split()
        if a not in ("idle", "none") and comp and comp[0].isdigit():
            # suspended at a sync_max boundary: widen, then end the op
            with open(f"{m}/sync_max", "w") as fh:
                fh.write("max")
            with open(f"{m}/sync_action", "w") as fh:
                fh.write("idle")
    except OSError:
        pass
    with open(f"{m}/sync_min", "w") as fh:
        fh.write("0")
    with open(f"{m}/sync_max", "w") as fh:
        fh.write("max")


def fail_member(mddev: str, dev: str) -> None:
    run(["mdadm", mddev, "--fail", dev])


def readd_member(mddev: str, dev: str, cap: int = 600) -> None:
    run(["mdadm", mddev, "--remove", dev], check=False)   # a failed member must
    run(["mdadm", mddev, "--add", dev])                   # be removed before re-add
    import time
    m = mdsys(mddev)
    for _ in range(cap):
        if open(f"{m}/sync_action").read().strip() == "idle":
            return
        time.sleep(1)
    raise RuntimeError(f"rebuild of {dev} did not finish in {cap}s")


# ---------------------------------------------------------------- snapshots

def subvolume_names(mountpoint: str) -> set[str]:
    """Every subvolume and snapshot of the filesystem that holds
    `mountpoint`, as its path relative to the filesystem root
    (`btrfs subvolume list`). Implementation-agnostic pin check (vacuity
    review F2): whatever a repair names its transient pin — the reference's
    `.anas-repair-snap` in the mountpoint's PARENT, the engine's
    `anas-selfheal-<epoch>` INSIDE the mountpoint on a flat rig — it is a
    subvolume of this filesystem, so a leaked pin shows up here no matter
    the naming or placement scheme."""
    r = run(["btrfs", "subvolume", "list", mountpoint])
    names = set()
    for line in r.stdout.splitlines():
        # lines are `ID <n> gen <n> top level <n> path <relpath>`; the path
        # is everything after the ` path ` marker (it may contain spaces;
        # the top level's line has none and is skipped)
        if " path " in line:
            p = line.split(" path ", 1)[1]
            if p:
                names.add(p)
    return names


def snap_path(mountpoint: str, name: str) -> str:
    return os.path.join(os.path.dirname(mountpoint.rstrip("/")), name)


def remove_snap(mountpoint: str, name: str) -> None:
    p = snap_path(mountpoint, name)
    if os.path.exists(p):
        run(["btrfs", "subvolume", "delete", p])


def make_snap(mountpoint: str, name: str) -> str:
    remove_snap(mountpoint, name)
    p = snap_path(mountpoint, name)
    run(["btrfs", "subvolume", "snapshot", "-r", mountpoint, p])
    return p


def snapshot_read(path: str, blocks: list[int] | None = None) -> dict:
    """Read `path` (usually under a snapshot) 4K-direct; with `blocks`, only
    those. Returns {ok_blocks, eio_blocks, data{block:bytes}}."""
    size = os.path.getsize(path)
    nblocks = (size + BS - 1) // BS
    want = set(blocks) if blocks is not None else range(nblocks)
    ok, eio, data = [], [], {}
    fd = os.open(path, os.O_RDONLY | os.O_DIRECT)
    try:
        for b in sorted(want):
            os.lseek(fd, b * BS, 0)
            buf = mmap.mmap(-1, BS)
            try:
                try:
                    got = os.readv(fd, [memoryview(buf)])
                    ok.append(b)
                    data[b] = bytes(buf[:got])
                except OSError:
                    eio.append(b)
            finally:
                buf.close()
    finally:
        os.close(fd)
    return {"ok": ok, "eio": eio, "data": data}


# ---------------------------------------------------------------- markers

def sig_for(name: str, block: int = 300) -> bytes:
    """33-byte ASCII marker, DISTINCT PER BLOCK — the injector scans for the
    signature of the exact block it targets, so scan hits from other blocks
    (or their parity copies) never confuse the oracle."""
    sig = f"ANASGT-{name.upper()}B{block}-MARKER-0123456789abcdef"
    return sig[:33].encode()


def file_sector_digests(path: str) -> list[str]:
    """sha256 of every 4 KiB sector of a (member loop) file, read in 1 MiB
    windows. Case 7 proves band A got no DATA write from a segment-2 repair by
    comparing these before/after and classifying every changed sector by its LV
    location — a whole-file hash cannot separate the repair's writes from
    btrfs's own metadata/superblock commits."""
    import hashlib
    digs = []
    with open(path, "rb") as fh:
        while True:
            buf = fh.read(1 << 20)
            if not buf:
                break
            for i in range(0, len(buf), BS):
                digs.append(hashlib.sha256(buf[i:i + BS]).hexdigest())
    return digs


def btrfs_chunk_ranges(srcdev: str, kinds: str) -> list[tuple[int, int]]:
    """LV byte ranges of every chunk whose type matches one of `kinds` (a
    regex alternation, e.g. "DATA" or "SYSTEM|METADATA"). A DUP chunk has TWO
    on-device stripes and both are returned — in the two-band rig the
    metadata chunk and its DUP copy both sit in segment 1."""
    ranges = []
    for item in dump_tree(srcdev, 3).split("\n\titem "):
        if "CHUNK_ITEM" not in item:
            continue
        if not re.search(rf"type [^ ]*\b(?:{kinds})\b", item):
            continue
        ln = int(re.search(r"length (\d+)", item).group(1))
        for off in re.findall(r"stripe \d+ devid \d+ offset (\d+)", item):
            off = int(off)
            ranges.append((off, off + ln))
    return ranges


def btrfs_metadata_ranges(srcdev: str) -> list[tuple[int, int]]:
    """LV byte ranges of every non-DATA chunk (SYSTEM/METADATA — a DUP chunk
    has TWO on-device stripes, and in the two-band rig both the metadata
    chunk and its DUP copy sit in segment 1). A repair's snapshot commits a
    btrfs transaction, and its tree updates land in these ranges — so band-A
    members DO change there, by btrfs housekeeping, on a perfectly correct
    repair. The superblock mirrors are NOT here: their positions are not
    stable across mkfs runs (measured: a live super at 64 KiB and 64 MiB, a
    magic-less csum block at 1 MiB, an all-zero 320 KiB mirror a later
    transaction fills), so case 7 measures them by running the repair's own
    transaction first (tx-probe) instead of guessing."""
    return btrfs_chunk_ranges(srcdev, "SYSTEM|METADATA")


def make_marker(name: str, kind: str, size: int, seed: int | None = None,
                blocks: list[int] | None = None) -> str:
    """Write a marker file into the mountpoint and stash regen + sha.
    kind: random (seeded), zeros, text. Every block in `blocks` (default
    [300]) carries its own signature; an EXPLICIT empty list writes a plain
    data file with no signature (filler). Returns the path."""
    import hashlib
    work = open(f"{GT}/state/workdir.txt").read().strip()
    os.makedirs(KEEP, exist_ok=True)
    if kind == "zeros":
        buf = bytearray(size)
    elif kind == "text":
        rep = (b"anas selfheal suite\n" * (size // 20 + 1))[:size]
        buf = bytearray(rep)
    else:
        buf = bytearray(__import__("random").Random(seed).randbytes(size))
    for b in (blocks if blocks is not None else [300]):
        sig = sig_for(name, b)
        buf[b * BS: b * BS + len(sig)] = sig
    path = os.path.join(work, f"{name}.bin")
    with open(path, "wb") as fh:
        fh.write(bytes(buf))
    run(["sync"])
    with open(os.path.join(KEEP, f"{name}.regen"), "wb") as fh:
        fh.write(bytes(buf))
    with open(os.path.join(KEEP, f"{name}.sha256"), "w") as fh:
        fh.write(hashlib.sha256(bytes(buf)).hexdigest() + "\n")
    return path


def regen(name: str) -> bytes:
    return open(os.path.join(KEEP, f"{name}.regen"), "rb").read()


# ---------------------------------------------------------------- teardown

def teardown_all() -> None:
    sh("teardown_all")


def rig_up(level: int, chunk: str = "64K") -> str:
    sh(f"bash {GT}/00-rig.sh {level} {chunk}")
    return open(f"{GT}/state/mddev.txt").read().strip()


def mddev_workdir() -> tuple[str, str]:
    md = open(f"{GT}/state/mddev.txt").read().strip()
    work = open(f"{GT}/state/workdir.txt").read().strip()
    return md, work


def build_two_band_rig() -> tuple[str, str, str, list[dict]]:
    """The AHR pool shape: TWO md arrays (bands) as the PVs of one VG, one LV
    spanning both in band order — the linear concatenation the single-array
    rigs never had (review finding R1: the suite must catch a repair that
    places every byte with the first segment's geometry). Band A is RAID5
    6×200 MiB @ 64K, band B RAID5 4×200 MiB @ 512K (different chunks on
    purpose). Verifies from the dm table that the LV has exactly two linear
    segments in band order and records them. Returns (mda, mdb, workdir, segments)."""
    sh(f"bash {GT}/00-rig-twoband.sh")
    mda = open(f"{GT}/state/mda.txt").read().strip()
    mdb = open(f"{GT}/state/mdb.txt").read().strip()
    work = open(f"{GT}/state/workdir.txt").read().strip()
    segs = dm_segments(find_btrfs_dev(work))
    if len(segs) != 2 or [s["dev"] for s in segs] != [mda, mdb]:
        raise RuntimeError(f"two-band rig: dm table is not two linear segments "
                           f"in band order: {segs} (want {[mda, mdb]})")
    return mda, mdb, work, segs


def mddevs_workdir() -> tuple[list[str], str]:
    mda = open(f"{GT}/state/mda.txt").read().strip()
    mdb = open(f"{GT}/state/mdb.txt").read().strip()
    work = open(f"{GT}/state/workdir.txt").read().strip()
    return [mda, mdb], work


# ---------------------------------------------------------------- repair cmd

REPAIR_CMD = os.environ.get("REPAIR_CMD") or f"python3 {GT}/suite/repair-ref.py"


def call_repair(mountpoint: str, path: str, block: int, fail_at: str | None = None,
                report: str | None = None, log: str | None = None) -> tuple[int, str]:
    import shlex
    cmd = shlex.split(REPAIR_CMD) + [mountpoint, path, str(block)]
    env = dict(os.environ)
    if fail_at:
        env["REPAIR_FAIL_AT"] = fail_at
    else:
        env.pop("REPAIR_FAIL_AT", None)
    if report:
        env["REPAIR_REPORT"] = report
    r = subprocess.run(cmd, capture_output=True, text=True, env=env,
                       stdin=subprocess.DEVNULL)
    out = (r.stdout + r.stderr).strip()
    if log:
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "w") as fh:
            fh.write(f"$ {' '.join(cmd)}\nrc={r.returncode}\n{out}\n")
    return r.returncode, out


def repair_report(path: str) -> dict:
    if os.path.exists(path):
        return json.load(open(path))
    return {}

# ---------------------------------------------------------------- parity cmd

PARITY_CMD = os.environ.get("PARITY_CMD") or f"python3 {GT}/suite/parity-ref.py"


def call_parity(mountpoint: str, band: int, report: str | None = None,
                log: str | None = None, evidence: str | None = None,
                command: str | None = None) -> tuple[int, str]:
    """Run the parity-rewrite verb under test (story selfheal.10, case 8).

    Contract — the same shape as REPAIR_CMD, one verb along:
      `<cmd> <mountpoint> <band>`
      exit 0 rewritten - 2 still-mismatched - 3 refused - 1 internal error
      PARITY_REPORT=<path> writes a JSON sidecar; the suite reads `outcome`,
      `reason`, `reason_code`, `mismatch_before`, `mismatch_after`, `array`.

    A PARITY_CMD may carry flags of its own (the ANAS dev entry's
    `--assume-mismatch` stands in for the completed-scrub evidence a loop rig
    has no job queue for); they are part of the command string and are passed
    before the two positional arguments.

    The EVIDENCE GATE (vacuity review F7): both implementations refuse with
    exit 3 / `no-parity-mismatch` when they have no proof that a parity
    mismatch was counted on the band — the reference requires `--evidence
    <file>`, the ANAS dev entry takes `--evidence <file>` in place of its
    dev-only `--assume-mismatch` (which bypasses the gate and hardcodes the
    count). The suite passes the evidence file itself: it is produced by a
    bounded check on the rig (a JSON `{"mismatch_cnt": N, ...}` with
    N > 0). `evidence=None` and a `command` with the assume-flag stripped is
    the 8-no-evidence control: the verb must refuse before touching md."""
    import shlex
    base = shlex.split(command if command is not None else PARITY_CMD)
    cmd = base + (["--evidence", evidence] if evidence else []) + \
        [mountpoint, str(band)]
    env = dict(os.environ)
    if report:
        env["PARITY_REPORT"] = report
    r = subprocess.run(cmd, capture_output=True, text=True, env=env,
                       stdin=subprocess.DEVNULL)
    out = (r.stdout + r.stderr).strip()
    if log:
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "w") as fh:
            fh.write(f"$ {' '.join(cmd)}\nrc={r.returncode}\n{out}\n")
    return r.returncode, out


# ---------------------------------------------------------------- mirror cmd

MIRROR_CMD = os.environ.get("MIRROR_CMD") or f"python3 {GT}/suite/mirror-ref.py"


def call_mirror(mountpoint: str, band: int, report: str | None = None,
                log: str | None = None, evidence: str | None = None,
                passes: int | None = None,
                command: str | None = None) -> tuple[int, str]:
    """Run the mirror-reconcile verb under test (story selfheal.11, cases 9).

    Contract - the same shape as REPAIR_CMD and PARITY_CMD, one verb along:
      `<cmd> [--evidence <file>] [--passes N] <mountpoint> <band>`
      exit 0 reconciled - 2 residual - 3 refused - 1 internal error
      MIRROR_REPORT=<path> writes a JSON sidecar; the suite reads `outcome`,
      `reason`, `reason_code`, `arm`, `passes`, `rows_compared`,
      `rows_differing`, `rows_written`, `free_space_rows`, `unchecked_rows`,
      `unresolved_rows`, `mismatch_before`, `mismatch_after` and `array`.

    The EVIDENCE GATE is the parity verb's, one story along: a rig has no
    daemon and no job queue, so `--evidence <file>` (a JSON `{"mismatch_cnt":
    N}` with N > 0, produced by the suite's own bounded check) stands in for
    "the pool's last completed scrub counted disagreeing legs on this band".
    Without it the verb must refuse: exit 3, `no-mirror-mismatch`.

    `--passes N` bounds arm A ("scrub until clean"). Case 9b passes 1 so the
    run falls through to arm B deterministically instead of depending on
    whether md happened to serve the rotten leg a second time; the reference
    accepts the flag and ignores it (it is compare-legs only)."""
    import shlex
    base = shlex.split(command if command is not None else MIRROR_CMD)
    cmd = base + (["--evidence", evidence] if evidence else []) \
        + (["--passes", str(passes)] if passes is not None else []) \
        + [mountpoint, str(band)]
    env = dict(os.environ)
    if report:
        env["MIRROR_REPORT"] = report
    r = subprocess.run(cmd, capture_output=True, text=True, env=env,
                       stdin=subprocess.DEVNULL)
    out = (r.stdout + r.stderr).strip()
    if log:
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "w") as fh:
            fh.write(f"$ {' '.join(cmd)}\nrc={r.returncode}\n{out}\n")
    return r.returncode, out


def kernel_md_log() -> list[str]:
    """The kernel ring buffer's md lines, right now.

    md announces every sync operation it starts. Captured verbatim on the node
    (kernel 7.0.14-17-pve, 2026-09-15) on a 2 x 200 MiB loop RAID1:

        md: check of RAID array md127     /  md: md127: check done.
        md: repair of RAID array md127    /  md: md127: repair done.

    That is what lets the case-9 rows assert the epic's invariant on the RUN
    rather than on the verb's source: whatever the implementation, if md ever
    took a repair on the mirror band the kernel said so."""
    r = subprocess.run(["dmesg"], capture_output=True, text=True,
                       stdin=subprocess.DEVNULL)
    return [l for l in r.stdout.splitlines() if "md:" in l]


def md_repair_lines(before: list[str], mddev: str) -> list[str]:
    """New `md: repair of RAID array <kernel>` lines for this array."""
    kernel = os.path.basename(os.path.realpath(mddev))
    fresh = kernel_md_log()[len(before):]
    return [l for l in fresh
            if re.search(rf"md: repair of RAID array {re.escape(kernel)}\b", l)]
