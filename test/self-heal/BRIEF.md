# AHR self-heal ground-truth drill (story selfheal.1 — GT only, NO product code)

You are running a ground-truth drill on the stunt node. You write shell/python
scripts under `test/self-heal/gt/`, run them on the node over SSH, capture
outputs, and write `docs/AHR-SELF-HEAL-GROUND-TRUTH.md`. You do NOT touch
`packages/`. First action: save this whole brief verbatim to
`test/self-heal/BRIEF.md`.

## Node + hard safety rules

- Node: `ssh root@192.168.200.50` (key auth works non-interactively). Kernel
  7.0.14-12-pve, mdadm 4.4, btrfs-progs 6.14, LVM, python3 present. ~5 GB free
  on /. 3 GB RAM.
- ONLY touch: loop devices you create from files under `/root/gtsh/`, md
  arrays named `/dev/md/gtsh5` and `/dev/md/gtsh6`, VG `gtsh`, mount
  `/mnt/gtsh`. NEVER run mdadm/lvm/mkfs/dd against `/dev/sda*`, `/dev/zd*`,
  or any device not in `losetup -j /root/gtsh/*`. Never touch the ANAS
  install on the node (`/opt/anas`, systemd units) or `/etc/mdadm`.
- Every rig script starts and ends with teardown (umount, lvremove, vgremove,
  pvremove, mdadm --stop, losetup -d). Use `set -euo pipefail` and a
  `trap teardown EXIT`.
- Context economy: never `cat` a whole output. Redirect every command's output
  to `/root/gtsh/out/<stage>.txt` on the node, then `grep`/`head -40` what you
  need. At the end `rsync -a root@192.168.200.50:/root/gtsh/out/
  test/self-heal/gt/out/` (do not commit `out/`; add it to a `.gitignore` in
  `test/self-heal/`).
- If a step does not behave as the brief expects: record `UNEXPECTED:` with
  the verbatim lines in the GT doc and continue to the next stage. Do NOT
  redesign, do NOT try alternative approaches beyond what the stage says.
- Always `sync; echo 3 > /proc/sys/vm/drop_caches` before reading data you
  expect to come from disk, and read members / md with `dd iflag=direct`.

## Rig (script `00-rig.sh <5|6>`)

- 7 loop files of 200 MiB: `/root/gtsh/m0..m6` (`truncate -s 200M`), attach
  with `losetup -f --show`.
- RAID5: `mdadm --create /dev/md/gtsh5 --level=5 --raid-devices=6
  --chunk=64K --assume-clean --metadata=1.2 <6 loops>` (zeroed members, so
  parity=0 is already correct). RAID6: `--level=6 --raid-devices=7` on all 7.
  Record the resolved `/dev/mdNNN` name (`readlink -f`).
- LVM on top: `pvcreate`, `vgcreate gtsh`, `lvcreate -l 100%FREE -n data gtsh`.
- `mkfs.btrfs -f -m dup -d single /dev/gtsh/data` (this is AHR's profile;
  default csum crc32c). Mount `/mnt/gtsh`, create subvolume `@data`, work in
  `/mnt/gtsh/@data`.
- Record (GT-1) verbatim: `mdadm --detail`, `mdadm --examine <loop0>` (Data
  Offset line), `cat /sys/block/mdN/md/{level,chunk_size,layout,raid_disks,
  rmw_level,sync_min,sync_max,mismatch_cnt,sync_action}`, `dmsetup table`,
  `btrfs filesystem show`, `btrfs inspect-internal dump-super /dev/gtsh/data |
  grep -i csum`.

## Marker files (`01-markers.py`, run on the node)

Every file is built from a seeded PRNG so any block can be regenerated.
Write into `/mnt/gtsh/@data/`:
- `f1.bin` 4 MiB of seeded random bytes (seed 1). Block index 300 (offset
  300*4096) additionally has bytes 0..31 replaced by the ASCII signature
  `ANASGT-F1-MARKER-0123456789abcdef` (exactly 32 bytes).
- `f2.bin` same shape, seed 2, signature `ANASGT-F2-MARKER-...` at block 300.
- `f3.bin` 4 MiB of highly compressible text (repeat "anas selfheal gt\n"),
  signature `ANASGT-F3-MARKER-...` at block 300. Written later in stage 07
  on a `compress=zstd` remount.
