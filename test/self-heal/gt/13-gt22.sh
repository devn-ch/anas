#!/bin/bash
# 13-gt22.sh — GT-22: can a MIRROR band's mismatch be repaired with md's own
# mechanism via a "fail-one-leg scrub"? Run on the node: bash /root/gtsh/13-gt22.sh
#
# 2-member RAID1 loop rig (00-rig.sh 1), f1 marker at block 300 located by the
# raw signature scan (13-gt22.py scan) on BOTH legs. Arms:
#   (a) rot on leg A only — 3 cold btrfs scrubs through md (csum_errors 0 or 1
#       each: did md serve the rotten leg?), bounded mismatch_cnt
#   (b) order 1: fail leg B (the GOOD leg) -> scrub names f1 -> --remove B ->
#       hand repair the way the engine would (original block written THROUGH md,
#       lands on A only) -> junk into removed B's block -> --re-add B ->
#       recovery (direction: does A overwrite B's junk?) -> mismatch 0, cold OK
#   (c) order 2, fresh rig: rot on A, fail A (the BAD leg) -> scrub reads only
#       B -> expected CLEAN -> re-add A -> resync B over A -> all good
#       (c2) UNEXPECTED(run 2): --re-add of a FAILED-but-present member "succeeds"
#       with a no-op recovery and the rot on A SURVIVES — so c2 redoes the arm
#       the engine-correct way: --remove A then --add A = a REAL recovery
#   (d) read-balance: both legs in, 5 cold scrubs (does md ever serve the rotten
#       leg?); then good leg failed, 3 scrubs (the error must ALWAYS appear)
#   (e) recovery durations + /proc/mdstat rate lines (recovery_watch files)
#   (f) mdadm --action=repair on a RAID1 with rot on A, then on B (fresh rigs):
#       which copy propagates — the "do not run md repair on a mirror" evidence
# UNEXPECTED(first run): a scrub that SEES the rot can also HEAL the band —
# btrfs re-reads (md then serves the good leg), writes the good block back
# through md, and md propagates it to BOTH legs (corrected_errors=1, array
# clean afterwards). So every multi-run scrub arm re-injects a FRESH rot before
# each run — otherwise run N measures the array run N-1 healed.
# Every mdadm call gets </dev/null; teardown_all between rigs; node left clean.
set -uo pipefail
GT=/root/gtsh
OUTG=$GT/out/gt22
mkdir -p "$OUTG"
source "$GT/lib.sh"
MDDEV=$(cat "$GT/state/mddev.txt")
MOUNT=$(cat "$GT/state/workdir.txt")
MEMBERS=($(cat "$GT/state/members.txt"))   # /dev/loopN, one per leg; m0 = leg A
LOG=$OUTG/run.log
note() { echo "=== $*" | tee -a "$LOG"; }
mdsys_path() { mdsys "$MDDEV"; }           # lib.sh's mdsys, bound to this rig

# scrub_once <label> — one cold btrfs scrub; start -B -R (summary + error lines)
# AND status -R (raw counters) captured verbatim.
scrub_once() {
    local label=$1 f="$OUTG/$1-scrub.txt"
    drop_caches
    {
        echo "--- btrfs scrub start -B -R $MOUNT"
        btrfs scrub start -B -R "$MOUNT" 2>&1
        echo "scrub rc=$?"
        echo "--- btrfs scrub status -R $MOUNT"
        btrfs scrub status -R "$MOUNT" 2>&1
    } > "$f" 2>&1
    grep -E "csum_errors|corrected_errors|uncorrectable_errors|read_errors" "$f" \
        | tr -s ' \n\t' ' ' | sed "s/^/[$label] /" | tee -a "$LOG"
    grep -iE "csum|error" "$f" | grep -vE "_errors:|no_csum|csum_discards" \
        | sed "s/^/[$label] /" | tee -a "$LOG" || true
    # the per-file/per-bytenr error naming is NOT in the scrub summary — it is
    # kernel dmesg (GT-3); capture the tail so the naming evidence is kept
    dmesg | tail -30 > "$OUTG/$1-dmesg.txt" 2>&1
    grep -iE "checksum|btrfs" "$OUTG/$1-dmesg.txt" | head -4 \
        | sed "s/^/[$label dmesg] /" | tee -a "$LOG" || true
}

# mcnt <label> — mismatch_cnt read AFTER a settle delay (GT-18: it is briefly
# stale when a sync op settles)
mcnt() {
    sleep 1
    echo "[$1] mismatch_cnt=$(mdsys_get "$MDDEV" mismatch_cnt)" | tee -a "$LOG"
}

