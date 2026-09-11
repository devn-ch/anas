# AHR self-heal — ground truth (story selfheal.1)

Loop-device drill on the stunt node. No product code; scripts under `test/self-heal/gt/`
(rig `00-rig.sh`, markers `01-markers.py`, locate `02-locate.*`, stages `03`–`08`,
helpers `lib.sh`/`crc32c.py`), raw outputs under `test/self-heal/gt/out/` (gitignored).
Rig: 7 × 200 MiB loop files under `/root/gtsh/`, `md/gtsh5` (RAID5, 6 members),
`md/gtsh6` (RAID6, 7 members), VG `gtsh` → `gtsh/data`, btrfs `-m dup -d single`,
subvolume `@data`. Marker files carry a 33-byte ASCII signature at file block 300.

- Node: `anas-pve` (192.168.200.50), Debian PVE 9
- Kernel: `7.0.14-12-pve`; mdadm `v4.4 - 2024-11-07`; btrfs-progs `v6.14`; python 3.13.5
- Date: 2026-09-11

Verdicts are per the drill brief; `UNEXPECTED` carries the verbatim lines. Where the
kernel's own report differs from the brief's assumption, the fact is recorded — not
worked around.

---

## GT-1 — Rig geometry and md/btrfs knobs — PROVEN

Fresh RAID5 rig recorded verbatim (`out/00-gt1-rig.txt`):

```
            Layout : left-symmetric
        Chunk Size : 64K
    Data Offset : 2048 sectors
chunk_size=65536
layout=2
raid_disks=6
rmw_level=1
sync_min=0
sync_max=max
mismatch_cnt=0
sync_action=idle
```

```
0 2031616 linear 9:127 2560
csum_type		0 (crc32c)
csum_size		4
```

RAID6 rig (7 loops): `raid_disks=7`, same chunk/layout (`out/06-info-raid6.txt`).
`layout=2` is sysfs numeric for **left-symmetric**.

## GT-2 — Locate chain file block → member offset, vs independent scan — PROVEN (with a chain correction)

The chain (filefrag → dmsetup → md sysfs formula) predicted `(m0, 4308992)` for
f1 block 300; the independent signature scan (raw windowed scan of every member,
sharing no code) found exactly one hit: `('m0', 4308992)`. Same for f5:
predicted `(m0, 30982144)` == scan hit. f4 predicted `(m2, 30130176)` == scan hit
(a second hit at `m0@30130176` is f4's own parity slot — f4 is zeros except the
signature, so the stripe parity equals the data block verbatim).

```
=== f1.bin logical block 300 ===
btrfs chunk map: DATA logical 13631488+8388608 -> device 13631488 (delta 0)
LV byte   = logical_byte 14860288 - chunk_logical + chunk_device = 14860288
dm start_sector = 2560 -> md byte = LV byte + start_sector*512 = 16171008
md: chunk=65536 n=6 layout=left-symmetric data_offset=1048576 chunk_index=246 stripe=49 in_chunk=49152
predict[left-symmetric] = (m0, 4308992)
oracle scan hits for f1 signature: [('m0', 4308992)]
GT-2 f1: prediction==scan ? MATCH:left-symmetric
```

left-asymmetric was predicted as an alternative and never matched the scan.

**UNEXPECTED(brief) — filefrag's "physical_offset" is the btrfs LOGICAL bytenr,
not the device offset.** With the brief's chain the prediction missed the scan by
60,358,656 bytes. The LV byte needs one extra hop through the chunk tree
(`dump-tree -t 3`):

```
	item 4 key (FIRST_CHUNK_TREE CHUNK_ITEM 82378752) itemoff 15801 itemsize 80
		length 117440512 owner 2 stripe_len 65536 type DATA|single
			stripe 0 devid 1 offset 142737408
```

There can be **several DATA chunks with different deltas** — on one rig an
8 MiB first data chunk had delta 0 and the 112 MiB second chunk delta 60,358,656;
the mapper must select the chunk *covering* the logical byte. Recorded verbatim in
`out/02-f1-locate.txt`.

## GT-3 — Scrub diagnostic quality — UNEXPECTED (partial)

Member-level junk over f1 block 300 → `btrfs scrub start -B -R` reports
`csum_errors: 1`, `uncorrectable_errors: 1` (`out/03-scrub.txt`). The dmesg line
names logical, physical, path — **but not the failing 4K block and no csum values**:

