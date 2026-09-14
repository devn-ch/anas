# Live proof — the self-heal arc (`selfheal.3` / `.4` / `.5` / `.6`)

Driven 2026-09-11 against the disposable stunt PVE 9 node `anas-pve` (192.168.200.50), kernel
`7.0.14-12-pve`, from `main` @ `5318f09` plus the two fixes this round produced (F1, F2 — both
re-deployed and re-proven live). Every call below went to the REAL daemon on its unix socket
`/run/anas/anasd.sock` with the identity headers (`x-anas-user: liveproof@pam` /
`x-anas-user-uid: 0` / `x-anas-request-id: <uuid>`) and confirm retries via `x-anas-confirm`.

Answers were compared against the system's own truth — `/proc/mdstat`, `/sys/block/md127/md/*`,
`dmsetup table`, `findmnt`, `btrfs subvolume list`, `filefrag -v`, `journalctl -k`, raw O_DIRECT
reads of the member partitions, and sha256 of the files — never against fixtures. The injector
and the verifier are the **selfheal.2 suite's own** `oracle.py` (raw signature scan of the member
devices, sharing no code with any mapping helper) and `common.py` (md geometry, O_DIRECT I/O,
snapshot cold reads, `mdadm --fail`/`--re-add`), copied to the node unchanged.

The pool was created, exercised and destroyed through the API; the spare disks were detached and
their images deleted. The node is back to its baseline (see **Left behind**).

## Verdicts

| Story | Verdict | Note |
|---|---|---|
| `selfheal.3` — the scrub names what is corrupt | **PROVEN, with one gap** | file, subvolume, stripe and the exact 4 KiB block, on a §12 `@data` pool and inside a nested subvolume; honest counts; both notifications. **F3**: a COMPRESSED extent's finding carries `badBlocks: []` |
| `selfheal.4` — periodic scrub is the whole two-phase scrub | **PROVEN** | units + marker + cadence rewrite + removal, mdcheck taken over and left off, foreign array named, runner fires a real `ahr.scrub` job |
| `selfheal.5` — the repair engine | **PROVEN** | RAID5 XOR + csum arbitration, uncompressed / compressed / nested-subvolume pin, knobs restored, no leftover snapshot, above-md diagnosed and nothing written |
| `selfheal.6` — Repair from parity | **PROVEN** | 409 + `X-Anas-Confirm-Code` with the five warnings, three honest buckets, every refusal, one notification per run |

**Findings: 2 fixed this round (F1 MEDIUM, F2 LOW-MEDIUM), 1 open (F3 MEDIUM, story proposed),
1 observation (F4, suite-internal).** Nothing was preserved for inspection.

---

## 1. The rig

Four 2 GiB virtio SCSI spares (`ANAS_HOT10`–`13`) hot-attached with `add-disk.sh --size 2048`.
512 MiB was tried first and is unusable: §2.5 floors every disk's usable size to a whole GiB
(`AHR_SIZE_GRANULARITY_BYTES = 1024³`), so a sub-GiB disk rounds to zero. 2 GiB is the smallest
size that bands at all.

```
POST /v1/ahr/layout/preview
  {"disks":["…ANAS_HOT10","…ANAS_HOT11","…ANAS_HOT12","…ANAS_HOT13"],"tier":"ahr1"}
→ {"bands":[{"band":1,"range":{"startBytes":0,"endBytes":2147483648},
             "memberCount":4,"level":"raid5","heightBytes":2147483648,
             "usableBytes":6442450944,"protected":true}],
   "capacity":{"rawBytes":8589934592,"usableBytes":6442450944,
               "redundancyOverheadBytes":2147483648,"unprotectedWastedBytes":0},
   "warnings":[],"minDisksMet":true}
```

The create is confirm-gated, as every wipe is:

```
POST /v1/ahr  {"name":"sh7","tier":"ahr1","disks":[…four…]}
→ HTTP/1.1 409 Conflict
  x-anas-confirm-code: 72d9df6bef8f
  x-anas-confirm-expires: 2026-09-11T21:09:44.482Z
  {"code":"CONFIRMATION_REQUIRED",
   "message":"Creating AHR pool 'sh7' will WIPE 4 disk(s) — all data on them will be permanently erased",
   "warnings":["scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT10 (QEMU HARDDISK, 2 GiB) will be completely erased", …]}

POST /v1/ahr … (x-anas-confirm: 72d9df6bef8f)
→ 202; job ahr.create completed in 29 s
  {"created":"sh7","mountpoint":"/mnt/anas-ahr/sh7","arrays":["sh7-r1"]}
```

The §12 layout — **the pin path the suite's flat loop rigs never exercise** — is what the pool
actually came up with:

```
$ grep sh7 /etc/fstab
/dev/sh7/sh7-vol /mnt/anas-ahr/sh7 btrfs nofail,subvol=@data,x-systemd.before=rtslib-fb-targetctl.service,x-systemd.device-timeout=45s 0 0

$ findmnt -n -o SOURCE,TARGET,FSTYPE,OPTIONS /mnt/anas-ahr/sh7
/dev/mapper/sh7-sh7--vol[/@data] /mnt/anas-ahr/sh7 btrfs rw,relatime,space_cache=v2,subvolid=256,subvol=/@data

$ btrfs subvolume list /mnt/anas-ahr/sh7
ID 256 gen 9 top level 5 path @data
ID 257 gen 9 top level 5 path @snapshots

$ dmsetup table /dev/sh7/sh7-vol
0 12541952 linear 9:127 3072
```

Array geometry, read live from sysfs (this is what every mapping below is derived from):

```
members (rd0..rd3): /dev/sdb1 /dev/sdc1 /dev/sdd1 /dev/sde1
level raid5, raid_disks 4, chunk 524288, layout left-symmetric, rd0/offset 4194304 bytes
```

### What the API let me put in it

Three files, written by hand into the mounted `@data` tree:

| File | Kind | Marker |
|---|---|---|
| `/mnt/anas-ahr/sh7/f1.bin` | 8 MiB seeded random, uncompressed | 33-byte signature at file block 300 |
| `/mnt/anas-ahr/sh7/photos/f2.bin` | 1 MiB seeded random, in a NESTED subvolume | signature at block 40 |
| `/mnt/anas-ahr/sh7/comp/text.bin` | 1 MiB repeated text, `compression=zstd` | signature at block 60 |

**Noted, as the story asks:** ANAS has no API for either of the last two shapes. `/v1/ahr/:name/
snapshots` is the only subvolume verb there is — create/list/delete/rollback of an AHR *snapshot*
under `@snapshots` — so the nested subvolume was made with `btrfs subvolume create
/mnt/anas-ahr/sh7/photos`, and compression with `btrfs property set … compression zstd` on a
directory. Both are outside ANAS's surface today and neither is in a story. The engine and the
scrub attribution handle both correctly (§4, §7), so the gap is in what an operator can *ask*
ANAS for, not in what it copes with.

`filefrag -v` confirms the compressed file is really encoded — eight 128 KiB extents, each
compressing to a single 4 KiB on-disk sector:

```
 ext:     logical_offset:        physical_offset: length:   expected: flags:
   0:        0..      31:     232704..    232735:     32:             encoded
   1:       32..      63:     232705..    232736:     32:     232736: encoded
   …
   7:      224..     255:     232711..    232742:     32:     232742: last,encoded,eof
```

---

## 2. Injecting rot BEHIND md

The suite's oracle located the byte to corrupt — a raw windowed scan of every member device for
the block's own 33-byte signature, no layout math anywhere in the path:

```
sig = b'ANASLP7-F1.BINB300-MARKER-0123456'
scan_members(['/dev/sdb1','/dev/sdc1','/dev/sdd1','/dev/sde1'], sig)
→ [{"dev":"/dev/sde1","off":9617408}]          stripe 10 = (9617408 − 4194304) / 524288
```

Disambiguated the way the harness rule requires — one-byte flip on the member, COLD read of file
block 300 through a fresh read-only snapshot, then restore — never by the formula:

```
flip  /dev/sde1 @9617408 → snapshot_read(f1.bin, [300])  eio=[300]  ok=[]
restore                  → snapshot_read(f1.bin, [300])  eio=[]     ok=[300]
```

Then the 4 KiB block at that member offset was overwritten with random junk:

```
dd if=<junk> of=/dev/sde1 bs=4096 seek=2348 count=1 oflag=direct conv=notrunc
```

| | |
|---|---|
| member | `/dev/sde1` (rd3) |
| member offset | 9 617 408 (4 KiB block 2348) |
| stripe | 10 (parity member for stripe 10 = rd1 = `/dev/sdc1`) |
| original block sha256 | `f9311161d6cfa5297c7af14190fd5c2f36d1bf2bc54f5c4a017d9fd5521f534b` |
| junk sha256 | `ef03e44bff60eb5c8522efcecb101c7611351ff2664344fd6c9bb04a5527fbc6` |

---

## 3. `selfheal.3` — the scrub names the file and the block

```
POST /v1/ahr/sh7/scrub  →  HTTP/1.1 202 Accepted
  {"job":{"id":"acd64141-…","status":"running","operation":"ahr.scrub","createdBy":"liveproof@pam"}}
```

Progress, in order (0.25 s polling):

```
[21:14:08] running | md check on sh7-r1 (0.3%)
[21:14:13] running | md check on sh7-r1 (47.7%)
[21:14:18] running | md check on sh7-r1 (95.8%)
[21:14:24] running | Attributing scrub errors: 1/1 (/mnt/anas-ahr/sh7/f1.bin)
```

and from the first run of the same job (which caught the two lines the faster poll skipped over):

```
[21:12:10] running | phase 2/2: btrfs checksum scrub
[21:12:11] running | Reading the kernel journal for the scrub's errors
```

The order is md-parity-then-btrfs, as `selfheal.4` (a) rules. The `phase 1/2: md parity check on
sh7-r1` string is set immediately before `mdadm --action=check` and is overwritten by the wait
loop's first poll inside the same second, so it was never caught on the wire; the phase-1
percentage lines and the phase-2 line above are the observable sequence, and the kernel journal
confirms it (every md check line precedes `BTRFS info (device dm-0): scrub: started on devid 1`).

The result:

