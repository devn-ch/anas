#!/bin/bash
# 99-teardown.sh — end-of-drill full teardown (rig is disposable; runs at the end).
set -euo pipefail
source /root/gtsh/lib.sh
teardown_all
echo "teardown done"
