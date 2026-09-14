#!/usr/bin/env python3
"""GT-23 — md's stripe cache vs the self-heal engine's eviction, on kernel
7.0.14-17-pve.

The engine's `above-md` verdict rests on ONE number: a bounded md `check` over
the target stripe reading `mismatch_cnt = 0` while the block fails its stored
csum. GT-14 established that md serves a recently-touched stripe from its
stripe cache, and the engine's `evictStripeCache` (shrink `stripe_cache_size`
to 17, sweep +/-200 stripes while small, restore) is what was supposed to make
that check read the DISKS. The suite's 7.0.14-17 re-run found the eviction no
longer reaches a stripe written moments before. This probe measures it, and
measures the cheap alternatives, against the truth read straight off the
members.

Six rounds, each on its OWN stripe (500 apart, so no round's +/-200 sweep
touches another's target) and each self-contained: a CLEAN write through md
(`rmw_level=0`, so md rebuilds the whole parity group and the stripe is
consistent on disk AND cached), then 4 KiB of junk written DIRECT to the data
member behind md's back, then one reading method.

  1  the engine's eviction + bounded check           -- the verdict under test
  2  drop_caches THEN the engine's eviction + check  -- cheap alternative
  3  drop_caches ALONE + check                       -- isolates drop_caches
  4  sweep, `stripe_cache_size` left at a DIFFERENT  -- cheap alternative
     value than it started at + check
  5  no eviction at all + check                      -- the baseline control
  6  a stripe whose last through-md touch is OLD     -- the control that says
     (written first, probed last) + eviction + check    the eviction is not
                                                        simply broken

Round 1 also reads the truth two ways md's cache cannot reach: a direct
O_DIRECT XOR of all six members' rows (zero iff the parity group is
consistent), and a WHOLE-ARRAY check, which recycles the cache deterministically.

Usage: 14-gt23.py /dev/mdN
"""
import os
import subprocess
import sys
import time

BS = 4096
SPAN = 200                       # selfheal-repair.ts SELFHEAL_EVICT_SPAN
FLOOR = "17"                     # selfheal-repair.ts STRIPE_CACHE_FLOOR
SETTLE = 1.0                     # mismatch_cnt finalizes after sync_action idles


def sysfs(mddev):
    return "/sys/block/%s/md" % os.path.basename(os.path.realpath(mddev))


def rd(path):
    with open(path) as fh:
        return fh.read().strip()


def wr(path, value):
    with open(path, "w") as fh:
        fh.write(str(value))