```json
{
  "scrubbed": "sh7",
  "btrfsErrors": "csum=1",
  "checkedArrays": 1,
  "findings": [
    { "path": "/mnt/anas-ahr/sh7/f1.bin", "subvolume": "@data", "inode": 258,
      "stripes": [ { "logical": 14811136, "offset": 1179648, "length": 4096 } ],
      "badBlocks": [ 300 ] }
  ],
  "errorsReported": 1, "errorsAttributed": 1, "unattributed": 0, "truncated": false
}
```

`badBlocks: [300]` is the block that was corrupted, found by ANAS's own 16 O_DIRECT probe reads
inside the 64 KiB stripe the kernel named — the kernel never said it:

```
BTRFS warning (device dm-0): scrub: checksum error at logical 14811136 on dev
  /dev/mapper/sh7-sh7--vol, physical … root 256 inode 258 offset 1179648 length 4096
  links 1 (path: f1.bin)
```

`root 256` → `@data`, and because a §12 pool MOUNTS `@data` at the mountpoint, the path is
`/mnt/anas-ahr/sh7/f1.bin` and not `/mnt/anas-ahr/sh7/@data/f1.bin`. That is the branch the
suite's flat rigs cannot reach, and it is correct here.

### The notifications

Both were captured verbatim out of the delivered mail (root@pam's address was pointed at a local
mailbox for the round and put back afterwards — see **Left behind**):

```
SUBJECT: ANAS: AHR scrub: parity mismatch on sh7-r1
rot exists in sh7-r1 — phase 2 (running now) will name the files

SUBJECT: ANAS: AHR scrub found errors
btrfs scrub on pool 'sh7' reported: csum=1. Latent corruption was surfaced — check
'btrfs scrub status /mnt/anas-ahr/sh7' and the pool's disks.

Affected files (1 of 1 reported error(s) attributed):
  /mnt/anas-ahr/sh7/f1.bin — 1 bad 4K block(s)
```

One phase-1 warning naming the band, one phase-2 warning naming the file. A CLEAN scrub sends
neither: after the repair (§5) the same call returned `"btrfsErrors": null` and the mailbox stayed
at 0 bytes.

### `GET /jobs?status=completed` carries the findings (the UI's recovery path)

```
GET /v1/jobs?status=completed
→ {"id":"acd64141-…","operation":"ahr.scrub","status":"completed",
   "completedAt":"2026-09-11T21:14:24.983Z",
   "result":{…the same findings[] verbatim…}}
```

That queue is in memory: the `ahr.create` and first `ahr.scrub` jobs of this round were gone after
the daemon restarted for a re-deploy, exactly as the story's "last completed scrub since the
daemon started" wording says.

---

## 4. `selfheal.6` — Repair from parity

### The confirm gate

```
POST /v1/ahr/sh7/repair  {"files":[{"path":"/mnt/anas-ahr/sh7/f1.bin","blocks":[300]}]}
→ HTTP/1.1 409 Conflict
  x-anas-confirm-code: 9e170c97b6e4
  x-anas-confirm-expires: 2026-09-11T21:17:20.440Z
  {"code":"CONFIRMATION_REQUIRED",
   "message":"Repairing 1 block(s) in 1 file(s) on AHR pool 'sh7' writes reconstructed data through md",
   "warnings":[
     "A read-only snapshot of the file's subvolume is taken for the duration and removed afterwards",
     "md's rmw_level, sync_min, sync_max and stripe_cache_size on the pool's array(s) are changed for the duration and restored afterwards",
     "One 4 KiB block per finding is written THROUGH md — and only after the reconstruction from the other members matches the checksum btrfs stored for it",
     "Nothing else on the array is touched: no other file, no other block, no parity rewrite beyond the stripes these blocks live in",
     "A block that cannot be proven is left exactly as it is — reported unrepairable, or as corruption that arrived above md, never \"fixed\""]}
```

### The replay

```
POST /v1/ahr/sh7/repair … (x-anas-confirm: 9e170c97b6e4)
→ HTTP/1.1 202 Accepted

[21:15:20] running | Repairing /mnt/anas-ahr/sh7/f1.bin block 300 (1/1)
[21:15:29] running | /mnt/anas-ahr/sh7/f1.bin block 300: repaired

result:
{"pool":"sh7",
 "files":[{"path":"/mnt/anas-ahr/sh7/f1.bin",
           "blocks":[{"block":300,"outcome":"repaired",
             "reason":"/mnt/anas-ahr/sh7/f1.bin block 300 reconstructed from the XOR of the
                       other 3 members of stripe 10 and verified against the stored csum 0x15aca78e"}]}],
 "repaired":1,"unrepairable":0,"aboveMd":0,"blocks":1}
```

```
SUBJECT: ANAS: AHR repair from parity completed
Repair from parity on AHR pool 'sh7': 1 repaired, 0 unrepairable, 0 above md, of 1 block(s) in 1 file(s).

Files:
  /mnt/anas-ahr/sh7/f1.bin — 1 repaired
```

### Verified independently, against the system

```json
{
 "member": "/dev/sde1", "member_offset": 9617408, "stripe": 10,
 "member_block_equals_original": true,
 "member_block_equals_junk": false,
 "member_sha256":   "f9311161d6cfa5297c7af14190fd5c2f36d1bf2bc54f5c4a017d9fd5521f534b",
 "original_sha256": "f9311161d6cfa5297c7af14190fd5c2f36d1bf2bc54f5c4a017d9fd5521f534b",
 "bounded_check_stripe10_mismatch_cnt": 0,
 "file_sha256":          "073366da079a9572d299a5ea9ec565d18c9c3d3c053371fa63ea0e51c4696d7c",
 "file_sha256_expected": "073366da079a9572d299a5ea9ec565d18c9c3d3c053371fa63ea0e51c4696d7c",
 "file_matches": true,
 "md_knobs": {"sync_action":"idle","sync_min":"0","sync_max":"max",
              "rmw_level":"1","stripe_cache_size":"256"}
}
```

The bounded check is the suite's own procedure done by hand (evict the stripe cache down to 17
slots and sweep ±200 stripes, `sync_min`/`sync_max` around the one stripe, `check`, wait for
`sync_completed ≥ sync_max`, write `idle`, settle 1 s, read `mismatch_cnt`, restore) — see **F4**
for the one number that had to change for a 512 KiB chunk. Every md knob the engine touches came
back at md's own defaults, and no pin snapshot was left behind:

```
$ btrfs subvolume list /mnt/anas-ahr/sh7
ID 256 … path @data
ID 257 … path @snapshots
ID 258 … path photos
$ GET /v1/ahr/sh7/snapshots → {"data":[]}
```

### A fresh scrub reports nothing

```
POST /v1/ahr/sh7/scrub → job b35a26b9-… completed
  {"scrubbed":"sh7","btrfsErrors":null,"checkedArrays":1}
mailbox: 0 bytes
```

---

## 5. The operator's own test — the parity trap (GT-7)

With a **different** member of the band failed, every block of the repaired file must still read
back correctly. If the repair had written through md at md's default `rmw_level` it would have
left the parity describing the junk, and the failed member's reconstruction would return exactly
one wrong 4 KiB block (GT-7).

```
$ mdadm /dev/md/sh7-r1 --fail /dev/sdb1      # rd0 — NOT the member that was repaired (rd3)
md127 : active raid5 sde1[4] sdd1[2] sdc1[1] sdb1[0](F)
      6274560 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/3] [_UUU]
```

Cold O_DIRECT read of the whole 8 MiB file through the degraded array, after `drop_caches`:

```json
{"degraded_cold_read_eio_blocks": [],
 "degraded_cold_read_blocks": 2048,
 "degraded_cold_read_sha256": "073366da079a9572d299a5ea9ec565d18c9c3d3c053371fa63ea0e51c4696d7c",
 "expected_sha256":           "073366da079a9572d299a5ea9ec565d18c9c3d3c053371fa63ea0e51c4696d7c",
 "bit_identical": true}
```

Then back:

```
$ mdadm /dev/md/sh7-r1 --remove /dev/sdb1 ; mdadm /dev/md/sh7-r1 --re-add /dev/sdb1
mdadm: hot removed /dev/sdb1 from /dev/md/sh7-r1
mdadm: re-added /dev/sdb1
md127 : active raid5 sdb1[0] sde1[4] sdd1[2] sdc1[1]
      6274560 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/4] [UUUU]
sync_action=idle

GET /v1/ahr/sh7 → state: healthy | array: clean | ['in_sync','in_sync','in_sync','in_sync']
```

---

## 6. Refusals, verbatim

| Situation | Response |
|---|---|
| repair while the scrub is in **phase 1** (pool state `scrubbing`) | `409 {"code":"CONFLICT","message":"AHR pool 'sh7' is scrubbing — a check re-reads every stripe, including this one; repair when the pool is healthy and idle"}` |
| repair while the scrub is in **phase 2** (md idle; the job-queue record is the only witness) | `409 {"code":"CONFLICT","message":"a scrub is in flight on AHR pool 'sh7' (job 27ad33ef-…) — a repair needs the array to itself; wait for it to finish"}` |
| scrub while a scrub runs | `409 {"code":"CONFLICT","message":"AHR pool 'sh7' is scrubbing — a scrub would thrash the running operation; wait for it to finish"}` |
| **scrub while a repair is in flight** | `409 {"code":"CONFLICT","message":"a repair job is in flight on AHR pool 'sh7' (job aecc6c78-…) — a check would re-read the stripes the repair is writing; wait for it to finish"}` |
| repair while a repair is in flight | `409 {"code":"CONFLICT","message":"another repair is in flight on AHR pool 'sh7' (job aecc6c78-…) — a repair needs the array to itself; wait for it to finish"}` |
| repair of a **missing** path | `409 {"code":"CONFLICT","message":"'/mnt/anas-ahr/sh7/nosuch.bin' does not exist — the file was deleted since the scrub named it, and there is nothing to repair"}` |
| repair of an **`outsideMount`** finding (`@snapshots/…`, filesystem-relative) | `400 {"code":"VALIDATION_ERROR","message":"Invalid repair request: Must be an absolute path — repair takes absolute paths under the pool's mountpoint with at least one 4 KiB block each; a finding inside a snapshot (@snapshots/…) is filesystem-relative and cannot be repaired in this cut"}` |
| repair while **degraded** | `409 {"code":"CONFLICT","message":"AHR pool 'sh7' is degraded — a reconstruction needs every other member of the stripe; repair when the pool is healthy and idle"}` |

