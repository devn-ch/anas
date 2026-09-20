# Live proof — upgrade rehearsal, 0.3.1 → main (`selfheal` line on a production-shaped node)

Driven 2026-09-14 against the disposable stunt PVE 9 node `anas-pve` (192.168.200.50), kernel
`7.0.14-12-pve`, pve-manager `9.2.11`. The question: **pve5 runs 0.3.1 in production with the OLD
periodic-scrub toggle ON (mdcheck timers enabled by ANAS 0.3.1) and a killed-repair-shaped md
state is the worst a live node can present — its upgrade to the self-heal line must be boring.**
Every step below ran on the node; every command's output is verbatim. The deliverable's verdict
word was decided before writing: **BORING — every upgrade invariant held, nothing was fixed.**

Code under test: `v0.3.1` (the GitHub release tarball `anas-0.3.1.tar.gz`, its own
`packaging/install.sh`) and `main` @ `02d9fe3` (release tarball built with
`packaging/make-release.sh --dev` — dev mode, **no git tag created**, smoke-tested by the build:
daemon + gateway boot on the pruned node_modules).

The upgrade path used is the **production tarball path, not `deploy-anas.sh`**: the dev script is
an rsync of a working tree plus hand-written unit files — nothing a production node ever runs.
`packaging/install.sh`'s own contract is "a re-run is a clean in-place upgrade (backup → install →
drop backup on success)", which is exactly what pve5 will do: untar the release and run
`install.sh`. That is what ran here, twice (once 0.3.1, once main over it).

Notifications were captured the same way as `LIVE-PROOF-SELFHEAL.md`: `root@pam`'s email pointed
at a throwaway local mailbox for the round (`anasmail`), restored to `root@localhost` afterwards.
The mailbox is byte-counted at each checkpoint so "no notification" is a measured claim.

## Verdicts

| Question | Verdict |
|---|---|
| main's `uninstall.sh` mdcheck restore (first live run) | **PROVEN** — RESTORED branch printed, timers enabled |
| 0.3.1 installed + production shape reproduced | **PROVEN** — toggle ON = mdcheck enabled, no ANAS units |
| The upgrade in place (0.3.1 → main) | **PROVEN** — reconcile restored the dirty knobs, no adoption, mdcheck untouched, no notification, data intact |
| The takeover + give-back on main | **PROVEN** — units + marker, mdcheck off; then units removed, mdcheck back on, node returns to stock |
| Final uninstall (timers enabled, no scrub timer on disk) | **PROVEN** — restore branch correctly does not fire, no mdcheck line at all |

**Findings: 0 defects, 3 rehearsal observations (O1–O3, no action required).** Nothing was fixed.

---

## 1. The rig, and where the node started

The node was already running `main` @ `02d9fe3` (dev-deployed: no `/opt/anas/VERSION`,
`package.json` still says 0.3.1 — see O1), left over from the self-heal suite rounds: no AHR
pools, no `anas-scrub` units, and mdcheck **disabled** — the standing state this node's ruling
left it in:

```
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
disabled
disabled
$ ls /etc/systemd/system/ | grep ^anas
anas.service
anasd.service
anas-backup-lp-*.service/.timer   (3 pairs — leftovers of the backup live-proof round)
$ cat /proc/mdstat | tail -1
unused devices: <none>
```

Four 2 GiB spares were hot-attached (`add-spare-disks.sh 4 10 2048` → `ANAS_HOT10..13` →
`/dev/sdl..sdo`; 2 GiB because §2.5 floors every disk's usable size to a whole GiB — 512 MiB
bands to nothing, `LIVE-PROOF-SELFHEAL.md` §1).

A pool was created through **main's** API so the pre-uninstall node had a live scrub schedule on
it (that is what the first uninstall run needs in order to prove its restore branch):

