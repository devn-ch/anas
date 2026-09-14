# AHR self-heal — ground truth (story selfheal.1)

Loop-device drill on the stunt node. No product code; scripts under `test/self-heal/gt/`
(rig `00-rig.sh`, markers `01-markers.py`, locate `02-locate.*`, stages `03`–`08`,
helpers `lib.sh`/`crc32c.py`), raw outputs under `test/self-heal/gt/out/` (gitignored).
GT-18..21 (2026-09-14, follow-up to the self-heal design review) add stages
`09-gt18.sh`(+`09-gt18-xor.py`), `10-gt19.sh`, `11-gt20.sh`(+`11-gt20-leaf.py`,
`11-gt20-followup.sh`), `12-gt21.sh`; raw outputs under `out/gt18..gt21/`, `out/gt20f/`.
GT-22 (2026-09-14, story selfheal.11) adds `13-gt22.sh`(+`13-gt22.py`); raw outputs
under `out/gt22/`; each arm ran on its own freshly built 2 × 200 MiB RAID1 rig.
Rig: 7 × 200 MiB loop files under `/root/gtsh/`, `md/gtsh5` (RAID5, 6 members),
`md/gtsh6` (RAID6, 7 members), VG `gtsh` → `gtsh/data`, btrfs `-m dup -d single`,
subvolume `@data`. Marker files carry a 33-byte ASCII signature at file block 300.

- Node: `anas-pve` (192.168.200.50), Debian PVE 9
- Kernel: `7.0.14-12-pve` (GT-1..21), `7.0.14-17-pve` (GT-22, after the stunt-node
  point-release upgrade); mdadm `v4.4 - 2024-11-07`; btrfs-progs `v6.14`; python 3.13.5
- Date: 2026-09-11 (GT-1..21), 2026-09-14 (GT-22)

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

## GT-18 — Parity-member rot: btrfs sees nothing, bounded `md repair` fixes it — and the data-rot negative blesses the rot — PROVEN

Design-review question: is `mdadm --action=repair` the correct verb for the
data-intact / parity-wrong case, and what does it do to a *data* member rot?
Fresh RAID5 rig (6 × 200 MiB, chunk 64K, `md/gtsh5`), f1 marker at block 300 →
`stripe=49 data=m0(/dev/loop0) parity=m4(/dev/loop4) row_moff=4308992`. The
parity member's stripe row was corrupted 4 KiB **behind md** (written to the
loop file at `moff=4308992`), the data member left untouched.

(a) btrfs scrub sees nothing:

```
	read_errors: 0
	csum_errors: 0
	uncorrectable_errors: 0
	corrected_errors: 0
scrub rc=0
```

(b) bounded md check over the stripe (cache evicted): `mismatch_cnt = 8`
(`out/gt18/A-03-check.txt`).

(c) cold read of the file's block 300 through btrfs:

```
cold read blk300: SUCCESS sha=a6109fa891e1265b39e75005774b692166d0a1e84373174020c3ca73d6298f24
  kept block sha: a6109fa891e1265b39e75005774b692166d0a1e84373174020c3ca73d6298f24
  content: MATCH
```

(d) `mdadm --action=repair /dev/md127` bounded to the stripe (`sync_min=6272
sync_max=6400`): accepted, `sync_action=repair`, settled to `idle` on its own.
Post-repair, all three expected facts held (`out/gt18/A-06-post.txt`):
bounded check `mismatch_cnt = 0`; the file still reads `MATCH`; and the parity
member's row now equals the XOR of the five data members' rows
(`parity row == XOR(data rows): True`, `09-gt18-xor.py`).

