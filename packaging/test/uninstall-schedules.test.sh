#!/usr/bin/env bash
#
# Tests for packaging/uninstall.sh remove_schedule_units (review R8): the
# uninstaller removes the ANAS schedule units (anas-scrub.* AND the snapshot
# schedules it never removed before) and RESTORES mdadm's mdcheck timers when
# it removed the scrub timer — selfheal.4 disabled them when ANAS took md
# checks over, so without this the node would be left with NO periodic parity
# check at all.
#
# uninstall.sh is sourced in ANAS_UNINSTALL_LIB_ONLY mode (the install.sh
# pattern) with a throwaway SYSTEMD_DIR/stamp dir and a faked systemctl that
# records every argv — no root, no real node.
#
#   bash packaging/test/uninstall-schedules.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNINSTALL="${HERE}/../uninstall.sh"

PASS=0
FAIL=0
check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  ok   ${desc}"; PASS=$((PASS + 1))
  else
    echo "  FAIL ${desc}"; FAIL=$((FAIL + 1))
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

SYSTEMD_DIR="${WORK}/systemd"
STAMPS="${WORK}/timers"
SYSTEMCTL="${WORK}/systemctl"
mkdir -p "${SYSTEMD_DIR}" "${STAMPS}"

# Faked systemctl: record argv, always succeed.
cat > "${SYSTEMCTL}" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${WORK}/systemctl.log"
exit 0
EOF
chmod +x "${SYSTEMCTL}"

# Source the uninstaller in lib mode and expose remove_schedule_units.
source_uninstall() {
  : > "${WORK}/systemctl.log"
  PATH="$(dirname "${SYSTEMCTL}"):${PATH}" \
    SYSTEMD_DIR="${SYSTEMD_DIR}" TIMERS_STAMP_DIR="${STAMPS}" \
    ANAS_UNINSTALL_LIB_ONLY=1 bash -c "source '${UNINSTALL}'; remove_schedule_units"
}

# Fixture: the units a 0.3.1-upgraded node with periodic scrub + two snapshot
# schedules would carry, including Persistent stamps.
make_units() {
  : > "${WORK}/systemctl.log"
  rm -rf "${SYSTEMD_DIR}" "${STAMPS}"
  mkdir -p "${SYSTEMD_DIR}" "${STAMPS}"
  printf '[Service]\n' > "${SYSTEMD_DIR}/anas-scrub.service"
  printf '[Timer]\n'   > "${SYSTEMD_DIR}/anas-scrub.timer"
  : > "${STAMPS}/stamp-anas-scrub.timer"
  for n in nightly hourly; do
    printf '[Service]\n' > "${SYSTEMD_DIR}/anas-snap-${n}.service"
    printf '[Timer]\n'   > "${SYSTEMD_DIR}/anas-snap-${n}.timer"
    : > "${STAMPS}/stamp-anas-snap-${n}.timer"
  done
}

echo "== 1. uninstall with a scrub timer restores the mdcheck timers =="
make_units
source_uninstall
check "anas-scrub.timer disabled before removal" \
  grep -q 'disable --now anas-scrub.timer' "${WORK}/systemctl.log"
check "both scrub unit files removed" \
  bash -c "! test -e '${SYSTEMD_DIR}/anas-scrub.timer' && ! test -e '${SYSTEMD_DIR}/anas-scrub.service'"
check "the scrub timer's Persistent stamp removed" \
  bash -c "! test -e '${STAMPS}/stamp-anas-scrub.timer'"
check "mdcheck_start re-enabled" \
  grep -q 'enable mdcheck_start.timer mdcheck_continue.timer' "${WORK}/systemctl.log"

echo "== 2. snapshot schedule units + stamps go with it =="
check "snapshot units removed" \
  bash -c "! test -e '${SYSTEMD_DIR}/anas-snap-nightly.service' && ! test -e '${SYSTEMD_DIR}/anas-snap-nightly.timer' && ! test -e '${SYSTEMD_DIR}/anas-snap-hourly.timer'"
check "snapshot stamps removed" \
  bash -c "! test -e '${STAMPS}/stamp-anas-snap-nightly.timer' && ! test -e '${STAMPS}/stamp-anas-snap-hourly.timer'"
check "each snapshot timer disabled" \
  bash -c "grep -q 'disable --now anas-snap-nightly.timer' '${WORK}/systemctl.log' && grep -q 'disable --now anas-snap-hourly.timer' '${WORK}/systemctl.log'"

echo "== 3. no scrub timer → mdcheck left exactly as it is =="
make_units
rm -f "${SYSTEMD_DIR}/anas-scrub.timer" "${SYSTEMD_DIR}/anas-scrub.service" "${STAMPS}/stamp-anas-scrub.timer"
source_uninstall
check "no mdcheck enable without a removed scrub timer" \
  bash -c "! grep -q 'enable mdcheck' '${WORK}/systemctl.log'"
check "snapshot units still removed" \
  bash -c "! test -e '${SYSTEMD_DIR}/anas-snap-nightly.timer'"

echo "== 4. idempotent — a second run is clean =="
make_units
source_uninstall >/dev/null 2>&1
source_uninstall >/dev/null 2>&1
check "second run removes nothing, enables nothing" \
  bash -c "! grep -q 'enable mdcheck' '${WORK}/systemctl.log' && ! grep -q 'anas-scrub' '${WORK}/systemctl.log'"

echo "== 5. the printed line names the restoration =="
make_units
PATH="$(dirname "${SYSTEMCTL}"):$PATH" SYSTEMD_DIR="${SYSTEMD_DIR}" TIMERS_STAMP_DIR="${STAMPS}" \
  ANAS_UNINSTALL_LIB_ONLY=1 bash -c "source '${UNINSTALL}'; remove_schedule_units" > "${WORK}/out.log" 2>&1
check "restoration line printed" \
  grep -q "restored mdadm's mdcheck timers" "${WORK}/out.log"
check "scrub removal line printed" \
  grep -q 'removed the ANAS periodic scrub units' "${WORK}/out.log"

echo
echo "uninstall-schedules tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