- `f4.bin` 4 MiB of zeros with the signature `ANASGT-F4-MARKER-...` at block
  300 only.
- `f5.bin` 8 MiB seeded random (seed 5) — a full-stripe file for stage 05.
Save every file's SHA-256 and the 4 KiB block-300 bytes (`f1.blk300` etc.) to
`/root/gtsh/keep/` BEFORE any corruption. `sync` after writing.

## Locate (`02-locate.sh`) — GT-2 mapping chain, proven by an independent scan

For f1 (and f4, f5 block 0):
1. `filefrag -v /mnt/gtsh/@data/f1.bin` → the extent containing logical block
   300; its `physical_offset` is in 4 KiB blocks on the btrfs device (the LV).
   LV byte = physical_block*4096 + (300 - logical_start)*4096.
2. `dmsetup table /dev/mapper/gtsh-data` → `0 <len> linear <major:minor>
   <start_sector>`; md byte = LV byte + start_sector*512.
3. Compute the EXPECTED member + member offset from md sysfs: chunk = 65536,
   n = raid_disks, data_offset from `mdadm --examine` (sectors*512).
   chunk_index = md_byte // chunk; stripe = chunk_index // (n-1);
   in_chunk = md_byte % chunk. For layout `left-symmetric` (the md default):
   parity_disk = (n-1) - (stripe % n); data slot d = chunk_index % (n-1) maps
   to disk (parity_disk + 1 + d) % n. member_offset = data_offset +
   stripe*chunk + in_chunk. Also print the `left-asymmetric` prediction
   (data disks = all disks in order skipping parity_disk) so the doc records
   which formula matched.
4. INDEPENDENT ORACLE: python scans each `/root/gtsh/m*` file in 1 MiB windows
   for the 32-byte signature (handle window boundaries) and prints
   `(member_file, offset)`. This scan shares no code with step 3.
5. GT-2 passes when step 3's prediction == step 4's scan for f1. Record both.
   For RAID6 (stage 06) repeat: layout `left-symmetric` RAID6 has parity P at
   (n-1) - (stripe % n) and Q at the next disk; data follows Q.
   Record which formula matched; if neither, record UNEXPECTED with numbers.
Also record `btrfs inspect-internal logical-resolve` is NOT needed here, but
run `btrfs inspect-internal dump-tree -t 5 /dev/gtsh/data | grep -B2 -A6
"inode 257"` style once (mounted read-only is fine? — if dump-tree refuses on
a mounted fs, note it and skip) to see the `extent data disk byte` (logical
bytenr) for f1.

## Corrupt + scrub (`03-corrupt-scrub.sh`) — GT-3, GT-4

1. Overwrite f1's block-300 bytes ON THE MEMBER at the scanned offset:
   `dd if=/dev/urandom of=/root/gtsh/mX bs=4096 seek=$((off/4096)) count=1
   conv=notrunc oflag=direct`. Also keep the junk you wrote (`f1.junk`).
2. drop caches. `btrfs scrub start -B -R /mnt/gtsh` → record the summary.
3. `dmesg | tail -30` → record VERBATIM the `checksum error at logical N on
   dev ... physical M ... inode ... offset ... (path: ...)` line AND the line
   that carries `csum 0x... expected csum 0x...`. GT-3 = the scrub names
   logical, physical, path, actual csum and expected csum.
4. Compute crc32c of `/root/gtsh/keep/f1.blk300` in python (implement the
   Castagnoli table, poly 0x82F63B78 reflected, init 0xFFFFFFFF, final xor
   0xFFFFFFFF) and compare with the dmesg `expected csum`. Record match or
   UNEXPECTED (btrfs stores crc32c little-endian; try both byte orders and say
   which matched). GT-4.
5. `dd if=/mnt/gtsh/@data/f1.bin bs=4096 skip=300 count=1 iflag=direct
   of=/dev/null` → record that it fails with an I/O error (`EIO`).

## Pre-check + above-md control (`04-precheck.sh`) — GT-5, GT-6

