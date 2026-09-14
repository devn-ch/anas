# Live proof — PVE point-release upgrade of the stunt node (ANAS compatibility)

Driven 2026-09-14 against the disposable stunt PVE node `anas-pve` (192.168.200.50), running ANAS
`0.3.1+dev.02d9fe3` (main @ `02d9fe3`, both services active, no AHR pools, mdcheck timers disabled
by the standing ruling). The upgrade is the one a real operator would run — `apt-get update` +
`apt-get dist-upgrade` — followed by a reboot into the new kernel, and then the same ANAS checks
the node answered before. Every command below ran on the node verbatim; outputs are recorded
unabridged where they carry information.

**Verdict: PROVEN — compatibility held end to end, zero findings against ANAS.** Every fragile
point a PVE release can break survived it: the `AnasProxy.pm` splice, the `index.html.tpl`
injection, the apt Post-Invoke hook that re-applies both, and the gateway/daemon pair itself.

---

## 1. Environment

| | |
|---|---|
| Node | `anas-pve`, PVE 9 VM on the isolated `anas-test` NAT network (192.168.200.50) |
| ANAS install | tarball (`/opt/anas`), version string `0.3.1+dev.02d9fe3` — main @ `02d9fe3` |
| ANAS services | `anas` (gateway), `anasd` (daemon) — both active before and after |
| Repos | enterprise repos **disabled** (pve + pbs, commented out); `pve-no-subscription` in use |
| mdcheck | `mdcheck_start.timer` / `mdcheck_continue.timer` **disabled** before and after (ruling) |
| Pre-existing state | two ZFS pools `gtbackup`/`gtiscsi` and stale share warnings from earlier GT rounds — untouched by this round |

## 2. Versions — before / after

| Component | Before | After |
|---|---|---|
| pve-manager | 9.2.11 (`f6997e698c7933ea`) | **9.2.20** (`49318c671b82f31e`) |
| running kernel | 7.0.14-12-pve | **7.0.14-17-pve** |
| `proxmox-ve` | 9.2.0 | 9.2.0 (unchanged) |
| zfsutils-linux | 2.4.3-pve1 | **2.4.4-pve1** |
| libpve-storage-perl | 9.1.8 | 9.1.10 |
| libpve-common-perl | 9.2.1 | 9.2.2 |
| **libpve-http-server-perl** | **6.0.5** | **6.0.5 (unchanged — the module the splice hooks)** |
| qemu-server | 9.2.6 | 9.2.7 |
| pve-qemu-kvm | 11.0.3-2 | 11.0.3-3 |

18 packages upgradable at capture time (19 lines incl. the `Listing...` header):

```
libnvpair3linux/stable,stable 2.4.4-pve1 amd64 [upgradable from: 2.4.3-pve1]
libpve-apiclient-perl/stable 3.4.3 all [upgradable from: 3.4.2]
libpve-storage-perl/stable 9.1.10 all [upgradable from: 9.1.8]
librados2-perl/stable 1.5.1 amd64 [upgradable from: 1.5.0]
libuutil3linux/stable,stable 2.4.4-pve1 amd64 [upgradable from: 2.4.3-pve1]
libzfs7linux/stable,stable 2.4.4-pve1 amd64 [upgradable from: 2.4.3-pve1]
libzpool7linux/stable,stable 2.4.4-pve1 amd64 [upgradable from: 2.4.3-pve1]
proxmox-kernel-7.0/stable,stable 7.0.14-16 amd64 [upgradable from: 7.0.14-12]
pve-container/stable 6.1.14 all [upgradable from: 6.1.13]
pve-docs/stable 9.2.10 all [upgradable from: 9.2.4]
pve-edk2-firmware-legacy/stable 4.2026.08-1 all [upgradable from: 4.2025.05-3]
pve-edk2-firmware-ovmf/stable 4.2026.08-1 all [upgradable from: 4.2025.05-3]
pve-firmware/stable,stable 3.18-6 all [upgradable from: 3.18-5]
pve-manager/stable 9.2.18 all [upgradable from: 9.2.11]
pve-qemu-kvm/stable 11.0.3-3 amd64 [upgradable from: 11.0.3-2]
qemu-server/stable 9.2.7 amd64 [upgradable from: 9.2.6]
zfs-zed/stable,stable 2.4.4-pve1 amd64 [upgradable from: 2.4.3-pve1]
zfsutils-linux/stable,stable 2.4.4-pve1 amd64 [upgradable from: 2.4.3-pve1]
```