```
POST /v1/ahr/layout/preview  {"disks":[…ANAS_HOT10..13…],"tier":"ahr1"}
→ one band: raid5, memberCount 4, usableBytes 6442450944, minDisksMet true

POST /v1/ahr  {"name":"up0","tier":"ahr1","disks":[…]}
→ 409  x-anas-confirm-code: 0ffaafa60358  (4 disks will be completely erased)
POST /v1/ahr … (x-anas-confirm: 0ffaafa60358) → 202 job ahr.create, completed in 32 s
  {"created":"up0","mountpoint":"/mnt/anas-ahr/up0","arrays":["up0-r1"]}
```

§12 layout confirmed on disk:

```
/dev/up0/up0-vol /mnt/anas-ahr/up0 btrfs nofail,subvol=@data,x-systemd.before=rtslib-fb-targetctl.service,x-systemd.device-timeout=45s 0 0
/dev/mapper/up0-up0--vol[/@data] /mnt/anas-ahr/up0 btrfs … subvolid=256,subvol=/@data
md127 : active raid5 sde1[4] sdd1[2] sdc1[1] sdb1[0]   6274560 blocks super 1.2 level 5, 512k chunk [4/4] [UUUU]
```

The periodic scrub toggle was enabled (main semantics — ANAS takes mdcheck over):

```
PUT /v1/scrub/ahr/up0 {"enabled":true,"cadence":"monthly"} → 202 job scrub.ahr.toggle
  {"pool":"up0","periodicScrub":true,"cadence":"monthly","scope":"node-level"}

$ cat /etc/systemd/system/anas-scrub.timer
# X-ANAS-Schedule={"kind":"ahr-scrub","cadence":"monthly","pools":["up0"]}   ← marker in BOTH files
OnCalendar=Sun *-*-01..07 03:00:00   Persistent=true
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
disabled   disabled          ← ANAS owns md checks
```

---

## 2. Step 1 — main's uninstall, first live run, then 0.3.1 installed

### The uninstall (mdcheck restore branch, live for the first time)

State before: `anas-scrub.service`/`.timer` on disk, mdcheck `disabled/disabled`.

```
$ bash /opt/anas/packaging/uninstall.sh
==> Uninstalling ANAS (prefix: /opt/anas)...
    stopping and disabling services
    reverting PVE UI integration
anas: removed script line from /usr/share/pve-manager/index.html.tpl
anas: removed /usr/share/pve-manager/js/anas.js
anas: removed apt hook /etc/apt/apt.conf.d/80anas-pve-integration
anas: excised the ANAS hook block from /usr/share/perl5/PVE/APIServer/AnyEvent.pm (another project's hook is present and was preserved)
anas: pveproxy restarted (proxy hook removed)
anas: removed /usr/share/anas/perl/AnasProxy.pm
anas: PVE UI integration uninstalled.
    removed systemd unit files
    removed 3 ANAS schedule unit pair(s) (anas-backup-*)
    removed 1 ANAS schedule unit pair (anas-scrub.*)
    ANAS periodic scrub removed. mdadm's own parity check (mdcheck_start.timer, mdcheck_continue.timer) — the distro default, which ANAS disabled when the scrub was enabled — has been RESTORED;
    run `systemctl disable --now mdcheck_start.timer mdcheck_continue.timer` if you do not want a periodic md parity check on this node.
    removed the iSCSI ordering drop-in (targetcli-fb, python3-rtslib-fb and the saved LIO configuration are left alone)
    removed md-event hook /usr/local/bin/anas-md-event
    removed ANAS notification templates from /usr/share/pve-manager/templates/default
    removing /opt/anas

==> ANAS uninstalled.

$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
enabled
enabled
```

The RESTORED branch (sixth-pass N7 wording) printed exactly once, and the timers are genuinely
enabled after. The 3 `anas-backup-lp-*` pairs went with it — the uninstaller's one rule for all
four schedule families (their runners die with `/opt/anas`; a lost schedule is the honest outcome
of uninstalling). No `/etc/systemd/system/anas*` unit survived; the pool's on-disk state
(fstab, mdadm.conf, md127, mounted `@data`) was untouched by the uninstall, as designed.

### 0.3.1 installed from its own release tarball