The two in-flight refusals were raced deliberately: a repair over eight clean blocks (all
`mapping-abort`, nothing written) held the pool for ~2 s while the scrub and second repair were
submitted, and a scrub of a 3.1 GiB-full pool held phase 2 long enough to submit the repair
against an idle md. Both directions refuse at SUBMIT, from the job queue's own record, with no
shadow state.

The `mapping-abort` run is also the honest-bucket proof:

```
result: {"repaired":0,"unrepairable":8,"aboveMd":0,"blocks":8}
  block 1 mapping-abort "not corrupt here: the content at (m1, 8916992) passes the stored csum
                         for /mnt/anas-ahr/sh7/f1.bin block 1. Nothing was written."
  … eight of them, ascending, one per block …
```

---

## 7. Above-md diagnosis

The same block was corrupted again — this time **through md**, at md's own `rmw_level=1`, so md
recomputed the parity and the stripe stayed internally consistent (GT-6):

```
scan_device('/dev/md/sh7-r1', sig) → [md byte 16433152]     # md block 4012
dd if=<junk> of=/dev/md/sh7-r1 bs=4096 seek=4012 count=1 oflag=direct conv=notrunc
```

The scrub found it and — this is the point — sent **only one** notification, because phase 1's md
check saw nothing to complain about:

```
[21:25:46] running | md check on sh7-r1 (0.0%)
…
[21:26:03] running | Attributing scrub errors: 1/1 (/mnt/anas-ahr/sh7/f1.bin)
result: findings[0].badBlocks = [300], errorsReported 1, errorsAttributed 1

mail: exactly one message — "ANAS: AHR scrub found errors"
      (no "parity mismatch on sh7-r1" — mismatch_cnt was 0)
```

The repair diagnosed it and wrote nothing:

```
[21:26:19] running | /mnt/anas-ahr/sh7/f1.bin block 300: above-md

{"pool":"sh7","repaired":0,"unrepairable":0,"aboveMd":1,"blocks":1,
 "files":[{"path":"/mnt/anas-ahr/sh7/f1.bin","blocks":[{"block":300,"outcome":"above-md",
   "reason":"the bounded md check over stripe 10 reports mismatch_cnt=0 while the block fails
             its stored csum — parity agrees with the bad data, which implicates something other
             than the disks. Nothing was written."}]}]}
```

```
SUBJECT: ANAS: AHR repair from parity left blocks unrepaired
Repair from parity on AHR pool 'sh7': 0 repaired, 0 unrepairable, 1 above md, of 1 block(s) in 1 file(s).

Files:
  /mnt/anas-ahr/sh7/f1.bin — 1 above-md

Blocks diagnosed above md were not written: parity already agreed with the bad data — this
implicates something other than the disks (memory, controller, software).
```

Verified: the md block still held the junk byte for byte
(`md_block_untouched_still_junk: true`), the stripe still checked at `mismatch_cnt=0`, and every
md knob was back at its default. The wording stays an implication, never a certainty.

---

## 8. Compressed extent, and the nested subvolume

### `photos/f2.bin` — a file in a NESTED subvolume (behind md)

Scan → `/dev/sdc1 @196771840` (stripe 367), flip+cold-read through a snapshot of `photos` itself
(a read-only btrfs snapshot does not recurse — GT-52/55), then 4 KiB of junk. The scrub:

```json
{"path":"/mnt/anas-ahr/sh7/photos/f2.bin","subvolume":"@data/photos","inode":257,
 "stripes":[{"logical":298975232,"offset":131072,"length":4096}],"badBlocks":[40]}
```

`@data/photos` resolved, and the remainder kept under the mountpoint — exactly what `selfheal.3`'s
result text describes. The repair pinned that nested subvolume and fixed it:

```
{"block":40,"outcome":"repaired",
 "reason":"… reconstructed from the XOR of the other 3 members of stripe 367 and verified
           against the stored csum 0xd9cf6159"}
member_equals_original: True      file sha256 == expected
```

### `comp/text.bin` — a zstd extent (behind md)

The oracle found the marker on **two** members at the same offset — the data slot and its parity
copy, because the stripe's other members are zeros there. The harness rule's disambiguation
settled it without any layout math:

```
flip /dev/sdb1 @414715948 → cold read clean            (parity slot)
flip /dev/sdc1 @414715948 → cold read EIO on blocks 32..63   (data slot; the whole 128 KiB extent)
```

That blast radius is the compressed-extent fact: one bad on-disk sector costs the whole extent.
The 4 KiB blob at `/dev/sdc1` block 101 249 (stripe 783) was overwritten with junk.

**The scrub named the file and nothing else** — this is **F3**:

```json
{"path":"/mnt/anas-ahr/sh7/comp/text.bin","subvolume":"@data","inode":259,
 "stripes":[{"logical":953155584,"offset":0,"length":4096}],
 "badBlocks":[]}
```

Handed the right block by hand, the engine repaired it — single-sector blob, so none of the
documented multi-sector limitation applies:

```
POST /v1/ahr/sh7/repair {"files":[{"path":"/mnt/anas-ahr/sh7/comp/text.bin","blocks":[60]}]}
→ 409 + code → 202

{"block":60,"outcome":"repaired",
 "reason":"/mnt/anas-ahr/sh7/comp/text.bin block 60 reconstructed from the XOR of the other 3
           members of stripe 783 and verified against the stored csum 0xf0449da8"}
```

