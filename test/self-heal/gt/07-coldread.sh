#!/bin/bash
# 07-coldread.sh — GT-9a (warm page hides corruption; cold read fails),
# GT-9b (compressed extents: no ASCII signature on disk; buffered fallback),
# GT-10 (zero blocks / implicit extents).
set -euo pipefail
source /root/gtsh/lib.sh
WORK=$(cat "$GT/state/workdir.txt")

bash "$GT/00-rig.sh" 5
python3 "$GT/01-markers.py" f2 f4
bash "$GT/02-locate.sh" f2
MDDEV=$(cat "$GT/state/mddev.txt")
LOCS="$GT/state/locate_f2.json"
MEMBER=$(python3 -c "import json;print(json.load(open('$LOCS'))['scan_hits'][0][0])")
MOFF=$(python3 -c "import json;print(json.load(open('$LOCS'))['scan_hits'][0][1])")
MEMDEV=$(sed -n "$(( ${MEMBER#m} + 1 ))p" "$GT/state/members.txt")

# ---------- GT-9a: f2 warm-page trap ----------
head -c 4096 /dev/urandom > "$KEEP/f2.junk"
cat "$WORK/f2.bin" > /dev/null                                  # warm the cache
dd if="$KEEP/f2.junk" of="$MEMDEV" bs=4096 seek=$((MOFF/4096)) count=1 conv=notrunc oflag=direct status=none
{
    echo "=== GT-9a f2: corrupted on member, cache NOT dropped ==="
    dd if="$WORK/f2.bin" bs=4096 skip=300 count=1 of=/dev/null status=none 2>&1 \
        && echo "live buffered read blk300: SUCCESS (stale page served)" \
        || echo "live buffered read blk300: FAILED"
    btrfs subvolume snapshot -r "$WORK" "$MOUNT/@snap" >/dev/null
    echo "--- snapshot reads (cold) ---"
    dd if="$MOUNT/@snap/f2.bin" bs=4096 skip=300 count=1 iflag=direct of=/dev/null status=none 2>&1 \
        && echo "snapshot direct read blk300: SUCCESS (UNEXPECTED)" \
        || echo "snapshot direct read blk300: EIO (expected)"
    dd if="$MOUNT/@snap/f2.bin" bs=4096 skip=300 count=1 of=/dev/null status=none 2>&1 \
        && echo "snapshot buffered read blk300: SUCCESS (UNEXPECTED)" \
        || echo "snapshot buffered read blk300: EIO (expected)"
} > "$OUT/07-gt9a.txt" 2>&1
btrfs subvolume delete "$MOUNT/@snap" >/dev/null

# ---------- GT-9b + GT-10: compress=zstd remount, f3 ----------
mount -o remount,compress=zstd "$MOUNT"
python3 "$GT/01-markers.py" f3
filefrag -v "$WORK/f3.bin" > "$OUT/07-f3-filefrag.txt" 2>&1
btrfs inspect-internal dump-tree -t 3 /dev/$VG/$LV > "$OUT/07-f3-chunktree.txt" 2>&1
dmsetup table /dev/mapper/$VG-$LV > "$OUT/07-f3-dmtable.txt" 2>&1
m=$(mdsys "$MDDEV")
{ cat "$m"/level "$m"/chunk_size "$m"/layout "$m"/raid_disks; } > "$OUT/07-f3-mdsys.txt" 2>&1
mdadm --examine "$(head -1 "$GT/state/loops.txt")" > "$OUT/07-f3-examine.txt" 2>&1
python3 "$GT/07-f3locate.py" > "$OUT/07-f3-locate.txt" 2>&1
cat "$OUT/07-f3-locate.txt"

F3LINE=$(grep '^FIRST4K' "$OUT/07-f3-locate.txt" | awk '{print $2, $3}')
F3MEM=${F3LINE%% *}; F3MOFF=${F3LINE##* }
F3DEV=$(sed -n "$(( ${F3MEM#m} + 1 ))p" "$GT/state/members.txt")
head -c 4096 /dev/urandom > "$KEEP/f3.junk"
cat "$WORK/f3.bin" > /dev/null
dd if="$KEEP/f3.junk" of="$F3DEV" bs=4096 seek=$((F3MOFF/4096)) count=1 conv=notrunc oflag=direct status=none
{
    echo "=== GT-9b f3 (compress=zstd): corrupted FIRST 4K of extent at $F3MEM $F3MOFF ==="
    echo "--- live f3 reads (cache warm), block 0 (corrupt region) and block 300 ---"
    dd if="$WORK/f3.bin" bs=4096 skip=0 count=1 iflag=direct of=/dev/null status=none 2>&1 \
        && echo "live DIRECT read blk0: SUCCESS (buffered fallback on compressed extent)" \
        || echo "live DIRECT read blk0: FAILED"
    dd if="$WORK/f3.bin" bs=4096 skip=0 count=1 of=/dev/null status=none 2>&1 \
        && echo "live buffered read blk0: SUCCESS (stale page)" \
        || echo "live buffered read blk0: FAILED"
    dd if="$WORK/f3.bin" bs=4096 skip=300 count=1 iflag=direct of=/dev/null status=none 2>&1 \
        && echo "live DIRECT read blk300: SUCCESS" \
        || echo "live DIRECT read blk300: FAILED"
    btrfs subvolume snapshot -r "$WORK" "$MOUNT/@snap" >/dev/null
    echo "--- snapshot (cold) ---"
    dd if="$MOUNT/@snap/f3.bin" bs=4096 skip=0 count=1 iflag=direct of=/dev/null status=none 2>&1 \
        && echo "snapshot direct blk0: SUCCESS (UNEXPECTED)" \
        || echo "snapshot direct blk0: EIO (expected)"
    dd if="$MOUNT/@snap/f3.bin" bs=4096 skip=300 count=1 iflag=direct of=/dev/null status=none 2>&1 \
        && echo "snapshot direct blk300: SUCCESS (note)" \
        || echo "snapshot direct blk300: EIO"
} > "$OUT/07-gt9b.txt" 2>&1
btrfs subvolume delete "$MOUNT/@snap" >/dev/null

# ---------- GT-10: zero blocks ----------
{
    echo "=== GT-10 f4 (zeros + marker blk300), written pre-remount (no compress) ==="
    filefrag -v "$WORK/f4.bin" 2>&1 | grep -vE "Filesystem|^$" | head -6
    echo "=== zero file written under compress=zstd ==="
    dd if=/dev/zero of="$WORK/fz.bin" bs=4096 count=1024 status=none
    sync
    filefrag -v "$WORK/fz.bin" 2>&1 | grep -vE "Filesystem|^$" | head -6
} > "$OUT/07-gt10.txt" 2>&1

for f in 07-gt9a 07-gt9b 07-gt10; do tail -n 3 "$OUT/$f.txt"; done
teardown_all
echo "07 done"