def dd_read(device, offset, length):
    """O_DIRECT read of `length` bytes at `offset` -- the engine's readDirect."""
    r = subprocess.run(
        ["/usr/bin/dd", "if=%s" % device, "iflag=direct", "bs=%d" % BS,
         "skip=%d" % (offset // BS), "count=%d" % (length // BS), "status=none"],
        stdin=subprocess.DEVNULL, capture_output=True)
    if r.returncode != 0 or len(r.stdout) != length:
        raise RuntimeError("read %s @%d: rc=%d got %d bytes: %s"
                           % (device, offset, r.returncode, len(r.stdout),
                              r.stderr.decode().strip()))
    return r.stdout


def dd_discard(device, offset, length):
    """O_DIRECT read thrown away -- the engine's readDiscard (sweep reads)."""
    subprocess.run(
        ["/usr/bin/dd", "if=%s" % device, "iflag=direct", "bs=%d" % BS,
         "skip=%d" % (offset // BS), "count=%d" % (length // BS),
         "of=/dev/null", "status=none"],
        stdin=subprocess.DEVNULL, capture_output=True)


def dd_write(device, offset, data):
    """O_DIRECT + fsync write -- the engine's writeDirect."""
    path = "/run/gt23-payload.bin"
    with open(path, "wb") as fh:
        fh.write(data)
    try:
        r = subprocess.run(
            ["/usr/bin/dd", "if=%s" % path, "of=%s" % device, "oflag=direct",
             "conv=fsync,notrunc", "bs=%d" % BS, "seek=%d" % (offset // BS),
             "count=%d" % (len(data) // BS), "status=none"],
            stdin=subprocess.DEVNULL, capture_output=True)
        if r.returncode != 0:
            raise RuntimeError("write %s @%d: rc=%d: %s"
                               % (device, offset, r.returncode, r.stderr.decode().strip()))
    finally:
        os.unlink(path)


def xor_bytes(buffers):
    out = bytearray(BS)
    for b in buffers:
        for i in range(BS):
            out[i] ^= b[i]
    return bytes(out)


class Rig:
    """The array's own geometry, read live from sysfs exactly as the engine does."""

    def __init__(self, mddev):
        self.dev = mddev
        self.sys = sysfs(mddev)
        self.n = int(rd("%s/raid_disks" % self.sys))
        self.chunk = int(rd("%s/chunk_size" % self.sys))
        self.data_disks = self.n - 1
        self.members = []
        self.offsets = []
        for role in range(self.n):
            self.members.append("/dev/%s"
                                % os.path.basename(os.path.realpath(
                                    "%s/rd%d/block" % (self.sys, role))))
            self.offsets.append(int(rd("%s/rd%d/offset" % (self.sys, role))) * 512)
        # rd<n>/size is in KIBIBYTES and is already net of the data offset.
        self.member_sectors = int(rd("%s/rd0/size" % self.sys)) * 2
        self.window_sectors = self.chunk // 512
        self.last_stripe = self.member_sectors // self.window_sectors

    def md_byte(self, stripe):
        """The md offset of data slot 0 of `stripe`."""
        return stripe * self.data_disks * self.chunk

    def parity_role(self, stripe):
        return (self.n - 1) - (stripe % self.n)

    def data_role(self, stripe, d=0):
        """Role holding data slot `d` of `stripe` (left-symmetric, md order)."""
        return (self.parity_role(stripe) + 1 + d) % self.n

    def member_offset(self, stripe, role):
        """selfheal-map.ts memberOffsetOn, for a row at a chunk boundary."""
        return self.offsets[role] + stripe * self.chunk

    def rows(self, stripe):
        """Every member's 4 KiB row of `stripe`, read O_DIRECT off the DISKS."""
        return [dd_read(self.members[role], self.member_offset(stripe, role), BS)
                for role in range(self.n)]

    def direct_consistent(self, stripe):
        """XOR of the data rows == the P row? The truth md's cache cannot reach."""
        rows = self.rows(stripe)
        p = self.parity_role(stripe)
        computed = xor_bytes([r for role, r in enumerate(rows) if role != p])
        return computed == rows[p], computed, rows[p]


def evict(rig, stripe, span=SPAN, restore_to=None):
    """The ENGINE's eviction, verbatim (selfheal-repair.ts evictStripeCache):
    shrink to the floor, sweep +/-span stripes while small, put the size back.
    `restore_to` puts back something OTHER than the original -- the cheap
    alternative round 4 measures."""
    path = "%s/stripe_cache_size" % rig.sys
    original = rd(path)
    wr(path, FLOOR)
    try:
        lo = max(0, stripe - span)
        hi = min(stripe + span + 1, rig.last_stripe)
        for s in range(lo, hi):
            if s == stripe:
                continue
            dd_discard(rig.dev, rig.md_byte(s), rig.chunk)
    finally:
        wr(path, restore_to if restore_to is not None else original)
    return original


def bounded_check(rig, stripe, cap=180):
    """One md `check` bounded to `stripe` -- the engine's boundedWindowCheck
    window, sync_min/sync_max in per-member sectors (GT-5)."""
    low = stripe * rig.window_sectors
    high = (stripe + 1) * rig.window_sectors
    wr("%s/sync_min" % rig.sys, low)
    wr("%s/sync_max" % rig.sys, high)
    wr("%s/sync_action" % rig.sys, "check")
    ended = False
    for _ in range(cap * 2):
        if rd("%s/sync_action" % rig.sys) == "idle":
            ended = True
            break
        completed = rd("%s/sync_completed" % rig.sys).split()[0]
        if completed.isdigit() and int(completed) >= high:
            try:
                wr("%s/sync_action" % rig.sys, "idle")
                ended = True
                break
            except OSError:
                pass
        time.sleep(0.5)
    if not ended:
        raise RuntimeError("bounded check over stripe %d did not settle" % stripe)
    time.sleep(SETTLE)
    count = int(rd("%s/mismatch_cnt" % rig.sys))
    wr("%s/sync_min" % rig.sys, "0")
    wr("%s/sync_max" % rig.sys, "max")
    return count


def whole_array_check(rig, cap=600):
    wr("%s/sync_min" % rig.sys, "0")
    wr("%s/sync_max" % rig.sys, "max")
    wr("%s/sync_action" % rig.sys, "check")
    for _ in range(cap * 2):
        if rd("%s/sync_action" % rig.sys) == "idle":
            break
        time.sleep(0.5)
    else:
        raise RuntimeError("whole-array check did not settle")
    time.sleep(SETTLE)
    return int(rd("%s/mismatch_cnt" % rig.sys))


def drop_caches():
    subprocess.run(["/usr/bin/sync"], stdin=subprocess.DEVNULL, check=True)
    wr("/proc/sys/vm/drop_caches", "3\n")


def clean_write(rig, stripe, fill):
    """Write 4 KiB THROUGH md at `rmw_level=0` -- md rebuilds the whole parity
    group, so the stripe is consistent on disk and freshly in md's cache."""
    path = "%s/rmw_level" % rig.sys
    original = rd(path)
    wr(path, "0")
    try:
        dd_write(rig.dev, rig.md_byte(stripe), bytes([fill]) * BS)
    finally:
        wr(path, original)


def rot_behind_md(rig, stripe, fill):
    """4 KiB of junk written DIRECT to the data member -- md never sees it."""
    role = rig.data_role(stripe)
    dd_write(rig.members[role], rig.member_offset(stripe, role), bytes([fill]) * BS)
    return role


def say(line):
    print(line, flush=True)


def main():
    mddev = sys.argv[1]
    rig = Rig(mddev)
    say("[rig] %s level=raid5 n=%d chunk=%d data_disks=%d member_sectors=%d "
        "stripes=%d" % (rig.dev, rig.n, rig.chunk, rig.data_disks,
                        rig.member_sectors, rig.last_stripe))
    say("[rig] members=%s offsets=%s" % (rig.members, rig.offsets))
    say("[rig] kernel=%s stripe_cache_size=%s rmw_level=%s"
        % (os.uname().release, rd("%s/stripe_cache_size" % rig.sys),
           rd("%s/rmw_level" % rig.sys)))

    # Round 6's stripe is written FIRST so that by the time it is probed its
    # last through-md touch is long past -- the control that says the eviction
    # is not simply broken.
    OLD = 3000
    clean_write(rig, OLD, 0x6C)
    say("[old-write] stripe %d written through md (probed LAST, after every "
        "other round has touched the cache)" % OLD)

    # ---- round 1: the engine's own eviction, and the truth beside it -------
    S = 500
    clean_write(rig, S, 0x11)
    ok, _, _ = rig.direct_consistent(S)
    say("[1-setup] stripe %d written clean through md; direct member XOR == P "
        "row: %s (the parity group really is consistent on disk)" % (S, ok))
    role = rot_behind_md(rig, S, 0xAB)
    say("[1-rot] 4 KiB of 0xAB written DIRECT to %s @%d (role %d, data slot 0 "
        "of stripe %d) -- md was not told"
        % (rig.members[role], rig.member_offset(S, role), role, S))
    evict(rig, S)
    n1 = bounded_check(rig, S)
    say("[1-evicted-check] engine eviction (shrink to %s, sweep +/-%d, restore) "
        "then bounded check over stripe %d: mismatch_cnt=%d" % (FLOOR, SPAN, S, n1))
    ok, computed, parity = rig.direct_consistent(S)
    say("[1-direct-xor] O_DIRECT read of all %d member rows of stripe %d: "
        "XOR(data rows) == P row: %s (computed %s..., P row %s...)"
        % (rig.n, S, ok, computed[:8].hex(), parity[:8].hex()))
    n1w = whole_array_check(rig)
    say("[1-whole-array] whole-array check: mismatch_cnt=%d" % n1w)
    say("[1-verdict] bounded=%d direct_consistent=%s whole_array=%d"
        % (n1, ok, n1w))

    # ---- round 2: drop_caches THEN the engine's eviction -------------------
    S2 = 1000
    clean_write(rig, S2, 0x22)
    rot_behind_md(rig, S2, 0xAB)
    drop_caches()
    evict(rig, S2)
    n2 = bounded_check(rig, S2)
    ok2, _, _ = rig.direct_consistent(S2)
    say("[2-drop+evict] stripe %d: drop_caches then the engine eviction, "
        "bounded check mismatch_cnt=%d (direct XOR consistent: %s)"
        % (S2, n2, ok2))

    # ---- round 3: drop_caches alone ---------------------------------------
    S3 = 1500
    clean_write(rig, S3, 0x33)
    rot_behind_md(rig, S3, 0xAB)
    drop_caches()
    n3 = bounded_check(rig, S3)
    ok3, _, _ = rig.direct_consistent(S3)
    say("[3-drop-only] stripe %d: drop_caches alone (no shrink, no sweep), "
        "bounded check mismatch_cnt=%d (direct XOR consistent: %s)"
        % (S3, n3, ok3))

    # ---- round 4: stripe_cache_size left at a DIFFERENT value --------------
    S4 = 2000
    clean_write(rig, S4, 0x44)
    rot_behind_md(rig, S4, 0xAB)
    before = evict(rig, S4, restore_to="512")
    n4 = bounded_check(rig, S4)
    ok4, _, _ = rig.direct_consistent(S4)
    say("[4-different-size] stripe %d: shrink to %s, sweep, then size left at "
        "512 (was %s), bounded check mismatch_cnt=%d (direct XOR consistent: %s)"
        % (S4, FLOOR, before, n4, ok4))
    wr("%s/stripe_cache_size" % rig.sys, before)

    # ---- round 5: no eviction at all (the baseline) ------------------------
    S5 = 2500
    clean_write(rig, S5, 0x55)
    rot_behind_md(rig, S5, 0xAB)
    n5 = bounded_check(rig, S5)
    ok5, _, _ = rig.direct_consistent(S5)
    say("[5-no-evict] stripe %d: no eviction at all, bounded check "
        "mismatch_cnt=%d (direct XOR consistent: %s)" % (S5, n5, ok5))

    # ---- round 6: the OLD stripe, written before everything else -----------
    rot_behind_md(rig, OLD, 0xAB)
    evict(rig, OLD)
    n6 = bounded_check(rig, OLD)
    ok6, _, _ = rig.direct_consistent(OLD)
    say("[6-old-stripe] stripe %d (written through md before every other "
        "round): engine eviction then bounded check mismatch_cnt=%d "
        "(direct XOR consistent: %s)" % (OLD, n6, ok6))

    say("[summary] evicted=%d drop+evict=%d drop-only=%d different-size=%d "
        "no-evict=%d old-stripe=%d whole-array=%d" % (n1, n2, n3, n4, n5, n6, n1w))
    wr("%s/sync_min" % rig.sys, "0")
    wr("%s/sync_max" % rig.sys, "max")
    return 0


if __name__ == "__main__":
    sys.exit(main())