```
[ 3455.495994] BTRFS warning (device dm-0): scrub: checksum error at logical 14811136 on dev /dev/mapper/gtsh-data, physical 14811136 root 256 inode 257 offset 1179648 length 4096 links 1 (path: f1.bin)
[ 3455.496001] BTRFS error (device dm-0): bdev /dev/mapper/gtsh-data errs: wr 0, rd 0, flush 0, corrupt 1, gen 0
```

**UNEXPECTED(brief):** the brief expected a line carrying `csum 0x… expected csum
0x…`; kernel 7.0.14 prints neither csum. The reported `logical`/`offset` is the
**64 KiB btrfs stripe start** (14811136 = extent start + 288·4096, exactly 64 KiB
aligned), not the failing block 300 — the failing 4K must be found by direct reads
with EIO inside the named stripe. The scrub's own summary (last_physical,
csum_errors count) is intact.

## GT-4 — crc32c identity of the expected csum — PROVEN (via csum tree); dmesg route REFUTED

`crc32c(f1.blk300)` (Castagnoli, poly 0x82F63B78 reflected, init/final-xor
0xFFFFFFFF) = `0xb894db02`; stored little-endian `02 db 94 b8`. The dmesg route has
no csum to compare (GT-3), so the stored `EXTENT_CSUM` leaf was read directly through
the md device (`out/03-stored-csum-check.txt`):

```
entry 288: stored=0x05999094 crc32c(regen blk)=0x05999094 MATCH
entry 299: stored=0x38e81104 crc32c(regen blk)=0x38e81104 MATCH
entry 300: stored=0xb894db02 crc32c(regen blk)=0xb894db02 MATCH
entry 301: stored=0xf29e8bc0 crc32c(regen blk)=0xf29e8bc0 MATCH
```

Byte order: the stored 4-byte csum read as **little-endian u32 equals the computed
value** (btrfs stores crc32c LE). Corrupt-block read through btrfs fails as
expected: `dd: error reading '/mnt/gtsh/@data/f1.bin': Input/output error`.

## GT-5 — Bounded md check sees rot BELOW md — PROVEN

Bounded check over f1's stripe (`sync_min=stripe*128`, `sync_max=(stripe+1)*128`):

```
=== bounded check f1 stripe 49 (sync_min=6272 sync_max=6400) ===
rmw_level before: 1
mismatch_cnt=8
sync_completed=6400 / 407552
sync_action=idle
```

`mismatch_cnt=8` — md flags the stripe while btrfs's csum error is the only
symptom above it. The literal `max` is accepted for `sync_max`:

```
echo max > sync_max:
accepted
sync_max now: max
```

**UNEXPECTED(brief):** a check that reaches `sync_max` < device end **suspends**
with `sync_action` stuck on `check` and `sync_completed=6400 / 407552`; writing
`idle` to `sync_action` mid-operation is refused (`echo: write error: Device or
resource busy`). The resume path is `echo max > sync_max`, after which the
operation completes and md returns to idle.

## GT-6 — Corruption written THROUGH md is invisible to md, visible to btrfs — PROVEN

f2's block corrupted via `dd … of=/dev/mdN` inside its stripe:

```
f2 corrupted THROUGH md at md_byte=20365312
mismatch_cnt=0  (expected 0)
sync_completed=none
```

```
[ 4146.552801] BTRFS warning (device dm-0): scrub: checksum error at logical 19005440 on dev /dev/mapper/gtsh-data, physical 19005440 root 256 inode 258 offset 1179648 length 4096 links 1 (path: f2.bin)
	csum_errors: 2
```

Zero md mismatch + btrfs csum error ⇒ the corruption arrived through md (parity
agrees with the bad data). GT-6 holds.

## GT-7 — Naive repair at DEFAULT rmw_level poisons parity — PROVEN (the key result)

Fresh RAID5 rig, f5, member-level junk at the scanned offset, then the original
block written back **through md** with `rmw_level` at its default:

```
data disks this stripe: m5 m0 m1 m2 m3
rmw_level at default: 1
pre-repair bounded check: mismatch_cnt=8
naive repair readback: 4064a6be301875f237d1c94c086b4f4642cc194ebd78f347dd95ddc6350253a2
original block sha:    4064a6be301875f237d1c94c086b4f4642cc194ebd78f347dd95ddc6350253a2
data member fixed: YES
post-repair bounded check: mismatch_cnt=8  (GT-7: expected >0)
```