1. Bounded md check over f1's stripe: sectors = stripe*chunk/512 .. +chunk/512
   (compute from stage 02; widen to the whole stripe = one chunk of md offset
   space per member, i.e. `sync_min=stripe*128`, `sync_max=(stripe+1)*128`).
   `echo <min> > sync_min; echo <max> > sync_max; echo check > sync_action`;
   poll `sync_action` until `idle` (sleep 1 loop, cap 120 s); record
   `mismatch_cnt`, `sync_completed`. Expected: mismatch_cnt > 0 (rot is BELOW
   md). Then restore: `echo max > sync_max; echo 0 > sync_min`. Record whether
   the literal `max` is accepted (`cat sync_max` after). GT-5.
2. Above-md control on f2: corrupt f2's block 300 by writing junk THROUGH the
   md device: `dd if=/dev/urandom of=/dev/mdN bs=4096 seek=$((md_byte/4096))
   count=1 conv=notrunc oflag=direct` (md_byte from stage 02 for f2). Bounded
   check over f2's stripe → expected mismatch_cnt == 0 (parity agrees with the
   bad data). Then `btrfs scrub` → expected: still detects f2's csum error.
   GT-6 = "zero mismatch + csum error ⇒ corruption arrived through md".
   Restore sync knobs.

## Parity-poisoning negative control (`05-poison.sh`) — GT-7 (THE key result)

Fresh RAID5 rig (rerun 00 + 01 + 02 for f5). f5 is 8 MiB so it spans whole
stripes; pick block 300 of f5 (offset known from stage 02 scan).
1. Corrupt f5's block 300 on its member (as stage 03 step 1). Confirm
   bounded check → mismatch_cnt > 0.
2. NAIVE REPAIR with rmw_level at its DEFAULT (record the value): write the
   ORIGINAL block back through md: `dd if=/root/gtsh/keep/f5.blk300
   of=/dev/mdN bs=4096 seek=$((md_byte/4096)) count=1 conv=notrunc
   oflag=direct`. drop caches; `dd` the block back via md with iflag=direct
   and confirm it equals the original (data member fixed).
3. Bounded check over that stripe → record mismatch_cnt. EXPECTED: > 0
   (parity poisoned by read-modify-write). If it is 0, record UNEXPECTED and
   ALSO record `rmw_level` and raid_disks — md picks reconstruct-write when
   it is no more expensive than RMW, which depends on member count.
4. Prove the poison: fail a DIFFERENT data member of that stripe
   (`mdadm /dev/mdN --fail /dev/loopY`), drop caches, then read the whole
   stripe through md with iflag=direct (all (n-1) data chunks at
   stripe*chunk*(n-1)) and compare each 4 KiB block to the regenerated f5
   content (python, seeded PRNG at the right file offsets — use filefrag to
   map md bytes back to f5 offsets; if a chunk is not f5, skip it and say so).
   EXPECTED: the failed member's chunk reads back WRONG. Record how many
   blocks mismatched. GT-7.
5. Teardown (do NOT re-add; the rig is disposable).

## The fix (`06-fix.sh`) — GT-8, GT-11 (RAID5), then RAID6 GT-12

Fresh RAID5 rig, f5 again, corrupt block 300 on the member.
1. `echo 0 > /sys/block/mdN/md/rmw_level` (record old value, restore in trap).
2. RECONSTRUCT + ARBITRATE in python (the PoC): read, with O_DIRECT, the same
   member_offset 4 KiB from every OTHER member file (data siblings AND parity);
   XOR them all → candidate. Compute crc32c(candidate) and compare with the
   dmesg `expected csum` from a scrub run first. EXPECTED: match. GT-11.
3. READ-BACK GUARD: `dd if=/dev/mdN iflag=direct bs=4096
   skip=$((md_byte/4096)) count=1` must equal the JUNK currently on the member
   (compare to what you wrote). Record.
4. Write the candidate through md with `oflag=direct conv=fsync`.
5. Bounded check → EXPECTED mismatch_cnt == 0. GT-8a.
6. `btrfs subvolume snapshot -r /mnt/gtsh/@data /mnt/gtsh/@snap`; drop caches;
   `dd if=/mnt/gtsh/@snap/f5.bin bs=4096 skip=300 count=1 iflag=direct | sha256sum`
   must equal the original block's sha256. GT-8b. `btrfs scrub` → 0 errors.