```
$ tar -xzf anas-0.3.1.tar.gz && cd anas-0.3.1 && ./install.sh
    (preflight: PVE 9.2.11, Node v22.23.2, ZFS 2.4.3, mdadm/btrfs-progs/samba/nfs/targetcli present)
    gateway port: 3000 (default)
==> Preflight OK.
==> Installing ANAS to /opt/anas ...
    copying application files
    ...
    wrote /etc/default/anas (ANAS_PORT=3000)
    waiting for health check
    gateway responded on :3000 (HTTP 401)
    UI integration verified
==> ANAS 0.3.1 installed — https://192.168.200.50:8006 (the normal PVE web UI)
```

0.3.1 **sees the pool main created** and reads its scrub state the 0.3.1 way — this is precisely
pve5's production shape before its upgrade:

```
GET /v1/ahr    → up0, healthy, subvolLayout: true
GET /v1/scrub  → {"target":{"kind":"ahr","pool":"up0"},"enabled":true,"cadence":"monthly",
                  "mechanism":"mdcheck-timer",
                  "note":"md checks are node-global (every array on the host); this toggle governs md periodic checks for all AHR pools.",
                  "lastScrub":null}
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
enabled enabled
```

The pool was then destroyed through the 0.3.1 API (confirm gate → 202 `ahr.destroy`) and
**recreated through the 0.3.1 API** so the pool under test for the rest of the round is a
0.3.1-native create (§12 layout, healthy, 22 s):

```
{"created":"up0","mountpoint":"/mnt/anas-ahr/up0","arrays":["up0-r1"]}
```

---

## 3. Step 2 — the 0.3.1 production shape, files, and the killed-repair simulation

The 0.3.1 toggle was enabled (its semantics: flip **mdcheck** on; it writes no ANAS units):

```
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer   # before
enabled enabled
PUT /v1/scrub/ahr/up0 {"enabled":true} → 202 job scrub.ahr.toggle
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer   # after
enabled enabled
$ ls /etc/systemd/system/anas-scrub.* 2>/dev/null || echo 'none (0.3.1 writes no units)'
none (0.3.1 writes no units)
```

