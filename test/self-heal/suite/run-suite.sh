#!/bin/bash
# run-suite.sh — dev-box entry for the selfheal.2 loop-device suite.
#
# Pushes the suite (+ the gt rig/lib scripts it reuses) to the stunt node,
# runs it there over ssh, and pulls report.md/report.json back into out/.
# out/report.md is copied to LAST-RUN.md (the committed record).
#
# The suite can also be run entirely on the node:
#   rsync -a test/self-heal/suite/ test/self-heal/gt/{lib.sh,00-rig.sh} node:/root/gtsh/
#   ssh node 'python3 /root/gtsh/suite/suite.py'
#
# Env: NODE (default root@192.168.200.50), REPAIR_CMD (passed through to the
# node run; see README for the contract).
set -euo pipefail
NODE=${NODE:-root@192.168.200.50}
HERE=$(cd "$(dirname "$0")" && pwd)
GTDIR=$(cd "$HERE/../gt" && pwd)

ssh "$NODE" 'mkdir -p /root/gtsh/suite /root/gtsh/suite-out'
rsync -a --delete --exclude out/ --exclude LAST-RUN.md \
    "$HERE/" "$NODE:/root/gtsh/suite/"
rsync -a "$GTDIR/lib.sh" "$GTDIR/00-rig.sh" "$GTDIR/00-rig-twoband.sh" \
    "$NODE:/root/gtsh/"

set +e
# REPAIR_CMD has to cross the ssh boundary explicitly — ssh carries no
# environment of its own, and the README has always said this script passes it
# through (selfheal.5: it did not, so an alternative repair could only be run by
# hand on the node). Quoted so a multi-word command (`node /opt/…/x.js`) stays
# one value.
if [ -n "${REPAIR_CMD:-}" ]; then
    ssh "$NODE" "REPAIR_CMD=$(printf '%q' "$REPAIR_CMD") python3 /root/gtsh/suite/suite.py"
else
    ssh "$NODE" "python3 /root/gtsh/suite/suite.py"
fi
RC=$?
set -e

rsync -a "$NODE:/root/gtsh/suite-out/report.md" "$NODE:/root/gtsh/suite-out/report.json" \
    "$HERE/out/" 2>/dev/null || true
mkdir -p "$HERE/out"
if [ -f "$HERE/out/report.md" ]; then
    # LAST-RUN.md is the reference implementation's record; a run with another
    # REPAIR_CMD gets its own file so neither overwrites the other.
    if [ -n "${REPORT_NAME:-}" ]; then
        cp "$HERE/out/report.md" "$HERE/$REPORT_NAME"
    else
        cp "$HERE/out/report.md" "$HERE/LAST-RUN.md"
    fi
fi
exit "$RC"