(e) Negative control — fresh rig, 4 KiB of the **data** member corrupted
instead, same bounded `mdadm --action=repair` (`out/gt18/E-03-precheck.txt`,
`E-05-repair.txt`, `E-06-post.txt`; the repair block is identical to (d)'s):

```
bounded_window_check mismatch_cnt = 8
mismatch_cnt=8
```
```
bounded_window_check mismatch_cnt = 0
mismatch_cnt=0
cold read blk300: FAILED (dd rc!=0):
  dd: error reading '/mnt/gtsh/@data/f1.bin': Input/output error
  m0 [data]: sha256[:16]=39b7e891d622a6d9
  m4 [PARITY]: sha256[:16]=ba09543d18c6ed10
  parity row == XOR(data rows): True
  parity row == junk: False
```

(pre-check 8, then repair, then post-check 0 — the rot is now consistent at
the md layer.)

md rewrote **parity to match the rotten data**: the row is now internally
consistent (mismatch_cnt 0, parity == XOR of the data rows — the parity row
equals the XOR, not the 4 KiB junk itself, because it is `junk ⊕ siblings`),
while btrfs still EIOs the block. The rot is "blessed" at the md layer and
invisible to any future bounded check.

**Verdict: PROVEN.** `md repair` bounded to a stripe is the correct verb for
parity-only rot (data intact) — it repairs parity, leaves data untouched, and
leaves the array clean. It is the *wrong* verb for data-member rot — it
recomputes parity from the bad data and erases the md-layer symptom, so the
engine must arbitrate with the btrfs csum (GT-8/GT-11) *before* any repair
write, never after a bare `md repair`.

## GT-19 — `sync_action=idle` during a recovery: md interrupts and immediately resumes — PROVEN

Design-review question: what does md actually do if self-heal writes `idle`
into a running recovery — does it pause? The rig was 6 × **600 MiB** (not the
standard 200 MiB): measured ~700 MB/s loop writes on this node make a 200 MiB
rig's ~1 GiB rebuild finish in ~2 s, too fast to idle mid-recovery; 600 MiB
gives a ~7 s window. The re-added member reuses the removed loop device (only
4.4 G of headroom on `/`; a 7th 600 MiB file would not fit) — the rebuild is
the same full-array recovery either way. f1 + f5 written, `--fail` /
`--remove` / `--add` of `/dev/loop0` → `sync_action=recover`.

(a) `echo idle > sync_action` (during `recover`): **accepted (rc=0), and the
recovery did not stop** — md interrupted it and resumed on its own ~40 ms
later. dmesg, verbatim (`out/gt19/07-dmesg-history.txt`):

```
[249358.787245] md: recover of RAID array md127
[249359.209105] md: md127: recover interrupted.
[249359.247550] md: recover of RAID array md127
```

The 0.5 s poll already showed `sync_action=recover` at 21.9 % (it was 6.7 %
before the idle write); the 2 s poll logged `RESUMED on its own`.

(b) `mdadm --action=idle /dev/md/gtsh5` (while recovering again at 51.7 %):
rc=0, and dmesg shows the identical interrupt→resume pair ~40 ms apart
(`[249359.838207] recover interrupted.` / `[249359.878460] recover of RAID
array md127`).

(c) `echo check > sync_action` during `recover`: refused, verbatim:

```
/root/gtsh/10-gt19.sh: line 87: echo: write error: Device or resource busy
check write: rc=1 (write error line above, if any)
sync_action now: recover
```

(d) `echo max > sync_max` during `recover`: **accepted** (rc=0; the value was
already `max`, no observable effect). `echo 0 > sync_min`: **refused**
(`write error: Device or resource busy`, rc=1) — the two knobs are not treated
symmetrically mid-recovery. The running recovery ran to the full array either
way.

Then left to finish: `sync_action=idle`, `mismatch_cnt=0`,
`State : clean`, `[6/6] [UUUUUU]`, full-array check `mismatch_cnt=0`.

**UNEXPECTED (for the code): `/sys/block/mdN/md/recovery_start` does not
exist on this kernel** — `cat` fails with `No such file or directory`
throughout the run. Recovery progress must be read from `sync_completed` and
`/proc/mdstat`, not a `recovery_start` attribute.

**Verdict: PROVEN** (the question is settled): `idle` — via sysfs or via
`mdadm --action=idle` — does **not** pause a recovery. md logs
`recover interrupted.`, then starts a new `recover of RAID array` ~40 ms
later, within the same event cycle. A paused recovery is not a stable state;
the self-heal code must never attempt to hold a recovery open or gate on it
being stopped. The recovery also cannot be *aimed* mid-flight: `check` is
EBUSY and `sync_min` is EBUSY while `recover` is running.

## GT-20 — Metadata DUP stripe-0 rot: the raw leaf read can lie; the RW MOUNT (not scrub) repairs it — PROVEN (with an UNEXPECTED)

Fresh `-m dup` rig. The csum tree's root leaf was found via `dump-tree -r`
(short root info): `checksum tree key (CSUM_TREE ROOT_ITEM 0) 30834688
level 0`. **FACT (btrfs-progs v6.14): the *numeric* `-t <n>` is not the kernel
tree object id** — `-t 10` dumps the FREE SPACE tree and `-t 7` the csum tree;
the string form `-t csum` works. The leaf sits in a `METADATA|DUP` chunk
(`logical 30408704..82378751, stripe offsets=[38797312, 90767360]` — both
stripes recorded). Mapping each stripe's device offset through dm+md gives the
two member copies:

```
stripe 0 copy: LV 39223296 -> md 40534016 -> /dev/loop0 moff 9142272
stripe 1 copy: LV 91193344 -> md 92504064 -> /dev/loop1 moff 19562496
```

The oracle scan for the leaf-bytenr bytes (LE u64) hits both copies (at
`loop0@9142320`, `loop1@19562544`, i.e. moff+48) plus the bytenr stored
elsewhere. The leaf's **header csum** identity (the brief's formula) was
verified on the INTACT stripe-1 copy first: btrfs nodesize is 16384, and
`stored(bytes 0..3)=0xf33da5b9 == crc32c(bytes 32..16384)` → **match=True**.
(The header csum field occupies bytes 0..7; the *bytenr* is not at byte 0 —
the scan hit at moff+48 is the bytenr field, so a naive "bytes 0..3 ==
bytenr" locator would be wrong.)

Corruption: the **last 4 KiB** of the leaf (offsets `9154560..9158655`) on
STRIPE 0's copy, written behind md (`0xaa×4096`); the header — bytenr + csum
field — survives, so the header-csum comparison stays meaningful. Post-write:
stripe 0 `sha=f74749be613099ad (changed: True)`, stripe 1 unchanged; on the
corrupt copy `stored(bytes 0..3)=0xf33da5b9` is intact but the recomputed
crc32c no longer matches → `match=False` (detectable), while the intact copy
still `match=True`.

(a) `btrfs check --readonly` on the LV (unmounted) — it reports the bad copy,
falls back to the mirror, and exits clean:

```
checksum verify failed on 30834688 wanted 0xb9a53df3 found 0x944e5a93
[1/8] checking log skipped (none written)
 ...
  found 12746752 bytes used, no error found
rc=0
```

(b) remount + read every file: `mount: ok`; `f1.bin: sha MATCH`,
`f5.bin: sha MATCH` — all read fine, btrfs fell back to the mirror. The
kernel's own account (dmesg, `out/gt20/07-dmesg-mount-correct.txt`) shows the
repair happening at that mount:

```
BTRFS warning (device dm-0): checksum verify failed on logical 30834688 mirror 1 wanted 0xb9a53df3 found 0x944e5a93 level 0
BTRFS info (device dm-0): read error corrected: ino 0 off 30834688 (dev /dev/mapper/gtsh-data sector 76608)
```

(c) `btrfs scrub start -B -R`: **every counter is 0** — `corrected_errors: 0`,
`csum_errors: 0`, `read_errors: 0`. The scrub repaired nothing, because by the
time it ran the bad copy was **already repaired — by the RW mount in (b), not
by the scrub** (see the follow-up below).

(d) `dump-tree -b 30834688`: clean leaf dump, `rc=0` (the copy was already
good by then).

(e) raw `dd` of the copies post-scrub: both copies byte-identical
(`copies_equal_now=True`), and stripe 0's copy is byte-identical to its
**pre-corruption snapshot** (`changed vs pre: False`) — the repair restored
the exact original bytes, not merely consistent ones. Each
`stored(bytes 0..3)=0xf33da5b9` and `crc32c(bytes 32..16384)=0xf33da5b9
match=True`.

**UNEXPECTED (the decisive answer):** the 0-corrected scrub in (c) could not
by itself say who had repaired the copy; the dmesg above already points at
the mount, and a follow-up (`11-gt20-followup.sh`) proved it on the raw
copies (a fresh rig — different fs, same geometry — so the csum values below
differ, but the leaf bytenr and offsets are identical). With the copy still
bad and the fs **unmounted**, `dump-tree -b` on the bad copy:

```
checksum verify failed on 30834688 wanted 0xc13591a3 found 0xecdef6c3
btrfs-progs v6.14
leaf 30834688 items 2 free space 3945 generation 10 owner CSUM_TREE
 ...
  (rc=0)
```

btrfs-progs reads STRIPE 0 first, fails the header csum, prints
`checksum verify failed …`, then **retries the mirror (stripe 1) and dumps
that** — `rc=0` even though the primary copy is garbage. Then, after a bare RW
remount and *before* any scrub, the raw check of the saved offsets:

```
stripe 0 /dev/loop0@9142272: sha=faebd225d61600c7 (changed vs pre: False)
  stored(bytes 0..3)=0xa39135c1 crc32c(bytes 32..16384)=0xa39135c1 match=True
stripe 1 /dev/loop1@19562496: sha=faebd225d61600c7 (changed vs pre: False)
  ... match=True
copies_equal_now=True
```

i.e. **the RW mount itself rewrote the bad stripe-0 copy from the mirror** —
`corrected_errors` never sees it because the repair happens at mount time.
The kernel's own account (dmesg, `out/gt20f/05-dmesg-mirror-correct.txt`):

```
BTRFS warning (device dm-0): checksum verify failed on logical 30834688 mirror 1 wanted 0xc13591a3 found 0xecdef6c3 level 0
BTRFS info (device dm-0): read error corrected: ino 0 off 30834688 (dev /dev/mapper/gtsh-data sector 76608)
```

**Verdict: PROVEN.** A raw leaf read from stripe 0 **can lie** (it is the
chunk's first stripe, so it is read first), but the header csum
(`crc32c(bytes 32..nodesize)` vs bytes 0..3) detects it and every btrfs tool
falls back to the surviving mirror. The repair is done by the **RW mount's
read path**, not by `btrfs scrub` — a scrub on an already-remounted array
reports 0 corrected. For the engine: a metadata-DUP stripe-0 rot is
self-healing on remount and leaves no scrub signal, so the only durable
evidence is the header-csum mismatch on the raw copy (and the one-time dmesg
`read error corrected` line).

## GT-21 — A plain `apt` mdadm reinstall does NOT re-enable admin-disabled mdcheck timers; `systemctl preset` WOULD — REFUTED (for apt) / PROVEN (for preset)

The two mdcheck timers are disabled on the node by the ANAS ruling. The
question: does an ordinary mdadm upgrade re-enable what an admin disabled?
BEFORE (`out/gt21/01-before.txt`):

```
--- systemctl is-enabled mdcheck_start.timer mdcheck_continue.timer:
disabled
disabled
UNIT FILE                STATE    PRESET
mdcheck_continue.timer   disabled enabled
mdcheck_start.timer      disabled enabled
```

Note `PRESET: enabled` on both — the preset *would* enable them (see below).
`/var/lib/systemd/deb-systemd-helper-enabled/` held **`.dsh-also`** files
(`mdcheck_*.timer.dsh-also`, content = the `mdmonitor.service.wants/`
symlink paths), not admin `enable`/`disable` markers. `apt-cache policy mdadm`
→ installed `4.4-11` == candidate (no upgrade available, so this exercises the
reinstall path only).

`apt-get install --reinstall -y mdadm` (rc=0). The postinst's own words:

```
mdcheck_continue.timer is a disabled or a static unit not running, not starting it.
mdcheck_start.timer is a disabled or a static unit not running, not starting it.
```

AFTER reinstall: `is-enabled` still `disabled` / `disabled`; the `.dsh-also`
files' mtimes refreshed but their content was unchanged. **An ordinary mdadm
reinstall/upgrade left the admin-disabled timers disabled** — the
deb-systemd-helper's message above shows it treated each timer as disabled and
skipped it, and no enable was performed.

`systemctl preset mdcheck_start.timer`: **this one flipped them ON**:

```
Created symlink '/etc/systemd/system/mdmonitor.service.wants/mdcheck_start.timer' → '/usr/lib/systemd/system/mdcheck_start.timer'.
Created symlink '/etc/systemd/system/mdmonitor.service.wants/mdcheck_continue.timer' → '/usr/lib/systemd/system/mdcheck_continue.timer'.
preset rc=0
after: enabled
```

(Only two preset files exist on the node — `50-zfs.preset` and
`90-systemd.preset`, neither with a catch-all `disable *` — so no rule matches
`mdcheck_*.timer` and preset falls through to its default-ENABLE, matching the
`PRESET: enabled` column; and it acted on *both* timers from a single-unit
invocation.) The script then removed both symlinks
to restore the ruling — FINAL state `disabled` / `disabled` (`out/gt21/05-final.txt`).

**Verdict: REFUTED for the apt path** — a plain `apt-get install --reinstall
mdadm` (and by extension a version upgrade) does **not** re-enable
admin-disabled mdcheck timers; the postinst skips disabled units. **PROVEN for
the preset path** — `systemctl preset` (or any preset-driven tooling, e.g. a
`preset-all` after a systemd upgrade) **would** re-enable them, because they
carry no preset-exemption and default to enable. The ANAS ruling is safe
against mdadm upgrades but not against a blanket preset pass; if the timers
must stay off, they need an explicit preset/disable, not just `is-enabled`.

---

## GT-22 — Fail-one-leg scrub on a RAID1 band: the scrub-arm works, `--re-add` of a failed member does NOT resync, and `md repair` blindly copies leg 0 — PROVEN (with UNEXPECTEDs)

Story selfheal.11's design-to-ground-truth question: can a MIRROR band's mismatch
(the decision tree's F1/R9 root — md counts disagreeing legs, btrfs reads through md,
phase 2 names nothing) be repaired with md's own mechanism? Rig per arm: freshly built
2 × 200 MiB loop RAID1 (`md/gtsh1`, LVM, btrfs `-m dup -d single`, `@data`), f1 marker
at block 300 located by the raw signature scan on BOTH legs (the suite's
`oracle.py`/`common.py`, pushed to the node as `run-suite.sh` does):

```
{"hits": [["/dev/loop0", 16957440], ["/dev/loop1", 16957440]], "boff": 16957440,
 "data_offset": 1048576, "md_byte": 15908864, "members": ["/dev/loop0", "/dev/loop1"],
 "mddev": "/dev/md127"}
```

Same member offset on both legs (`data_offset` 1 MiB + md LBA, GT-16's RAID1 shape);
rot = 4 KiB of fresh junk written DIRECT to one leg's block 300 behind md. Every
multi-run scrub arm re-injects a fresh rot before each run — see UNEXPECTED(1).

**(a) Rot on leg A, both legs in — md serves the rotten leg, and the scrub REPAIRS
the band through md — PROVEN, with UNEXPECTED(1).** Cold single-block read first:
`[a] cold read of blk300 through md: EIO (rot leg served)`. Three cold scrubs (fresh
rot before each), identical every time:

```
[p1-a-scrub1] read_errors: 0 csum_errors: 1 uncorrectable_errors: 0 corrected_errors: 1
[p1-a-scrub1] WARNING: errors detected during scrubbing, 1 corrected
[p1-a-post-blkA1] m0 (/dev/loop0) blk300: MATCH sha=a6109fa891e1265b
[p1-a-post-blkB1] m1 (/dev/loop1) blk300: MATCH sha=a6109fa891e1265b
```

(scrubs 2/3 byte-identical in shape; dmesg `scrub: fixed up error at logical
14811136 on dev /dev/mapper/gtsh-data physical 14811136`). Bounded full check with a
fresh rot: `mismatch_cnt=128` — the brief's ">0" holds, but note the unit: on RAID1
one rotted 4 KiB block counts 128, on RAID5 it counted 8 (GT-18).

**(b) Order 1 — fail the GOOD leg B: the rot becomes visible, repairable by hand,
and md's own resync finishes the job — PROVEN.** After `--fail` (`[2/1] [U_]`), the
scrub with only the rotten leg servable:

```
ERROR: there are 1 uncorrectable errors
csum_errors: 1 / uncorrectable_errors: 1 / corrected_errors: 0 ; scrub rc=3
```

The naming is in dmesg, not in the scrub summary (GT-3's rule, now on RAID1):

```
[5203.975852] BTRFS error (device dm-0): scrub: unable to fixup (regular) error at logical 14811136 on dev /dev/mapper/gtsh-data physical 14811136
[5203.975898] BTRFS warning (device dm-0): scrub: checksum error at logical 14811136 on dev /dev/mapper/gtsh-data, physical 14811136 root 256 inode 257 offset 1179648 length 4096 links 1 (path: f1.bin)
```

(the plain read path names the exact 4 KiB file offset instead:
`csum failed root 256 ino 257 off 1228800 csum 0x… expected csum 0x02db94b8 mirror 1`
— 1228800 = 300 × 4096; the scrub line's `offset 1179648` is extent-relative, the
extent starts at file offset 49152). Then `--remove` B, hand repair the way the
engine would — the kept-original block written THROUGH md at `md_byte=15908864`,
landing on A only (`m0 blk300: MATCH`), junk injected into the removed B
(`m1 blk300: BAD sha=12ce88678df023d5`), then:

```
[p1-b] mdadm --re-add /dev/md127 /dev/loop1 rc=1 (mdadm: --re-add for /dev/loop1 to /dev/md127 is not possible )
[p1-b-add] mdadm --add /dev/md127 /dev/loop1 rc=0 (mdadm: added /dev/loop1 )
[p1-b-add] recovery done in 1.30s (200 MiB leg)
```

**`--re-add` of a REMOVED member is refused without a write-intent bitmap** (rc=1,
verbatim above) — the verb the story text hoped for does not exist on this rig;
`--add` is the real path. The recovery trail (`out/gt22/p1-b-add-recovery.txt`) shows
md copying A→B: speed ramps 0 → 203776 K/sec, and the poll line that flips the state
is

```
[===================>.]  recovery = 99.7% (203776/203776) finish=0.0min speed=203776K/sec  →  [2/2] [UU]
```

Direction proven by the junk: B's block 300 held junk BEFORE the recovery and reads
`MATCH sha=a6109fa891e1265b` after — **the resync overwrote B's junk with A's good
block**. Post: bounded check `mismatch_cnt=0`, cold btrfs read `MATCH=True`.

**(c) Order 2 — fail the BAD leg A: scrub clean, but `--re-add` does NOT fix A —
REFUTED as stated; the engine-correct arm (--remove + --add) is PROVEN.** Three cold
scrubs with only the good leg servable, all clean every time
(`csum_errors: 0 … corrected_errors: 0`) — the brief's "expected clean" holds, and
with one leg failed the bounded check reads `mismatch_cnt=0` (md compares nothing —
a degraded check cannot see leg rot). Then the arm as the story sketched it:

```
[p2] mdadm --re-add /dev/md127 /dev/loop0 rc=0 (mdadm: re-add /dev/loop0 to md127 succeed )
[p2] recovery done in 0.12s (200 MiB leg)
      [===================>.]  recovery = 99.7% (203776/203776) finish=0.0min speed=0K/sec
[p2-post-readd (bounded full check)] mismatch_cnt=1408
[p2-04-blkA] m0 (/dev/loop0) blk300: BAD sha=f4e8ceb93b2e020f
[p2-06-coldread] coldread: EIO
```

**UNEXPECTED(2): `--re-add` of a FAILED-but-present member "succeeds" without
syncing anything.** rc=0, "succeed", a 0.12 s no-op recovery at `speed=0K/sec`, the
member returns to `[UU]`, and the rot survives untouched (cold read EIO). The story's
order-2 arm must not rely on `--re-add`. The engine-correct sequence — `--fail` +
`--remove` (a still-active member refuses `--remove` outright: `Cannot open
/dev/loop0: Device or resource busy`), then `--add` — gives a REAL recovery:

```
[p2-c2] mdadm --add /dev/md127 /dev/loop0 rc=0 (mdadm: added /dev/loop0 )
[p2-c2] recovery done in 1.20s (200 MiB leg)   →  [2/2] [UU]
[p2-c2 (bounded full check)] mismatch_cnt=0
[p2-c2-03-blkA] m0 (/dev/loop0) blk300: MATCH sha=a6109fa891e1265b
[p2-c2-05-coldread] coldread: MATCH=True sha=a6109fa891e1265b
```

— resync copied B over A's junk (A was BAD before, MATCH after). "If the scrub is
clean, let md's resync fix it" is real, but only via remove+add.

**(d) Read-balance leakage — PROVEN.** With both legs in and a fresh rot before each
run, all 5 cold scrubs saw the rot (`csum_errors: 1, corrected_errors: 1` each, leg A
MATCH after every one) — across four complete probe runs, every cold read and every
cold scrub with a fresh rot served the rotten leg (4/4 cold reads; 3× (a) + 5× (d)
per run, `csum_errors: 1` each). md's read-balance shows no good-leg stickiness here
— but it is not contractual, and a pass where md serves the good leg (scrub clean,
rot persists on A) is exactly what the story's second pass covers. With the GOOD leg
failed and a fresh rot before each run, all 3 scrubs see the error and none can heal:

```
[p3-d-failed-scrub1] read_errors: 0 csum_errors: 1 uncorrectable_errors: 1 corrected_errors: 0
[p3-d-failed-scrub1] ERROR: there are 1 uncorrectable errors
```

(3/3 identical; `scrub rc=3`). Stripe-cache eviction is N/A — RAID1 has no
`stripe_cache_size` (GT-16); only `drop_caches` between runs.

**(e) Timing — PROVEN.** Full-leg recovery of the 200 MiB member: 1.2–1.5 s in every
run that did one ((b) and (c2), reproducible across three complete probe runs);
`/proc/mdstat` speed ramps 0 → 203776 K/sec (≈199 MiB/s = md's default 200 MB/s
sync throttle, not the loop devices). For the confirm gate's estimate: measured
200 MiB legs land at ≈6–7.5 s/GiB with the ramp, floor ≈5.2 s/GiB at the throttle
cap; the cap can be raised with `sync_speed_max` if a gate ever needs to. A full-array
`mdadm --action=repair` runs 1.40–1.51 s with `sync_completed: none` (GT-18's
no-recovery-target rule holds on RAID1).

**(f) `mdadm --action=repair` on a mirror copies leg 0 blindly — PROVEN, both
directions (the notification evidence).** Fresh rigs, bounded check first
(`mismatch_cnt=128` each), repair, then both legs read:

```
rot on m0: [p4-0-blkA] m0 blk300: BAD sha=987155173e8d0462
           [p4-0-blkB] m1 blk300: BAD sha=987155173e8d0462     ; coldread: EIO
rot on m1: [p4-1-blkA] m0 blk300: MATCH sha=a6109fa891e1265b
           [p4-1-blkB] m1 blk300: MATCH sha=a6109fa891e1265b   ; coldread: MATCH
```

With the rot on leg 0, the junk was propagated to leg 1 (the band now agrees on
rotten data — the GT-18 "blessed rot" on a mirror); with the rot on leg 1, leg 0's
good copy won. The winner is always leg 0, never "the good one". Post-repair
`mismatch_cnt` still read 128 (the GT-18 stale-counter note; no re-check was run).

**UNEXPECTED summary**

1. **A scrub that sees a mirror band's rot can heal the whole band through md as a
   side effect.** btrfs re-reads (md's read-balance then serves the good leg),
   writes the good block back, and md propagates the write to BOTH legs:
   `csum_errors: 1, corrected_errors: 1`, both legs MATCH afterwards. This is why
   every multi-run scrub arm here re-injects a fresh rot before each run — without
   that, later runs measure the array an earlier run healed (that exact mistake
   invalidated the first probe run's (a) and (d) arms before the re-injection was
   added).
   It also means a btrfs scrub is ITSELF a repair verb for a RAID1 band whose legs
   disagree — when md cooperates; the case where md serves the good leg every time
   (scrub reports clean, rot persists on A) is the one the fail-one-leg order covers.
2. **`--re-add` of a failed-but-present member is a silent no-op** — rc=0, "re-add …
   succeed", `speed=0K/sec`, no resync, rot survives (and the post-re-add check found
   `mismatch_cnt=1408` — more than the one rotted block's 128; extra units recorded
   verbatim, unexplained). Only a removed member gets a real recovery.
3. **`--re-add` of a removed member is refused** on a bitmap-less RAID1:
   `mdadm: --re-add for /dev/loop1 to /dev/md127 is not possible` (rc=1) — `--add`
   is the verb.
4. **A degraded `check` cannot see leg rot**: with one leg failed, the bounded full
   check read `mismatch_cnt=0` while a rotted block was being served — there is no
   second copy to compare against. With both legs in, one rotted 4 KiB block counts
   `128` (RAID5 counted 8, GT-18).

**Verdict: PROVEN** for the fail-one-leg scrub as a repair mechanism, with the story's
verbs corrected by ground truth: order 1 = `--fail` good leg → scrub (uncorrectable,
names the file) → `--remove` → engine repair per block through md (lands on the
surviving leg) → `--add` (never `--re-add`) → md's resync overwrites the re-added
leg; order 2 = `--fail` bad leg → scrub clean → `--fail` + `--remove` + `--add` →
resync copies the good leg over the rotten one. Every step is md-native; the
degraded window is real and the confirm gate's estimate is ≈6–7.5 s/GiB of band at
md's default sync throttle. `mdadm --action=repair` on a mirror is confirmed dangerous
in both directions (copies leg 0 blindly) — the parity-only notification wording is
justified.

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
- `mismatch_cnt` is briefly STALE after a sync op settles: a `repair` that ends
  with `sync_action=idle` still reads the pre-op count for a moment (GT-18's
  repair printed `final: mismatch_cnt=8` at settle; the subsequent bounded check
  read 0). Read it after a settle delay, or from a fresh bounded check.
- A bounded `repair` on a NON-degraded array reports `sync_completed=none` and
  never suspends at `sync_max` (GT-18) — the GT-5/GT-13 boundary-suspend rule
  applies to `check` (and full resyncs), not to a repair with no recovery target.
- dmesg is the durable record of a DUP-metadata correction: `checksum verify
  failed on logical <bytenr> mirror 1 wanted 0x… found 0x…` + `read error
  corrected: ino 0 off <bytenr>` — both printed at mount time, none of it in
  any `btrfs scrub` counter (GT-20).
- `btrfs inspect-internal dump-tree` (v6.14): `-r` lists every tree root with
  its bytenr; the NUMERIC `-t <n>` is not the kernel tree object id (10 → free
  space tree, 7 → csum tree); use `-t csum` / the string names (GT-20).
- `teardown_all` can fail SILENTLY right after a scrub/unmount: the GT-20
  follow-up's end-of-run teardown left md + PV + VG + LV standing with the
  member files already removed (loops shown as `(deleted)`); the md stop errors
  were preserved in `/root/gtsh/state/stop-errors.log`
  (`failed to stop array … Device or resource busy` / `Cannot get exclusive
  access`). The stack tore down by hand a moment later (nothing held it —
  `fuser` empty, fs unmounted); the loops detach automatically when the array
  stops. Verify node cleanliness after every stage, not just after the script
  prints done.
- Node left clean: all rigs torn down (the GT-20 follow-up's survivor was
  removed by hand — see above); `/root/gtsh/` retained (scripts, keep/, out/);
  mdcheck timers left DISABLED per the ANAS ruling (GT-21).
