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
| 1r6-b | RAID6 with the P member failed after repair (Q reconstruction path) | (same controls) |
| 2 | zero-block mapping: corrupt the data slot of a zeros file (scan hits data AND parity; flip-test disambiguates), repair invoked with a deliberately wrong block index onto a healthy zero block must exit 4 | 2-neg: the correct block still repairs (exit 0) and reads back cold |
| 3 | compressed extent (`compress=zstd`), file page-cached BEFORE the rot: repair's end-to-end read must go cold via the fresh snapshot | 3-neg: first the warm-cache pair — live read succeeds, snapshot read EIOs |
| 4 | `REPAIR_FAIL_AT=<step>` injected at every step boundary of the reference repair (11 steps): exit 70, `rmw_level`/`sync_min`/`sync_max`/`sync_action` restored, no transient snapshot left, then a full md check covers the whole array again | 4-neg: a clean run repairs and restores everything |
| 5 | above-md rot (junk written THROUGH md, parity agrees): pre-check diagnoses it, exit 3, `precheck_mismatch == 0` | 5-neg: below-md rot in the same file repairs normally, not exit 3 |

Each case records its verdict and a detail line; the final line of the report
is `SUITE: PASS|FAIL (n/m cases, k/l negative controls)` and the suite exits 0
iff everything passed.

## How to run

From the dev box:

```sh
test/self-heal/suite/run-suite.sh                 # NODE=root@192.168.200.50
NODE=root@someother test/self-heal/suite/run-suite.sh
```

`run-suite.sh` rsyncs this directory (+ `../gt/lib.sh` and `../gt/00-rig.sh`)
to `/root/gtsh/` on the node, runs `python3 /root/gtsh/suite/suite.py` there
over ssh, pulls `report.md`/`report.json` back into `out/`, and copies the
report to `LAST-RUN.md` (the committed record of the last full run). Exit code
is the suite's. (This dev-box-entry shape is the story's chosen convention:
run from the dev box, everything else happens on the node.)

Requires on the node: python3, mdadm, lvm2, btrfs-progs, ~5 GB free under
`/root`, and 7 loop devices.

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
- **teardown race**: the drill's `teardown_all` swallows a busy
  `mdadm --stop` (`|| true`); after one green run `/proc/mdstat` still listed
  md127 until a second teardown. `suite.py` retries teardown once for this.

## Files

- `run-suite.sh` — dev-box entry (rsync + ssh + pull report).
- `suite.py` — orchestrator: builds the RAID5 rig, runs cases, tears down,
  builds the RAID6 rig, tears down, writes `report.md`/`report.json` under
  `/root/gtsh/suite-out/`, prints the `SUITE:` line.
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
