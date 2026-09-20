#!/bin/bash
# 00-rig.sh <1|5|6> [chunk] — build the loop-device rig: md RAID1(2 disks),
# RAID5(6) or RAID6(7), LVM, btrfs. CHUNK (default 64K) is md's chunk on the
# parity levels; the AHR band shape is md's 512K default (F4). RAID1 has no
# chunk and no stripe knobs at all (GT-16).
# Run on the node. Records GT-1 rig facts under /root/gtsh/out/, state under /root/gtsh/state.
set -euo pipefail
LEVEL=${1:?usage: 00-rig.sh <1|5|6> [chunk]}
CHUNK=${2:-64K}
source /root/gtsh/lib.sh
# rig scripts START with full teardown (clean slate) and LEAVE the rig standing
# for the later stages; 99-teardown.sh ends the drill.
teardown_all
mkdir -p "$GT/state" "$KEEP"

case "$LEVEL" in
    1) nloops=2 ;;
    5) nloops=6 ;;
    6) nloops=7 ;;
    *) echo "unknown level $LEVEL (want 1, 5 or 6)" >&2; exit 2 ;;
esac

# loop files of 200 MiB, attach
loops=()
for i in $(seq 0 $((nloops - 1))); do
    f=$GT/m$i
    truncate -s 200M "$f"
    dd if=/dev/zero of="$f" bs=1M count=200 status=none   # zeroed members: parity=0 correct
    loops+=("$(losetup -f --show "$f")")
done
printf '%s\n' "${loops[@]}" > "$GT/state/loops.txt"

md_create() { # md_create <mdadm args...> — run mdadm --create with its output
              # kept: a silent rc=1 here cost a whole suite run (the create is
              # the only silenced command in this script, and the failure
              # showed up as an empty "rc=1" with no clue)
    local log=$GT/state/mdadm-create.log
    "$@" >"$log" 2>&1 || {
        echo "mdadm --create FAILED:" >&2
        cat "$log" >&2
        return 1
    }
}

case "$LEVEL" in
    1)
        members=("${loops[@]}")       # m0..m1 — the two legs
        md_create mdadm --create /dev/md/gtsh1 --level=1 --raid-devices=2 \
            --assume-clean --metadata=1.2 "${members[@]}"
        ;;
    5)
        members=("${loops[@]:0:6}")   # m0..m5
        md_create mdadm --create /dev/md/gtsh5 --level=5 --raid-devices=6 --chunk=$CHUNK \
            --assume-clean --metadata=1.2 "${members[@]}"
        ;;
    6)
        members=("${loops[@]}")       # m0..m6
        md_create mdadm --create /dev/md/gtsh6 --level=6 --raid-devices=7 --chunk=$CHUNK \
            --assume-clean --metadata=1.2 "${members[@]}"
        ;;
esac
mdadm --wait /dev/md/gtsh* >/dev/null 2>&1 || true
MDDEV=/dev/md/gtsh$LEVEL
MDRES=$(readlink -f "$MDDEV")
# the created array must be FULLY assembled in sysfs: the kernel removes a
# faulty member's rdN outright (the suite hardening round caught the suite
# reading rd0 after mdadm --fail of member 0), so the rig's own build asserts
# every rdN is present before anything runs against it
MDSYS=/sys/block/$(basename "$MDRES")/md
nrds=$(cat "$MDSYS/raid_disks")
for i in $(seq 0 $((nrds - 1))); do
    [ -d "$MDSYS/rd$i" ] || {
        echo "rig $LEVEL: $MDRES has no rd$i in sysfs (raid_disks=$nrds):" >&2
        ls "$MDSYS" >&2
        exit 1
    }
done
echo "$MDRES" > "$GT/state/mddev.txt"
n=${#members[@]}
echo "$n" > "$GT/state/ndisks.txt"
printf '%s\n' "${members[@]}" > "$GT/state/members.txt"

# LVM on top
pvcreate -ff -y "$MDRES" >/dev/null
vgcreate $VG "$MDRES" >/dev/null
lvcreate -l 100%FREE -n $LV $VG >/dev/null

# btrfs — AHR's profile
mkfs.btrfs -f -m dup -d single /dev/$VG/$LV >"$OUT/00-mkfs.txt" 2>&1
mkdir -p "$MOUNT"
mount /dev/$VG/$LV "$MOUNT"
btrfs subvolume create "$MOUNT/@data" >/dev/null
echo "$MOUNT/@data" > "$GT/state/workdir.txt"

# ---- GT-1 records ----
{
    echo "=== mdadm --detail $MDDEV ==="
    mdadm --detail "$MDDEV"
    echo; echo "=== mdadm --examine member0 ==="
    mdadm --examine "${loops[0]}"
    echo; echo "=== md sysfs ==="
    m=$(mdsys "$MDDEV")
    for k in level chunk_size layout raid_disks rmw_level stripe_cache_size sync_min sync_max mismatch_cnt sync_action; do
        v=$(cat "$m/$k" 2>/dev/null) && printf '%s=%s\n' "$k" "$v" || printf '%s=ABSENT\n' "$k"
    done
    echo; echo "=== dmsetup table ==="
    dmsetup table /dev/mapper/$VG-$LV
    echo; echo "=== btrfs filesystem show ==="
    btrfs filesystem show
    echo; echo "=== btrfs dump-super csum ==="
    btrfs inspect-internal dump-super /dev/$VG/$LV | grep -i csum
} > "$OUT/00-gt1-rig.txt" 2>&1

echo "rig $LEVEL ready: md=$MDRES n=$n workdir=$MOUNT/@data"
