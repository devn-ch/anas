#!/bin/bash
# 00-rig.sh <5|6> — build the loop-device rig: md RAID5(6 disks) or RAID6(7), LVM, btrfs.
# Run on the node. Records GT-1 rig facts under /root/gtsh/out/, state under /root/gtsh/state.
set -euo pipefail
LEVEL=${1:?usage: 00-rig.sh <5|6>}
source /root/gtsh/lib.sh
# rig scripts START with full teardown (clean slate) and LEAVE the rig standing
# for the later stages; 99-teardown.sh ends the drill.
teardown_all
mkdir -p "$GT/state" "$KEEP"

# 7 loop files of 200 MiB, attach
loops=()
for i in 0 1 2 3 4 5 6; do
    f=$GT/m$i
    truncate -s 200M "$f"
    dd if=/dev/zero of="$f" bs=1M count=200 status=none   # zeroed members: parity=0 correct
    loops+=("$(losetup -f --show "$f")")
done
printf '%s\n' "${loops[@]}" > "$GT/state/loops.txt"

if [ "$LEVEL" = 5 ]; then
    members=("${loops[@]:0:6}")   # m0..m5
    mdadm --create /dev/md/gtsh5 --level=5 --raid-devices=6 --chunk=64K \
        --assume-clean --metadata=1.2 "${members[@]}" >/dev/null 2>&1
else
    members=("${loops[@]}")       # m0..m6
    mdadm --create /dev/md/gtsh6 --level=6 --raid-devices=7 --chunk=64K \
        --assume-clean --metadata=1.2 "${members[@]}" >/dev/null 2>&1
fi
mdadm --wait /dev/md/gtsh* >/dev/null 2>&1 || true
MDDEV=/dev/md/gtsh$LEVEL
MDRES=$(readlink -f "$MDDEV")
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
    for k in level chunk_size layout raid_disks rmw_level sync_min sync_max mismatch_cnt sync_action; do
        printf '%s=%s\n' "$k" "$(cat "$m/$k")"
    done
    echo; echo "=== dmsetup table ==="
    dmsetup table /dev/mapper/$VG-$LV
    echo; echo "=== btrfs filesystem show ==="
    btrfs filesystem show
    echo; echo "=== btrfs dump-super csum ==="
    btrfs inspect-internal dump-super /dev/$VG/$LV | grep -i csum
} > "$OUT/00-gt1-rig.txt" 2>&1

echo "rig $LEVEL ready: md=$MDRES n=$n workdir=$MOUNT/@data"
