#!/bin/bash
# 12-gt21.sh — GT-21: does an ordinary `apt` mdadm upgrade re-enable mdcheck
# timers an admin disabled? Run on the node: bash /root/gtsh/12-gt21.sh
# The ANAS ruling leaves both timers DISABLED — the script restores that at
# the end if anything (reinstall, preset) flipped them.
set -uo pipefail
OUTG="/root/gtsh/out/gt21"
mkdir -p "$OUTG"

{
    echo "=== GT-21: BEFORE ==="
    echo "--- systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer:"
    systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
    echo "--- systemctl list-unit-files 'mdcheck*':"
    systemctl list-unit-files 'mdcheck*' --no-pager 2>&1
    echo "--- /var/lib/systemd/deb-systemd-helper-enabled/ (mdcheck state files):"
    ls -la /var/lib/systemd/deb-systemd-helper-enabled/ | grep -i mdcheck || echo "(no mdcheck entries)"
    echo "--- apt-cache policy mdadm:"
    apt-cache policy mdadm
} > "$OUTG/01-before.txt" 2>&1

echo "=== GT-21: apt-get install --reinstall mdadm ===" | tee "$OUTG/run.log"
echo "DEBIAN_FRONTEND=noninteractive apt-get install --reinstall -y mdadm" > "$OUTG/02-reinstall.txt"
DEBIAN_FRONTEND=noninteractive apt-get install --reinstall -y mdadm >> "$OUTG/02-reinstall.txt" 2>&1
echo "apt rc=$?" >> "$OUTG/02-reinstall.txt"
sed 's/^/  /' "$OUTG/02-reinstall.txt" | tee -a "$OUTG/run.log"

{
    echo "=== GT-21: AFTER reinstall ==="
    echo "--- systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer:"
    systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
    echo "--- /var/lib/systemd/deb-systemd-helper-enabled/ (mdcheck state files):"
    ls -la /var/lib/systemd/deb-systemd-helper-enabled/ | grep -i mdcheck || echo "(no mdcheck entries)"
} > "$OUTG/03-after.txt" 2>&1
sed 's/^/  /' "$OUTG/03-after.txt" | tee -a "$OUTG/run.log"

{
    echo "=== GT-21: systemctl preset mdcheck_start.timer ==="
    echo "before: $(systemctl is-enabled mdcheck_start.timer)"
    systemctl preset mdcheck_start.timer
    echo "preset rc=$?"
    echo "after: $(systemctl is-enabled mdcheck_start.timer)"
    echo "--- preset files in effect:"
    cat /etc/systemd/system-preset/*.preset 2>/dev/null || true
    cat /usr/lib/systemd/system-preset/*.preset 2>/dev/null || true
    echo "--- /var/lib/systemd/deb-systemd-helper-enabled/ (mdcheck state files):"
    ls -la /var/lib/systemd/deb-systemd-helper-enabled/ | grep -i mdcheck || echo "(no mdcheck entries)"
} > "$OUTG/04-preset.txt" 2>&1
sed 's/^/  /' "$OUTG/04-preset.txt" | tee -a "$OUTG/run.log"

{
    echo "=== GT-21: FINAL (must end DISABLED per the ANAS ruling) ==="
    for t in mdcheck_start.timer mdcheck_continue.timer; do
        st=$(systemctl is-enabled "$t")
        if [ "$st" != disabled ]; then
            echo "RESTORING $t: $st -> disabled"
            systemctl disable "$t" 2>&1
        fi
    done
    echo "--- final is-enabled:"
    systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
} > "$OUTG/05-final.txt" 2>&1
sed 's/^/  /' "$OUTG/05-final.txt" | tee -a "$OUTG/run.log"
echo "12 done"
