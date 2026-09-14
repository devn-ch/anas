#!/bin/bash
# 09-gt18.sh — GT-18: PARITY-member rot through the two-phase scrub + bounded
# md repair (A), and the data-member negative (E): does `md repair` rewrite
# parity to match what the data members hold — right verb for parity-only rot,
# and the "blessing" trap for data rot?
# Run on the node: bash /root/gtsh/09-gt18.sh
# Teardowns: rig A torn down at the start of rig E (00-rig.sh); E at the end.
set -euo pipefail
source /root/gtsh/lib.sh
OUTG="$OUT/gt18"
mkdir -p "$OUTG"

geom() { # geom <locate.json> -> "stripe parity_disk data_disk data_moff"
    python3 - "$1" <<'EOF'
import json, sys
j = json.load(open(sys.argv[1]))
print(j['stripe'], j['parity_disk'], j['scan_hits'][0][0][1:], j['scan_hits'][0][1])
EOF
}

check() { # check <mdname> <stripe> — bounded md check, stripe cache evicted first
    # (GT-14 rule: a check that does not evict the cache reads cached content)
    python3 - "$@" <<'EOF'
import sys
sys.path.insert(0, '/root/gtsh/suite')
from common import bounded_window_check
print("bounded_window_check mismatch_cnt =", bounded_window_check(sys.argv[1], int(sys.argv[2])))
EOF
}

bounded_settle() { # bounded_settle <mdname> <sync_max_sectors>
    # Wait for a user-started sync op to finish its bounded window. GT-5/GT-13:
    # an op that REACHES sync_max < end SUSPENDS with sync_action stuck — widen
    # to max to let it run out, then end it with idle, then restore the knobs.
    local m=$(mdsys "$1") maxs=$2 a c i=0 poked=0
    while [ $i -lt 180 ]; do
        a=$(cat "$m/sync_action")
        if [ "$a" = idle ]; then break; fi
        c=$(awk '{print $1}' "$m/sync_completed" 2>/dev/null || echo none)
        if [ $poked -eq 0 ] && [ "$c" != none ] && [ "$c" -ge "$maxs" ] 2>/dev/null; then
            if echo max > "$m/sync_max"; then poked=1; fi
        fi
        sleep 1; i=$((i+1))
    done
    [ "$a" = idle ] || { echo idle > "$m/sync_action" 2>/dev/null || true; }
    sleep 1
    restore_sync_knobs "$1"
}

coldread() { # coldread <path> <keep-block-file>
    drop_caches
    local tmp="$OUTG/coldread.tmp"
    if dd if="$1" bs=4096 skip=300 count=1 iflag=direct of="$tmp" status=none \
            2>"$tmp.err"; then
        echo "cold read blk300: SUCCESS sha=$(sha256sum < "$tmp" | cut -d' ' -f1)"
        echo "  kept block sha: $(sha256sum < "$2" | cut -d' ' -f1)"
        if cmp -s "$tmp" "$2"; then echo "  content: MATCH"; else echo "  content: MISMATCH"; fi
    else
        echo "cold read blk300: FAILED (dd rc!=0):"
        sed 's/^/  /' "$tmp.err"
    fi
}

start_rig() { # start_rig <label> — MUST run in the current shell: the caller
    # uses its MDDEV/M/STRIPE/PDISK/DDISK/MOFF/PMDEV/DMDEV variables.
    echo "=== $1: fresh rig + f1 marker + locate ==="
    bash "$GT/00-rig.sh" 5 2>&1 | tee -a "$OUTG/run.log"
    python3 "$GT/01-markers.py" f1 2>&1 | tee -a "$OUTG/run.log"
    bash "$GT/02-locate.sh" f1 2>&1 | tee -a "$OUTG/run.log"
    MDDEV=$(cat "$GT/state/mddev.txt"); M=$(mdsys "$MDDEV")
    read -r STRIPE PDISK DDISK MOFF < <(geom "$GT/state/locate_f1.json")
    PMDEV=$(sed -n "$((PDISK+1))p" "$GT/state/members.txt")
    DMDEV=$(sed -n "$((DDISK+1))p" "$GT/state/members.txt")
    {
        echo "md=$MDDEV"
        echo "f1 blk300: stripe=$STRIPE data=m$DDISK($DMDEV) parity=m$PDISK($PMDEV) row_moff=$MOFF"
        echo "rmw_level=$(cat "$M/rmw_level") stripe_cache_size=$(cat "$M/stripe_cache_size")"
    } > "$OUTG/${1##* }-info.txt"
    cat "$OUTG/${1##* }-info.txt"
}