The data member reads back correct, yet the bounded check still reports 8 —
**the read-modify-write updated parity against the junk, not against the restored
block**. Proof by member failure (fail m5, a *different* data member of the stripe;
reconstruction must use the poisoned parity):

```
chunk 0 (md 16056320, file blocks 272..287): 1 wrong of 16
chunk 1 (md 16121856, file blocks 288..303): 0 wrong of 16
chunk 2 (md 16187392, file blocks 304..319): 0 wrong of 16
chunk 3 (md 16252928, file blocks 320..335): 0 wrong of 16
chunk 4 (md 16318464, file blocks 336..351): 0 wrong of 16
TOTAL wrong 4K blocks in stripe: 1
```

Exactly the failed member's chunk reads back wrong, and only one 4K block in it —
the poison is scoped to the repaired block's parity window. (`out/05-info.txt`,
`out/05-stripe-verify.txt`.)

## GT-8 — Reconstruct + csum-arbitrated repair leaves the array clean — PROVEN

Fresh RAID5 rig, f5, member-level junk, `rmw_level=0`; candidate = XOR of the same
4 KiB member offset on every OTHER member; arbitration against the stored csum;
write through md with `oflag=direct conv=fsync`:

```
pre-repair mismatch_cnt=8
rmw_level now: 0
crc32c(candidate)=0xc5bb14ca stored csum=0xc5bb14ca MATCH — GT-11 PROVEN
read-back guard: md block == junk YES
post-repair mismatch_cnt=0  (GT-8a: expected 0)
snapshot blk300 sha MATCH (GT-8b)
	csum_errors: 0
	uncorrectable_errors: 0
	corrected_errors: 0
failing m5 (/dev/loop5)
TOTAL wrong 4K blocks in stripe: 0
```

a: bounded check clean after repair. b: read-only snapshot cold read of block 300
matches the original sha; full scrub reports 0 errors. c: with a *different* data
member failed, the whole stripe reads back bit-identical through md.

## GT-9 — Warm page vs cold read; compressed extents — PROVEN

**a. Warm page hides the corruption; the snapshot exposes it** (`out/07-gt9a.txt`):

```
live buffered read blk300: SUCCESS (stale page served)
snapshot direct read blk300: EIO (expected)
snapshot buffered read blk300: EIO (expected)
```

**b. compress=zstd:** the 4 MiB compressible file lands as **32 extents of 32
logical blocks (128 KiB) each, every one compressed to a single 4 KiB physical
block** (`filefrag`, `out/07-f3-filefrag.txt`: extent 0 = logical `0..31` at
physical `20112`, extent 1 = `32..63` at `20113`, … extent 9 = `288..319` at
`20121`, all flagged `encoded`). The raw-member scan **does** find the ASCII
signature — but at an **unaligned** offset inside the zstd stream, never at a 4K
block boundary:

```
chain: logical 82378752 -> LV 142737408 -> md 144048128 -> (m2, 29818880)
signature scan on members: [('m2', 29855775)]
```

So marker-block corruption does not apply; the extent's first 4 KiB was corrupted
instead (per the brief). With a warm cache the live file keeps reading (buffered
fallback serves stale pages), and the cold snapshot read of the corrupt region
fails:

```
live DIRECT read blk0: SUCCESS (buffered fallback on compressed extent)
snapshot direct blk0: EIO (expected)
```

The cold snapshot read of file block 300 **succeeded** — and that is expected,
not an anomaly: block 300 is in extent 9 (physical block `20121`), while the
corruption was written to extent 0's single physical block (`20112`, member
offset `m2@29818880`). Only blocks `0..31` share the corrupted extent. (The drill
first logged this as UNEXPECTED; review against `07-f3-filefrag.txt` resolved
it.) Corollary for the compressed case: one corrupt 4 KiB physical block takes
out a whole 128 KiB logical extent, and the failing region is the extent, not a
4 KiB file block.

```
snapshot direct blk0: EIO (expected)
snapshot direct blk300: SUCCESS (different extent — expected)
```

## GT-10 — Zero blocks and extents — PROVEN

f4 (4 MiB of zeros + the marker at block 300, written without compress): **one**
allocated extent covering the whole file — zero blocks are real allocated extents,
and block 300 does **not** get an extent of its own:

```
File size of /mnt/gtsh/@data/f4.bin is 4194304 (1024 blocks of 4096 bytes)
   0:        0..    1023:       4352..      5375:   1024:             last,shared,eof
```

A 4 MiB zero file written under `compress=zstd` lands as `encoded` extents
(32 blocks per 1 MiB of zeros in the `filefrag` listing) — zeros are compressed
and allocated, not skipped (`out/07-gt10.txt`).

## GT-11 — XOR candidate's crc32c matches the stored csum — PROVEN

See the GT-8 block: `crc32c(candidate)=0xc5bb14ca stored csum=0xc5bb14ca MATCH`.
The XOR of the same member offset on the other members reproduces the original
block bit-exactly, and the btrfs csum arbitrates it.

## GT-12 — RAID6: kept-original repair under rmw_level=0, P-member failure — PROVEN

RAID6 rig (7 members, chunk 64K, left-symmetric): f5 block 300 sits at stripe 49,
`P=m6 Q=m0` (formula: P at `(n-1)-(stripe%n)`, Q next, data follows Q). Member
junk → `pre-repair mismatch_cnt=8`. With `rmw_level=0` the kept original block
written through md gives `post-repair mismatch_cnt=0`. Failing the **P member**
and reading the whole stripe through md — every block correct (Q reconstruction
exercised):

```
RAID6: corrupt member=m2 moff=4308992 md_byte=16171008 stripe=49 P=m6 Q=m0
post-repair mismatch_cnt=0  (expected 0)
failing P member m6 (/dev/loop6)
TOTAL wrong 4K blocks in stripe: 0
```

Negative control (fresh RAID6, `rmw_level` at DEFAULT): the naive kept-original
write through md **still poisons parity**:

```
RAID6 negative control: rmw_level=1 (default)
pre-repair mismatch_cnt=8
post-naive-write mismatch_cnt=8
raid_disks=7 rmw_level=1
```

`rmw_level` semantics observed: default 1 = read-modify-write parity update on a
4K write (poisons when the pre-write data was itself corrupt); 0 = reconstruct
write — the data/parity group is rebuilt from what is read, so a corrected block
written through md lands with consistent parity at every level. On RAID6 the
XOR-of-others candidate is not computable (two syndromes), hence the kept-original
route.

## GT-13 — sync_max trap — PROVEN

```
set: sync_min=0 sync_max=256 resync_start=none
run 1: settled=suspended sync_completed=256 / 407552
  idle accepted (op ended, coverage 0..256 only)
resync_start after run 1: none
run 2 (sync_max still 256 — the trap):
run 2: settled=suspended sync_completed=256 / 407552
run 3 (echo 0 > sync_min; echo max > sync_max first):
run 3: settled=idle sync_completed_during=none final_action=idle
restored: sync_min=0 sync_max=max
```

The check suspends at `sync_max` (256/407552 of the array), and **the knob
persists**: a re-run without restoring stops at 256 again. Only restoring
`sync_max` (and a `sync_min` reset) gives full coverage. Two adjacent facts
recorded: while a check is suspended, a new `echo check > sync_action` is refused
(`Device or resource busy`) — end the suspended op with `echo idle` first; and a
bounded op that is ended with `idle` leaves `resync_start=none`, so the next run
starts from `sync_min`.

## GT-14 — The naive write-back poisons parity only when the stripe is cache-cold — PROVEN (probe, two identical runs)

Follow-up to GT-7, run after the `selfheal.2` suite raised the question. Three
variants, each on a fresh RAID5 rig (6 × 200 MiB loops, chunk 64K,
left-symmetric, `rmw_level=1`, `stripe_cache_size=256`), f block 300 on member
`m0` at stripe 49, parity on `m4`; the correct block written back through md
with `oflag=direct conv=notrunc,fsync`; then an evicted bounded check and a
failed-member (`m1`) stripe read (`probe-out/probe.json`, `run2.log` on the node).