Three files written into the mounted `@data` tree (checksums below are the upgrade's own test):

```
c518f8ec…7d412  f1.bin       (8 MiB random)
e183bba0…45b2f  docs/f2.bin  (1 MiB random, in a directory)
ddbe3cf8…47aa21 notes.txt    (1 MiB repeated text)
```

Then the md knobs a SIGKILLed repair leaves behind (D4's exact scenario), on `up0-r1`
(`/dev/md127`), with md's own defaults recorded first:

```
BEFORE:  rmw_level=1 stripe_cache_size=256 sync_min=0 sync_max=max sync_action=idle
echo 0    > /sys/block/md127/md/rmw_level
echo 17   > /sys/block/md127/md/stripe_cache_size
echo 1024 > /sys/block/md127/md/sync_max        # one 512 KiB stripe — GT-13's trap
AFTER:   rmw_level=0 stripe_cache_size=17 sync_min=0 sync_max=1024 sync_action=idle
```

Mailbox checkpoint: 7698 bytes (six pool-create-era messages: two mdadm `DegradedArray`
initial-resync events, two `ANAS: md RebuildFinished` from the md-event hook, two
`ANAS: AHR pool created`). **Nothing from this point on may add a byte.**

---

## 4. Step 3 — the upgrade in place: 0.3.1 → main

```
$ cd /root/anas-up/anas-0.3.1+dev.02d9fe3 && ./install.sh
==> Preflight checks (no changes will be made)...
    upgrade: ANAS 0.3.1 -> 0.3.1+dev.02d9fe3
    PVE node detected: pve-manager/9.2.11/f6997e698c7933ea (running kernel: 7.0.14-12-pve)
    ...
    gateway port: 3000 (preserved from /etc/default/anas)
    existing ANAS gateway is listening on :3000 — it will be stopped and upgraded
==> Preflight OK.
==> Installing ANAS to /opt/anas ...
    stopping running anasd/anas
    backing up existing /opt/anas -> /opt/anas.bak.1789402341
    copying application files
    installing md-event hook -> /usr/local/bin/anas-md-event
    installing PVE notification templates -> /usr/share/pve-manager/templates/default
    wrote /etc/default/anas (ANAS_PORT=3000)
    installing systemd units
    installed iSCSI ordering drop-in -> /etc/systemd/system/rtslib-fb-targetctl.service.d/anas-ordering.conf
    starting services
    waiting for health check
    gateway responded on :3000 (HTTP 401)
    installing PVE UI integration
anas: installed /usr/share/pve-manager/js/anas.js (generated from src/)
anas: bundle cache-bust token v=a69548642a30
anas: re-stamped script line in /usr/share/pve-manager/index.html.tpl (?v=a69548642a30)
anas: proxy hook already present in /usr/share/perl5/PVE/APIServer/AnyEvent.pm (nothing to do)
anas: installed apt hook /etc/apt/apt.conf.d/80anas-pve-integration
anas: PVE UI integration installed.
    UI integration verified
==> ANAS 0.3.1+dev.02d9fe3 installed
```

### The daemon-start journal — reconciliation, and nothing else

```
Sep 14 16:12:21 anas-pve systemd[1]: Stopping anasd.service - ANAS Daemon...
Sep 14 16:12:21 anas-pve systemd[1]: Started anasd.service - ANAS Daemon.
Sep 14 16:12:21 anas-pve node[1388991]: {"msg":"Server listening at /run/anas/anasd.sock"}
Sep 14 16:12:21 anas-pve node[1388991]: {"msg":"anasd listening on /run/anas/anasd.sock"}
Sep 14 16:12:22 anas-pve node[1388991]: {"level":40,"msg":"selfheal reconcile: up0-r1: sync window restored to 0..max (was 0..1024 — a repair left it bounded to one stripe, which would have made the next parity check cover that stripe alone)"}
Sep 14 16:12:22 anas-pve node[1388991]: {"level":40,"msg":"selfheal reconcile: up0-r1: rmw_level restored to 1 (was 0)"}
Sep 14 16:12:22 anas-pve node[1388991]: {"level":40,"msg":"selfheal reconcile: up0-r1: stripe_cache_size restored to 256 (was 17)"}
```

All three dirty knobs read off the kernel and put back at md's own defaults, one journald line
each, one second after the socket came up — the upgrade restarted anasd mid-"killed repair" and
the D4 reconciliation did exactly what it exists for. No transient pin was found to sweep (none
existed — nothing logged), and there is **no adoption line and no unit written**: main's F1
ruling removed mdcheck adoption; for comparison, the intermediate Sep-13 build on this node
logged `scrub-schedules: mdcheck adoption skipped (mdcheck-not-enabled)` at every start — the
current build logs nothing about mdcheck at daemon start at all.

### Every upgrade invariant, checked

```
$ ls /etc/systemd/system/anas-scrub.* 2>/dev/null || echo 'does not exist'
does not exist                                    ← no ANAS scrub unit written
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
enabled
enabled                                           ← 0.3.1's toggle left untouched
$ systemctl is-active anas-scrub.timer 2>/dev/null || echo inactive
inactive

GET /v1/scrub (AHR row):
  {"target":{"kind":"ahr","pool":"up0"},"enabled":false,"cadence":"monthly",
   "mechanism":"mdcheck-timer","nextRun":null,"phases":["md-parity","btrfs-checksums"],
   "note":"the OS's monthly md parity check (mdcheck) is on — the distro default, and what ANAS
           puts back when the last pool's periodic scrub is turned off; enabling ANAS periodic
           scrub takes it over (md parity + btrfs checksums, two phases)",
   "lastScrub":null}
                                                  ← the legacy state, reported read-only;
                                                    the Scrubs UI renders this note verbatim
$ for a in rmw_level stripe_cache_size sync_min sync_max sync_action …
rmw_level=1 stripe_cache_size=256 sync_min=0 sync_max=max sync_action=idle   ← md defaults
$ cat /proc/mdstat      → [4/4] [UUUU], no check/resync running
GET /v1/ahr             → up0 healthy, arrays [(1,'clean')], advisories []
$ sha256sum f1.bin docs/f2.bin notes.txt     ← all three unchanged
$ wc -c < /var/mail/anasmail
7698                                              ← BYTE-IDENTICAL: the upgrade sent no notification
```

The ZFS rows (`gtbackup`, `gtiscsi`, `zfs-property` mechanism) were untouched by the upgrade and
kept reporting `enabled: true` throughout.

---

## 5. Step 4 — the takeover, and the give-back

```
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer   # before
enabled enabled
PUT /v1/scrub/ahr/up0 {"enabled":true,"cadence":"monthly"} → 202 job scrub.ahr.toggle (618 ms)

$ cat /etc/systemd/system/anas-scrub.timer
[Unit]
Description=ANAS periodic AHR scrub timer
# X-ANAS-Schedule={"kind":"ahr-scrub","cadence":"monthly","pools":["up0"]}
[Timer]
OnCalendar=Sun *-*-01..07 03:00:00
Persistent=true
$ systemctl is-active anas-scrub.timer; systemctl show -p NextElapseUSecRealtime anas-scrub.timer
active
NextElapseUSecRealtime=Sun 2026-10-04 03:00:00 UTC
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
disabled
disabled                          ← ANAS owns md checks on this node now

GET /v1/scrub (AHR row): {"enabled":true,"cadence":"monthly","mechanism":"anas-scrub-timer",
  "nextRun":"2026-10-04T03:00:00.000Z","phases":["md-parity","btrfs-checksums"],
  "note":"one node-level timer scrubs the enabled AHR pools sequentially (phase 1 md parity,
          then phase 2 btrfs checksums)"}

PUT /v1/scrub/ahr/up0 {"enabled":false} → 202 job scrub.ahr.toggle (486 ms)
$ ls /etc/systemd/system/anas-scrub.* 2>/dev/null || echo removed
removed
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
enabled
enabled                          ← the last pool went off: the node returns to stock (the ruling)
GET /v1/scrub (AHR row): {"enabled":false,"mechanism":"mdcheck-timer","nextRun":null,
  "note":"the OS's monthly md parity check (mdcheck) is on — the distro default, and what ANAS
          puts back when the last pool's periodic scrub is turned off; enabling ANAS periodic
          scrub takes it over (md parity + btrfs checksums, two phases)"}
$ wc -c < /var/mail/anasmail
7698                             ← toggles notify nothing
```

---

## 6. Step 5 — the final uninstall, re-deploy, teardown

### Uninstall with mdcheck enabled and no scrub timer on disk

After step 4's disable, the `anas-scrub` units are already gone and mdcheck is enabled — the
`restored` branch is gated on an `anas-scrub` unit file existing, so it must not fire, and no
mdcheck line of any kind should print:

```
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer   # before
enabled enabled
$ ls /etc/systemd/system/anas-scrub.*
(nothing)
$ bash /root/anas-up/anas-0.3.1+dev.02d9fe3/uninstall.sh
==> Uninstalling ANAS (prefix: /opt/anas)...
    stopping and disabling services
    reverting PVE UI integration
anas: removed script line from /usr/share/pve-manager/index.html.tpl
anas: removed /usr/share/pve-manager/js/anas.js
anas: removed apt hook /etc/apt/apt.conf.d/80anas-pve-integration
anas: excised the ANAS hook block from /usr/share/perl5/PVE/APIServer/AnyEvent.pm (another project's hook is present and was preserved)
anas: pveproxy restarted (proxy hook removed)
anas: removed /usr/share/anas/perl/AnasProxy.pm
anas: PVE UI integration uninstalled.
    removed systemd unit files
    removed the iSCSI ordering drop-in (targetcli-fb, python3-rtslib-fb and the saved LIO configuration are left alone)
    removed md-event hook /usr/local/bin/anas-md-event
    removed ANAS notification templates from /usr/share/pve-manager/templates/default
    removed /etc/default/anas
    removing /opt/anas

==> ANAS uninstalled.

$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
enabled
enabled           ← untouched: nothing was removed that owned them, so nothing was said
```

No `anas-backup-*` line either — there were no schedule units left of any family. The
`removed 3 ANAS schedule unit pair(s)` of §2 does not reappear.

### Re-deploy, teardown

Current main was re-deployed with the same tarball `install.sh` (fresh-install path this time —
no PREFIX, preflight says so), and the node was put back to its standing state:

```
DELETE /v1/ahr/up0 → 409 confirm (a15644980a5d) → 202 ahr.destroy completed
GET /v1/ahr → {"data":[]}
$ tail -1 /proc/mdstat; grep -c up0 /etc/fstab /etc/mdadm/mdadm.conf
unused devices: <none>   0  0
```

- The four spares (`ANAS_HOT10..13` = `/dev/sdl..sdo`) were detached from the VM and their qcow2
  images deleted from the host.
- mdcheck timers were restored to **DISABLED** — this node's standing ruling (a spindown node
  runs no periodic parity check on purpose; the earlier round left them disabled and the ruling
  for this node is the operator's, not the distro default that governs uninstall):
  `systemctl disable --now mdcheck_start.timer mdcheck_continue.timer` → `disabled disabled`.
- `root@pam`'s email was set back to `root@localhost`; the `anasmail` user and mailbox deleted.
- `/root/anas-0.3.1*`, `/root/anas-up`, the tarballs and the curl header scratch files removed.
  No `/opt/anas.bak.*` was left (the successful upgrade drops its own backup).
- `/root/aq.sh` predates this round and stays.

Node end state: `main` @ `02d9fe3` (tarball-installed, `/opt/anas/VERSION` =
`0.3.1+dev.02d9fe3`), anasd + anas active, no AHR pools, no ANAS schedule units, mdcheck
disabled, ZFS rows unchanged. The final boot's journal carries no self-heal line at all — on a
clean node the reconciliation is silent, as designed.

---

## Observations (no defects; no fixes made)

### O1 — the preflight's version line reads `0.3.1 -> 0.3.1+dev.02d9fe3` because main has not been version-bumped yet

`packaging/install.sh`'s transition detection worked exactly as designed — it read the installed
`/opt/anas/VERSION` (0.3.1, written by 0.3.1's own installer) and the release's VERSION. The
rehearsal's "main" is a `--dev` tarball stamped `0.3.1+dev.02d9fe3` because the 0.4.0 bump is
still pending in release prep. pve5's real upgrade will read `upgrade: ANAS 0.3.1 -> 0.4.0`.
Nothing to change.

### O2 — a dev-deployed node carries no `/opt/anas/VERSION`, so the preflight cannot classify it

This node's pre-rehearsal `main` install came from `deploy-anas.sh` (rsync), which stamps no
VERSION file; upgrading directly over such an install would read `OLD_VERSION="unknown"` and
skip the fresh/reinstall/upgrade classification. No production node can be in that state — the
tarball installer always writes VERSION (pve5 has it). The rehearsal uninstalled the dev install
first, which is also why step 3's upgrade is a faithful stand-in for pve5's: both sides of it
(0.3.1 below, main above) were install.sh-installed. If dev-vs-production provenance ever
matters on a shared node, it is a `deploy-anas.sh` nicety, not a packaging story.

### O3 — the uninstaller's mdcheck line is silent when there was nothing to restore

Step 1 proved the RESTORED branch live. Step 5 proved the other edge: with no `anas-scrub` unit
on disk the uninstaller prints no mdcheck line at all — correct, since ANAS never touched mdcheck
on that pass, and the timers the node already has stay exactly as they were. An operator
uninstalling a node that never enabled the periodic scrub gets no parity-check sentence; that is
honest silence, not a gap. (The one state with no line and no parity check — ANAS units present,
mdcheck masked — is covered by N7's warn branch, unit-tested, not reachable here.)

---

## Left behind

Nothing beyond the node's standing state, listed at the end of §6. Specifically: no ANAS
schedule units, mdcheck disabled per this node's ruling, no AHR pools, no spare disks attached,
no installer backup, no notification-capture artifacts, and the two ZFS ground-truth pools the
node already hosted are exactly as they were.