Note the `pve-manager` candidate moved **during the round**: `apt-cache policy` (against the
pre-`update` index) said 9.2.18; after `apt-get update` the install took it to 9.2.20. The point
release moved under us mid-proof and ANAS didn't care.

## 3. The upgrade

```
$ apt-get update   (repo lines, verbatim from the output)
Get:2 https://deb.debian.org/debian trixie InRelease
Get:4 https://deb.debian.org/debian trixie-updates InRelease
Get:5 https://deb.debian.org/debian trixie-backports InRelease
Get:6 https://deb.debian.org/debian-security trixie-security InRelease
Get:10 http://download.proxmox.com/debian/pbs trixie InRelease
Get:11 http://download.proxmox.com/debian/pve trixie InRelease
Get:12 http://download.proxmox.com/debian/pbs trixie/pbs-no-subscription amd64 Packages
Get:13 http://download.proxmox.com/debian/pve trixie/pve-no-subscription amd64 Packages
Fetched 805 kB in 1s (585 kB/s)
```

No 401s — the enterprise repos are disabled as the README documents and never touched.

```
$ DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::="--force-confold" dist-upgrade
  → EXIT=0
```

`--force-confold` was chosen deliberately: keep local conffiles unless the README says otherwise.
In the event **no conffile prompt surfaced at all** — the log contains no conffile/dispatch lines
and no `.dpkg-dist` / `.dpkg-old` files were left anywhere under `/etc` or `/usr/share`.

Upgrade log tail (the informative end):

```
Setting up proxmox-kernel-7.0.14-17-pve-signed (7.0.14-17) ...
Examining /etc/kernel/postinst.d.
run-parts: executing /etc/kernel/postinst.d/initramfs-tools 7.0.14-17-pve /boot/vmlinuz-7.0.14-17-pve
update-initramfs: Generating /boot/initrd.img-7.0.14-17-pve
Running hook script 'zz-proxmox-boot'..
Re-executing '/etc/kernel/postinst.d/zz-proxmox-boot' in new private mount namespace..
No /etc/kernel/proxmox-boot-uuids found, skipping ESP sync.
run-parts: executing /etc/kernel/postinst.d/zz-update-grub 7.0.14-17-pve /boot/vmlinuz-7.0.14-17-pve
Generating grub configuration file ...
Found linux image: /boot/vmlinuz-7.0.14-17-pve
Found initrd image: /boot/initrd.img-7.0.14-17-pve
Found linux image: /boot/vmlinuz-7.0.14-12-pve
...
Adding boot menu entry for UEFI Firmware Settings ...
done
Setting up proxmox-firewall-data (0.1) ...
Setting up libpve-storage-perl (9.1.10) ...
Setting up pve-edk2-firmware-legacy (4.2026.08-1) ...
Setting up pve-firewall (6.0.6) ...
Setting up libuutil3linux:amd64 (2.4.4-pve1) ...
Setting up libzpool7linux:amd64 (2.4.4-pve1) ...
Setting up pve-container (6.1.14) ...
Setting up proxmox-kernel-7.0 (7.0.14-17) ...
Setting up libzfs7linux:amd64 (2.4.4-pve1) ...
No diversion 'diversion of /lib/x86_64-linux-gnu/libzfs_core.so.3 to /lib/x86_64-linux-gnu/libzfs_core.so.3.usr-is-merged by libzfs6linux', none removed.
No diversion 'diversion of /lib/x86_64-linux-gnu/libzfs_core.so.3.0.0 to /lib/x86_64-linux-gnu/libzfs_core.so.3.0.0.usr-is-merged by libzfs6linux', none removed.
Setting up qemu-server (9.2.7) ...
Setting up zfsutils-linux (2.4.4-pve1) ...
zfs-import-scan.service is a disabled or a static unit, not starting it.
Setting up pve-manager (9.2.20) ...
Setting up zfs-zed (2.4.4-pve1) ...
Processing triggers for procps (2:4.0.4-9) ...
Processing triggers for pve-ha-manager (5.2.5) ...
Processing triggers for libc-bin (2.41-12+deb13u4) ...
Processing triggers for systemd (257.13-1~deb13u1) ...
Processing triggers for man-db (2.13.1-1) ...
Processing triggers for dbus (1.16.2-2) ...
adock: installed /usr/share/pve-manager/js/adock.js (generated from src/)
adock: bundle cache-bust token v=92a2ed4ddd9c
adock: inserted script line into /usr/share/pve-manager/index.html.tpl (?v=92a2ed4ddd9c)
adock: installed /usr/share/adock/perl/AdockProxy.pm
adock: proxy hook already present in /usr/share/perl5/PVE/APIServer/AnyEvent.pm (nothing to do)
adock: installed apt hook /etc/apt/apt.conf.d/80adock-pve-integration
adock: PVE UI integration installed.
anas: installed /usr/share/pve-manager/js/anas.js (generated from src/)
anas: bundle cache-bust token v=a69548642a30
anas: inserted script line into /usr/share/pve-manager/index.html.tpl (?v=a69548642a30)
anas: installed /usr/share/anas/perl/AnasProxy.pm
anas: proxy hook already present in /usr/share/perl5/PVE/APIServer/AnyEvent.pm (nothing to do)
anas: installed apt hook /etc/apt/apt.conf.d/80anas-pve-integration
anas: PVE UI integration installed.
```

