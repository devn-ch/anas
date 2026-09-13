# selfheal fixtures — provenance

Captured verbatim from a live loop-device rig on the stunt node (`anas-pve`,
192.168.200.50) on 2026-09-11, kernel `7.0.14-12-pve`, mdadm `v4.4`,
btrfs-progs `v6.14`. The rig is the one `test/self-heal/gt/00-rig.sh` builds —
7 × 200 MiB loop files under `/root/gtsh/`, md RAID5 (6 members) or RAID6
(7 members), chunk 64 K, left-symmetric, `--assume-clean`, LVM VG `gtsh` →
LV `gtsh/data`, `mkfs.btrfs -m dup -d single`, subvolume `@data` mounted at
`/mnt/gtsh`. Nothing here is hand-written or reformatted; the capture script is
`test/self-heal/suite/common.py` driven from a throwaway script, and the rig was
torn down afterwards (`test/self-heal/gt/out/` is produced on the node and never
committed, which is why these live here instead).

Two marker files were written into `/mnt/gtsh/@data`:

- `f1.bin` — 8 MiB of seeded random data, uncompressed, one 8 MiB extent.
- `f3.bin` — 4 MiB of repeating text written after `mount -o remount,compress=zstd`,
  so it lands as 32 extents of 128 KiB, each compressed to a single 4 KiB
  on-disk block (the compressed-extent case).

| file | what it is |
|------|------------|
| `dump-tree-chunk.txt` | `btrfs inspect-internal dump-tree -t 3 /dev/mapper/gtsh-data` — the chunk tree. Carries the GT-2 case: an 8 MiB first DATA chunk with delta 0 and a 112 MiB second one with delta 60,358,656. |
| `dump-tree-subvol.txt` | `… dump-tree -t 256 …` — the subvolume tree holding both files' EXTENT_DATA items (inode 257 = f1.bin, 258 = f3.bin). |
| `dump-tree-csum.txt` | `… dump-tree -t 7 …` — the csum tree. |
| `dmsetup-table-lv.txt` | `dmsetup table /dev/mapper/gtsh-data` — one linear segment at md offset 2560 sectors. |
| `dmsetup-table-all.txt` | `dmsetup table` — the name-prefixed form of the same. |
| `findmnt-source.txt` | `findmnt -n -o SOURCE -T /mnt/gtsh/@data`. |
| `stat-inode-f1.txt`, `stat-inode-f3.txt` | `stat -c %i` of the two files. |
| `btrfs-rootid.txt` | `btrfs inspect-internal rootid` of f1.bin. |
| `md-sysfs-raid5.txt`, `-raid6.txt`, `-raid1.txt` | Every md sysfs attribute the engine reads, one `key=value` per line, plus each `rd<n>/`. RAID1 is the AHR band case that has NO `rmw_level` and NO `stripe_cache_size` — the reason the engine treats both as optional. |
| `mdadm-detail-export-raid5.txt`, `-raid6.txt`, `-raid1.txt` | `mdadm --detail --export` — the role → device map. |
| `expected-mapping.json` | The ANSWERS: what `test/self-heal/suite/common.py` (the selfheal.2 verification-side mapper, written independently in Python) resolves for five file blocks, plus each block's stored csum. The TypeScript mapping helper is asserted against these numbers. |
| `member-block-f1-300.b64` | The actual 4096 bytes at `(m0, 4308992)` — f1.bin block 300 on its member disk — base64. |
| `member-block-f1-300.csum` | btrfs's stored csum for that block. `crc32c(member-block-f1-300)` must equal it: that one line is the whole arbitration claim, checked against the filesystem's own number rather than a self-consistent one. |

The RAID1 captures come from a separate 2 × 64 MiB loop array
(`mdadm --create --level=1 --raid-devices=2 --assume-clean`), built and torn
down in the same session.

## Tree-walk fixtures (the bounded lookup path)

A SECOND rig, built the same way but deliberately FILLED — 4 × 100 MiB of
`/dev/urandom` plus 3000 small text files — so that the csum tree and the fs
tree both go multi-level (`level 1`) instead of being one leaf each. That is the
only state in which a key-directed descent is exercised at all.

| file | what it is |
|------|------------|
| `dump-tree-roots.txt` | `btrfs inspect-internal dump-tree -r` — one short line per tree root, which is where every bounded walk starts. The whole output is 624 bytes. |
| `node-<bytenr>.txt` | `btrfs inspect-internal dump-tree -b <bytenr>` for EVERY node along one real path per tree: the csum root node (28 children) and two of its leaves, the fs-tree root node (83 children) and two of its leaves, and the chunk tree (one leaf at this size). |
| `tree-walk-expected.json` | The ANSWERS, again from an independently-written Python walker: for each target, the exact sequence of block numbers the descent must visit, plus the mapping and stored csum it must arrive at. It also carries `last_child` — a csum target that sorts past every separator key of the root node, so the "largest key ≤ target" selection is checked at the END of a node, where getting it wrong answers confidently from the wrong subtree — and `inline`, the fs-tree leaf holding a tiny file's INLINE extent, which the engine must recognise and refuse rather than map. |

The two rigs are different filesystems, so the bytenrs in the tree-walk
fixtures have nothing to do with those in the mapping fixtures above; each set
is self-consistent and the tests keep them apart.

## Compressed-extent attribution fixtures (selfheal.8)