junk() { # junk <outfile> — fresh 4 KiB of urandom
    head -c 4096 /dev/urandom > "$1"
}

repair_bounded() { # repair_bounded <outfile>
    # The brief's verb, then the sysfs path if the verb did not start an op:
    # sync_min/sync_max bound the window, mdadm --action=repair, wait, idle,
    # restore knobs. Every attempt is recorded verbatim.
    local f=$1
    {
        echo "set: sync_min=$((STRIPE*128)) sync_max=$(((STRIPE+1)*128))"
        echo $((STRIPE*128)) > "$M/sync_min"
        echo $(((STRIPE+1)*128)) > "$M/sync_max"
        echo "  sync_min=$(cat "$M/sync_min") sync_max=$(cat "$M/sync_max")"
        echo "--- mdadm --action=repair $MDDEV"
        if mdadm --action=repair "$MDDEV" < /dev/null; then
            echo "  rc=0"
        else
            echo "  rc=$? (mdadm output above, if any)"
        fi
        sleep 1
        echo "  sync_action now: $(cat "$M/sync_action")"
        if [ "$(cat "$M/sync_action")" = idle ]; then
            echo "--- echo repair > sync_action (sysfs path)"
            if echo repair > "$M/sync_action"; then
                echo "  rc=0"
            else
                echo "  rc=$? (write error above, if any)"
            fi
            sleep 1
            echo "  sync_action now: $(cat "$M/sync_action")"
        fi
        bounded_settle "$MDDEV" $(((STRIPE+1)*128))
        echo "final: sync_action=$(cat "$M/sync_action") sync_completed=$(cat "$M/sync_completed") mismatch_cnt=$(cat "$M/mismatch_cnt")"
        echo "restored: sync_min=$(cat "$M/sync_min") sync_max=$(cat "$M/sync_max")"
    } > "$f" 2>&1
    cat "$f"
}

# ================= A: PARITY member rot =================
start_rig "A"
junk "$OUTG/A-parity.junk"
echo "A: junk sha=$(sha256sum < "$OUTG/A-parity.junk" | cut -d' ' -f1)" | tee -a "$OUTG/run.log"
# corrupt 4 KiB of the PARITY member at the stripe row (behind md)
dd if="$OUTG/A-parity.junk" of="$PMDEV" bs=4096 seek=$((MOFF/4096)) count=1 \
    conv=notrunc oflag=direct status=none
drop_caches
echo "A: corrupted PARITY member $PMDEV at moff=$MOFF (4 KiB); data member $DMDEV untouched" | tee -a "$OUTG/run.log"

echo "A: (a) scrub" | tee -a "$OUTG/run.log"
{
    echo "=== GT-18a: btrfs scrub start -B -R (parity member rot, data intact) ==="
    rc=0
    btrfs scrub start -B -R /dev/gtsh/data || rc=$?
    echo "scrub rc=$rc"
} > "$OUTG/A-02-scrub.txt" 2>&1
sed 's/^/  /' "$OUTG/A-02-scrub.txt" | tee -a "$OUTG/run.log"

echo "A: (b) bounded check" | tee -a "$OUTG/run.log"
{
    echo "=== GT-18b: bounded md check over stripe $STRIPE (cache evicted) ==="
    check "$MDDEV" "$STRIPE" || echo "bounded check FAILED (see output above)"
    echo "mismatch_cnt=$(cat "$M/mismatch_cnt")"
} > "$OUTG/A-03-check.txt" 2>&1
sed 's/^/  /' "$OUTG/A-03-check.txt" | tee -a "$OUTG/run.log"