That tail is the two designed defenses proving themselves live:

- **The fragile point was hit and healed.** The pve-manager upgrade rewrote
  `/usr/share/pve-manager/index.html.tpl`, dropping the injected `<script>` line — exactly the
  documented failure mode — and the `DPkg::Post-Invoke` apt hook (`80anas-pve-integration`)
  re-ran `install.sh` within the same transaction, re-applying it ("anas: inserted script line").
- **The sibling interop held.** ADOCK's integration re-applied *beside* ours ("proxy hook already
  present … nothing to do" on both sides — neither install cost the other its hook; issue #20's
  convention working as designed on a real dpkg transaction).

### Did pveproxy/pvedaemon restart?

**Not during the transaction.** After the upgrade (before the reboot):

```
$ systemctl show pveproxy pvedaemon -p ActiveEnterTimestamp -p NRestarts
pveproxy:  ActiveEnterTimestamp=Mon 2026-09-14 16:14:19 UTC   NRestarts=0
pvedaemon: ActiveEnterTimestamp=Fri 2026-09-11 05:53:13 UTC   NRestarts=0
```

Both pre-date the upgrade. `libpve-http-server-perl` was not in the upgrade set, so
`AnyEvent.pm` was never rewritten and `install.sh`'s restart is correctly splice-conditional
("proxy hook already present (nothing to do)" → no restart). `perl -c` on the live module passed
and the proxy was still serving `/anas` through the old process (authenticated `/v1/status` 200).

### The splice after the transaction

```
$ ls -l /usr/share/anas/perl/AnasProxy.pm
-rw-r--r-- 1 root root 9350 Sep 14 16:31 /usr/share/anas/perl/AnasProxy.pm
$ grep -c Anas /usr/share/perl5/PVE/APIServer/AnyEvent.pm
2
$ perl -c /usr/share/perl5/PVE/APIServer/AnyEvent.pm
/usr/share/perl5/PVE/APIServer/AnyEvent.pm syntax OK
$ grep -c "pve2/js/anas.js" /usr/share/pve-manager/index.html.tpl
1
```

## 4. Reboot

Kernel moved (7.0.14-12 → 7.0.14-17), so the node was rebooted. SSH answered after ~30 s
(polling at 10 s intervals; well under the 5-minute budget).