| variant | cache state at the write | post-write `mismatch_cnt` | wrong 4K blocks with `m1` failed (of 80) | verdict |
|---|---|---|---|---|
| V1 | cold (`drop_caches` + stripe-cache eviction, no check before the write) | **8** | **1** (in `m1`'s chunk) | POISONED |
| V2 | a bounded `check` over the stripe ran first and was NOT evicted (all sibling data blocks up to date in the cache) | **0** | **0** | CORRECT |
| V3 | the stripe row was READ through md before corrupting (`dd if=/dev/md127 bs=65536 count=5 skip=245 iflag=direct`), no eviction | **8** | **1** | POISONED |

Reading: V1 is the real-world shape (rot on disk, stripe not cached) and it
poisons — GT-7 stands. V2 shows WHY a naive write can come out clean: with
every sibling data block already up to date in the stripe cache, md's
RMW-vs-RCW cost comparison is 0 vs 0 and it takes the reconstruct path, so
parity is recomputed from the cached siblings plus the new block. V3 shows
that a plain aligned read through md does NOT populate the stripe cache
(raid5's aligned-read bypass): "recently read" is still cold for this purpose.
Consequence for the repair sequence: never rely on cache residency between a
pre-check and the write — `rmw_level=0` for the write window, as designed.
The suite's parity-trap negative control is cache-cold by construction.

## GT-15 — md's RAID6 Q syndrome convention — PROVEN (engine probe, three stripes)

Q is `Σ gᵈ · Dᵈ` over GF(2^8) with the primitive polynomial x⁸+x⁴+x³+x²+1
(**0x11D**, not AES's 0x11B) and generator g = 2, where *d* is the data disk's
position in md's stripe order counting from the first disk **after Q** — the same
index the left-symmetric placement formula produces. Verified on a fresh RAID6
loop rig (7 members, chunk 64 K, left-symmetric, `--assume-clean`): P and Q
computed from the member blocks matched the array's own P and Q members
byte-for-byte on stripes 49, 58 and 63, and the Q-only reconstruction of a data
member (`D_f = g^(−f) · (Q ⊕ Σ_{i≠f} gⁱ·Dᵢ)`, P never consulted) reproduced that
member exactly in all three. GT-12 proves Q reconstruction works *through md*;
this is the arithmetic itself, which a userspace reconstruction needs when the P
member of a stripe is damaged too. (`selfheal.5`, `selfheal-repair.ts`.)

## GT-16 — RAID1 arrays do not have the RAID5/6 knobs at all — PROVEN

On a 2 × 64 MiB RAID1 loop array (kernel 7.0.14-12-pve), `rmw_level` and
`stripe_cache_size` are **absent** from `/sys/block/mdN/md/` — not zero, not
present-and-ignored. `chunk_size` reads 0 and `layout` reads 0 while meaning
nothing by it (0 is `left-asymmetric` on RAID5/6, so decoding it as a parity
layout would wrongly refuse the array). `sync_min=128` / `sync_max=256` are
accepted: md's "sync_max must be a multiple of the chunk" rule only applies when
`chunk_sectors` is non-zero. Any code that reads those four attributes
unconditionally breaks on an AHR RAID1 band. (`selfheal.5` fixture
`fixtures/selfheal/`.)

## GT-17 — `array_state` is `clean` or `active` on a healthy array — PROVEN

The freshly built RAID6 rig reported `array_state=clean` and the RAID5 rig, after
marker writes, reported `active`. Both are healthy and writable — `active` only
means the array has dirty stripes. A gate that demands the literal string `clean`
refuses a perfectly writable array; the states that actually bar a write are
`inactive`, `clear`, `readonly`, `read-auto`, `suspended` and `broken`. Adjacent:
`mdadm --detail --export` emits `MD_DEVICE_<name>_ROLE` / `_DEV` pairs — genuine
structured output for the role → device map, so nothing parses `--detail`'s
prose table.

---

## Drill notes (factual, no recommendations)

- `btrfs scrub` error lines on this kernel name the 64 KiB stripe, the path, and
  counts — never the failing 4K and never csum values. Exact-block location inside
  a named stripe requires direct reads (EIO bisect) or the csum tree.
- The stored csum tree is directly readable through md (leaf parse:
  `EXTENT_CSUM` item offsets count from the end of the 101-byte leaf header), and
  its entries equal crc32c of the file content blocks, little-endian.
- Reusing a rig across marker rewrites leaves stale-generation copies of old data
  on members; the signature scan then reports multiple hits. Every stage above ran
  on a freshly built rig (single marker generation).
- The brief's marker string `ANASGT-F1-MARKER-0123456789abcdef` is 33 bytes, not
  32 as stated; it was used verbatim.
- Node left clean: all rigs torn down; `/root/gtsh/` retained (scripts, keep/, out/).
