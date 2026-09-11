#!/bin/bash
# 05-poison.sh — GT-7: naive repair through md at DEFAULT rmw_level poisons parity.
# Fresh RAID5 rig; f5 (8 MiB full-stripe file); corrupt blk300 on the member,
# bounded check, naive write-back of the original block through md, bounded
# check again, then fail a DIFFERENT data member and read the whole stripe.
set -euo pipefail
source /root/gtsh/lib.sh
R="$GT/05-poison"
mkdir -p "$R"

bash "$GT/00-rig.sh" 5
python3 "$GT/01-markers.py" f5
bash "$GT/02-locate.sh" f5

MDDEV=$(cat "$GT/state/mddev.txt")
M=$(mdsys "$MDDEV")
LOCS="$GT/state/locate_f5.json"
MEMBER=$(python3 -c "import json;print(json.load(open('$LOCS'))['scan_hits'][0][0])")
MOFF=$(python3 -c "import json;print(json.load(open('$LOCS'))['scan_hits'][0][1])")
MDBYTE=$(python3 -c "import json;print(json.load(open('$LOCS'))['md_byte'])")
STRIPE=$(python3 -c "import json;print(json.load(open('$LOCS'))['stripe'])")
CHUNK=$(python3 -c "import json;print(json.load(open('$LOCS'))['chunk'])")
N=$(python3 -c "import json;print(json.load(open('$LOCS'))['n'])")
PD=$(python3 -c "import json;print(json.load(open('$LOCS'))['parity_disk'])")
MEMDEV=$(sed -n "$(( ${MEMBER#m} + 1 ))p" "$GT/state/members.txt")
# the 5 data disks of this stripe (left-symmetric): d = 0..n-2
DATA_DISKS=$(python3 -c "
pd=$PD; n=$N
print(' '.join(str((pd+1+d)%n) for d in range(n-1)))")
{
    echo "member=$MEMBER moff=$MOFF md_byte=$MDBYTE stripe=$STRIPE chunk=$CHUNK n=$N parity_disk=m$PD"
    echo "data disks this stripe: m${DATA_DISKS// / m}"
    echo "rmw_level at default: $(cat "$M/rmw_level")"
} > "$OUT/05-info.txt"

# 1. corrupt f5 blk300 ON THE MEMBER
head -c 4096 /dev/urandom > "$KEEP/f5.junk"
dd if="$KEEP/f5.junk" of="$MEMDEV" bs=4096 seek=$((MOFF/4096)) count=1 conv=notrunc oflag=direct status=none
drop_caches
if bounded_check "$MDDEV" $((STRIPE*128)) $(((STRIPE+1)*128)); then
    echo "pre-repair bounded check: mismatch_cnt=$(cat "$M/mismatch_cnt")" >> "$OUT/05-info.txt"
else
    echo "UNEXPECTED: bounded check did not complete" >> "$OUT/05-info.txt"
fi

# 2. NAIVE REPAIR through md at DEFAULT rmw_level
dd if="$KEEP/f5.blk300" of="$MDDEV" bs=4096 seek=$((MDBYTE/4096)) count=1 conv=notrunc oflag=direct status=none
drop_caches
READBACK=$(dd if="$MDDEV" bs=4096 skip=$((MDBYTE/4096)) count=1 iflag=direct 2>/dev/null | sha256sum | cut -d" " -f1)
ORIG=$(sha256sum "$KEEP/f5.blk300" | cut -d" " -f1)
{ echo "naive repair readback: $READBACK"
  echo "original block sha:    $ORIG"
  [ "$READBACK" = "$ORIG" ] && echo "data member fixed: YES" || echo "data member fixed: NO (UNEXPECTED)"
} >> "$OUT/05-info.txt"

# 3. bounded check after naive repair — parity poisoned?
drop_caches
if bounded_check "$MDDEV" $((STRIPE*128)) $(((STRIPE+1)*128)); then
    echo "post-repair bounded check: mismatch_cnt=$(cat "$M/mismatch_cnt")  (GT-7: expected >0)" >> "$OUT/05-info.txt"
else
    echo "UNEXPECTED: bounded check did not complete" >> "$OUT/05-info.txt"
fi

# 4. fail a DIFFERENT data member, read the whole stripe via md, compare to regen
CORRUPT_IDX=${MEMBER#m}
OTHER=$(python3 -c "
d=[int(x) for x in '$DATA_DISKS'.split()]
print(next(x for x in d if x != $CORRUPT_IDX))")
OTHERDEV=$(sed -n "$(( OTHER + 1 ))p" "$GT/state/members.txt")
echo "failing member m$OTHER ($OTHERDEV), not the corrupted m$CORRUPT_IDX" >> "$OUT/05-info.txt"
mdadm "$MDDEV" --fail "$OTHERDEV" >> "$OUT/05-info.txt" 2>&1
drop_caches
python3 "$GT/05-verify.py" "$MDDEV" "$STRIPE" "$N" "$CHUNK" > "$OUT/05-stripe-verify.txt" 2>&1 || true
tail -5 "$OUT/05-stripe-verify.txt"

# 5. rig is disposable — full teardown, no re-add
teardown_all
echo "05 done (rig torn down)"
