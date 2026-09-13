# AHR self-heal loop-device suite (selfheal.2)

The acceptance suite every AHR self-heal repair implementation must pass.
Grown from the `selfheal.1` ground-truth drill (`../gt/`, reused: `lib.sh`,
`00-rig.sh`, the oracle scan concept, `crc32c.py`). Runs entirely on the
stunt node against loop devices built fresh per run and torn down after —
never the ANAS install, never `/dev/sda*` or `/dev/zd*`.

## What it runs

| id | case | negative control |
|----|------|------------------|
| 1a / 1r6-a | parity trap, RAID5 (6 × 200 MiB) / RAID6 (7 members): corrupt a data block below md, repair, fail a DIFFERENT member, every sibling block reads back correctly | 1-neg: the same repair with `rmw_level` at its default MUST poison parity (`mismatch_cnt > 0`) and sibling blocks MUST read back wrong |
| 1r5x-a | the RAID5 parity case again on a rig built with `--chunk=512K` — md's default and the AHR band shape (F4): every stripe/sector window is derived from the array's own `chunk_size`, so nothing is hardcoded to the rig's 64 KiB | 1-neg (same controls, tagged `r5x`) |
| 1r6-b | RAID6 with the P member failed after repair (Q reconstruction path) | (same controls) |
| 2 | zero-block mapping: corrupt the data slot of a zeros file (scan hits data AND parity; flip-test disambiguates), repair invoked with a deliberately wrong block index onto a healthy zero block must exit 4 | 2-neg: the correct block still repairs (exit 0) and reads back cold |
| 3 | compressed extent (`compress=zstd`), file page-cached BEFORE the rot: repair's end-to-end read must go cold via the fresh snapshot | 3-neg: first the warm-cache pair — live read succeeds, snapshot read EIOs |
| 4 | `REPAIR_FAIL_AT=<step>` injected at every step boundary of the reference repair (11 steps): exit 70, `rmw_level`/`sync_min`/`sync_max`/`sync_action` restored, no transient snapshot left, then a full md check covers the whole array again | 4-neg: a clean run repairs and restores everything |
| 5 | above-md rot (junk written THROUGH md, parity agrees): pre-check diagnoses it, exit 3, `precheck_mismatch == 0` | 5-neg: below-md rot in the same file repairs normally, not exit 3 |
| 6 | RAID1 (2 legs, GT-16: no `rmw_level`, no `stripe_cache_size`, `chunk_size` reads 0): corrupt the marker block on ONE leg behind md — the signature is on BOTH legs, the injector picks one hit and records which — repair must exit 0 and the block must read back correct on BOTH legs afterwards (md writes every leg); post-repair cold snapshot read matches | 6-neg: BEFORE the repair, a cold read through md may be served either leg — the control records which leg md served and whether the btrfs read EIOs accordingly; both outcomes are legitimate, so it asserts only coherence (EIO iff md served the corrupt bytes) and that the rot is real on the member |
| 7 | **Two-band rig — the AHR pool shape (review finding R1).** Two md arrays (bands) as the PVs of one VG, one LV spanning both in band order with DIFFERENT chunks on purpose (band A RAID5 6×200 MiB @ 64K, band B RAID5 4×200 MiB @ 512K) — the LV is a linear concatenation, and the segment that owns each byte comes from the dm table, never from one array's geometry. The rig is filled past segment 1 until a marker block lands in segment 2 (band B); corrupt that block on its member (the oracle scans the members of BOTH arrays and records which one it hit) and repair: exit 0 using band B's OWN geometry, the member block reads back the original, an evicted bounded check over band B's stripe reads 0, cold snapshot read matches. The assertion R1 exists to be caught by runs REGARDLESS of the repair's exit: no DATA write on band A — the repair's own snapshot commits a btrfs transaction whose superblock/metadata writes can all sit in segment 1, so every changed band-A 4K block is mapped back to its LV byte through band A's geometry and must fall in md's superblock region, a measured superblock-mirror block, or a SYSTEM/METADATA chunk stripe. The mirrors are measured by the tx-probe (7-txprobe): the suite runs the SAME transaction the repair runs (RO snapshot create + delete) before the baseline and records the band-A blocks it writes — a measured block inside a DATA chunk FAILS the suite (the assertion would have a blind spot) | 7-neg: a marker in segment 1 (band A) repairs normally — both segments of the concatenated LV are reachable, so the segment-2 repair is not a rig fluke; 7-neg2: the post-repair cold snapshot read of the segment-1 block matches |

