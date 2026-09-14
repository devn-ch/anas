#!/bin/bash
# 14-gt23.sh — GT-23 (story selfheal.12): does md's stripe cache still hide
# below-md rot from the ENGINE's own eviction on kernel 7.0.14-17?
#
# Builds a BARE RAID5 rig — six 200 MiB loops, chunk 64K, --assume-clean,
# members zeroed so parity starts correct — and nothing above it. GT-23 is a
# question about md's cache alone: no LVM, no btrfs, nothing that could be
# damaged by writing raw md bytes, and no filesystem whose own I/O would touch
# the stripes under test.
#
# Run on the node. Raw output under /root/gtsh/out/gt23/.
set -euo pipefail
source /root/gtsh/lib.sh
teardown_all
mkdir -p "$GT/state" "$OUT/gt23"

loops=()
for i in 0 1 2 3 4 5; do
    f=$GT/m$i
    truncate -s 200M "$f"
    dd if=/dev/zero of="$f" bs=1M count=200 status=none   # zeroed: parity=0 is correct
    loops+=("$(losetup -f --show "$f")")
done
printf '%s\n' "${loops[@]}" > "$GT/state/loops.txt"

log=$GT/state/mdadm-create.log
mdadm --create /dev/md/gtsh5 --level=5 --raid-devices=6 --chunk=64K \
    --assume-clean --metadata=1.2 "${loops[@]}" >"$log" 2>&1 </dev/null || {
    echo "mdadm --create FAILED:" >&2; cat "$log" >&2; exit 1
}
mdadm --wait /dev/md/gtsh5 >/dev/null 2>&1 || true
MDRES=$(readlink -f /dev/md/gtsh5)
echo "$MDRES" > "$GT/state/mddev.txt"
MDSYS=/sys/block/$(basename "$MDRES")/md
for i in 0 1 2 3 4 5; do
    [ -d "$MDSYS/rd$i" ] || { echo "gt23: $MDRES has no rd$i" >&2; ls "$MDSYS" >&2; exit 1; }
done

python3 "$GT/14-gt23.py" "$MDRES" | tee "$OUT/gt23/gt23.txt"
rc=${PIPESTATUS[0]}

teardown_all
exit "$rc"
