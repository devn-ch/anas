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