After: `pveversion -v` (full) —

```
proxmox-ve: 9.2.0 (running kernel: 7.0.14-17-pve)
pve-manager: 9.2.20 (running version: 9.2.20/49318c671b82f31e)
proxmox-kernel-helper: 9.2.0
proxmox-kernel-7.0.14-17-pve-signed: 7.0.14-17
proxmox-kernel-7.0: 7.0.14-17
proxmox-kernel-7.0.14-12-pve-signed: 7.0.14-12
proxmox-kernel-7.0.14-6-pve-signed: 7.0.14-6
ceph-fuse: 19.2.3-pve1
corosync: 3.1.10-pve3
criu: 4.1.1-1
frr-pythontools: 10.6.1-1+pve3
ifupdown2: 3.3.0-1+pmx12
libjs-extjs: 7.0.0-7
libproxmox-acme-perl: 1.7.2
libproxmox-backup-qemu0: 2.0.2
libproxmox-rs-perl: 0.4.1
libpve-access-control: 9.1.1
libpve-apiclient-perl: 3.4.3
libpve-cluster-api-perl: 9.1.6
libpve-cluster-perl: 9.1.6
libpve-common-perl: 9.2.2
libpve-guest-common-perl: 6.0.5
libpve-http-server-perl: 6.0.5
libpve-network-perl: 1.6.7
libpve-notify-perl: 9.1.6
libpve-rs-perl: 0.15.3
libpve-storage-perl: 9.1.10
libspice-server1: 0.15.2-1+b1
lvm2: 2.03.31-2+pmx1
lxc-pve: 7.0.0-2
lxcfs: 7.0.0-pve1
novnc-pve: 1.7.0-2
proxmox-backup-client: 4.2.5-1
proxmox-backup-file-restore: 4.2.5-1
proxmox-backup-restore-image: 1.0.0
proxmox-enterprise-support-keyring: 1.1
proxmox-firewall: 1.2.3
proxmox-kernel-helper: 9.2.0
proxmox-mail-forward: 1.0.3
proxmox-mini-journalreader: 1.7
proxmox-offline-mirror-helper: 0.7.4
proxmox-widget-toolkit: 5.2.8
pve-cluster: 9.1.6
pve-container: 6.1.14
pve-docs: 9.2.10
pve-edk2-firmware: not correctly installed
pve-esxi-import-tools: 1.0.1
pve-firewall: 6.0.6
pve-firmware: 3.18-6
pve-ha-manager: 5.2.5
pve-i18n: 3.10.0
pve-qemu-kvm: 11.0.3-3
pve-xtermjs: 6.0.0-2
qemu-server: 9.2.7
smartmontools: 7.5-pve2
spiceterm: 3.4.2
swtpm: 0.8.0+pve3
vncterm: 1.9.2
zfsutils-linux: 2.4.4-pve1
```

`$ uname -r` → `7.0.14-17-pve`

(`pve-edk2-firmware: not correctly installed` is a pre-existing condition of the
firmware/ovmf split on this rig — it printed the same line before the upgrade and is
not ANAS-related.)

## 5. ANAS checks on the new PVE

```
$ systemctl is-active anas anasd pveproxy pvedaemon
active
active
active
active
```

`pveproxy` restarted with the boot at 16:33:41 UTC — this is the fresh-boot path for the splice:
the patched `AnyEvent.pm` was required for the first time by the new boot's pveproxy, and `/anas`
proxied correctly on the first try.

The health path: the gateway's own unauthenticated probe (`GET /anas/api/health`) is reachable
but answers the gateway's own `UNAUTHORIZED` gate through the pveproxy route
(`{"error":{"code":"UNAUTHORIZED","message":"Access ANAS through the Proxmox UI"}}` — a PVE
ticket is required for anything beyond it). The real health signal is an authenticated
`GET /v1/status`, which returned 200 with the full aggregate both before and after:

```
$ curl -sk -b "PVEAuthCookie=$TICKET" https://127.0.0.1:8006/anas/api/nodes/$(hostname)/v1/status
{"data":{"node":"anas-pve","pools":[{"name":"gtbackup","state":"ONLINE",…},
 {"name":"gtiscsi","state":"ONLINE",…}],"disks":{…},"shares":{…},"jobs":[],
 "warnings":[…pre-existing share/mount warnings…],"ahrPools":[]}}
```

The UI index injection survived the reboot (the Post-Invoke hook's re-application is on disk and
PVE serves it):

```
$ curl -sk https://127.0.0.1:8006/ | grep -c anas
3
$ curl -sk https://127.0.0.1:8006/ | grep "anas.js"
    <script type="text/javascript" src="/pve2/js/anas.js?v=a69548642a30"></script>
```

```
$ journalctl -u anas -u anasd -b --no-pager | grep -iE "error|warn" | head
(no output — clean boot, clean exercise, no errors or warnings)
```

**Version-skew surface (12.1):** `GET /v1/status` carries no PVE-version-dependent field, and the
12.1 story's skew surface is ANAS↔ANAS (additive schema fields an older daemon omits), not
PVE↔ANAS. What this round exercised is the thing that would break it: every response the round
round-tripped (`/v1/status`, `/v1/disks`, `/v1/ahr`, `/v1/jobs`, `/v1/scrub`, the layout preview,
the scrub and destroy results) parsed against the shared schemas unchanged. Nothing to warn
about, and no schema drift surfaced.

## 6. AHR pool, two-phase scrub, teardown — on the new PVE

### Rig prep (rig hygiene, not a product finding)

Four spares (`ANAS_HOT4`–`7`) were hot-attached via `test/stunt-node/add-spare-disks.sh 4 4 2048`.
The recycled images carried leftovers from earlier GT rounds — GPT labels, partitions and md
superblocks, which the **reboot auto-assembled into three foreign md arrays**:

```
$ cat /proc/mdstat
md125 : active (auto-read-only) raid1 sdc3[0]
      2092992 blocks super 1.2 [2/1] [U_]
md126 : inactive sdc1[5](S) sdb1[3](S)
md127 : inactive sdc2[3](S) sdb2[1](S)
```

ANAS's disk list correctly classified the members `other` (PVE's own classification of a disk
that is neither free nor LVM/ZFS) and the layout preview refused them by name:

```
{"error":{"code":"VALIDATION_ERROR","message":"Ineligible disk selection:
 disk 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT4' is not available (status: other); …"}}
```

That is the gate doing its job. `mdadm --stop` + `wipefs -a` on the four disks restored
`available`, and this was rig cleanup of pre-existing state, not anything the upgrade caused.

### Create — confirm-gated, 3 bands

The disks came up unequal (4/6/6/2 GiB — recycled images), so the §2 bander built THREE bands:

```
POST /v1/ahr/layout/preview →
  band 1: raid5 4×2 GiB   band 2: raid5 3×2 GiB   band 3: raid1 2×2 GiB
  rawBytes 19327352832, usableBytes 12884901888, minDisksMet true, warnings []

POST /v1/ahr {"name":"pveup","tier":"ahr1","disks":[…4…]}
→ HTTP/1.1 409 Conflict
  X-Anas-Confirm-Code: eb85014cf00c
  {"code":"CONFIRMATION_REQUIRED",
   "message":"Creating AHR pool 'pveup' will WIPE 4 disk(s) — all data on them will be permanently erased",
   "warnings":["scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT4 (QEMU HARDDISK, 4 GiB) will be completely erased", …]}

POST /v1/ahr … (x-anas-confirm: eb85014cf00c) → 202
  job e6fd59b6-… completed in 35 s
  {"created":"pveup","mountpoint":"/mnt/anas-ahr/pveup","arrays":["pveup-r1","pveup-r2","pveup-r3"]}
```

A multi-band pool — the shape the self-heal suite's case 7 exercises — created without a hitch on
the new PVE (mdadm 4.x semantics, btrfs, dm-crypt-free linear stacking all behaving).

### The two-phase scrub — clean across all three bands