# bcheck <label> — bounded check over the WHOLE array (lib.sh bounded_check
# handles the sync_max boundary-suspend, GT-13), then the settled count
bcheck() {
    local size
    size=$(cat "/sys/block/$(basename "$(readlink -f "$MDDEV")")/size")
    if bounded_check "$MDDEV" 0 "$size" 300; then
        mcnt "$1 (bounded full check)"
    else
        echo "[$1] UNEXPECTED: bounded check did not return to idle in 300s" | tee -a "$LOG"
    fi
}

# brepair <label> — mdadm --action=repair bounded to the whole device (GT-18:
# a repair with no recovery target may ignore sync_max entirely — whatever it
# does to the window is recorded, not asserted)
brepair() {
    local m; m=$(mdsys_path)
    local size
    size=$(cat "/sys/block/$(basename "$(readlink -f "$MDDEV")")/size")
    echo 0 > "$m/sync_min"
    echo "$size" > "$m/sync_max"
    local t0=$(date +%s.%N)
    mdadm --action=repair "$MDDEV" < /dev/null > "$OUTG/$1-repair-cmd.txt" 2>&1
    echo "[$1] mdadm --action=repair rc=$?" | tee -a "$LOG"
    local i=0 a
    while :; do
        a=$(cat "$m/sync_action")
        [ "$a" = idle ] && break
        sleep 0.1; i=$((i+1)); [ $i -ge 1200 ] && { echo "[$1] UNEXPECTED: repair not idle after 120s" | tee -a "$LOG"; break; }
    done
    local t1=$(date +%s.%N)
    {
        echo "sync_completed during/after: $(cat "$m/sync_completed" 2>/dev/null)"
        echo "duration: $(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.2f", b-a}')s"
    } > "$OUTG/$1-repair-timing.txt" 2>&1
    restore_sync_knobs "$MDDEV"
    mcnt "$1 post-repair"
}

# recovery_watch <label> <mdadm re-add cmd + args...> — poll md state at 20 Hz
# from BEFORE the re-add call until idle; captures /proc/mdstat lines,
# sync_completed and the duration. A REFUSED re-add is returned to the caller
# (sync_action stays idle, so the poll loop alone would silently pass).
recovery_watch() {
    local label=$1; shift
    local m; m=$(mdsys_path)
    local f="$OUTG/$label-recovery.txt" t0=$(date +%s.%N) a
    {
        echo "--- mdstat BEFORE re-add:"
        grep -A2 "$(basename "$(readlink -f "$MDDEV")")" /proc/mdstat
        echo "sync_completed: $(cat "$m/sync_completed" 2>/dev/null)"
    } > "$f" 2>&1
    {
        echo "--- mdstat BEFORE re-add:"
        grep -A2 "$(basename "$(readlink -f "$MDDEV")")" /proc/mdstat
    } | tee -a "$LOG"
    "$@" < /dev/null >> "$OUTG/$label-readd-cmd.txt" 2>&1
    local rc=$?
    echo "[$label] $* rc=$rc ($(tr '\n' ' ' < "$OUTG/$label-readd-cmd.txt" | head -c 200))" | tee -a "$LOG"
    [ $rc -eq 0 ] || return $rc
    local i=0 line comp
    while :; do
        a=$(cat "$m/sync_action")
        comp=$(cat "$m/sync_completed" 2>/dev/null)
        line=$(grep -A2 "$(basename "$(readlink -f "$MDDEV")")" /proc/mdstat | tr '\n' '|')
        echo "$(date +%s.%N) action=$a comp=$comp stat=[$line]" >> "$f"
        [ "$a" = idle ] && break
        sleep 0.05; i=$((i+1)); [ $i -ge 6000 ] && { echo "[$label] UNEXPECTED: not idle after 300s" | tee -a "$LOG"; break; }
    done
    local t1=$(date +%s.%N)
    echo "[$label] recovery done in $(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.2f", b-a}')s (200 MiB leg)" | tee -a "$LOG"
    {
        echo "--- final:"
        grep -A2 "$(basename "$(readlink -f "$MDDEV")")" /proc/mdstat
        echo "sync_completed: $(cat "$m/sync_completed" 2>/dev/null)"
        echo "duration_seconds: $(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.2f", b-a}')"
    } >> "$f" 2>&1
    grep -E "resync|recover|speed" "$f" | tail -5 | sed 's/^/  /' | tee -a "$LOG" || true
}

