#!/bin/bash
# lib.sh — shared helpers for the AHR self-heal ground-truth drill (selfheal.1).
# Sources are pushed to the node and sourced by every stage script.
# Safety: only loop devices created from /root/gtsh/m* are ever touched.

GT=/root/gtsh
OUT=$GT/out
KEEP=$GT/keep
MOUNT=/mnt/gtsh
VG=gtsh
LV=data
MD5=gtsh5
MD6=gtsh6

out() { # out <name> <cmd...>  — run cmd, capture stdout+stderr to $OUT/<name>.txt
    local name=$1; shift
    mkdir -p "$OUT"
    { "$@"; } >"$OUT/$name.txt" 2>&1
}

drop_caches() { sync; echo 3 > /proc/sys/vm/drop_caches; }

# md sysfs device for /dev/md/gtshN — resolved /dev/mdNNN
mdsys() { local m=/sys/block/$(basename "$(readlink -f "$1")")/md; echo "$m"; }

mdsys_get() { cat "$(mdsys "$1")/$2"; }

wait_idle() { # wait_idle <mdname> [cap_seconds]
    local m=$(mdsys "$1") cap=${2:-120} i=0
    while [ "$(cat "$m/sync_action")" != idle ]; do
        sleep 1; i=$((i+1)); [ $i -ge $cap ] && return 1
    done
    return 0
}

bounded_check() { # bounded_check <mdname> <min> <max>  — sets knobs, runs check, ends it.
    # UNEXPECTED(brief): md does NOT go idle when a check reaches sync_max < device
    # end; it SUSPENDS at the boundary with sync_action stuck on "check". Writing
    # "idle" is refused (EBUSY) while the op is active — the resume path is
    # echo max > sync_max, after which the op completes and md returns to idle.
    local m=$(mdsys "$1") a i=0 max=$3 poked=0
    echo "$2" > "$m/sync_min"
    echo "$max" > "$m/sync_max"
    echo check > "$m/sync_action" || return 1
    while :; do
        a=$(cat "$m/sync_action")
        if [ "$a" = idle ]; then
            echo 0 > "$m/sync_min" 2>/dev/null || true
            echo max > "$m/sync_max" 2>/dev/null || true
            return 0
        fi
        if [ $poked -eq 0 ] && [ "$a" = check ] && cat "$m/sync_completed" 2>/dev/null |
                awk -v m="$max" '{exit !($1+0 >= m)}'; then
            echo max > "$m/sync_max" && poked=1
        fi
        sleep 1; i=$((i+1)); [ $i -ge ${4:-120} ] && return 1
    done
}

restore_sync_knobs() { # restore_sync_knobs <mdname>
    local m=$(mdsys "$1")
    echo max > "$m/sync_max" 2>/dev/null || true
    echo 0    > "$m/sync_min" 2>/dev/null || true
}

teardown_all() { # teardown everything the drill may have created; tolerates absence
    sync
    umount "$MOUNT"                 2>/dev/null || true
    umount "$MOUNT/@snap"           2>/dev/null || true
    lvremove -f /dev/$VG/$LV        2>/dev/null || true
    vgremove $VG                    2>/dev/null || true
    for pv in $(pvs --noheadings -o pv_name 2>/dev/null | grep -E '^/dev/md' || true); do
        case "$(readlink -f "$pv")" in /dev/md*) pvremove -f "$pv" 2>/dev/null || true;; esac
    done
    for md in /dev/md/gtsh5 /dev/md/gtsh6; do
        [ -e "$md" ] || continue
        mdadm --stop "$md" 2>/dev/null || true
    done
    # detach only loops backed by /root/gtsh files (every m?, not just m0)
    for f in "$GT"/m?; do
        [ -e "$f" ] || continue
        for lo in $(losetup -j "$f" 2>/dev/null | cut -d: -f1); do
            losetup -d "$lo" 2>/dev/null || true
        done
    done
    for f in "$GT"/m?; do
        [ -e "$f" ] && rm -f "$f"
    done
    rm -rf "$MOUNT" 2>/dev/null || true
}

# Per-stage safety net: on exit (incl. error) restore md knobs and rmw_level the
# stage may have changed. The RIG ITSELF persists across stages by design —
# full teardown_all runs at the START of 00-rig.sh (clean slate) and in
# 99-teardown.sh at the end of the drill.
stage_guard() { # stage_guard <mdname> [rmw_sysfs_path]
    local md=$1 rmw=${2:-}
    trap '
        [ -n "$rmw" ] && cat /root/gtsh/state/rmw_backup 2>/dev/null > "$rmw" 2>/dev/null
        restore_sync_knobs "$md"
    ' EXIT 2>/dev/null || true
}

restore_rmw_backup() { # restore_rmw_backup <sysfs-rmw-path>
    local rmw=$1
    [ -f "$GT/state/rmw_backup" ] && cat "$GT/state/rmw_backup" > "$rmw" 2>/dev/null || true
}
