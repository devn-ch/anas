#!/bin/bash
# 03-corrupt-scrub.sh — GT-3 (scrub diagnostic quality) + GT-4 (crc32c match).
# Corrupt f1's marker block ON THE MEMBER at the scanned offset, scrub, capture
# the btrfs dmesg lines verbatim, compare the expected csum with our crc32c.
set -euo pipefail
source /root/gtsh/lib.sh
MDDEV=$(cat "$GT/state/mddev.txt")
WORK=$(cat "$GT/state/workdir.txt")
LOC="$GT/state/locate_f1.json"
MEMBER=$(python3 -c "import json;print(json.load(open('$LOC'))['scan_hits'][0][0])")
MOFF=$(python3 -c "import json;print(json.load(open('$LOC'))['scan_hits'][0][1])")
MEMDEV=$(sed -n "$(( ${MEMBER#m} + 1 ))p" "$GT/state/members.txt")
echo "corrupting $MEMDEV ($MEMBER) at $MOFF (scan oracle)" | tee "$OUT/03-info.txt"

# 1. junk ON the member at the scanned offset
head -c 4096 /dev/urandom > "$KEEP/f1.junk"
dd if="$KEEP/f1.junk" of="$MEMDEV" bs=4096 seek=$((MOFF/4096)) count=1 conv=notrunc oflag=direct status=none
sha256sum "$KEEP/f1.junk" >> "$OUT/03-info.txt"

# 2. scrub
drop_caches
btrfs scrub start -B -R "$MOUNT" > "$OUT/03-scrub.txt" 2>&1 || true

# 3. dmesg verbatim capture
dmesg | tail -40 > "$OUT/03-dmesg.txt" 2>&1 || true
grep -E "checksum error|expected csum|csum " "$OUT/03-dmesg.txt" > "$OUT/03-csum-lines.txt" || true

# 4. crc32c of the ORIGINAL block vs the expected csum in the dmesg line
python3 "$GT/03-crc-check.py" f1 "$OUT/03-dmesg.txt" | tee "$OUT/03-crc-check.txt"

# 5. direct read of the corrupt block through btrfs must EIO
drop_caches
if dd if="$WORK/f1.bin" bs=4096 skip=300 count=1 iflag=direct of=/dev/null \
        > "$OUT/03-read-eio.txt" 2>&1; then
    echo "UNEXPECTED: direct read SUCCEEDED" >> "$OUT/03-read-eio.txt"
else
    echo "direct read failed (expected): rc=$?" >> "$OUT/03-read-eio.txt"
fi
cat "$OUT/03-read-eio.txt"
