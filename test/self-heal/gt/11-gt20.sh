#!/bin/bash
# 11-gt20.sh — GT-20: METADATA DUP STRIPE-0 CORRUPTION. Fresh -m dup rig,
# csum-tree root leaf's STRIPE 0 copy rotted (last 4 KiB, header survives):
# (a) btrfs check --readonly unmounted, (b) mount + read every file,
# (c) btrfs scrub, (d) dump-tree -b, (e) raw copies + header csum.
# Run on the node: bash /root/gtsh/11-gt20.sh
set -uo pipefail
source /root/gtsh/lib.sh
OUTG="$OUT/gt20"
mkdir -p "$OUTG"
LV=/dev/gtsh/data

echo "=== rig (00-rig.sh: -m dup -d single) ===" | tee "$OUTG/run.log"
bash "$GT/00-rig.sh" 5 >>"$OUTG/run.log" 2>&1
python3 "$GT/01-markers.py" f1 f5 >>"$OUTG/run.log" 2>&1
sync
python3 "$GT/11-gt20-leaf.py" corrupt > "$OUTG/01-locate-corrupt.txt" 2>&1 \
    || { echo "locate/corrupt FAILED:"; sed 's/^/  /' "$OUTG/01-locate-corrupt.txt" | tee -a "$OUTG/run.log"; exit 1; }
sed 's/^/  /' "$OUTG/01-locate-corrupt.txt" | tee -a "$OUTG/run.log"
LEAF=$(python3 -c "import json;print(json.load(open('$OUTG/leaf.json'))['leaf'])")

# (a) unmounted btrfs check
{
    echo "=== GT-20a: btrfs check --readonly $LV (unmounted, stripe 0 copy rotted) ==="
    umount "$MOUNT"
    sleep 1
    rc=0
    btrfs check --readonly "$LV" || rc=$?
    echo "rc=$rc"
    echo "--- dmesg tail:"
    dmesg | tail -8
} > "$OUTG/02a-check-readonly.txt" 2>&1
sed 's/^/  /' "$OUTG/02a-check-readonly.txt" | tee -a "$OUTG/run.log"

# (b) remount + read every file
{
    echo "=== GT-20b: remount + read every file (expect: all fine via the DUP mirror) ==="
    if mount "$LV" "$MOUNT"; then
        echo "mount: ok"
    else
        echo "mount: FAILED rc=$?"
        dmesg | tail -8
    fi
    for f in f1 f5; do
        if [ -f "$MOUNT/@data/$f.bin" ]; then
            if sha=$(sha256sum "$MOUNT/@data/$f.bin" 2>/dev/null | cut -d' ' -f1); then
                if [ "$sha" = "$(cat "$KEEP/$f.sha256")" ]; then
                    echo "$f.bin: sha MATCH ($sha)"
                else
                    echo "$f.bin: sha MISMATCH (got $sha want $(cat "$KEEP/$f.sha256"))"
                fi
            else
                echo "$f.bin: read FAILED"
            fi
        else
            echo "$f.bin: ABSENT"
        fi
    done
} > "$OUTG/03b-reads.txt" 2>&1
sed 's/^/  /' "$OUTG/03b-reads.txt" | tee -a "$OUTG/run.log"

# (c) scrub
{
    echo "=== GT-20c: btrfs scrub start -B -R (mounted, stripe 0 copy rotted) ==="
    rc=0
    btrfs scrub start -B -R /dev/gtsh/data || rc=$?
    echo "rc=$rc"
} > "$OUTG/04c-scrub.txt" 2>&1
sed 's/^/  /' "$OUTG/04c-scrub.txt" | tee -a "$OUTG/run.log"

# (d) dump-tree -b of the (possibly moved) csum root
{
    echo "=== GT-20d: dump-tree -b (csum root) ==="
    echo "corrupted leaf bytenr: $LEAF"
    CURROOT=$(btrfs inspect-internal dump-tree -r "$LV" | sed -n 's/.*checksum tree key (CSUM_TREE ROOT_ITEM [0-9]*) //p' | awk '{print $1}')
    echo "current csum tree root (dump-tree -r): $CURROOT"
    for b in $(printf '%s\n%s\n' "$LEAF" "$CURROOT" | sort -un); do
        echo "--- btrfs inspect-internal dump-tree -b $b $LV (head -12):"
        btrfs inspect-internal dump-tree -b "$b" "$LV" 2>&1 | head -12
        echo "  (rc=$?)"
    done
} > "$OUTG/05d-dumptree.txt" 2>&1
sed 's/^/  /' "$OUTG/05d-dumptree.txt" | tee -a "$OUTG/run.log"

# (e) raw copies + header csum, post-scrub
{
    echo "=== GT-20e: raw copies + header csum (post-scrub) ==="
    python3 "$GT/11-gt20-leaf.py" check
} > "$OUTG/06e-raw.txt" 2>&1
sed 's/^/  /' "$OUTG/06e-raw.txt" | tee -a "$OUTG/run.log"

teardown_all
echo "11 done (rig torn down)"