Each case records its verdict and a detail line; the final line of the report
is `SUITE: PASS|FAIL (n/m cases, k/l negative controls)` and the suite exits 0
iff everything passed.

## How to run

From the dev box:

```sh
test/self-heal/suite/run-suite.sh                 # NODE=root@192.168.200.50
NODE=root@someother test/self-heal/suite/run-suite.sh

# the ANAS repair engine (selfheal.5), deployed by test/stunt-node/deploy-anas.sh
REPAIR_CMD="node /opt/anas/packages/daemon/dist/bin/selfheal-repair.js" \
REPORT_NAME=LAST-RUN-engine.md test/self-heal/suite/run-suite.sh
```

`run-suite.sh` rsyncs this directory (+ `../gt/lib.sh`, `../gt/00-rig.sh` and
`../gt/00-rig-twoband.sh`) to `/root/gtsh/` on the node, runs
`python3 /root/gtsh/suite/suite.py` there
over ssh, pulls `report.md`/`report.json` back into `out/`, and copies the
report to `LAST-RUN.md` (the committed record of the last full run) — or to
`REPORT_NAME` when one is given, so a run with a different `REPAIR_CMD` does not
overwrite the reference implementation's record. Exit code is the suite's.
(This dev-box-entry shape is the story's chosen convention: run from the dev
box, everything else happens on the node.) `REPAIR_CMD` is exported across the
ssh boundary explicitly — ssh carries no environment of its own.

