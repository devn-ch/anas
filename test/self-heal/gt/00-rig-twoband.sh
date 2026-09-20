#!/bin/bash
# 00-rig-twoband.sh — build the TWO-BAND loop rig: the AHR pool shape
# (AHR-DESIGN, LVM: one VG per pool, one LV, PVs are the md devices in band
# order). Band A = RAID5 6×200 MiB loops, 64K chunk; band B = RAID5 4×200 MiB
# loops, md's 512K default chunk — DIFFERENT ON PURPOSE: a repair that places
# a segment-2 byte with segment 1's geometry is exactly what the suite's case
# 7 exists to catch (review finding R1). btrfs -m dup -d single on the LV,
# @data subvolume.
# Run on the node. State under /root/gtsh/state: mda.txt, mdb.txt,
# members-a.txt, members-b.txt, loops.txt, dm-table.txt, workdir.txt.
set -euo pipefail
source /root/gtsh/lib.sh
# rig scripts START with full teardown (clean slate) and LEAVE the rig standing
# for the later stages; the suite's teardown_retry tears it down.
teardown_all
mkdir -p "$GT/state" "$KEEP"

NLOOPS_A=6
NLOOPS_B=4

# 10 loop files of 200 MiB (m0..m9), attach
loops=()
for i in $(seq 0 $((NLOOPS_A + NLOOPS_B - 1))); do
    f=$GT/m$i
    truncate -s 200M "$f"
    dd if=/dev/zero of="$f" bs=1M count=200 status=none   # zeroed members: parity=0 correct
    loops+=("$(losetup -f --show "$f")")
done
printf '%s\n' "${loops[@]}" > "$GT/state/loops.txt"

md_create() { # md_create <mdadm args...> — keep the create's output (the
              # single-array rig's same lesson: a silent rc=1 cost a whole run)
    local log=$GT/state/mdadm-create-$$.log
    "$@" >"$log" 2>&1 || {
        echo "mdadm --create FAILED:" >&2
        cat "$log" >&2
        return 1
    }
}

members_a=("${loops[@]:0:$NLOOPS_A}")
md_create mdadm --create /dev/md/gtshA --level=5 --raid-devices=6 --chunk=64K \
    --assume-clean --metadata=1.2 "${members_a[@]}"
members_b=("${loops[@]:$NLOOPS_A:$NLOOPS_B}")
md_create mdadm --create /dev/md/gtshB --level=5 --raid-devices=4 --chunk=512K \
    --assume-clean --metadata=1.2 "${members_b[@]}"
mdadm --wait /dev/md/gtshA /dev/md/gtshB >/dev/null 2>&1 || true
MDA=$(readlink -f /dev/md/gtshA)
MDB=$(readlink -f /dev/md/gtshB)
# both arrays must be FULLY assembled in sysfs before anything runs against
# them (the kernel removes a faulty member's rdN outright — the single-array
# rig asserts this, the two-band rig must too)
for md in "$MDA" "$MDB"; do
    MDSYS=/sys/block/$(basename "$md")/md
    nrds=$(cat "$MDSYS/raid_disks")
    for i in $(seq 0 $((nrds - 1))); do
        [ -d "$MDSYS/rd$i" ] || {
            echo "two-band rig: $md has no rd$i in sysfs (raid_disks=$nrds):" >&2
            ls "$MDSYS" >&2
            exit 1
        }
    done
done

# LVM: the PVs are the md devices in BAND ORDER — one VG, one LV spanning both
pvcreate -ff -y "$MDA" "$MDB" >/dev/null
vgcreate $VG "$MDA" "$MDB" >/dev/null
lvcreate -l 100%FREE -n $LV $VG >/dev/null

# the LV must be TWO linear segments, band A's PV first (band order) — the
# suite re-verifies and records this from the dm table
dmsetup table /dev/$VG/$LV > "$GT/state/dm-table.txt"
nseg=$(grep -c linear "$GT/state/dm-table.txt" || true)
[ "$nseg" = 2 ] || {
    echo "two-band rig: LV has $nseg dm segments, want 2:" >&2
    cat "$GT/state/dm-table.txt" >&2
    exit 1
}

# btrfs — AHR's profile
mkfs.btrfs -f -m dup -d single /dev/$VG/$LV >"$OUT/00-mkfs-twoband.txt" 2>&1
mkdir -p "$MOUNT"
mount /dev/$VG/$LV "$MOUNT"
btrfs subvolume create "$MOUNT/@data" >/dev/null
echo "$MOUNT/@data" > "$GT/state/workdir.txt"
echo "$MDA" > "$GT/state/mda.txt"
echo "$MDB" > "$GT/state/mdb.txt"
printf '%s\n' "${members_a[@]}" > "$GT/state/members-a.txt"
printf '%s\n' "${members_b[@]}" > "$GT/state/members-b.txt"

# ---- records ----
{
    echo "=== dmsetup table (TWO linear segments, band A first) ==="
    cat "$GT/state/dm-table.txt"
    echo; echo "=== mdadm --detail $MDA (band A) ==="
    mdadm --detail "$MDA"
    echo; echo "=== mdadm --detail $MDB (band B) ==="
    mdadm --detail "$MDB"
    echo; echo "=== md sysfs (per array) ==="
    for md in "$MDA" "$MDB"; do
        echo "--- $md"
        m=$(mdsys "$md")
        for k in level chunk_size layout raid_disks rmw_level stripe_cache_size; do
            v=$(cat "$m/$k" 2>/dev/null) && printf '%s=%s\n' "$k" "$v" || printf '%s=ABSENT\n' "$k"
        done
        echo "rd0_offset=$(cat "$m/rd0/offset") rd0_size=$(cat "$m/rd0/size")"
    done
    echo; echo "=== btrfs filesystem show ==="
    btrfs filesystem show
} > "$OUT/00-gt1-rig-twoband.txt" 2>&1

echo "two-band rig ready: mdA=$MDA (6×200MiB, 64K) mdB=$MDB (4×200MiB, 512K) workdir=$MOUNT/@data"