(`0xf0449da8` is the little-endian form of the `expected csum 0xa89d44f0` the kernel printed —
GT-1's "stored csum leaf equals crc32c LE", confirmed again here.) Verified: member block
byte-identical to the original, `mismatch_cnt` of stripe 783 = 0, file sha256 equal to the
original. **So the answer to the story's question is: repaired, not `unrepairable`** — with the
caveat that the operator cannot get there from the Scrubs window today (F3).

---

## 9. `selfheal.4` — the periodic path

Before the toggle, mdcheck owned parity checks on this node and ANAS said so:

```
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
enabled enabled
GET /v1/scrub → AHR sh7: enabled false, nextRun null,
                note "double parity check — mdcheck is on"
```

```
PUT /v1/scrub/ahr/sh7  {"enabled":true,"cadence":"monthly"}
→ 202; job scrub.ahr.toggle completed
  {"pool":"sh7","periodicScrub":true,"cadence":"monthly","scope":"node-level"}
```

The two unit files it wrote, verbatim:

```ini
# /etc/systemd/system/anas-scrub.service
[Unit]
Description=ANAS periodic AHR scrub (monthly) — md parity, then btrfs checksums
# X-ANAS-Schedule={"kind":"ahr-scrub","cadence":"monthly","pools":["sh7"]}

[Service]
Type=oneshot
ExecStart=/usr/bin/node /opt/anas/packages/daemon/dist/scrub-task.js sh7
```

```ini
# /etc/systemd/system/anas-scrub.timer
[Unit]
Description=ANAS periodic AHR scrub timer

[Timer]
OnCalendar=Sun *-*-01..07 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```
$ systemctl is-enabled anas-scrub.service anas-scrub.timer
static enabled                     # the service is timer-triggered; the timer is what enables
$ systemctl is-active anas-scrub.timer
active
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
disabled disabled                  # ANAS owns md checks on this node now
$ systemctl show -p NextElapseUSecRealtime anas-scrub.timer
NextElapseUSecRealtime=Sun 2026-10-04 03:00:00 UTC

GET /v1/scrub → {"target":{"kind":"ahr","pool":"sh7"},"enabled":true,"cadence":"monthly",
                 "mechanism":"anas-scrub-timer","nextRun":"2026-10-04T03:00:00.000Z",
                 "phases":["md-parity","btrfs-checksums"],
                 "note":"one node-level timer scrubs the enabled AHR pools sequentially
                         (phase 1 md parity, then phase 2 btrfs checksums)","lastScrub":null}
```

### The runner really runs the scrub

```
$ systemctl start anas-scrub.service
Sep 11 21:27:36 anas-pve systemd[1]: Starting anas-scrub.service - ANAS periodic AHR scrub (monthly) — md parity, then btrfs checksums...
Sep 11 21:27:57 anas-pve node[282974]: {"pool":"sh7","result":{"scrubbed":"sh7","btrfsErrors":null,"checkedArrays":1}}
Sep 11 21:27:57 anas-pve systemd[1]: Finished anas-scrub.service - ANAS periodic AHR scrub (monthly) — md parity, then btrfs checksums.
Result=success  ExecMainStatus=0
```

and the job it POSTed shows up in the daemon's own queue, under the runner's identity:

```
{"id":"aa7c6f95-dda2-4040-97e3-eba0d61a5c52","operation":"ahr.scrub","status":"completed",
 "createdBy":"root@pam","createdAt":"2026-09-11T21:27:37.077Z","completedAt":"2026-09-11T21:27:53.151Z"}
{"scrubbed":"sh7","btrfsErrors":null,"checkedArrays":1}
```

### Cadence rewrites the calendar

```
PUT /v1/scrub/ahr/sh7 {"enabled":true,"cadence":"quarterly"} → {"cadence":"quarterly","scope":"node-level"}

OnCalendar=Sun *-01,04,07,10-01..07 03:00:00
Description=ANAS periodic AHR scrub (quarterly) — md parity, then btrfs checksums
# X-ANAS-Schedule={"kind":"ahr-scrub","cadence":"quarterly","pools":["sh7"]}
```

### Disabling the last pool removes both units and leaves mdcheck off

```
PUT /v1/scrub/ahr/sh7 {"enabled":false} → {"pool":"sh7","periodicScrub":false,"scope":"node-level"}

$ ls /etc/systemd/system/anas-scrub.service /etc/systemd/system/anas-scrub.timer
ls: cannot access …: No such file or directory
$ systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer
disabled disabled
GET /v1/scrub → AHR sh7: enabled false, nextRun null
```

### A foreign md array is named, never silent

A RAID1 over two loop files (`/dev/md126`, not an AHR band) was assembled on the node for the
check and removed afterwards:

```
md126 : active raid1 loop1[1] loop0[0]
GET /v1/scrub → note: "md126 is not an ANAS pool and is not scrubbed by ANAS"
```

---

## 10. Teardown, through the API

```
DELETE /v1/ahr/sh7
→ 409  x-anas-confirm-code: d93a0da5015c
  {"code":"CONFIRMATION_REQUIRED","message":"Destroying AHR pool 'sh7' erases all of its data",
   "warnings":["Pool 'sh7' (5.98 GiB usable) will be permanently destroyed — every array,
                partition, and all data erased",
               "The filesystem at '/mnt/anas-ahr/sh7' will be unmounted — anything serving from
                it (shares, backups, mounts) stops working"]}

DELETE /v1/ahr/sh7 (x-anas-confirm: d93a0da5015c) → 202; job ahr.destroy completed
  {"destroyed":"sh7"}

$ GET /v1/ahr → {"data":[]}
$ cat /proc/mdstat → unused devices: <none>
$ grep -c sh7 /etc/fstab /etc/mdadm/mdadm.conf → 0 / 0
```

The four spares were then detached from the VM and their qcow2 images deleted.

---

## Findings

### F1 — MEDIUM — every ANAS notification with a non-ASCII character arrived double-encoded (FIXED)

The first notification of the round rendered as:

```
rot exists in sh7-r1 Ã¢â‚¬â€ phase 2 (running now) will name the files
```

Probed on the node with the exact perl body `pve-notify.ts` emits, against the same body plus a
`decode`:

```
RAW      body bytes: b'em dash \xc3\xa2\xc2\x80\xc2\x94 here\n'      ← U+2014 encoded twice
DECODED  body bytes: b'em dash \xe2\x80\x94 here\n'                  ← correct
```

Perl hands `@ARGV` over as bytes with no UTF8 flag, and PVE's mail renderer encodes the body to
UTF-8 on its way out, so every byte of a multi-byte character was encoded a second time. This was
not an edge case: ANAS's own notification bodies and subjects are full of em dashes, so it hit
**every** message the product sends — AHR, backup, snapshot and replication alike.

**Fix** (in this worktree): `services/pve-notify.ts` now decodes `@ARGV` from UTF-8 in the perl
body (`use Encode qw(decode); … map { decode('UTF-8', $_, Encode::FB_DEFAULT) } @ARGV`).
`FB_DEFAULT` keeps the call total — a byte sequence that is somehow not UTF-8 becomes U+FFFD
rather than killing the notification. +1 daemon test. Re-deployed and re-proven live:

```
SUBJECT: ANAS: AHR scrub: parity mismatch on sh7-r1
rot exists in sh7-r1 — phase 2 (running now) will name the files
```

### F2 — LOW-MEDIUM — a repair that changed nothing told the operator to restore from backup (FIXED)

A repair whose blocks all came back `mapping-abort` — the engine's way of saying *the bytes on the
member still pass their stored checksum, nothing is wrong here* — ended its notification with:

```
Files:
  /mnt/anas-ahr/sh7/f1.bin — 8 mapping-abort

Unrepairable blocks have no source of truth left below the checksum tree — restore this file from backup.
```

`mapping-abort` counts in the `unrepairable` bucket, which is right (`selfheal.6` says so and the
block was not repaired), but it means the OPPOSITE of the rest of that bucket. Acting on the
advice would overwrite a good file.

**Fix** (in this worktree): `services/ahr-repair.ts` counts the mapping-aborts separately for the
notification tail. "Restore from backup" is emitted only for blocks that really have no source of
truth left; mapping-aborts get their own sentence. No schema change — the three buckets are
untouched. +2 daemon tests. Re-deployed and re-proven live:

```
Files:
  /mnt/anas-ahr/sh7/f1.bin — 2 mapping-abort

Blocks reported "not corrupt here" were left alone: the bytes on the member still pass their
stored checksum, so there was nothing to reconstruct — either the block was already repaired or
the finding no longer describes it. Nothing was written, and they need no restore.
```

### F3 — MEDIUM — a COMPRESSED file's finding carries no bad block, so the Repair action cannot reach it (OPEN at capture; fixed by `selfheal.8`)

For the corrupted zstd extent the kernel's scrub warning was:

```
BTRFS warning (device dm-0): scrub: checksum error at logical 953155584 on dev
  /dev/mapper/sh7-sh7--vol, physical 1229979648 root 256 inode 259 offset 0 length 4096
  links 1 (path: comp/text.bin)
```

`offset 0` — while the kernel's own read-time lines for the same damage, from the probe, say
where it really is:

```
BTRFS warning (device dm-0): csum failed root 256 ino 259 off 131072 csum 0x91788004 expected csum 0xa89d44f0
BTRFS warning (device dm-0): csum failed root 270 ino 259 off 147456 …
BTRFS warning (device dm-0): csum failed root 270 ino 259 off 151552 …
```

The damaged blob is the extent covering file bytes 131072–262143 (proved independently: the
one-byte flip EIO'd file blocks 32–63 and nothing else). The scrub warning's `offset` is relative
to the compressed extent, not to the file, so `selfheal.3` probes file blocks 0–15 — which are
healthy — and the finding comes back:

```json
{"path":"…/comp/text.bin","stripes":[{"logical":953155584,"offset":0,"length":4096}],"badBlocks":[]}
```

`AhrScrubFinding`'s doc reads an empty `badBlocks` as "the file was repaired, rewritten or removed
between the scrub and the probe". On a compressed file that reading is wrong: the file IS corrupt
and the probe looked in the wrong 64 KiB. Consequences, in order of weight:

1. `AhrRepairRequest` requires at least one block per file, so the Scrubs findings window has
   nothing to tick and the operator cannot launch a repair for a compressed file at all — even
   though the engine repairs it correctly when handed the block (§8).
2. The notification line reads `/mnt/anas-ahr/sh7/comp/text.bin — 0 bad 4K block(s)`, which
   understates a real corruption.

Nothing here is wrong in `selfheal.5`: the engine's compressed path works, and the mapping,
arbitration and write-back were all correct. The gap is entirely in the attribution probe.

**Not fixed** — it is not a small fix. Reading the whole file to find the block is unbounded on a
multi-TB file, and reporting the finding honestly needs a schema field and UI copy. **Proposed
story (`selfheal.8`):** *As a user, I want a scrub finding on a COMPRESSED file to name its bad
blocks — or to say plainly that it cannot.* The probe should detect the compressed case (the
extent the named logical falls in is `encoded`), resolve the extent's real file range from the
extent item rather than from the kernel's `offset`, probe that range, and — when it still cannot
name a block — carry a flag that the window renders as "corrupt, block not identified (compressed
extent)" with Repair disabled and the reason stated, instead of an empty list that reads as
"nothing found". Fixed as `selfheal.8` (2026-09-11): the finding carries the extent's real file
blocks plus `compressed`/`extentBlocks`, or `unidentified` with a stated reason.

### F4 — observation — the suite's bounded check assumes the loop rig's 64 KiB chunk

`test/self-heal/suite/common.py`'s `bounded_window_check()` and `evict_stripe_cache()` compute
`sync_min`/`sync_max` in units of 128 sectors, which is one stripe only on a 64 KiB-chunk array —
the rig's. AHR bands use md's 512 KiB default, where md refuses a non-chunk-multiple:

```
OSError: [Errno 22] Invalid argument     # open('/sys/block/md127/md/sync_max','w').write('1408')
```

Internally consistent for the suite, which builds its own rigs, so nothing is broken today; it is
a trap for anyone reusing those helpers against a real pool. The verification in this round used
the same procedure with the stripe unit read from the array's own `chunk_size`. ANAS's engine gets
this right already (`selfheal-repair.ts`: `geo.raid1 ? 128 : geo.chunkBytes / 512`).

---

## Left behind

Nothing. Specifically:

- AHR pool `sh7` destroyed through the API; `/etc/fstab` and `/etc/mdadm/mdadm.conf` carry no
  `sh7` entry, `/proc/mdstat` is empty, the four spares' partition tables were zapped by the
  destroy job.
- The four spare disks (`ANAS_HOT10`–`13`) were detached from the VM and their qcow2 images
  deleted from the host. The node's disk list is back to `sda` + the cloud-init ISO.
- `anas-scrub.service` / `.timer` removed by the disable; `mdcheck_start.timer` /
  `mdcheck_continue.timer` are left **disabled**, which is the `selfheal.4` (b) ruling ("disabling
  the last pool leaves them off — the operator asked for no scrubbing"). They were `enabled` when
  the round started; if a later round wants mdcheck back on this node, `systemctl enable
  mdcheck_start.timer mdcheck_continue.timer` restores it.
- The loop-backed `md126` used for the foreign-array note was stopped, its superblocks zeroed and
  its loop devices and image files removed.
- Notification capture: `root@pam`'s email was pointed at a local mailbox for the round and has
  been set back to `root@localhost`; the throwaway `anasmail` unix user and its mailbox are
  deleted.
- The node-side workspace `/root/sh7` (the suite copies, the marker regen images, the step
  scripts) and the poll helpers were removed. `/root/aq.sh` — which predates this round — stays.
- The node is running the build with the F1 and F2 fixes.

---

## Review remediation 2026-09-13

The code review of `v0.3.1..HEAD` (2026-09-12) against this arc, remediated in three lanes: the
engine and scrub findings (R1–R7) below, the schedule/UI/packaging findings (R8–R10) at the end of
this section, and the suite's own two-band rig (case 7).

### Engine and scrub lane (R1–R7)

Seven findings, all fixed at the source, each with a regression test that fails on the old code
and passes on the new one. Two new fixture captures were taken on the same stunt node and torn
down after (`PROVENANCE.md`: "Split-extent fixtures", "Multi-band fixtures").

| id | the finding | the fix | the test |
|---|---|---|---|
| R1 | `resolveContext` derived ONE `MdGeometry` from `segments[0]`, so a block in a later band of a multi-band pool was placed with band 1's geometry and read — and WRITTEN — on band 1's md device. | The context now carries BANDS: every dm segment resolved to its own md array and geometry, the band picked by the LV byte, and that band's device, members and sysfs used for the placement, the reads, the guard and the write. A segment whose device is not an md array is refused by name. | `selfheal-map.test.ts` — a live two-band capture (64 K and 512 K chunks, 1 MiB and 2 MiB data offsets): a byte in band 2 resolves to band 2's array, member and offset, and to a DIFFERENT member than band 1's geometry would have said. `selfheal-repair.test.ts` — a whole repair whose block is in band 2 reads and writes only band 2's array, and a segment on a non-md device is refused. |
| R2 | `EXTENT_SPAN_RE` dropped the EXTENT_DATA `extent data offset`, so after any CoW split `repairUnitFor` computed a logical bytenr a megabyte short; and `extentsForStripe` read an EXTENT_DATA_REF `offset` as a file offset, which it is not (btrfs stores `file_offset − extent_data_offset`). | The field is parsed and carried; `logicalByte = disk byte + extent data offset + (file offset − the item's file offset)`, bound-checked against the item's own `nr`. Backrefs are resolved by finding every EXTENT_DATA item of the inode that references THAT extent, forward from the backref offset. | `selfheal-map.test.ts` + `selfheal-csum.test.ts` against a live split capture (8 MiB file, 4 KiB overwritten 1 MiB in): block 300 maps to logical 14,860,288, whose STORED csum (`0x8b9126a3`, read off the rig's own csum leaf) equals crc32c of the file's block — while the pre-fix byte (13,807,616) carries a different block's csum. The backref with `count 2` resolves to BOTH owning items. |
| R3 | `evictStripeCache` read `rd0/size` as 512-byte sectors and subtracted the data offset again — it is KiB and already net of it — putting the last stripe at half the array, so a stripe in the upper half was never swept and a stale cache read back as `mismatch_cnt=0` (`above-md` on rot that was below md). | The size is read in KiB from the first SURVIVING role and doubled; nothing is subtracted twice. | `selfheal-repair.test.ts` — on the captured raid5 rig (203776 KiB + a 1 MiB offset = the 200 MiB member) the sweep around stripe 3180 covers 3175–3183 and stops at the real last stripe; pre-fix it swept nothing at all there. |
| R4 | Every RAID1 leg was read at the FIRST leg's data offset, though `geometryFromAttributes` already reads each member's own `rd<n>/offset`. | One helper, `memberOffsetOn`, computes a member's offset from ITS own data offset — used by the mirror re-verify, the mirror candidates, the guard and the parity row reads alike. | `selfheal-map.test.ts` for the helper; `selfheal-repair.test.ts` drives a whole repair on a mirror whose legs sit at 1 MiB and 4 MiB, and asserts each leg was read at its own offset. |
| R5 | The read-back guard compared the through-md read against ONE failing leg's bytes; md's `read_balance` may serve the healthy leg, so a sound repair failed as `unrepairable` about half the time. | On RAID1 the guard passes when the through-md bytes equal ANY leg's bytes read directly — which is what proves the md offset maps onto this mirror set. RAID5/6 keep the strict single-member comparison. | `selfheal-repair.test.ts` — md serving the healthy leg, md serving the failing leg (both repair), and md matching NEITHER leg (refused, nothing written). |
| R6 | The phase-1 wait loop could break on its first mdstat read before md had started the check: a stale `mismatch_cnt` was read as this scrub's verdict and phase 2 ran concurrently with the check. | After issuing the check the band is polled until md says it is running (`sync_action`, or mdstat), with a bounded start-wait; a band md never started is recorded as not checked and its counter is NOT read. The finish-wait consults sysfs alongside mdstat, and `mismatch_cnt` is read only after idle plus the settle. | `ahr-scrub.test.ts` — the "idle on the first read, then check, then idle" sequence (the counter is read only after both), and a band md never starts (no counter read, no rot claimed, progress says so). |
| R7 | `conflictingAhrJob` used `findByOperation`, which returns the LATEST job per (operation, pool) with no status filter, so a newer terminal job hid an older running one; and the scrub route refused only on `ahr.repair`, accepting a second concurrent scrub of the same pool. | `JobQueue.findActive(operations, target)` returns a job that is actually queued or running; both routes use it, and a scrub now refuses a running scrub or repair, as a repair already did. | `jobs/__tests__/queue.test.ts` for the query; `ahr-mutate.test.ts` for both directions of the hidden-running-job case and for the second-scrub refusal. |

Four adjacent items, cut but verified, rode along:

- **The compressed fallback.** ~~When the extents cannot be resolved, a stripe is reported
  `unidentified` with the reason instead of probing at the kernel's printed offset — for a
  compressed extent that offset is extent-relative (selfheal.8) and names blocks from a window
  that is not the finding. Blocks an operator can hand to a repair have to come from a window
  that was verified. The cost is named: with the mapping out, a finding names its file and not
  its blocks.~~ **REVERSED by F6 below** — the cost was understated (it fell on every extent of
  every file, not just compressed ones) and the reasoning was half wrong: a probe reads the FILE,
  so an EIO at the kernel's offset is a real bad block whichever extent it belongs to. The wrong
  window costs a miss, not a false accusation.
- **The journal read is bounded.** `journalctl -k -o json` for the scrub window now carries
  `-n 5000` and `-g 'error at logical'` (both error shapes contain it; a journalctl without
  pattern matching is retried without `-g`). Unbounded, a node with tens of thousands of errors
  did not truncate — the 10 MB executor buffer failed the call and the whole attribution was
  lost. A read that hits the cap sets `truncated`.
- **`drop_caches` is declared.** The repair drops the node's page cache once per block so the
  verification read is genuinely cold; the confirm gate now says so ("a busy node will feel it")
  rather than doing it silently.
- **Two duplicates collapsed.** The self-heal mapper's private `mdadm --detail --export` parser
  (which silently dropped `ROLE=spare`) now projects the ONE parser in `parsers/mdadm-detail.ts`
  onto role slots, spares excluded by name; and `ahr-scrub`'s `probeBlock` is the engine's own
  `probeFileBlock` (selfheal-io), so "read this block and see" has one definition.
- **The engine's harness sidecar names the array it used.** `REPAIR_REPORT` now carries `level`,
  `n` and `chunk` beside the member and stripe — the reference implementation has always written
  them, and they are the numbers that say WHICH band answered. Case 7's first engine run failed on
  exactly that: `7-bandA-untouched` passed (`data=0` — the mapping was right and band A was not
  written), while `7-repair` read `n=None` where band B's 4 was expected.

**The R1 proof, on a live two-band rig.** The suite's case 7 (added this round by the harness lane)
builds the AHR pool shape — band A RAID5 6 × 200 MiB @ 64 K and band B RAID5 4 × 200 MiB @ 512 K as
the two PVs of one VG, one LV across both — corrupts a marker block that lives in SEGMENT 2 below
md, and repairs it. Against the deployed engine:

```
[PASS] 7-txprobe          18 band-A blocks measured, 0 in a data chunk
[PASS] 7-scan             hit m2 of band B (loop8); verification-side map: m2 of /dev/md126, stripe 74, member offset 41197568
[PASS] 7-bandA-untouched  changed sectors: 130 — housekeeping=130 data=0
[PASS] 7-repair           rc=0 postcheck=0 n=4 (band B n=4) disk=m2 stripe=74 — the XOR of the other 3 members of stripe 74
[PASS] 7-member           loop8@41197568 match=True
[PASS] 7-bcheck           stripe 74 of md126: mismatch_cnt=0
[PASS] 7-cold             eio=[] content_match=True
[PASS] 7-neg              segment-1 (band A) marker repairs normally — disk=m2 stripe=2168, the XOR of the other 5 members
[PASS] 7-neg2             eio=[] content_match=True

SUITE: PASS (41/41 cases, 14/14 negative controls)
```

`n=4` with `disk=m2 stripe=74` is R1 in one line: the block was placed, read and written with band
B's own geometry (4 members, 512 K chunk), not band A's (6 members, 64 K) — and `7-neg` shows band
A still repairs normally through the same code. `data=0` on band A is the assertion that runs
whatever the repair returns.

### Second pass

A second review of the same range (`5d6e249..de17ed1`) found five more, all fixed at the source with a
regression test that fails on the old code and passes on the new one. Two more fixture captures were
taken on the stunt node and torn down after (`PROVENANCE.md`: "Leaf-crossing backref fixtures",
"Multi-sector compressed blob"). The engine suite after them: **SUITE: PASS (41/41 cases, 14/14
negative controls)**.

- **F3 — the finish-wait is bounded by a POLICY, not by nothing.** `ahr-scrub`'s per-band wait exited
  only when mdstat AND `sync_action` both read idle, so a band that went `frozen`, or whose check was
  replaced by a resync/recover/reshape, spun the job for ever — and with R7's active-job exclusion
  every later scrub or repair on that pool was refused until anasd restarted. A `check` in progress is
  still waited on for as long as it takes; `frozen` or any non-check sync action ends the wait for that
  band, recorded as "not checked (sync_action=…)" with NO counter read, and a 7-day absolute ceiling is
  the last resort with the same verdict. *(`ahr-scrub.test.ts`: frozen mid-check, recover replacing the
  check, the ceiling, and a long check still polled through.)*
- **F11 — a check that finishes before the first poll is not "never started".** On a small band a check
  can run to completion between `mdadm --action=check` returning and the first mdstat read, and the
  start-wait reported that as never-started and never read the counter — this scrub's own verdict. The
  band's `last_sync_action` is now snapshotted BEFORE the check is issued and read again at the end of
  the start window: idle plus `last_sync_action=check` means it ran, and its `mismatch_cnt` is read.
  *(`ahr-scrub.test.ts`: the scripted "always idle, last_sync_action=check" band warns on its 8
  mismatches instead of being skipped.)*
- **F5 — the knobs are saved and restored PER BAND.** R1 gave every on-disk sector its own band, but
  the repair still took `sectors[0].geometry` for the `rmw_level` save/restore, the sync-knob restore
  and the outcome's `array`/mapping, while the write, the bounded checks and `rmw_level=0` went to
  `target.geometry`. A compressed blob straddling a band boundary therefore left band 2 at
  `rmw_level=0` for good and "restored" band 1 to the value it already had; `reverify` read every
  sector's `raid1`/`members` out of the first sector's geometry too, so on a mirror-band-plus-parity-
  band pool it read the wrong disks entirely and called a repairable block unrepairable. Touched bands
  are now a map keyed by md device, restored one by one; the outcome and the mapping diagnostics name
  the TARGET's band; `reverify` uses each sector's own `location.geometry`. *(`selfheal-repair.test.ts`:
  a live 11-sector zstd blob split eight sectors on a RAID1 band and three on a RAID5 band — the repair
  lands on band 2, band 2's `rmw_level` comes back to 1, and band 1 is not written to at all.)*
- **F6 — a mapping failure no longer voids the whole pool's findings.** Two faults compounded:
  `resolveContext` threw for ANY band whose geometry was momentarily unreadable (R1), and the
  attribution dropped the plain probe whenever the mapping was unavailable. One unreadable band
  therefore made every file of every band `unidentified` with `badBlocks: []` and nothing to repair.
  Band geometry is now resolved lazily — carried on the band, raised only where a byte is actually
  placed on it, and refused up front by the repair gates — so the attribution, which walks the btrfs
  trees and needs no band at all, still answers. And the stripe is probed at the kernel's offset even
  with no mapping: `dd` reads the FILE, so a block that comes back EIO is genuinely unreadable
  whichever extent it belongs to. The wrong window costs a MISS, never a false accusation — and for an
  uncompressed extent the kernel's offset is exact (GT-3). A probe that finds nothing still reports
  `unidentified` with the reason. **This corrects the "compressed fallback" cost line above**, which
  understated it: the cut did not cost "a finding names its file and not its blocks" on compressed
  extents — it cost that on EVERY extent of EVERY file whenever the mapping was unavailable for any
  reason at all. *(`ahr-scrub.test.ts`: one of two bands with no readable geometry, findings intact; a
  stripe with the mapping down probed at the kernel offset and its failing block named; the compressed
  case with the mapping down still `unidentified`.)*
- **F7 — the backref scan crosses an fs-tree leaf.** `extentsReferencing` re-descended with
  `last + 1`, and `findLeaf` takes the greatest key ≤ its target — which for a key one byte past a
  leaf's last item is that same item, in that same leaf. The scan always stopped on its second
  iteration and `MAX_OWNER_LEAVES` was dead code, so a large extent split across two leaves handed a
  repair less than half of itself. The walk now steps to the genuinely next leaf through the recorded
  descent path (`findLeafPath`/`nextLeaf` in `selfheal-btree.ts`), still bounded by that cap.
  *(`selfheal-map.test.ts`, on a live capture — a 32 MiB extent cut into 121 pieces by 120 CoW
  overwrites, in a level-1 subvolume tree whose two leaves hold 49 and 72 of them: the scan returns
  121, the pre-fix code returned 49.)*

### Third pass

A third review of the same arc (`de17ed1..13cb6b3`) found four more, fixed at the source with
regression tests that fail on the old code and pass on the new one. No new captures were needed.

- **T2 — a fast check is proven by the COUNTER, not by `last_sync_action`.** F11's evidence was
  `last_sync_action = check` alone, and that attribute is PERSISTENT: it reads `check` for ever on
  any node that has run mdcheck, so "idle + check" is also the resting state of an array nobody
  touched, and exactly what a check aborted two seconds in by a member failure leaves behind — with
  a partial or stale `mismatch_cnt` beside it, reported as this scrub's verdict. `mismatch_cnt` and
  `last_sync_action` are now BOTH snapshotted before the check is issued; md zeroes the counter at a
  sync start, so a band is counted only when the counter MOVED, `last_sync_action` says `check`, and
  the array is idle. Short of that the band is "check state unknown — not counted": no rot claimed,
  no clean bill given. `priorAction` earns its snapshot too — a value that changed under us says md
  did take a check, which sharpens the unknown wording. *(`ahr-scrub.test.ts`: the aborted shape
  (counter unchanged at 8) is UNKNOWN and warns nothing; a genuine fast check whose counter was
  zeroed (8 → 0) is counted and clean; 0 → 8 is counted and warns.)*
- **T4 — an abandoned band's check is CANCELLED, not left armed.** When the finish-wait gives a band
  up (frozen, a foreign sync op, the ceiling) it wrote no `idle`, so ANAS's requested check stayed
  armed while the next band's check was issued — and on thaw two parity checks ran at once across
  what are very often the same spindles, against §4's strictly-sequential rule. Every abandonment now
  writes `idle` through `mdadm --action=idle` (the same front door that issued the check, the way
  `boundedWindowCheck` ends its own bounded one) before the `continue`, best-effort and recorded in
  the progress line; on a frozen array md refuses it, and the line says the check may still run when
  it thaws rather than claiming a cancellation that did not happen. *(`ahr-scrub.test.ts`: frozen and
  recover takeovers and the ceiling each write idle before the next band's check is issued; a frozen
  band whose idle is refused says so and the scrub carries on.)*
- **T6 — exhausting the owner-scan cap REFUSES.** F7 made `MAX_OWNER_LEAVES` live, and hitting it
  returned silently — byte-for-byte what "there were no more owning items" returns. Attribution would
  name a prefix of a file's extents as if it were the whole set, and a repair offered on that prefix
  reads as a repair of the file. The scan now tracks whether it reached a real end (the inode's items
  ran out, the learned `ref.offset + ram` limit was passed, or the tree had no next leaf) and throws
  `SelfhealMapError("owner scan truncated at 4 leaves …")` otherwise. `extentsForStripe` has one
  production caller — the attribution pass — so the throw surfaces there, as the finding's
  `unidentified` reason; the repair path never calls it. (Fourth pass: an earlier version of this
  line claimed a mapping abort in the repair path, which is unreachable.)
  *(`selfheal-map.test.ts`: a synthetic level-1 fs tree of five leaves, ten owning items, none past
  the limit — the scan refuses; pre-fix it handed back the eight items its four leaves held.)*
- **T7 — an unverified probe window says so on the finding.** With the mapping down F6 probes at the
  kernel's printed offset, which for a compressed extent names the wrong 64 KiB — so the blocks found
  are real but the list of them is not known to be complete, and nothing on the finding said that.
  Worse, `reason` attached only when `badBlocks` was empty, so one lucky stripe of a multi-stripe file
  erased the reason every other stripe had for finding nothing. `AhrScrubFinding` gains an additive
  optional `probedUnverified: boolean`, set whenever any stripe of the file was probed without the
  mapping, and `reason` is now kept alongside a non-empty `badBlocks`. `unidentified` still means "no
  block could be named at all". The findings window and the notification belong to another lane; what
  they should render off the pair is stated in the code: the blocks, plus a plain line that the search
  window could not be verified and why. *(`ahr-scrub.test.ts`: mapping down with one EIO hit →
  `probedUnverified: true` with the reason kept; mapping up → the field absent; the schema round-trip
  carries a finding with blocks AND a reason.)*

### Schedule, UI and packaging lane (R8–R10, GLM)

R8 — mdcheck adoption on upgrade: on daemon start, a node with no `anas-scrub` units, mdcheck enabled and ≥1 AHR pool is adopted onto the timer (all pools, monthly, mdcheck disabled, one audit line); the note distinguishes the legacy mdcheck-only state from a true double; uninstall removes the schedule units and re-enables mdcheck's timers.

R9 — the mapping-abort outcome is its own count in `AhrRepairResult` (not folded into `unrepairable`): schema, engine verdict loop, notification and Scrubs UI all read the one number, and "restore from backup" is reserved for true unrepairable.

R10 — `writeScrubUnits` reads before it writes: a marker-less `anas-scrub.service` is refused as a foreign unit (409 `reason: 'foreign-unit'`), never overwritten or deleted; `removeScrubUnits` also clears the timer's Persistent stamp; the enable-confirm dialog warns that enabling may start a scrub right away if this month's occurrence was missed.

Cut-but-verified — the runner polls a still-running scrub job with no cap (only a vanished job or daemon outage ends the wait); the findings window shows the newest completed scrub per pool, so a later clean scrub clears an older row's findings; the cadence combo is not overwritten mid-choice by the 10 s poll; the md-event advice lines are pure ASCII; the fourth hand-copy of the systemd unit-store plumbing is extracted into one shared module (`systemd-unit-store.ts`).

F1+F4 — the mdcheck adoption is REVERSED (design ruling: mdcheck is enabled by default on a stock node, so "mdcheck is on" is not an opt-in): `adoptMdcheckScrub` and its daemon-start call path are deleted; the legacy state is only REPORTED (`enabled:false`, `mechanism:'mdcheck-timer'`, note "the OS's monthly md parity check (mdcheck) is on; enabling ANAS periodic scrub takes it over (md parity + btrfs checksums, two phases)"); the per-pool toggle remains the only thing that writes units and takes mdcheck over.

F14 — a failed `writeScrubUnits` is never misreported as `foreign-unit`: the toggle route passes `ForeignUnitError` through and wraps every other failure as what it is; `writeScrubUnits` rolls back a failed write (previous pair restored byte-for-byte, or both files removed on a first write, best-effort reload) so the next attempt is clean.

F13 — the foreign-unit check covers BOTH files: the rendered timer carries the `X-ANAS-Schedule=` marker too, `scrubUnitsAreForeign` refuses on either file without it, and a foreign `anas-scrub.timer` alone can no longer be deleted by a disable.

F2+F8 — uninstall removes ALL FOUR ANAS unit families (`anas-snap-*`, `anas-backup-*`, `anas-repl-*`, `anas-scrub.*`, one count line per family) and NEVER re-enables mdcheck: ANAS is stateless and cannot know whether mdcheck was on before ANAS, so the scrub removal prints an honest line saying what is off and the exact `systemctl enable --now mdcheck_start.timer mdcheck_continue.timer` to get it back.

F9 — a vanished scrub job (404) ends the wait after 3 consecutive confirmations (~30 s: a job id is a randomUUID and cannot come back) with a "job vanished (daemon restarted?) — moving to the next pool" journald line, instead of blocking pools 2..n for the old 24 h backstop; the transport-outage handling keeps its own bounded retry, and other non-200s count as outage, not vanish.

Third review of the same schedule/packaging surface (`de17ed1..13cb6b3`, 2026-09-13), all fixed at the
source with a regression test that fails on the old code and passes on the new one.

- **T5 — the LEGACY pre-F13 pair is adopted, not refused.** The intermediate build wrote the
  `X-ANAS-Schedule=` marker into the service but not yet the timer, so the stunt node's on-disk pair
  (marked service, marker-less timer) read as foreign under F13's both-files check — every toggle PUT
  409'd `foreign-unit` in both directions and the timer could never be turned off from the UI. The
  marked .service now VOUCHES for the marker-less timer beside it (the next write re-renders the timer
  with its marker); a marker-less service, or a marker-less timer with no marked service beside it
  (timer-only), is still foreign. *(`scrub-schedule-units.test.ts`: the legacy pair is not foreign and
  is rewritten with the marker on the next write; the timer-only and service-only refusals stand.)*
- **T8 — the rollback takes the timer's enablement down (and puts it back).** `enable --now` enables
  BEFORE it starts, so a failed start on a first write left a dangling `timers.target.wants` symlink
  over a file the F14 rollback deletes; and a restored previous pair came back DISABLED. The rollback
  now best-effort `disable --now`s the timer when the write was the pair's first, and re-enables the
  restored pair when `is-enabled` (read before the write) said it was enabled before.
  *(`scrub-schedule-units.test.ts`: first-write start failure → disable called, no files left; update
  failure → previous pair restored AND its `enable --now` re-attempted after the files come back.)*
- **T9 — the vanished-job counter counts CONSECUTIVE 404s.** The 404 counter was not reset by other
  non-200s, so 404, 503, 404, 404 declared the job vanished after two real 404s. The non-404 branch
  resets `missing`: only three 404s IN A ROW end the wait. *(`scrub-task.test.ts`: the 404/503/404/404
  sequence completes; 404×3 still vanishes — covered by the existing F9 test.)*
- **T11 — the no-adoption guard is STRUCTURAL.** The old guard grepped index.ts's own text, which
  misses the import arriving one hop away. It now resolves the daemon's transitive static import graph
  from index.ts (a string scan over relative specifiers, `.js`→`.ts`, no bundler) and asserts, first,
  that no start-path module outside routes/ references the scrub store, and second — since
  `ahr-scrub.ts` legitimately borrows `mismatchCntArgs` from `scrub-schedules.ts` — that the unit-WRITE
  surface (`writeScrubUnits`/`removeScrubUnits`) is named nowhere outside the store layer and the
  toggle route. *(`scrub-schedules.test.ts`: both walks, plus the live-path check that the toggle
  wiring still reaches the store.)*
- **T12 — replication-units uses the shared unit store.** The fourth store's last private leftovers
  (`unlinkQuiet`, `runSystemctl`, the hand-rolled marker regex, the unit-dir listing/reads) now come
  from `systemd-unit-store.ts` like the other three stores; the marker regex is byte-identical
  (`markerRegex('X-ANAS-Task=')`), behaviour unchanged. *(`replication-units.test.ts` green unchanged.)*

A third review of `de17ed1..13cb6b3` (the disk-identity cache) found three more, all fixed at
the source with a regression test that fails on the old code and passes on the new one, plus the
bounded probe retry the review asked for. One new fixture, `smartctl-open-device-failed.json` —
SYNTHESIZED in the real 7.5 shape (the envelope mirrors `smartctl-standby-skip.json`; the message
is smartctl's own `jerr("Smartctl open device: %s failed: %s")` line), labeled as such in
`disk-identity-cache.test.ts`.

- **T1 — a failed probe is classified FROM THE DOCUMENT, not from a parse error.** smartctl
  `--json` emits a VALID document on an open failure (exit bit 1, a severity 'error' message, no
  device fields), and the executor resolves on a non-zero exit — so the round-2 `error` branch
  (parse-throw only) never fired: a real failure came back as a MEASURED all-null identity,
  overwrote the good one, and cached as a hit for the daemon's lifetime. `isSmartctlProbeFailure`
  now classifies the parsed document — no device identity, or `smartctl.exit_status & 2`, or a
  severity 'error' message — with standby checked FIRST (a sleeping disk is still a skip) and a
  dying-but-readable disk still measured (its FAILED line lands in the document's `output`, not
  in `smartctl.messages`). *(`smartctl.test.ts` for the classifier — including the QEMU
  SMART-unsupported fixture and the dying-disk case; `disk-identity-cache.test.ts` (l)/(m):
  open-failed after a good reading keeps the measured identity, `stale: 'probe-failed'`,
  re-probed; on a never-measured disk the plain unknown; the standby document is still a
  standby.*)
- **T3 — prune only on a list that can name the fleet, and only after repeated absence.** One
  empty `ls /dev/disk/by-id/` made every id fall back to serial/kernel name and pruned the WHOLE
  cache, sleeping disks' preserved identities included. `collectDisks` now passes the list as
  prunable or not (prunable = every disk's kernel name is in the by-id map), an empty list never
  prunes, and an entry is dropped only after 3 consecutive passes of absence from a trustworthy
  list. *(`disk-identity-cache.test.ts` (k)/(o): empty enumeration prunes nothing, one-pass
  absence kept, three-pass absence dropped; a degraded enumeration (kernel-name fallback) keeps
  the fleet intact across the glitch and the next healthy pass.*)
- **T10 — `stale` is only ever over a REAL reading.** A probe failure on a never-measured disk
  reported `stale: true` over an empty/standby placeholder — "last known" about a reading that
  never happened. `stale` is set only when a measured entry exists; the never-measured case keeps
  `staleReason: 'probe-failed'` (the re-probe duty) without the mark, so the payload is the plain
  unmarked unknown. *(`disk-identity-cache.test.ts` (i)/(m); `disks-stale-health.test.ts`: the
  standby→failure payload is unmarked at every step, marked only once a measured reading exists.*)
- **The probe retry is bounded.** A failing disk was re-probed on EVERY pass with no limit. Each
  consecutive failure now delays the next attempt 1, 2, 4, … passes, capped at 8; any answering
  probe (standby or measured) clears it. This supersedes the round-2 "a never-answering disk is
  cached and not re-probed at all" for the FIRST failure — a transient first failure (a udev race
  at boot) no longer blanks the disk for the daemon's lifetime, and a dead path costs at most one
  cheap probe per 8 passes. *(`disk-identity-cache.test.ts` (n): the 1, 2, 4, 8, 8 sequence over
  17 passes; (h)/(i) the backoff inside the first-failure and standby→failure→recovery stories;
  `disks-stale-health.test.ts` the same at the payload level.*)
### Fourth pass

A fourth narrow review of the same arc (`13cb6b3..cbfd063`, 2026-09-14) found eight more, all
mechanical, all fixed at the source with a regression test that fails on the old code and passes
on the new one. No new captures were needed.

- **T4 (again) — the unresolvable-realpath abandonment cancels its check too.** When the band's
  pin symlink would not resolve, the check was still ISSUED (deliberately: an unresolvable name
  costs the wait, never the check) but the `continue` walked away without writing `idle` — the
  fourth abandonment path, after the frozen/recover takeovers, the ceiling and the bounded-window
  check — so the next band's check, and then the btrfs scrub, ran over an armed parity check. The
  path now calls `cancelBandCheck` before the `continue`. *(`ahr-scrub.test.ts`: a failing
  `realpath /dev/md/t2-r1` → `--action=idle /dev/md/t2-r1` issued after that band's check and
  before the next band's `--action=check`.)*
- **T7 (again) — the unverified-window suffix is RENDERED.** `probedUnverified` and `reason` were
  carried on the finding but shown only in the `unidentified` arm, so a finding with blocks found
  in an unverified window read as a complete account. The notification body appends
  ` (search window unverified: <reason>)` to the finding's block text (the `unidentified` arm
  already names the reason, so it does not say it twice), and the findings window renders the same
  suffix muted in the bad-block cell with the reason as tooltip. *(`ahr-scrub.test.ts`: the
  mapping-down EIO hit names the suffix with the reason; the unidentified body does not double it.
  `dialog-contracts.harness.mjs`: the bad-block cell carries the suffix and the tooltip.)*
- **T6 (doc) — the owner-scan cap's throw reaches the attribution, not the repair path.** The
  third-pass T6 line claimed a "mapping abort in the repair path", but `extentsForStripe`'s only
  production caller is the attribution pass; the sentence now says the throw surfaces as the
  attribution's `unidentified` reason. Doc-only.
- **T9 (again) — a transport error also breaks the run of 404s.** The `missing` reset from the
  third pass landed in the HTTP non-404 branch but not the transport-error `catch`, so
  `404 → ECONNREFUSED → 404 → 404` still declared a vanished job after two real 404s. The catch
  now resets `missing` beside `outage += 1`. *(`scrub-task.test.ts`: that exact sequence completes;
  404×3 still vanishes at three confirmations.)*
- **T3 (again) — the prune gate is the LISTING, not the fleet.** `prunable =
  disks.every(d => byIdMap.has(d.name))` was all-or-nothing: one disk with no by-id symlink
  (virtio without a serial, some USB bridges) disabled the prune for ever and the cache grew
  without bound. `prunable` is now `byIdMap.size > 0` (the listing succeeded), and the route passes
  `loadMany` the ids that resolved through by-id as the prune's presence list — only fallback ids
  count as absent. *(`disk-identity-cache.test.ts` (p): a fallback disk alongside a healthy by-id
  listing — the absent disk is dropped after 3 trusted passes, the named disk and the degraded
  enumeration behaviour (o) untouched.)*
- **T8 (again) — the rollback's enablement covers the rewrite-of-a-disabled-timer case.** The
  `disable --now` arm was gated on the timer file not existing before, so a rewrite of a timer that
  was disabled beforehand (or whose `is-enabled` read failed closed to false) that failed after the
  write's own `enable --now` left the timer ARMED. The rollback now disables unless the restored
  pair was enabled before. *(`scrub-schedule-units.test.ts`: a failed rewrite reading
  `is-enabled: disabled` → the rollback calls `disable --now` after the failed enable and never
  re-enables.)*
- **(same file) — the rollback reloads BEFORE the enablement call.** It ran `enable`/`disable`
  first and `daemon-reload` last, so systemd could act on its cached half-written definition. The
  best-effort `daemon-reload` now comes first. *(`scrub-schedule-units.test.ts`: call order asserted
  in both the re-enable and the disable arm.)*
- **T6 (again) — an empty owner scan RETURNS empty.** The end-of-scan check was gated on
  `found.length > 0`, so a file truncated or rewritten since the scrub — leaves holding none of its
  EXTENT_DATA items — walked all four leaves and threw "truncated" over the honest "no extent of
  this file covers the reported stripe". A leaf with none of the inode's items past the first is a
  real end regardless of what was found (the first leaf stays exempt: the descent can land a leaf
  short of the search key). *(`selfheal-map.test.ts`: a synthetic five-leaf tree, every item
  another inode's → `[]`, no throw, and the walk ends at the second leaf.)*
- **T11 (again) — the write-surface guard names its door.** The structural guard's second walk
  skipped the whole routes tree, so any route could have named `writeScrubUnits`/`removeScrubUnits`
  unnoticed. Only `routes/scrub.ts` is exempt now. *(`scrub-schedules.test.ts`: same walk, door
  narrowed — still a string scan, still fast.)*

### Design review (2026-09-14)

A two-altitude read of the arc against `docs/DESIGN.md`, looking for systems-level gaps rather than
line bugs. Everything below was fixed at the source with a failing-before test.

- **D2 (LOSE-DATA) — never interrupt an md operation ANAS did not start.** `echo idle >
  sync_action` and `mdadm --action=idle` do not mean "cancel my check" — they mean "stop whatever
  you are doing", and what md is very often doing after a member fails is REBUILDING ONTO A SPARE.
  Three paths wrote it on sight (`boundedWindowCheck`'s poll loop, `restoreSyncKnobs` whenever the
  array was not idle, and `ahr-scrub`'s `cancelBandCheck` for every abandonment), so a disk failing
  mid-run had its rebuild aborted by the repair or the scrub that was trying to help — and the
  periodic scrub did it on every pass. One helper now decides, for everyone: `ownsSyncOp`
  (`selfheal-syncop.ts`) re-reads `sync_action` immediately before ANY write of `idle` and permits
  it only when it reads `check` AND this run issued a check on that array. `sync_min`/`sync_max` are
  narrowed and widened under the same rule, and the gates became RE-CHECKS: `degraded`,
  `sync_action` and `reshape_position` are re-read immediately before the write step, not only at
  step 1, and a change aborts as `unrepairable` — "array state changed mid-repair: …, nothing
  written". A band whose kernel name will not resolve is now left alone rather than written to
  blind: an unprovable `idle` is the write that aborts a rebuild. *(`selfheal-repair.test.ts`: a
  recovery started between the precheck and the write → no write, no `idle`, md's own
  `sync_min`/`sync_max` untouched, the outcome names the condition and `cleanupErrors` says what was
  left; the bounded check refuses to narrow a running recovery's window; our own check still ends
  with `idle`. `ahr-scrub.test.ts`: a band that went `recover` or `frozen` records not-checked with
  NO `--action=idle` call at all.)*
- **D3 (LOSE-DATA) — the csum leaf now proves itself, and has a second copy.** `readStoredCsum` read
  the leaf RAW off the LV with no self-check: no node-header crc32c, no bytenr check, and only
  `stripe 0` of the DUP metadata chunk. Rot in the csum tree itself came back as a plausible
  four-byte number, no reconstruction could match it, and a HEALTHY block was reported
  "unrepairable — restore from backup", after which the operator overwrites good data. The node is
  now verified exactly the way btrfs does it (crc32c of bytes 32…nodesize == the LE word in bytes
  0…3, and the node's own `bytenr` at header offset 48 == the leaf the walk asked for — both proved
  against the captured `split-csum-leaf.b64`), and a failure falls back to the DUP chunk's second
  copy (`parseChunkItems` reads every stripe now, not just the first). Both copies failing is a
  DISTINCT verdict — `unrepairable` with reason code `csum-unreadable` — whose text says the
  checksum could not be read and explicitly does not say restore-from-backup. Confirmed and
  documented: every `dump-tree -b` the walk consumes is verified by btrfs-progs itself and fails the
  command on a bad block, which `selfheal-btree.ts` already turns into an error, so the raw leaf was
  the only unprotected read in the engine. *(`selfheal-csum.test.ts`: the captured leaf passes; one
  flipped byte, a wrong bytenr and a short read each refuse; a synthetic leaf rotten on stripe 0 and
  good on stripe 1 is answered from the mirror.)*
- **D4 (LOSE-DETECTION) — daemon-start reconciliation.** SIGKILL, the OOM killer, or an upgrade
  restarting anasd mid-repair never runs the engine's `finally`, and the band keeps `sync_max`
  bounded to ONE STRIPE, `rmw_level=0` and `stripe_cache_size=17` for the life of the assembly —
  invisibly. The next monthly check then covers that one stripe, suspends there (GT-13's trap), and
  the 7-day finish-wait holds the pool's job exclusion. `reconcileSelfhealState`
  (`selfheal-reconcile.ts`, hooked once in `index.ts` after the AHR boot scan) reads every AHR
  band's `sync_min`/`sync_max`/`rmw_level`/`stripe_cache_size`, restores anything that is not md's
  own value (GT-1: `0`/`max`/`1`/`256`), logs one journald line per band, and sweeps the
  `anas-selfheal-*` transients through `listAhrSnapshots`/`deleteAhrSnapshot` (§12) and the flat
  pool's in-place prefix. A band md is mid-operation on keeps its sync window and is REPORTED
  instead — D2's rule from the other side. Phase 1 of the scrub also refuses to issue a check into a
  bounded window, restoring it first when the band is idle. Nothing is persisted and nothing is
  remembered: every value is read off the kernel and compared with md's own default, which is
  reading the system, not a shadow database (§11). *(`selfheal-reconcile.test.ts`: dirty knobs →
  restored + logged; a running `recover` → window untouched, band reported; a healthy node → silent;
  RAID1 (no such knobs, GT-16) → silent; both snapshot shapes swept, the operator's own snapshot
  left alone. `ahr-scrub.test.ts`: a 6272..6400 window is widened before the check goes in.)*
- **D7 — a member md kicked after the gates is treated as absent.** `reconstruct` read the siblings
  by device path out of the `mdadm --detail --export` snapshot the gates took, and a kicked member
  still has a path in it — reading it returns that disk's own stale bytes rather than an error.
  `degraded` is re-read immediately before the reconstruction and, when it has moved, each role's
  `rd<n>/state` says who is still in. RAID5 refuses (it needs every other member); RAID6 keeps only
  the syndrome that does not need the missing one — a kicked Q leaves the P-XOR, a kicked P leaves
  the Q solve; RAID1 drops the leg from the candidates. *(`selfheal-repair.test.ts`: a sibling
  kicked between the precheck and the reconstruction → `unrepairable` naming the device, nothing
  written; `reconstructionPlan` asserted level by level.)*
- **S2 — the final cold read is bounded, and says so.** `withTopLevelMount` serialises every holder
  of one pool's top-level mount, so the engine's cold read could join a queue behind a backup run
  for hours — with the block ALREADY WRITTEN and `rmw_level=0` still set on a live array. The read
  is a confirmation, not a gate: `withTopLevelMountWithin` waits at most 60 s (the queue depth is
  checked and the mount taken in the same synchronous turn, so nothing slips in front), and past it
  the outcome is an honest `repaired … (post-check passed; cold read skipped: top-level mount
  busy)`. The pin's DESTROY still waits — a snapshot left behind pins an extent, and by then every
  md knob is already restored. *(`selfheal-repair.test.ts`: a holder taken at the write step → the
  block is written, the cold read is skipped, the step is marked ok with its reason.)*
- **S3 — the per-band pre-issue re-check.** `mdadm --action=check` was issued unconditionally per
  band through `run`, which THROWS on a non-zero exit: a band that entered recovery after the
  route-time read failed the whole scrub, or (with the old cancel path) aborted the rebuild.
  `sync_action` is re-read per band immediately before issuing; a busy band is recorded "not checked
  (md is running <op>)" and skipped, and the issue itself no longer throws — a refusal is one band's
  line, never the job's failure. *(`ahr-scrub.test.ts`: a band in `recover` gets no check issued and
  no write; a band whose `--action=check` exits 1 is recorded and the scrub carries on.)*
- **S6 — the check exclusion is node-wide, and survives a restart.** Every other "already scrubbing"
  refusal is in-process — the pool state a topology read reports, and the job queue's own record —
  and a daemon restart takes both with it: md's check on band r1 keeps running while the job that
  issued it is gone, and the next scrub issues checks on bands that share spindles with it. The
  scrub route now reads /proc/mdstat once and refuses on a `check` (including a queued or delayed
  one) running on ANY AHR band of ANY pool on the node: "an md check is running on <band> (started
  outside this job or by a previous daemon)". A check on another pool's band is invisible to the
  requested pool's state no matter what, and on a real node those bands are very often slices of the
  same disks. *(`ahr-scrub.test.ts`: `runningAhrCheck` over two pools, a DELAYED check, a non-AHR
  array ignored, one mdstat read. `ahr-mutate.test.ts`: the route answers 409 with that message and
  no confirm code.)*
- **selfheal.10 — Rewrite parity rides these rules rather than reopening them.** The one verb that
  runs `mdadm --action=repair` (`services/ahr-parity-rewrite.ts`) reuses D2's ownership helper, the
  repair engine's own gates and pre-write re-check, and the scrub's phase-2 pass verbatim: both its
  md operations are whole-band with `sync_max` at its default, so it never narrows a window and
  never writes `idle`, and an operation md took of its own ends the run with every knob as md left
  it. Its licence is the two-phase scrub's verdict — mismatches on the band, checksums clean across
  the pool — re-taken immediately before the md write, with a FRESH btrfs scrub in between that
  aborts on any finding, because `repair` would bless that rot (GT-18's negative control).
  *(`ahr-parity-rewrite.test.ts`: each precondition refusal, the fresh-scrub abort with no
  `--action=repair` issued at all, a foreign op replacing the repair and the check, and a check that
  still counts mismatches reported as `still-mismatched`. Suite case 8 + its control on the stunt
  node: `test/self-heal/suite/LAST-RUN-parity.md`.)*