detail() { # detail <label> — one-line md state: detail State + mdstat status line
    {
        echo "--- mdadm --detail $MDDEV (State / RAID level / legs):"
        mdadm --detail "$MDDEV" < /dev/null | grep -E "State|RaidLevel|RaidDevice|Number"
        echo "--- /proc/mdstat:"
        grep -A2 "$(basename "$(readlink -f "$MDDEV")")" /proc/mdstat
    } > "$OUTG/$1-detail.txt" 2>&1
    grep -E "^State|^\[|blocks" "$OUTG/$1-detail.txt" | sed "s/^/[$1] /" | tee -a "$LOG"
}

byte() { # byte <label> <args...> — 13-gt22.py, output to log + file
    local label=$1; shift
    local f="$OUTG/$label.txt"
    python3 "$GT/13-gt22.py" "$@" < /dev/null > "$f" 2>&1
    echo "[$label] $(cat "$f")" | tee -a "$LOG"
}

build_rig() { # build_rig <label> — full teardown + fresh RAID1 rig + marker + scan
    note "building fresh rig ($1)"
    bash "$GT/00-rig.sh" 1 < /dev/null > "$OUTG/$1-rig-build.txt" 2>&1 || {
        echo "rig build FAILED — see $OUTG/$1-rig-build.txt" | tee -a "$LOG"; exit 1; }
    MDDEV=$(cat "$GT/state/mddev.txt")
    MEMBERS=($(cat "$GT/state/members.txt"))
    python3 "$GT/01-markers.py" f1 < /dev/null > "$OUTG/$1-markers.txt" 2>&1
    byte "$1-scan" scan
}

# ============================== PHASE 1: (a) + (b) — order 1, rot on A, fail GOOD leg B
note "PHASE 1 (a)+(b): rot on leg A (m0), fail the GOOD leg B (m1)"
build_rig p1
byte p1-rotA rot 0
note "(a) which leg does md serve? cold single-block read first"
drop_caches
if dd if="$MOUNT/f1.bin" bs=4096 skip=300 count=1 iflag=direct of=/dev/null \
        > "$OUTG/p1-a-coldread.txt" 2>&1; then
    served="SUCCESS (good leg served)"
else
    served="EIO (rot leg served)"
fi
echo "[a] cold read of blk300 through md: $served" | tee -a "$LOG"
tail -1 "$OUTG/p1-a-coldread.txt" | tee -a "$LOG"
for i in 1 2 3; do
    note "(a) fresh rot on A, cold scrub $i/3"
    byte "p1-a-rot$i" rot 0
    scrub_once "p1-a-scrub$i"
    byte "p1-a-post-blkA$i" blk 0
    byte "p1-a-post-blkB$i" blk 1
done
byte p1-a-rot-final rot 0
bcheck "p1-a"
note "(b) fail leg B (the GOOD leg)"
mdadm --fail "$MDDEV" "${MEMBERS[1]}" < /dev/null > "$OUTG/p1-b-00-fail.txt" 2>&1
echo "[b] mdadm --fail loopB rc=$?" | tee -a "$LOG"
detail p1-b-01-after-fail
note "(b) scrub with only the rotten leg A servable"
scrub_once "p1-b-02"
grep -B1 -A4 "f1.bin" "$OUTG/p1-b-02-scrub.txt" | head -14 | tee -a "$LOG" || true
mdadm --remove "$MDDEV" "${MEMBERS[1]}" < /dev/null > "$OUTG/p1-b-03-remove.txt" 2>&1
echo "[b] mdadm --remove loopB rc=$?" | tee -a "$LOG"
detail p1-b-04-after-remove
byte p1-b-05-writemd writemd
byte p1-b-06-blkA blk 0
byte p1-b-07-blkB-removed blk 1
byte p1-b-08-rotB rot 1
byte p1-b-09-blkB-junk blk 1
note "(b) re-add leg B — recovery_watch captures mdstat/direction/duration"
if ! recovery_watch p1-b mdadm --re-add "$MDDEV" "${MEMBERS[1]}"; then
    echo "[b] --re-add refused, falling back to --add" | tee -a "$LOG"
    recovery_watch p1-b-add mdadm --add "$MDDEV" "${MEMBERS[1]}"
fi
detail p1-b-10-after-recovery
bcheck "p1-b"
byte p1-b-11-blkB blk 1
byte p1-b-12-blkA blk 0
byte p1-b-13-coldread coldread

