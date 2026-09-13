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

## Review remediation 2026-09-13

R8 — mdcheck adoption on upgrade: on daemon start, a node with no `anas-scrub` units, mdcheck enabled and ≥1 AHR pool is adopted onto the timer (all pools, monthly, mdcheck disabled, one audit line); the note distinguishes the legacy mdcheck-only state from a true double; uninstall removes the schedule units and re-enables mdcheck's timers.

R9 — the mapping-abort outcome is its own count in `AhrRepairResult` (not folded into `unrepairable`): schema, engine verdict loop, notification and Scrubs UI all read the one number, and "restore from backup" is reserved for true unrepairable.

R10 — `writeScrubUnits` reads before it writes: a marker-less `anas-scrub.service` is refused as a foreign unit (409 `reason: 'foreign-unit'`), never overwritten or deleted; `removeScrubUnits` also clears the timer's Persistent stamp; the enable-confirm dialog warns that enabling may start a scrub right away if this month's occurrence was missed.

Cut-but-verified — the runner polls a still-running scrub job with no cap (only a vanished job or daemon outage ends the wait); the findings window shows the newest completed scrub per pool, so a later clean scrub clears an older row's findings; the cadence combo is not overwritten mid-choice by the 10 s poll; the md-event advice lines are pure ASCII; the fourth hand-copy of the systemd unit-store plumbing is extracted into one shared module (`systemd-unit-store.ts`).
