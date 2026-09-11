#!/bin/bash
# 04-precheck.sh — GT-5 (bounded md check sees rot BELOW md) + GT-6 (above-md
# control: corruption written through md is invisible to md, visible to btrfs).
set -euo pipefail
source /root/gtsh/lib.sh
MDDEV=$(cat "$GT/state/mddev.txt")
M=$(mdsys "$MDDEV")
WORK=$(cat "$GT/state/workdir.txt")

# f2 mapping (fresh rig; f2 file already written by 01-markers)
bash "$GT/02-locate.sh" f2

F1_STRIPE=$(python3 -c "import json;print(json.load(open('$GT/state/locate_f1.json'))['stripe'])")
F2_MDBYTE=$(python3 -c "import json;print(json.load(open('$GT/state/locate_f2.json'))['md_byte'])")
F2_STRIPE=$(python3 -c "import json;print(json.load(open('$GT/state/locate_f2.json'))['stripe'])")
{ echo "f1 stripe=$F1_STRIPE f2 md_byte=$F2_MDBYTE f2 stripe=$F2_STRIPE"; } > "$OUT/04-info.txt"

# ---- GT-5: bounded check over f1's stripe (rot is BELOW md) ----
# 1 stripe = 1 chunk of md-offset space per member = 128 sectors
{
    echo "=== bounded check f1 stripe $F1_STRIPE (sync_min=$((F1_STRIPE*128)) sync_max=$(((F1_STRIPE+1)*128))) ==="
    echo "rmw_level before: $(cat "$M/rmw_level")"
} > "$OUT/04-gt5.txt"
if bounded_check "$MDDEV" $((F1_STRIPE*128)) $(((F1_STRIPE+1)*128)); then
    {
        echo "mismatch_cnt=$(cat "$M/mismatch_cnt")"
        echo "sync_completed=$(cat "$M/sync_completed")"
        echo "sync_action=$(cat "$M/sync_action")"
    } >> "$OUT/04-gt5.txt"
else
    echo "UNEXPECTED: bounded check did not reach idle" >> "$OUT/04-gt5.txt"
fi
restore_sync_knobs "$MDDEV"

# ---- GT-6: above-md control on f2 (corrupt THROUGH md) ----
head -c 4096 /dev/urandom > "$KEEP/f2.junk"
dd if="$KEEP/f2.junk" of="$MDDEV" bs=4096 seek=$((F2_MDBYTE/4096)) count=1 conv=notrunc oflag=direct status=none
echo "f2 corrupted THROUGH md at md_byte=$F2_MDBYTE" > "$OUT/04-gt6.txt"
if bounded_check "$MDDEV" $((F2_STRIPE*128)) $(((F2_STRIPE+1)*128)); then
    {
        echo "mismatch_cnt=$(cat "$M/mismatch_cnt")  (expected 0)"
        echo "sync_completed=$(cat "$M/sync_completed")"
    } >> "$OUT/04-gt6.txt"
else
    echo "UNEXPECTED: bounded check did not reach idle" >> "$OUT/04-gt6.txt"
fi
restore_sync_knobs "$MDDEV"

drop_caches
btrfs scrub start -B -R "$MOUNT" > "$OUT/04-gt6-scrub.txt" 2>&1 || true
grep -E "checksum error" <(dmesg | tail -30) > "$OUT/04-gt6-dmesg.txt" || echo "no checksum error lines" >> "$OUT/04-gt6-dmesg.txt"
grep -E "csum_errors|uncorrectable_errors" "$OUT/04-gt6-scrub.txt" >> "$OUT/04-gt6-dmesg.txt" || true

# ---- sync_max literal 'max' acceptance (GT-5 side record) ----
{
    echo "echo max > sync_max:"
    echo max > "$M/sync_max" && echo "accepted" || echo "REJECTED"
    echo "sync_max now: $(cat "$M/sync_max")"
    echo 0 > "$M/sync_max"
    restore_sync_knobs "$MDDEV"
    echo "restored: sync_min=$(cat "$M/sync_min") sync_max=$(cat "$M/sync_max")"
} > "$OUT/04-syncmax-literal.txt"

echo "04 done"