# ============================== PHASE 2: (c) — order 2, fresh rig, fail the BAD leg
note "PHASE 2 (c): fresh rig, rot on leg A (m0), fail the BAD leg A"
build_rig p2
byte p2-rotA rot 0
note "(c) fail leg A (the BAD leg); only good leg B servable"
mdadm --fail "$MDDEV" "${MEMBERS[0]}" < /dev/null > "$OUTG/p2-00-fail.txt" 2>&1
echo "[c] mdadm --fail loopA rc=$?" | tee -a "$LOG"
detail p2-01-after-fail
for i in 1 2 3; do
    note "(c) cold scrub $i/3 (only B servable — expected clean)"
    scrub_once "p2-02-scrub$i"
done
note "(c) re-add leg A — resync must copy B over A"
bcheck "p2-pre-readd"
if ! recovery_watch p2 mdadm --re-add "$MDDEV" "${MEMBERS[0]}"; then
    echo "[c] --re-add refused, falling back to --add" | tee -a "$LOG"
    recovery_watch p2-add mdadm --add "$MDDEV" "${MEMBERS[0]}"
fi
detail p2-03-after-recovery
bcheck "p2-post-readd"
byte p2-04-blkA blk 0
byte p2-05-blkB blk 1
byte p2-06-coldread coldread
note "(c2) engine-correct arm: --fail + --remove A then --add A forces a REAL recovery"
mdadm --fail "$MDDEV" "${MEMBERS[0]}" < /dev/null > "$OUTG/p2-c2-00-fail.txt" 2>&1
echo "[c2] mdadm --fail loopA rc=$?" | tee -a "$LOG"
mdadm --remove "$MDDEV" "${MEMBERS[0]}" < /dev/null > "$OUTG/p2-c2-00-remove.txt" 2>&1
echo "[c2] mdadm --remove loopA rc=$?" | tee -a "$LOG"
detail p2-c2-01-after-remove
if ! recovery_watch p2-c2 mdadm --add "$MDDEV" "${MEMBERS[0]}"; then
    echo "[c2] --add failed" | tee -a "$LOG"
fi
detail p2-c2-02-after-recovery
bcheck "p2-c2"
byte p2-c2-03-blkA blk 0
byte p2-c2-04-blkB blk 1
byte p2-c2-05-coldread coldread

# ============================== PHASE 3: (d) — read-balance leakage
note "PHASE 3 (d): fresh rig, rot on leg A (m0), read-balance leakage"
build_rig p3
byte p3-rotA rot 0
for i in 1 2 3 4 5; do
    note "(d) fresh rot on A, cold scrub $i/5 (RAID1: no stripe_cache to evict, GT-16)"
    byte "p3-d-rot$i" rot 0
    scrub_once "p3-d-scrub$i"
    byte "p3-d-post-blkA$i" blk 0
done
bcheck "p3-d"
note "(d) fail leg B (the GOOD leg) — the scrub must now ALWAYS see the error"
mdadm --fail "$MDDEV" "${MEMBERS[1]}" < /dev/null > "$OUTG/p3-00-fail.txt" 2>&1
echo "[d] mdadm --fail loopB rc=$?" | tee -a "$LOG"
detail p3-01-after-fail
for i in 1 2 3; do
    note "(d) fresh rot on A, only rot leg servable, cold scrub $i/3"
    byte "p3-d-frot$i" rot 0
    scrub_once "p3-d-failed-scrub$i"
done

# ============================== PHASE 4: (f) — mdadm --action=repair on a mirror
for leg in 0 1; do
    note "PHASE 4 (f): fresh rig, rot on leg $([ $leg = 0 ] && echo A || echo B) (m$leg), mdadm --action=repair"
    build_rig "p4-$leg"
    byte "p4-$leg-rot" rot $leg
    bcheck "p4-$leg-pre"
    detail "p4-$leg-pre-detail"
    brepair "p4-$leg"
    detail "p4-$leg-post-detail"
    byte "p4-$leg-blkA" blk 0
    byte "p4-$leg-blkB" blk 1
    byte "p4-$leg-coldread" coldread
done

# ============================== teardown, node must be clean
note "teardown"
teardown_all
bash "$GT/99-teardown.sh" > "$OUTG/99-teardown.txt" 2>&1 || true
{
    echo "--- /proc/mdstat:"; cat /proc/mdstat
    echo "--- gtsh loops still attached:"; losetup -a | grep gtsh || echo "(none)"
    echo "--- rig files left:"; ls "$GT"/m? 2>/dev/null || echo "(none)"
    echo "--- mdcheck timers (must stay disabled, ANAS ruling):"
    systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
} > "$OUTG/99-clean.txt" 2>&1
cat "$OUTG/99-clean.txt" | tee -a "$LOG"
echo "GT-22 done — outputs in $OUTG"
