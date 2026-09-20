#!/bin/bash
# 02-locate.sh <file>... — GT-2: btrfs extent -> LV -> md -> (member,offset) chain,
# validated by an independent signature scan. Run on the node.
# Default targets: f1 f4 f5 (signature block 300; f5 block 0 recorded too).
set -euo pipefail
source /root/gtsh/lib.sh
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(f1 f4 f5)
WORK=$(cat "$GT/state/workdir.txt")
MDDEV=$(cat "$GT/state/mddev.txt")
N=$(cat "$GT/state/ndisks.txt")

mkdir -p "$OUT"
PREFIX="02-${TARGETS[0]}"   # per-invocation outputs so multi-target reruns never cross-parse
: > "$OUT/$PREFIX-filefrag.txt"
for f in "${TARGETS[@]}"; do
    filefrag -v "$WORK/$f.bin" >> "$OUT/$PREFIX-filefrag.txt" 2>&1 || true
done
dmsetup table /dev/mapper/$VG-$LV > "$OUT/$PREFIX-dmtable.txt" 2>&1
m=$(mdsys "$MDDEV")
{ cat "$m"/level "$m"/chunk_size "$m"/layout "$m"/raid_disks; } > "$OUT/$PREFIX-mdsys.txt" 2>&1
mdadm --examine "$(head -1 "$GT/state/loops.txt")" > "$OUT/$PREFIX-examine.txt" 2>&1

btrfs inspect-internal dump-tree -t 5 /dev/$VG/$LV > "$OUT/$PREFIX-dumptree-raw.txt" 2>&1 \
    || echo "dump-tree refused (mounted fs?) — noting and skipping" >> "$OUT/$PREFIX-dumptree-raw.txt"
grep -B2 -A6 'inode 257' "$OUT/$PREFIX-dumptree-raw.txt" | head -60 > "$OUT/$PREFIX-dumptree-inode257.txt" || true

# UNEXPECTED(brief): filefrag's physical_offset on btrfs is the LOGICAL bytenr, not
# the device offset. The LV byte needs one extra hop through the chunk tree.
btrfs inspect-internal dump-tree -t 3 /dev/$VG/$LV > "$OUT/$PREFIX-chunktree.txt" 2>&1 || true

GT2_IN="$OUT/$PREFIX" python3 /root/gtsh/02-locate.py "${TARGETS[@]}" > "$OUT/$PREFIX-locate.txt" 2>&1
echo "locate done: see $OUT/$PREFIX-locate.txt"