Requires on the node: python3, mdadm, lvm2, btrfs-progs, ~5 GB free under
`/root`, and 10 loop devices (the two-band rig uses 6+4; the rigs are torn
down between runs, so never more than one rig's loops at a time).

## REPAIR_CMD contract

The suite calls `${REPAIR_CMD:-python3 <suite dir>/repair-ref.py}` as
`<cmd> <mountpoint> <file> <block>`.

Exit codes: `0` repaired · `2` unrepairable · `3` diagnosed-above-md ·
`4` mapping-abort ("not corrupt here") · `1` internal error.

Optional env the suite sets:

- `REPAIR_FAIL_AT=<step>` — raise an injected failure immediately BEFORE
  `<step>` and exit 70. Steps: `pin resolve reverify precheck rmw reconstruct
  arbitrate guard write postcheck coldread`. Cleanup in the finally-block
  must still run; case 4 asserts it.
- `REPAIR_REPORT=<path>` — write a JSON sidecar. The suite reads:
  `steps_done`, `injected_at`, `outcome`, `reason`, `precheck_mismatch`,
  `postcheck_mismatch`, `disk`, `moff`, `stripe`, `parity_disk`, `q_disk`,
  `compressed`, `blob_logical`, `blob_sectors`, `bad_sectors`,
  `candidate_csum`, `stored_csum`, `cleanup_errors`. It cross-checks the
  repair's mapping against the suite's own (verification-side) mapping.

A custom `REPAIR_CMD` only needs to honor the three-argument invocation and
the exit codes; the injected-failure and report envs are honored by the
reference implementation and checked when present.

## Implementations that have passed

| REPAIR_CMD | report | result |
|---|---|---|
| `python3 repair-ref.py` (the reference) | `LAST-RUN.md` | 41/41 cases, 14/14 controls |
| `node …/daemon/dist/bin/selfheal-repair.js` (the ANAS engine, selfheal.5) | `LAST-RUN-engine.md` | 41/41 cases, 14/14 controls (2026-09-13, with case 7 on the two-band rig) |

The engine covers everything the reference does and adds the RAID6 Q-syndrome
reconstruction as a fallback when the P-based XOR fails arbitration (a stripe
whose P member is damaged too), and the `gates` step ahead of `pin` — so
`REPAIR_FAIL_AT=gates` is accepted by it and meaningless to the reference;
case 4 injects into the eleven steps both share. Since the hardening round the
suite has a RAID1 case (case 6), which both implementations pass; the engine
also repairs a RAID1 block whose mirror legs DISAGREE from the second leg (the
reference exits 2 — its RAID1 candidates are the surviving legs, and it
refuses when they disagree), a shape the suite does not build. Since the
two-band round (2026-09-13, review finding R1) the suite has case 7 on the
AHR-shape rig, which both implementations pass. Case 7's first engine run
failed on `7-repair` alone — the engine's sidecar carried no `n`, which the
case cross-checks against band B's member count — while `7-bandA-untouched`
already passed (`data=0`): the mapping was right and the REPORT was short a
field the reference has always written. The engine's sidecar now carries
`level`, `n` and `chunk` (the array it actually used), and the case passes.

Two differences the suite cannot see, both about scale and layout rather than
correctness on a rig:

- the engine never DUMPS a btrfs tree. The reference's `dump_tree(dev, 7)` is
  fine on a 1 GB rig and impossible on a real pool (8 TB of data carries ~8 GB
  of checksums); the engine reads tree roots from `dump-tree -r` and then walks
  one 16 KiB node at a time with `dump-tree -b`, descending by key.
- on an AHR pool in the §12 layout the engine pins through `@snapshots` and the
  pool's on-demand top-level mount, exactly as a backup run does. These rigs are
  FLAT filesystems with no `@snapshots`, so they exercise the in-place fallback
  — the §12 branch is covered by unit tests, not here.

## What the reference repair does NOT cover

- **RAID6 P-member or Q-member corruption** — P-only XOR reconstruction needs
  P intact for a data member; with P itself corrupt the reference exits 2
  (restore from backup). Q corruption likewise exits 2. (The suite's case-1
  RAID6 variant fails the P member AFTER a data-block repair — Q
  reconstruction — which IS covered.)
- **Multi-sector corruption inside one compressed blob** — exits 2;
  single-sector (single 4K member block) repair only.
- **NOCOW / prealloc extents** — no stored csum to arbitrate against; exits 2.
- **Above-md rot** — diagnosed (exit 3), not repaired: md parity agrees with
  the bad data, so reconstruction returns the bad bytes and arbitration
  fails; there is no source of truth left below the csum tree.

## Notes (observed on the node, kernel 7.0.14-12-pve, verbatim where it bit)

- **Geometry is read live, never assumed (F4).** Every stripe/sector window
  (`bounded_window_check`, the ±span eviction sweep, `bounded_end_check`) is
  derived from the array's own `/sys/block/mdN/md/chunk_size` — the 128-sector
  window was the loop rig's 64 KiB chunk, and md refuses a non-chunk-multiple
  `sync_max` with EINVAL on a 512 KiB-chunk array (the AHR band shape; the
  suite proves it by re-running the parity case on a `--chunk=512K` rig).
  RAID1 has no stripe geometry at all (GT-16): `chunk_size` reads 0,
  `rmw_level` and `stripe_cache_size` are ABSENT from sysfs (absent means
  absent — the eviction helper returns without touching anything), and
  `sync_min`/`sync_max` are accepted without the chunk-multiple rule, so
  bounded checks there are a plain sector window around the block (64 KiB,
  the engine's convention).
- **mdadm over ssh**: `mdadm --create` asks an interactive write-intent
  bitmap `[y/N]` prompt which blocks forever on an ssh exec channel. Every
  spawned process in the suite (and the reference repair) uses
  `stdin=subprocess.DEVNULL`. If you drive the rig by hand over ssh, redirect
  stdin.
- **md stripe cache hides below-md rot from a bounded check.** A stripe
  recently written through md or recently read by an earlier check is served
  from md's stripe cache afterwards, so a check over it compares
  pre-corruption content and reports `mismatch_cnt=0` while the member block
  is junk. Neither half of the eviction used here is sufficient alone
  (probed live):
  - a sequential sweep of neighbouring stripes at the default cache size
    (256) never evicts the target — released stripes are reused LIFO, so
    only a few slots cycle;
  - shrinking `stripe_cache_size` (floor 17, values below rejected with
    EINVAL) discards cached stripes but KEEPS the 17 most recent — a stripe
    just written through md survives the shrink.
  `common.evict_stripe_cache` therefore shrinks to 17 and then sweeps
  ±200 stripes while small; `bounded_window_check` calls it before every
  check. The same staleness affects degraded reads (`verify_stripe` sweeps
  first).
- **The naive write-back poisons parity unless the stripe's SIBLING data
  blocks are already in md's stripe cache** (settled by a dedicated 3-variant
  probe, two identical runs, 2026-09-11 — see GT-14 in
  `docs/AHR-SELF-HEAL-GROUND-TRUTH.md`). Cache-cold (the real-world case: rot
  sits on disk, nobody has read the stripe through the cache), a default
  `rmw_level` write-through of the correct block does read-modify-write
  against the junk on disk → data member fixed, parity WRONG, a failed
  different member reconstructs 1 wrong block. If a preceding md `check` has
  loaded the stripe (all sibling data blocks up to date in cache), md's
  RMW/RCW cost comparison comes out 0/0 and it takes the reconstruct path:
  parity recomputed from the cached siblings plus the new block → CORRECT.
  A plain aligned READ through md does NOT populate the stripe cache
  (raid5's aligned-read bypass), so "I just read the file" does not protect
  a later write. The suite's negative control runs cache-cold on purpose —
  that is the only state in which it proves anything — and the reference
  repair never relies on cache residency: `rmw_level=0` for the write.
- **A FAILED member's rdN disappears from sysfs immediately.** The kernel
  removes a member's `/sys/block/mdX/md/rdN` the moment it is marked faulty —
  `/proc/mdstat` still shows `loop0[0](F)` and `[6/5] [_UUUUU]`, but `rd0/`
  is already gone. Caught live in the hardening round: the engine repaired
  member m3 of the 512K rig, so the sibling-block check failed member m0, and
  the suite's member-geometry reads — hardcoded to `rd0` — crashed with
  FileNotFoundError while the array was perfectly fine. Member geometry is
  now read from the first SURVIVING rdN (members on these rigs share size and
  data offset; the engine itself reads each member's own `rd<n>/offset`).
- **mismatch_cnt settles after sync_action**: on a small window the check op
  flips to `idle` slightly before `mismatch_cnt` is finalized for that op —
  reading immediately returns the PREVIOUS check's count. `bounded_window_check`
  sleeps 1 s after the op ends before reading.
- **GT-5 rule confirmed**: a check reaching `sync_max < end` SUSPENDS with
  `sync_action` stuck on `check`; `echo idle` while suspended ends the op
  scoped to the window; `echo check` while an op is active returns EBUSY.
- **Compressed-extent csum semantics** (probed live, extends GT): btrfs stores
  one csum entry per ON-DISK sector of the compressed blob, keyed
  contiguously from the extent's logical start across csum-item boundaries;
  entry k of an extent = crc32c(sector k of the on-disk blob). Verified:
  stored `0xd75bbc85 == crc32c(blob sector)`. The repair unit for a
  compressed extent is therefore the whole blob, not the caller's 4K file
  block.
- **filefrag lies on encoded extents** (`physical_hi` is bogus) —
  `btrfs inspect-internal dump-tree -t <subvolid>` EXTENT_DATA items are
  authoritative for `disk byte N nr <disk_len>` + compression.
- **dump-tree must run against the LV**, never the md device: the btrfs LV
  starts at a md member offset (dm start sector), so tree offsets read from
  md are shifted.
- **`mdadm --add` after `--fail` needs `--remove` first** (Device or resource
  busy otherwise); `readd_member` does remove-then-add and waits for idle.
- **Remounting `compress=zstd` must target the mount root** (`/mnt/gtsh`),
  not the subvolume path — a remount target must be a mountpoint.
- **teardown blocked two ways, and the name-in-use trap**: the drill's
  `teardown_all` swallowed a busy `mdadm --stop` (`|| true`) — with the
  multi-rig run this stopped being only an end-of-run hazard, and the first
  failure was doubly silent: `00-rig.sh 5 512K` exited 1 with no output
  because `mdadm --create`'s output went to /dev/null (the create now keeps
  its output and reports it), and the error it finally named was
  `mdadm: Array name /dev/md/gtsh5 is in use already.` — a surviving array
  keeps its metadata name, so only the rig that REUSES a name is refused
  (the RAID6 and RAID1 rigs, uniquely named, never hit it). Two independent
  blockers were found, both live-proven:
  - **the oracle leaked an fd on every scanned device.** `scan_device` sized
    the scan with `os.lseek(os.open(dev, ...), ...)` and never closed it, so
    each scan kept the member — and case 5's md-node scan, the md device
    ITSELF — open in the suite process for the rest of the run. Every later
    `mdadm --stop` of the first RAID5 rig failed EBUSY ("running process"),
    and its loops could not be detached either. That is why only the first
    RAID5 rig was un-stoppable and only while the suite lived: the process
    holding it was the suite.
  - **udev spawns `mdadm --monitor --scan` when a gtsh array is assembled**,
    and that monitor holds every array open: with it alive, `mdadm --stop`
    failed 3× in a row with `Cannot get exclusive access`. It is
    udev-transient — nothing respawns it while no array exists — so
    `teardown_all` TERMs it before stopping arrays.
  `teardown_all` also retries a busy stop 3× with the errors kept in
  `$GT/state/stop-errors.log`; `suite.py` runs the whole retrying teardown
  (`teardown_retry`) between rigs as well as at the ends and stops any
  surviving array still holding one of its own loops BY NODE
  (`stop_stale_gtsh_arrays`, matched against `/proc/mdstat` so a foreign
  array is never touched); and a rig that still will not build is recorded
  as a FAIL rather than crashing the run and hiding the rigs after it.
- **btrfs's superblock mirrors are not stable across mkfs runs** (measured on
  IDENTICAL fresh rigs — same size, same options, two runs): one rig carried
  live supers at 64 KiB and 64 MiB (csum + `_BHRfS_M` magic), a magic-less
  csum+fsid block at 1 MiB whose csum no transaction updates, and an
  ALL-ZERO 320 KiB block (one run's transaction filled it, the manually
  measured one's left it untouched); on another rig the transactions filled
  the 64 MiB + 64 KiB mirror too. LV 0 is all zero and never rewritten. No
  fixed offset list survives this, and a magic scan
  cannot see a zero mirror — so case 7's tx-probe does not guess: it runs
  the repair's own transaction (RO snapshot create + delete) right before
  the baseline digests and measures the band-A 4K blocks it writes (on the
  populated rig: the live supers plus metadata tree blocks, always
  0 in a DATA chunk — a probe hit inside one fails 7-txprobe, because the
  R1 assertion would then have a blind spot). The measured count still
  varies per run (27–52 blocks: the metadata-tree tail of the transaction
  depends on tree state), which is expected — the set is re-measured every
  run, never assumed.
- **The two-band rig's LV is a linear concatenation, read from the dm table.**
  `dmsetup table <LV>` gives one `linear` segment per band (band order), each
  with its own start sector into the band array; `common.dm_segments` parses
  it and the suite asserts the table is exactly two linear segments in band
  order at build time. Every byte→array mapping (verification side and the
  reference repair) takes the covering segment from THAT table and then uses
  only that array's own geometry — the shape of review finding R1 (an
  implementation that placed every block with the first segment's geometry
  passed every single-band rig, because a single-band LV has exactly one
  segment and both geometries agree).

## Files

- `run-suite.sh` — dev-box entry (rsync + ssh + pull report).
- `suite.py` — orchestrator: builds the RAID5 rig, runs the cases, tears
  down, builds the RAID6 rig (parity cases), tears down; the hardening round
  adds a 512 KiB-chunk RAID5 rig (parity case only — the F4 proof) and a
  2-member RAID1 rig (case 6); the two-band round adds the AHR-shape two-band
  rig (`../gt/00-rig-twoband.sh`: two md bands as one VG's PVs, one LV,
  different chunks — case 7 + its control); each rig is torn down in turn;
  then writes `report.md`/`report.json` under `/root/gtsh/suite-out/` and
  prints the `SUITE:` line.
- `cases.py` — the six case functions and their negative controls.
- `common.py` — node-side helpers: md geometry from sysfs, btrfs-tree
  mapping (logical → chunk hop → dm → md LBA → member offset), bounded
  checks, snapshots, marker files, repair invocation.
- `repair-ref.py` — the reference repair implementing the converged
  sequence; the default `REPAIR_CMD`.
- `oracle.py` — THE INJECTOR: raw signature scan of the member devices,
  flip-test disambiguation, junk writes. Shares NO code with the mapping
  helper (harness rule) — locating bytes via `common.locate_block` is
  verification-side only, and the injector's first-scan result is recorded
  and reused because the corruption destroys the signature.
- `crc32c.py` — spec CRC-32C (used for arbitration, not by the injector).
- `LAST-RUN.md` — committed report of the last full run.