```
POST /v1/ahr/pveup/scrub → 202  job 046d96b8-…

[16:41:02] running | md check on pveup-r1 (0.0%)
[…]
running | md check on pveup-r1 (72.3%)
running | md check on pveup-r2 (0.0%)
running | md check on pveup-r2 (94.2%)
running | md check on pveup-r3 (0.1%)
running | md check on pveup-r3 (95.6%)
completed | phase 2/2: btrfs checksum scrub

result: {"scrubbed":"pveup","btrfsErrors":null,"checkedArrays":3,
         "bandsChecked":["pveup-r1","pveup-r2","pveup-r3"]}
```

Phase 1 (md parity, band by band, strictly sequential) then phase 2 (btrfs checksums), 48 s end
to end, no findings, no notifications — the expected shape for a fresh pool.

`GET /v1/scrub` shows the pool honestly, mdcheck still off:

```
{"target":{"kind":"ahr","pool":"pveup"},"enabled":false,"cadence":"monthly",
 "mechanism":"anas-scrub-timer","nextRun":null,
 "phases":["md-parity","btrfs-checksums"],
 "note":"one node-level timer scrubs the enabled AHR pools sequentially (phase 1 md parity,
         then phase 2 btrfs checksums)","lastScrub":null}
```

### Destroy — confirm-gated, teardown verified

```
DELETE /v1/ahr/pveup → 409  X-Anas-Confirm-Code: 8f2ffb579204
DELETE /v1/ahr/pveup (x-anas-confirm: 8f2ffb579204) → 202
  [Unmounting /mnt/anas-ahr/pveup]
  [Zapping partition table on scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT6]
  [Updating initramfs (mdadm.conf changed)] ×4
  completed
```

```
$ GET /v1/ahr → {"data":[]}
$ cat /proc/mdstat → unused devices: <none>
$ grep -c pveup /etc/fstab /etc/mdadm/mdadm.conf → 0 / 0
$ findmnt /mnt/anas-ahr/pveup → not mounted
```

### One observation (not a finding): DELETE must be bodyless through pveproxy

A `DELETE` carrying a JSON body is refused by **pveproxy itself**, before it reaches the gateway:

```
$ curl … -X DELETE -d "{}" → HTTP/1.1 501 Unexpected content for method 'DELETE'
```

That is PVE's dispatcher (`libpve-http-server-perl`) rejecting request content on DELETE — the
same on 9.2.11 and 9.2.20, and not an ANAS defect: the confirm-gate flow is bodyless by design
(the 409 carries the code in a header; the replay is a bare DELETE). Recorded here only because
it shapes any future scripting: **DELETE requests through the `/anas` splice must not carry a
body.** No story proposed — the UI never sends one, and the API's own contract already works
this way.

## 7. Findings

**None.** Zero findings against ANAS on the new PVE. Every check passed on both sides of the
upgrade; the two notable events of the round (the tpl rewrite healed by the apt hook, and the
foreign-md-array refusal on the recycled spares) are the product's designed defenses working,
not failures.

## 8. End state

- Node on **pve-manager 9.2.20**, kernel **7.0.14-17-pve**, ZFS 2.4.4-pve1.
- ANAS main @ `02d9fe3` (`0.3.1+dev.02d9fe3`), `anas`/`anasd`/`pveproxy`/`pvedaemon` all active,
  journal clean for the whole boot including the pool exercise.
- **No AHR pools** (`GET /v1/ahr → {"data":[]}`); the pool, its arrays, partitions and fstab/
  mdadm.conf entries are gone; `/proc/mdstat` empty.
- **Spares detached** (`ANAS_HOT4`–`7`, virsh detach) and their qcow2 images deleted from the
  host; only `sda` + cloud-init ISO remain.
- **mdcheck timers still disabled** (`mdcheck_start.timer`/`mdcheck_continue.timer` → disabled),
  no `anas-scrub.*` units.
- **Enterprise repos still disabled** (pve + pbs, commented out / `Enabled: false`).
- Injected UI line and `AnasProxy.pm` splice present and serving.