7. Fail a DIFFERENT data member, drop caches, read the whole stripe via md as
   in 05-4 → EXPECTED all blocks correct. GT-8c.
8. Restore rmw_level, sync knobs; teardown.
RAID6 (GT-12): rig with `--level=6 --raid-devices=7`; repeat corrupt →
rmw_level=0 → naive candidate is NOT computable by XOR alone, so for RAID6
write the KEPT original block (skip arbitration) with rmw_level=0 → bounded
check == 0 → then fail the P member (identify P for that stripe from the
formula, cross-check by scanning which member holds NO f5 signature bytes...
simpler: record the formula's P disk) AND read the stripe via md → all
correct (this exercises Q reconstruction). Also run the negative control:
same on a fresh RAID6 rig with rmw_level DEFAULT → record mismatch_cnt after
the naive write. Record `rmw_level` semantics for RAID6 as observed.

## Cold-read trap + compression (`07-coldread.sh`) — GT-9

Fresh RAID5 rig.
1. f2: `cat f2.bin > /dev/null` (cache it). Corrupt block 300 on the member.
   Do NOT drop caches. `dd if=f2.bin skip=300 count=1 bs=4096 of=/dev/null`
   (buffered) → EXPECTED succeeds (stale page). Now snapshot ro `@snap`,
   `dd if=/mnt/gtsh/@snap/f2.bin ... iflag=direct` → EXPECTED EIO. Also read
   the snapshot path buffered → EXPECTED EIO. Record all three. GT-9a.
2. Remount `-o remount,compress=zstd`, write f3 (compressible), sync, locate
   its block-300 signature by scan (it is COMPRESSED on disk — if the scan
   does NOT find the ASCII signature, that itself is GT: record it and
   instead corrupt the first 4 KiB of f3's extent from `filefrag -v`
   physical_offset). `cat f3.bin > /dev/null`, corrupt, no drop: `dd
   iflag=direct` on the LIVE f3 → record whether it succeeds (btrfs falls back
   to buffered on compressed extents) ; then snapshot path → EXPECTED EIO.
   GT-9b.
3. Zero-block note (GT-10): for f4, `filefrag -v` — record whether the zero
   blocks are allocated extents at all and whether block 300 lives in its
   own extent. With `compress=zstd` write a zero file and record filefrag.

## sync_max trap (`08-syncmax.sh`) — GT-13

Fresh rig (any). Set `sync_min=0 sync_max=256`, run `check`, wait idle,
record `sync_completed` (EXPECTED `256 / <total>`). WITHOUT restoring, run
`echo check > sync_action` again → record `sync_completed` — EXPECTED it
stops at 256 again (the trap). Then `echo max > sync_max`, run check, wait
idle → EXPECTED full coverage. Record all three.

## Deliverables

1. `test/self-heal/gt/00-rig.sh … 08-syncmax.sh`, `01-markers.py`, helper
   `lib.sh` (teardown, wait_idle, bounded_check, drop_caches), `.gitignore`
   with `out/`.
2. `docs/AHR-SELF-HEAL-GROUND-TRUTH.md`: header (node, kernel, versions,
   date), then GT-1 … GT-13 each with: what was done (one line), the
   VERBATIM key output lines (fenced), verdict (`PROVEN` / `REFUTED` /
   `UNEXPECTED` with the lines). Keep it factual, no recommendations.
3. `docs/EPICS.md`: append an epic `selfheal` at the end with ONE story,
   `**selfheal.1** [done <date>] As a dev, I want ground truth for a
   userspace AHR self-heal repair path (btrfs csum arbitrating md
   reconstruction) on loop devices — result: docs/AHR-SELF-HEAL-GROUND-TRUTH.md`.
   Nothing else in EPICS.
4. ONE commit at the end: `selfheal.1: ground-truth drill for userspace AHR
   self-heal (loop-device rig + GT doc)`. Never push.
5. Leave the node clean: teardown run, `/root/gtsh/` may stay.

Final report: list GT items with verdicts in one table, and every UNEXPECTED.