echo "A: (c) cold read" | tee -a "$OUTG/run.log"
{
    echo "=== GT-18c: cold read of f1 block 300 through btrfs ==="
    coldread "$MOUNT/@data/f1.bin" "$KEEP/f1.blk300"
} > "$OUTG/A-04-coldread.txt" 2>&1
sed 's/^/  /' "$OUTG/A-04-coldread.txt" | tee -a "$OUTG/run.log"

echo "A: (d) bounded md repair" | tee -a "$OUTG/run.log"
repair_bounded "$OUTG/A-05-repair.txt" | tee -a "$OUTG/run.log"

echo "A: (d) post-repair: check + read + XOR" | tee -a "$OUTG/run.log"
{
    echo "=== GT-18d post: bounded check + cold read + parity==XOR(data) ==="
    check "$MDDEV" "$STRIPE" || echo "bounded check FAILED (see output above)"
    echo "mismatch_cnt=$(cat "$M/mismatch_cnt")"
    coldread "$MOUNT/@data/f1.bin" "$KEEP/f1.blk300"
    echo "--- parity row vs XOR of the 5 data rows at moff=$MOFF (parity=m$PDISK):"
    python3 "$GT/09-gt18-xor.py" "$MOFF" 6 "$PDISK"
} > "$OUTG/A-06-post.txt" 2>&1
sed 's/^/  /' "$OUTG/A-06-post.txt" | tee -a "$OUTG/run.log"

# ================= E: DATA member rot (negative) =================
start_rig "E"
junk "$OUTG/E-data.junk"
# corrupt 4 KiB of the DATA member at the stripe row (behind md)
dd if="$OUTG/E-data.junk" of="$DMDEV" bs=4096 seek=$((MOFF/4096)) count=1 \
    conv=notrunc oflag=direct status=none
drop_caches
echo "E: corrupted DATA member $DMDEV at moff=$MOFF (4 KiB); parity member $PMDEV untouched" | tee -a "$OUTG/run.log"

echo "E: pre-repair bounded check" | tee -a "$OUTG/run.log"
{
    echo "=== GT-18e pre: bounded md check over stripe $STRIPE (data member rot) ==="
    check "$MDDEV" "$STRIPE" || echo "bounded check FAILED (see output above)"
    echo "mismatch_cnt=$(cat "$M/mismatch_cnt")"
} > "$OUTG/E-03-precheck.txt" 2>&1
sed 's/^/  /' "$OUTG/E-03-precheck.txt" | tee -a "$OUTG/run.log"

echo "E: bounded md repair" | tee -a "$OUTG/run.log"
repair_bounded "$OUTG/E-05-repair.txt" | tee -a "$OUTG/run.log"

echo "E: post-repair: check + read + XOR" | tee -a "$OUTG/run.log"
{
    echo "=== GT-18e post: bounded check + cold read + parity==XOR(data incl. rot) ==="
    check "$MDDEV" "$STRIPE" || echo "bounded check FAILED (see output above)"
    echo "mismatch_cnt=$(cat "$M/mismatch_cnt")"
    coldread "$MOUNT/@data/f1.bin" "$KEEP/f1.blk300"
    echo "--- parity row vs XOR of the 5 data rows at moff=$MOFF (parity=m$PDISK):"
    python3 "$GT/09-gt18-xor.py" "$MOFF" 6 "$PDISK"
    echo "--- is the parity row equal to the junk we wrote on the data member?"
    python3 - "$MOFF" "$PDISK" "$OUTG/E-data.junk" <<'EOF'
import sys
sys.path.insert(0, '/root/gtsh/suite')
from common import read_direct
moff, pd, junk = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
print("parity row == junk:", read_direct(f"/root/gtsh/m{pd}", moff, 4096) == open(junk,'rb').read())
EOF
} > "$OUTG/E-06-post.txt" 2>&1
sed 's/^/  /' "$OUTG/E-06-post.txt" | tee -a "$OUTG/run.log"

teardown_all
echo "09 done (all rigs torn down)"