A THIRD capture, from a throwaway 256 MiB single-device loop rig on the same
stunt node on 2026-09-11 (kernel `7.0.14-12-pve`, btrfs-progs `v6.14`;
`mkfs.btrfs -m dup -d single`, subvolume `@data` mounted `compress=zstd`,
`f.bin` = 2 MiB of repeating text → 16 zstd extents of 128 KiB, each a single
4 KiB on-disk blob). One blob (logical 13635584 — the extent covering file
bytes 131072–262143) was overwritten with junk, the file read cold, and
`btrfs scrub start -B` run. The rig was torn down afterwards.

| file | what it is |
|------|------------|
| `dump-tree-roots-compressed.txt` | `dump-tree -r` of that filesystem. Names the EXTENT_TREE root — the one tree the selfheal.5 walk never needed and selfheal.8 does: it is keyed by DEVICE logical, the only btrfs index answering "which extent owns this on-disk byte". |
| `dump-tree-extent.txt` | `dump-tree -b <extent-root>` — the whole extent tree (one leaf). Every EXTENT_ITEM carries its `extent data backref root R objectid I offset O count C`; `O` is the extent's real FILE offset — for the corrupt extent, `offset 131072` while the scrub warning printed `offset 0`. |
| `dump-tree-subvol-compressed.txt` | `dump-tree -b <file-tree-root>` — the subvolume tree leaf holding f.bin's 16 zstd EXTENT_DATA items (inode 257). |

Kernel facts the capture settled (they are not in the GT drill, which never
scrubbed a compressed file on its rig):

- The scrub warning's `logical` is the **64 KiB stripe** containing the failing
  blob, not the blob itself: a corrupt blob at 13635584 was reported at
  `logical 13631488` — and an earlier probe run that corrupted a second blob
  (13651968, 16 KiB further) was reported at the SAME `logical 13631488`. The
  kernel does not say which blob inside the stripe failed.
- The scrub warning's `offset` is **extent-relative** for compressed extents
  (`0` here, and `0` in the live-proof F3 line for an extent starting 128 KiB
  into the file), while the read-time `csum failed` lines print the true
  FILE offset (`off 131072`). Probing the file at the scrub warning's offset
  reads the wrong 64 KiB — the F3 trap.
- The route from a named logical to the corrupt extent is the kernel's own:
  the extent tree at that logical, whose data backrefs name the owning
  (subvolume, inode, offset). **The backref's `offset` is `file_offset −
  extent_data_offset`, not the file offset** — on this rig every extent was
  freshly written, so the two coincided and the difference did not show. The
  split-extent capture below is where it does.

## Split-extent fixtures (review remediation R2, 2026-09-13)

A 1 GiB single-device loop rig on the stunt node (`anas-pve`, kernel
`7.0.14-12-pve`, btrfs-progs `v6.14`; `mkfs.btrfs -m dup -d single
--sectorsize 4096`, subvolume `@data`, no compression). `f1.bin` = 8 MiB of
random bytes, synced; then 4 KiB overwritten at file offset 1 MiB and synced
again — the CoW split. The rig was torn down afterwards (`capture-split.sh`,
run once; the numbers below are its output, recomputed on the node).

| file | what it is |
|------|------------|
| `split-dump-tree-subvol.txt` | `dump-tree -t <subvolid>` (one leaf). Inode 257 now has THREE EXTENT_DATA items: `(0, offset 0, nr 1048576)`, the new 4 KiB block at 1 MiB, and `(1052672, offset 1052672, nr 7335936)` — the tail of the ORIGINAL extent, same `disk byte 13631488`, starting a megabyte into it. |
| `split-dump-tree-extent.txt` | `dump-tree -t 2`. The 8 MiB extent carries ONE data backref, `offset 0 count 2`: both owning items hash to the same backref, which is what proves a backref offset is not a file offset. |
| `split-dump-tree-chunk.txt` / `split-dump-tree-roots.txt` | The chunk tree and the tree roots of that filesystem — the hop the csum leaf read needs. |
| `split-dump-tree-csum.txt` | `dump-tree -t 7` (one leaf, bytenr 30801920). |
| `split-csum-leaf.b64` | That csum leaf read RAW off the image (20 KiB from the chunk-hopped device offset 39190528) — the stored values, which a tree dump does not print. |
| `split-block-300.b64` | File block 300 read through the filesystem with O_DIRECT. |
| `split-expected.json` | What the node computed: `logical_byte 14860288` (with the extent data offset) vs `13807616` (without), the stored csum at each (`0x8b9126a3` / `0xa36a7021`), and `crc32c` of the block (`0x8b9126a3`). The csum tree is the arbiter of which arithmetic is right. |

## Multi-band fixtures (review remediation R1, 2026-09-13)

Six 200 MiB loop files on the same node: two 3-member RAID5 arrays with
DIFFERENT geometry (`--chunk=64` and `--chunk=512`, data offsets 2048 and 4096
sectors), both `pvcreate`d into one VG with one LV across them — the AHR
multi-band shape (AHR-DESIGN §2.6: the LV is a linear concatenation of one md
array per band, in band order). Torn down afterwards.

| file | what it is |
|------|------------|
| `twoband-dmsetup-table-lv.txt` | `dmsetup table` of the LV: `0 811008 linear 9:127 2048` then `811008 802816 linear 9:126 2048` — two segments, two arrays, in band order. |
| `twoband-md-sysfs-band1.txt` / `twoband-md-sysfs-band2.txt` | The same sysfs `key=value` capture as the rigs above, one per array (`chunk_size` 65536 vs 524288, `rd<n>/offset` 2048 vs 4096). |
| `twoband-mdadm-detail-export-band1.txt` / `…-band2.txt` | `mdadm --detail --export` for each — the role → device map, disjoint member sets. |
