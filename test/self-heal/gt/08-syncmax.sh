#!/bin/bash
# 08-syncmax.sh — GT-13: a check run under sync_max < max stops at sync_max AND
# the knob persists — a re-run without restoring stops there again; only
# echo max > sync_max restores full coverage.
set -euo pipefail
source /root/gtsh/lib.sh
bash "$GT/00-rig.sh" 5
python3 "$GT/01-markers.py" f1
MDDEV=$(cat "$GT/state/mddev.txt"); M=$(mdsys "$MDDEV")

wait_check_settled() { # wait_check_settled <target> — poll until idle, or (for a
    # bounded run, target < device end) suspended at the boundary completed>=target
    local target=${1:-256} i=0 a
    while :; do
        a=$(cat "$M/sync_action")
        if [ "$a" = idle ]; then echo idle; return 0; fi
        if [ "$a" = check ] && [ "$target" != full ] && cat "$M/sync_completed" 2>/dev/null |
                awk -v t="$target" '{exit !($1+0 >= t)}'; then
            echo suspended; return 0
        fi
        sleep 1; i=$((i+1)); [ $i -ge 120 ] && { echo timeout; return 1; }
    done
}

{
    echo 0 > "$M/sync_min"
    echo 256 > "$M/sync_max"
    echo "set: sync_min=$(cat "$M/sync_min") sync_max=$(cat "$M/sync_max") resync_start=$(cat "$M/resync_start")"
    echo check > "$M/sync_action"
    echo "run 1: settled=$(wait_check_settled 256) sync_completed=$(cat "$M/sync_completed")"
    echo "ending run 1 at the boundary with echo idle > sync_action:"
    echo idle > "$M/sync_action" && echo "  idle accepted (op ended, coverage 0..256 only)" \
        || echo "  UNEXPECTED: idle rejected"
    sleep 2
    echo "resync_start after run 1: $(cat "$M/resync_start")"
    echo "run 2 (sync_max still 256 — the trap):"
    echo check > "$M/sync_action"
    echo "run 2: settled=$(wait_check_settled 256) sync_completed=$(cat "$M/sync_completed")"
    echo idle > "$M/sync_action" 2>/dev/null || true
    sleep 2
    echo "run 3 (echo 0 > sync_min; echo max > sync_max first):"
    echo 0 > "$M/sync_min"
    echo max > "$M/sync_max"
    echo check > "$M/sync_action"
    echo "run 3: settled=$(wait_check_settled full) sync_completed_during=$(sleep 2; cat "$M/sync_completed") final_action=$(cat "$M/sync_action")"
    restore_sync_knobs "$MDDEV"
    echo "restored: sync_min=$(cat "$M/sync_min") sync_max=$(cat "$M/sync_max")"
} > "$OUT/08-syncmax.txt" 2>&1
cat "$OUT/08-syncmax.txt"
teardown_all
echo "08 done"
