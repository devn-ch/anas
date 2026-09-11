#!/bin/bash
# 06-fix.sh — GT-8 (reconstruct+arbitrate repair leaves the array clean),
# GT-11 (XOR candidate's crc32c == stored csum), GT-12 (RAID6 variant).
# RAID5 part: fresh rig, f5, corrupt blk300 on member, rmw_level=0, XOR the
# other members, arbitrate against the stored csum, write through md, then
# bounded check / snapshot scrub / failed-member stripe read.
set -euo pipefail
source /root/gtsh/lib.sh

raid5_fix() {
    R="$GT/06-fix"; mkdir -p "$R"
    bash "$GT/00-rig.sh" 5
    python3 "$GT/01-markers.py" f5
    bash "$GT/02-locate.sh" f5
    MDDEV=$(cat "$GT/state/mddev.txt"); M=$(mdsys "$MDDEV")
    LOCS="$GT/state/locate_f5.json"
    MEMBER=$(python3 -c "import json;print(json.load(open('$LOCS'))['scan_hits'][0][0])")
    MOFF=$(python3 -c "import json;print(json.load(open('$LOCS'))['scan_hits'][0][1])")
    MDBYTE=$(python3 -c "import json;print(json.load(open('$LOCS'))['md_byte'])")
    STRIPE=$(python3 -c "import json;print(json.load(open('$LOCS'))['stripe'])")
    N=$(python3 -c "import json;print(json.load(open('$LOCS'))['n'])")
    PD=$(python3 -c "import json;print(json.load(open('$LOCS'))['parity_disk'])")
    CI=${MEMBER#m}
    MEMDEV=$(sed -n "$(( CI + 1 ))p" "$GT/state/members.txt")
    {
        echo "corrupt member=$MEMBER moff=$MOFF md_byte=$MDBYTE stripe=$STRIPE parity=m$PD"
        echo "rmw_level default: $(cat "$M/rmw_level")"
    } > "$OUT/06-info.txt"

    head -c 4096 /dev/urandom > "$KEEP/f5.junk"
    dd if="$KEEP/f5.junk" of="$MEMDEV" bs=4096 seek=$((MOFF/4096)) count=1 conv=notrunc oflag=direct status=none
    drop_caches
    bounded_check "$MDDEV" $((STRIPE*128)) $(((STRIPE+1)*128)) || true
    echo "pre-repair mismatch_cnt=$(cat "$M/mismatch_cnt")" >> "$OUT/06-info.txt"

    # scrub first (record): on this kernel the dmesg line carries NO csum values
    btrfs scrub start -B -R "$MOUNT" > "$OUT/06-scrub-pre.txt" 2>&1 || true
    grep -E "checksum error" <(dmesg | tail -10) > "$OUT/06-dmesg-pre.txt" || true

    # THE FIX: rmw_level=0, XOR arbitration (GT-11), read-back guard, write
    echo 0 > "$M/rmw_level"
    echo "rmw_level now: $(cat "$M/rmw_level")" >> "$OUT/06-info.txt"
    python3 "$GT/06-repair.py" xor "$MDDEV" "$CI" "$MOFF" "$N" "$KEEP/06-candidate.bin" \
        | tee -a "$OUT/06-info.txt"

    # read-back guard: md must still serve the JUNK before we write
    RB=$(dd if="$MDDEV" bs=4096 skip=$((MDBYTE/4096)) count=1 iflag=direct 2>/dev/null | sha256sum | cut -d" " -f1)
    JK=$(sha256sum "$KEEP/f5.junk" | cut -d" " -f1)
    { [ "$RB" = "$JK" ] && echo "read-back guard: md block == junk YES" \
                        || echo "read-back guard: UNEXPECTED (md block != junk)"; } >> "$OUT/06-info.txt"

    dd if="$KEEP/06-candidate.bin" of="$MDDEV" bs=4096 seek=$((MDBYTE/4096)) count=1 conv=notrunc,fsync oflag=direct status=none

    # GT-8a: bounded check now clean
    drop_caches
    if bounded_check "$MDDEV" $((STRIPE*128)) $(((STRIPE+1)*128)); then
        echo "post-repair mismatch_cnt=$(cat "$M/mismatch_cnt")  (GT-8a: expected 0)" >> "$OUT/06-info.txt"
    else
        echo "UNEXPECTED: post-repair bounded check did not complete" >> "$OUT/06-info.txt"
    fi

    # GT-8b: snapshot cold read + scrub clean
    btrfs subvolume snapshot -r "$MOUNT/@data" "$MOUNT/@snap" >> "$OUT/06-info.txt" 2>&1
    drop_caches
    SNAP_SHA=$(dd if="$MOUNT/@snap/f5.bin" bs=4096 skip=300 count=1 iflag=direct 2>/dev/null | sha256sum | cut -d" " -f1)
    ORIG_SHA=$(sha256sum "$KEEP/f5.blk300" | cut -d" " -f1)
    { [ "$SNAP_SHA" = "$ORIG_SHA" ] && echo "snapshot blk300 sha MATCH (GT-8b)" \
                                    || echo "snapshot blk300 sha UNEXPECTED: $SNAP_SHA vs $ORIG_SHA"; } >> "$OUT/06-info.txt"
    btrfs scrub start -B -R "$MOUNT" > "$OUT/06-scrub-post.txt" 2>&1 || true
    grep -E "csum_errors|corrected_errors|uncorrectable_errors" "$OUT/06-scrub-post.txt" >> "$OUT/06-info.txt" || true

    # GT-8c: fail a DIFFERENT data member, whole-stripe read must be correct
    DD=$(python3 -c "
pd=$PD; n=$N
print(' '.join(str((pd+1+d)%n) for d in range(n-1) if (pd+1+d)%n != $CI))")
    OTHER=$(echo "$DD" | awk '{print $1}')
    OTHERDEV=$(sed -n "$(( OTHER + 1 ))p" "$GT/state/members.txt")
    echo "failing m$OTHER ($OTHERDEV)" >> "$OUT/06-info.txt"
    mdadm "$MDDEV" --fail "$OTHERDEV" >> "$OUT/06-info.txt" 2>&1
    drop_caches
    python3 "$GT/05-verify.py" "$MDDEV" "$STRIPE" "$N" 65536 > "$OUT/06-stripe-verify.txt" 2>&1 || true
    tail -1 "$OUT/06-stripe-verify.txt"

    echo 1 > "$M/rmw_level" 2>/dev/null || true
    teardown_all
}

# GT-12: RAID6 — XOR alone cannot reconstruct; write the KEPT original with
# rmw_level=0, then fail the P member and verify Q reconstruction.
raid6_fix() {
    bash "$GT/00-rig.sh" 6
    python3 "$GT/01-markers.py" f5
    bash "$GT/02-locate.sh" f5
    MDDEV=$(cat "$GT/state/mddev.txt"); M=$(mdsys "$MDDEV")
    LOCS="$GT/state/locate_f5.json"
    MEMBER=$(python3 -c "import json;print(json.load(open('$LOCS'))['scan_hits'][0][0])")
    MOFF=$(python3 -c "import json;print(json.load(open('$LOCS'))['scan_hits'][0][1])")
    MDBYTE=$(python3 -c "import json;print(json.load(open('$LOCS'))['md_byte'])")
    STRIPE=$(python3 -c "import json;print(json.load(open('$LOCS'))['stripe'])")
    N=$(python3 -c "import json;print(json.load(open('$LOCS'))['n'])")
    PD=$(python3 -c "import json;print(json.load(open('$LOCS'))['parity_disk'])")
    QD=$(python3 -c "import json;print(json.load(open('$LOCS'))['q_disk'])")
    CI=${MEMBER#m}
    MEMDEV=$(sed -n "$(( CI + 1 ))p" "$GT/state/members.txt")
    {
        echo "RAID6: corrupt member=$MEMBER moff=$MOFF md_byte=$MDBYTE stripe=$STRIPE P=m$PD Q=m$QD"
        echo "rmw_level default: $(cat "$M/rmw_level")"
    } > "$OUT/06-info-raid6.txt"

    head -c 4096 /dev/urandom > "$KEEP/f5.junk"
    dd if="$KEEP/f5.junk" of="$MEMDEV" bs=4096 seek=$((MOFF/4096)) count=1 conv=notrunc oflag=direct status=none
    drop_caches
    bounded_check "$MDDEV" $((STRIPE*128)) $(((STRIPE+1)*128)) || true
    echo "pre-repair mismatch_cnt=$(cat "$M/mismatch_cnt")" >> "$OUT/06-info-raid6.txt"

    echo 0 > "$M/rmw_level"
    echo "rmw_level now: $(cat "$M/rmw_level")" >> "$OUT/06-info-raid6.txt"
    dd if="$KEEP/f5.blk300" of="$MDDEV" bs=4096 seek=$((MDBYTE/4096)) count=1 conv=notrunc,fsync oflag=direct status=none
    drop_caches
    if bounded_check "$MDDEV" $((STRIPE*128)) $(((STRIPE+1)*128)); then
        echo "post-repair mismatch_cnt=$(cat "$M/mismatch_cnt")  (expected 0)" >> "$OUT/06-info-raid6.txt"
    else
        echo "UNEXPECTED: bounded check did not complete" >> "$OUT/06-info-raid6.txt"
    fi

    # fail the P member; whole-stripe read must be fully correct (Q exercised)
    PDEV=$(sed -n "$(( PD + 1 ))p" "$GT/state/members.txt")
    echo "failing P member m$PD ($PDEV)" >> "$OUT/06-info-raid6.txt"
    mdadm "$MDDEV" --fail "$PDEV" >> "$OUT/06-info-raid6.txt" 2>&1
    drop_caches
    python3 "$GT/05-verify.py" "$MDDEV" "$STRIPE" "$N" 65536 > "$OUT/06-stripe-verify-raid6.txt" 2>&1 || true
    tail -1 "$OUT/06-stripe-verify-raid6.txt"
    echo 1 > "$M/rmw_level" 2>/dev/null || true
    teardown_all
}

# negative control: fresh RAID6, rmw_level DEFAULT, naive write -> mismatch_cnt
raid6_negative() {
    bash "$GT/00-rig.sh" 6
    python3 "$GT/01-markers.py" f5
    bash "$GT/02-locate.sh" f5
    MDDEV=$(cat "$GT/state/mddev.txt"); M=$(mdsys "$MDDEV")
    LOCS="$GT/state/locate_f5.json"
    MEMBER=$(python3 -c "import json;print(json.load(open('$LOCS'))['scan_hits'][0][0])")
    MOFF=$(python3 -c "import json;print(json.load(open('$LOCS'))['scan_hits'][0][1])")
    MDBYTE=$(python3 -c "import json;print(json.load(open('$LOCS'))['md_byte'])")
    STRIPE=$(python3 -c "import json;print(json.load(open('$LOCS'))['stripe'])")
    CI=${MEMBER#m}
    MEMDEV=$(sed -n "$(( CI + 1 ))p" "$GT/state/members.txt")
    {
        echo "RAID6 negative control: rmw_level=$(cat "$M/rmw_level") (default)"
        echo "corrupt member=$MEMBER moff=$MOFF md_byte=$MDBYTE stripe=$STRIPE"
    } > "$OUT/06-info-raid6-neg.txt"
    head -c 4096 /dev/urandom > "$KEEP/f5.junk"
    dd if="$KEEP/f5.junk" of="$MEMDEV" bs=4096 seek=$((MOFF/4096)) count=1 conv=notrunc oflag=direct status=none
    drop_caches
    bounded_check "$MDDEV" $((STRIPE*128)) $(((STRIPE+1)*128)) || true
    echo "pre-repair mismatch_cnt=$(cat "$M/mismatch_cnt")" >> "$OUT/06-info-raid6-neg.txt"
    dd if="$KEEP/f5.blk300" of="$MDDEV" bs=4096 seek=$((MDBYTE/4096)) count=1 conv=notrunc,fsync oflag=direct status=none
    drop_caches
    bounded_check "$MDDEV" $((STRIPE*128)) $(((STRIPE+1)*128)) || true
    echo "post-naive-write mismatch_cnt=$(cat "$M/mismatch_cnt")" >> "$OUT/06-info-raid6-neg.txt"
    echo "raid_disks=$(cat "$M/raid_disks") rmw_level=$(cat "$M/rmw_level")" >> "$OUT/06-info-raid6-neg.txt"
    teardown_all
}

raid5_fix
raid6_fix
raid6_negative
echo "06 done"
