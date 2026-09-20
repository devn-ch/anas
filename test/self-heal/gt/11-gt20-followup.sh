#!/bin/bash
# 11-gt20-followup.sh — GT-20 disambiguation (the first run repaired the bad
# copy before the scrub's counters could say who did it). Sequence:
#   corrupt (fs mounted) -> umount -> dump-tree -b on the STILL-BAD copy
#   (which stripe does btrfs-progs read? does it error?) -> remount rw ->
#   raw-check the copies (did the MOUNT repair the DUP?) -> scrub -> raw-check
#   (did the SCRUB repair it? do its counters show it?).
# Run on the node: bash /root/gtsh/11-gt20-followup.sh
set -uo pipefail
source /root/gtsh/lib.sh
OUTG="$OUT/gt20f"
mkdir -p "$OUTG"
LV=/dev/gtsh/data

bash "$GT/00-rig.sh" 5 2>&1 | tee "$OUTG/run.log"
python3 "$GT/01-markers.py" f1 f5 2>&1 | tee -a "$OUTG/run.log"
sync
GT20_OUT="$OUTG" python3 "$GT/11-gt20-leaf.py" corrupt > "$OUTG/01-locate-corrupt.txt" 2>&1 \
    || { echo "locate/corrupt FAILED:"; sed 's/^/  /' "$OUTG/01-locate-corrupt.txt" | tee -a "$OUTG/run.log"; exit 1; }
sed 's/^/  /' "$OUTG/01-locate-corrupt.txt" | tee -a "$OUTG/run.log"
LEAF=$(python3 -c "import json;print(json.load(open('$OUTG/leaf.json'))['leaf'])")

umount "$MOUNT"
sleep 1

# (F1) dump-tree -b on the bad copy, unmounted
{
    echo "=== GT-20F1: dump-tree -b $LEAF $LV (UNMOUNTED, stripe 0 copy bad) ==="
    btrfs inspect-internal dump-tree -b "$LEAF" "$LV" 2>&1 | head -25
    echo "rc=$?"
} > "$OUTG/02-dump-tree-unmounted.txt" 2>&1
sed 's/^/  /' "$OUTG/02-dump-tree-unmounted.txt" | tee -a "$OUTG/run.log"

# (F2) remount rw, raw-check BEFORE any scrub
{
    echo "=== GT-20F2: remount rw, raw check (no scrub yet) ==="
    if mount "$LV" "$MOUNT"; then
        echo "mount: ok"
    else
        echo "mount: FAILED rc=$?"
    fi
    sleep 1
    GT20_OUT="$OUTG" python3 "$GT/11-gt20-leaf.py" check
} > "$OUTG/03-after-mount.txt" 2>&1
sed 's/^/  /' "$OUTG/03-after-mount.txt" | tee -a "$OUTG/run.log"

# (F3) scrub, raw-check again
{
    echo "=== GT-20F3: btrfs scrub start -B -R, then raw check ==="
    rc=0
    btrfs scrub start -B -R /dev/gtsh/data || rc=$?
    echo "scrub rc=$rc"
    GT20_OUT="$OUTG" python3 "$GT/11-gt20-leaf.py" check
} > "$OUTG/04-after-scrub.txt" 2>&1
sed 's/^/  /' "$OUTG/04-after-scrub.txt" | tee -a "$OUTG/run.log"

teardown_all
echo "11-followup done (rig torn down)"
