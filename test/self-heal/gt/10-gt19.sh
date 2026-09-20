#!/bin/bash
# 10-gt19.sh — GT-19: sync_action=IDLE DURING A RECOVERY. Fresh RAID5 rig,
# data written, one member failed/removed/re-added (recovery starts); while
# sync_action=recover: (c) echo check, (d) sync_max/sync_min writes, (a)
# echo idle, (b) mdadm --action=idle. Then let the recovery finish and confirm
# the array is clean.
# Run on the node: bash /root/gtsh/10-gt19.sh
#
# Rig is 6 x 600 MiB, not 00-rig.sh's 200 MiB: measured ~700 MB/s loop writes
# on this node, a 200 MiB rig's ~1 GiB rebuild finishes in ~2 s — too fast to
# idle mid-recovery. 600 MiB gives a ~7 s window. The re-added member reuses
# the removed loop device (only 4.4 G of headroom on /; a 7th 600 MiB file
# would not fit) — the rebuild is the same full-array recovery either way.
set -uo pipefail
source /root/gtsh/lib.sh
OUTG="$OUT/gt19"
mkdir -p "$OUTG"
SIZE=600

teardown_all
mkdir -p "$GT/state" "$KEEP"
loops=()
for i in 0 1 2 3 4 5; do
    f=$GT/m$i
    truncate -s ${SIZE}M "$f"
    dd if=/dev/zero of="$f" bs=1M count=$SIZE status=none
    loops+=("$(losetup -f --show "$f")")
done
printf '%s\n' "${loops[@]}" > "$GT/state/loops.txt"
mdadm --create /dev/md/gtsh5 --level=5 --raid-devices=6 --chunk=64K \
    --assume-clean --metadata=1.2 "${loops[@]}" < /dev/null >"$OUTG/00-create.txt" 2>&1
mdadm --wait /dev/md/gtsh5 >/dev/null 2>&1 || true
MDDEV=/dev/md/gtsh5
MDRES=$(readlink -f "$MDDEV")
M=/sys/block/$(basename "$MDRES")/md
for i in 0 1 2 3 4 5; do
    [ -d "$M/rd$i" ] || { echo "rig: no rd$i in sysfs" >&2; cat "$OUTG/00-create.txt" >&2; exit 1; }
done
echo "$MDRES" > "$GT/state/mddev.txt"
echo 6 > "$GT/state/ndisks.txt"
printf '%s\n' "${loops[@]}" > "$GT/state/members.txt"
pvcreate -ff -y "$MDRES" >/dev/null
vgcreate gtsh "$MDRES" >/dev/null
lvcreate -l 100%FREE -n data gtsh >/dev/null
mkfs.btrfs -f -m dup -d single /dev/gtsh/data > "$OUTG/00-mkfs.txt" 2>&1
mkdir -p "$MOUNT"
mount /dev/gtsh/data "$MOUNT"
btrfs subvolume create "$MOUNT/@data" >/dev/null
echo "$MOUNT/@data" > "$GT/state/workdir.txt"
python3 "$GT/01-markers.py" f1 f5
sync
echo "rig ready: md=$MDRES members=6x${SIZE}M; data: f1.bin f5.bin written" | tee "$OUTG/run.log"

MEM0=$(head -1 "$GT/state/members.txt")

# ---------- start the recovery ----------
{
    echo "=== GT-19: fail/remove/re-add $MEM0 to start a recovery ==="
    echo "dmesg line count before: $(dmesg | wc -l)"
    mdadm "$MDDEV" --fail "$MEM0" < /dev/null
    echo "--fail rc=$?"
    mdadm "$MDDEV" --remove "$MEM0" < /dev/null
    echo "--remove rc=$?"
    mdadm "$MDDEV" --add "$MEM0" < /dev/null
    echo "--add rc=$?"
    sleep 0.3
    echo "--- sync_action=$(cat "$M/sync_action") sync_completed=$(cat "$M/sync_completed") recovery_start=$(cat "$M/recovery_start") resync_start=$(cat "$M/resync_start")"
    echo "--- /proc/mdstat:"
    cat /proc/mdstat
    echo "--- mdadm --detail (State/Recovery/Sync lines):"
    mdadm --detail "$MDDEV" | grep -E 'State|Recovery|Sync' || true
} > "$OUTG/01-start.txt" 2>&1
sed 's/^/  /' "$OUTG/01-start.txt" | tee -a "$OUTG/run.log"

# wait until the recovery is actually running (tight poll)
i=0
while [ $i -lt 300 ]; do
    a=$(cat "$M/sync_action")
    if [ "$a" = recover ] || [ "$a" = resync ]; then break; fi
    sleep 0.1; i=$((i+1))
done
echo "recovery state at probe start: sync_action=$(cat "$M/sync_action") (after $((i/10))x0.1s)" | tee -a "$OUTG/run.log"

# ---------- (c) echo check while recovering ----------
{
    echo "=== GT-19c: echo check > sync_action during recovery (action=$(cat "$M/sync_action")) ==="
    if echo check > "$M/sync_action"; then
        echo "check write: ACCEPTED (rc=0)"
    else
        echo "check write: rc=$? (write error line above, if any)"
    fi
    echo "sync_action now: $(cat "$M/sync_action")"
    echo "--- /proc/mdstat:"
    cat /proc/mdstat
} > "$OUTG/02c-check.txt" 2>&1
sed 's/^/  /' "$OUTG/02c-check.txt" | tee -a "$OUTG/run.log"

# ---------- (d) sync_max / sync_min writes while recovering ----------
{
    echo "=== GT-19d: sync_max/sync_min writes during recovery (action=$(cat "$M/sync_action")) ==="
    echo "before: sync_min=$(cat "$M/sync_min") sync_max=$(cat "$M/sync_max")"
    if echo max > "$M/sync_max"; then
        echo "echo max > sync_max: ACCEPTED (rc=0)"
    else
        echo "echo max > sync_max: rc=$? (write error line above, if any)"
    fi
    echo "after: sync_max=$(cat "$M/sync_max")"
    if echo 0 > "$M/sync_min"; then
        echo "echo 0 > sync_min: ACCEPTED (rc=0)"
    else
        echo "echo 0 > sync_min: rc=$? (write error line above, if any)"
    fi
    echo "after: sync_min=$(cat "$M/sync_min")"
    echo "--- /proc/mdstat:"
    cat /proc/mdstat
} > "$OUTG/03d-knobs.txt" 2>&1
sed 's/^/  /' "$OUTG/03d-knobs.txt" | tee -a "$OUTG/run.log"

# ---------- (a) echo idle while recovering ----------
{
    echo "=== GT-19a: echo idle > sync_action during recovery (action=$(cat "$M/sync_action")) ==="
    echo "before: sync_action=$(cat "$M/sync_action") recovery_start=$(cat "$M/recovery_start") sync_completed=$(cat "$M/sync_completed")"
    if echo idle > "$M/sync_action"; then
        echo "idle write: ACCEPTED (rc=0)"
    else
        echo "idle write: rc=$? (write error line above, if any)"
    fi
    sleep 0.5
    echo "t=0.5s: sync_action=$(cat "$M/sync_action") recovery_start=$(cat "$M/recovery_start") sync_completed=$(cat "$M/sync_completed")"
    echo "--- /proc/mdstat:"
    cat /proc/mdstat
    echo "--- mdadm --detail (State/Recovery/Sync lines):"
    mdadm --detail "$MDDEV" | grep -E 'State|Recovery|Sync' || true
    echo "--- dmesg tail:"
    dmesg | tail -8
    # poll: does the recovery resume by itself?
    t=2
    resumed=no
    while [ $t -le 120 ]; do
        a=$(cat "$M/sync_action")
        if [ "$a" != idle ]; then
            echo "t=${t}s: RESUMED on its own (sync_action=$a recovery_start=$(cat "$M/recovery_start") sync_completed=$(cat "$M/sync_completed"))"
            resumed=yes
            break
        fi
        if [ $((t % 10)) -eq 0 ]; then
            echo "t=${t}s: still idle (recovery_start=$(cat "$M/recovery_start") sync_completed=$(cat "$M/sync_completed"))"
        fi
        sleep 2; t=$((t+2))
    done
    echo "poll result: resumed=$resumed sync_action=$(cat "$M/sync_action")"
    echo "--- /proc/mdstat:"
    cat /proc/mdstat
} > "$OUTG/04a-idle.txt" 2>&1
sed 's/^/  /' "$OUTG/04a-idle.txt" | tee -a "$OUTG/run.log"

# ---------- (b) mdadm --action=idle ----------
{
    echo "=== GT-19b: mdadm --action=idle $MDDEV (state after 19a: sync_action=$(cat "$M/sync_action")) ==="
    mdadm --action=idle "$MDDEV" < /dev/null
    echo "rc=$?"
    sleep 1
    echo "sync_action=$(cat "$M/sync_action") recovery_start=$(cat "$M/recovery_start") sync_completed=$(cat "$M/sync_completed")"
    echo "--- /proc/mdstat:"
    cat /proc/mdstat
} > "$OUTG/05b-action-idle.txt" 2>&1
sed 's/^/  /' "$OUTG/05b-action-idle.txt" | tee -a "$OUTG/run.log"

# ---------- finish the recovery, confirm clean ----------
{
    echo "=== GT-19: finish the recovery ==="
    a=$(cat "$M/sync_action")
    if [ "$a" != recover ] && [ "$a" != resync ]; then
        echo "recovery not running (action=$a) — attempting to resume:"
        echo "--- mdadm --action=recover $MDDEV"
        mdadm --action=recover "$MDDEV" < /dev/null
        echo "rc=$?"
    fi
    i=0
    while [ $i -lt 300 ]; do
        a=$(cat "$M/sync_action")
        [ "$a" = idle ] && break
        sleep 2; i=$((i+1))
    done
    echo "final: sync_action=$(cat "$M/sync_action") sync_completed=$(cat "$M/sync_completed") mismatch_cnt=$(cat "$M/mismatch_cnt")"
    echo "--- /proc/mdstat:"
    cat /proc/mdstat
    echo "--- mdadm --detail:"
    mdadm --detail "$MDDEV"
    echo "--- full-array check:"
    python3 - "$MDDEV" <<'EOF'
import sys
sys.path.insert(0, '/root/gtsh/suite')
from common import full_check
print("full_check:", full_check(sys.argv[1]))
EOF
} > "$OUTG/06-finish.txt" 2>&1
sed 's/^/  /' "$OUTG/06-finish.txt" | tee -a "$OUTG/run.log"

teardown_all
echo "10 done (rig torn down)"
