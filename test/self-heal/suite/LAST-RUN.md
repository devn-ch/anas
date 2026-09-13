# AHR self-heal loop-device suite — report

- date: 2026-09-13 17:14:14  node: anas-pve  kernel: 7.0.14-12-pve
- mdadm: 4.4  btrfs-progs: 6.14
- REPAIR_CMD: `python3 /root/gtsh/suite/repair-ref.py`
- rigs: RAID5 (6 × 200 MiB loops), RAID6 (7 × 200 MiB loops), RAID5 at md's 512 KiB chunk (6 × 200 MiB loops, parity case only), RAID1 (2 × 200 MiB loops), and the two-band AHR shape (RAID5 6 × 200 MiB @ 64K + RAID5 4 × 200 MiB @ 512K in one VG/LV, case 7) — built fresh per run, torn down after (see test/self-heal/gt/00-rig.sh and 00-rig-twoband.sh)

## Cases

| id | case | verdict | detail |
|----|------|---------|--------|
| 1r5-a | parity trap repair (RAID5, block 300) | PASS | rc=0 precheck_mismatch=8 postcheck=0 disk=m0 stripe=49 reason= |
| 1r5-a2 | sibling blocks correct with m1 failed (RAID5) | PASS | stripe 49: 0 wrong of 80 4K blocks |
| 2-scan | oracle scan+flip disambiguation picked the data slot (zeros file) | PASS | scan hit /dev/loop2@30130176 vs mapped m2@30130176 (cross-check only) |
| 2-wrong-index | repair at healthy zero block 200 aborts (exit 4 mapping-abort) | PASS | rc=4 (expected 4) reason=not corrupt here: member content at (m2, 30048256) passes the stored csum for /mnt/gtsh/@data/z1.bin block 200 |
| 3-map | corrupted compressed sector mapped back to a file block (verification side) | PASS | m0@53383168 -> c3.bin block 288 (compressed=True, extent disk 199856128 nr 4096 ram 131072) |
| 3-repair | repair of compressed extent (block 288) arbitrated against the on-disk-sector csum | PASS | rc=0 postcheck=0 candidate=0x30ff786b stored=0x30ff786b reason= |
| 3-cold | fresh-snapshot cold read of the whole extent matches the original content | PASS | blocks 288..319: eio=[] content_mismatch=[] |
| 4-pin | REPAIR_FAIL_AT=pin: exit 70, knobs restored, no transient snapshot | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} snapshots=absent |
| 4-resolve | REPAIR_FAIL_AT=resolve: exit 70, knobs restored, no transient snapshot | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} snapshots=absent |
| 4-reverify | REPAIR_FAIL_AT=reverify: exit 70, knobs restored, no transient snapshot | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} snapshots=absent |
| 4-precheck | REPAIR_FAIL_AT=precheck: exit 70, knobs restored, no transient snapshot | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} snapshots=absent |
| 4-rmw | REPAIR_FAIL_AT=rmw: exit 70, knobs restored, no transient snapshot | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} snapshots=absent |
| 4-reconstruct | REPAIR_FAIL_AT=reconstruct: exit 70, knobs restored, no transient snapshot | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} snapshots=absent |
| 4-arbitrate | REPAIR_FAIL_AT=arbitrate: exit 70, knobs restored, no transient snapshot | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} snapshots=absent |
| 4-guard | REPAIR_FAIL_AT=guard: exit 70, knobs restored, no transient snapshot | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} snapshots=absent |
| 4-write | REPAIR_FAIL_AT=write: exit 70, knobs restored, no transient snapshot | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} snapshots=absent |
| 4-postcheck | REPAIR_FAIL_AT=postcheck: exit 70, knobs restored, no transient snapshot | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} snapshots=absent |
| 4-coldread | REPAIR_FAIL_AT=coldread: exit 70, knobs restored, no transient snapshot | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} snapshots=absent |
| 4-endcheck | bounded check suspends one stripe short of the array end (coverage 0..end-1 stripe proven) | PASS | suspended=True completed=201600/201728 (stripe=128 sectors) mismatch_cnt=8 |
| 4-fullcheck | full md check (sync_max=max) reaches idle — the whole array is covered again | PASS | final=idle sampled_completed=382200/407552 mismatch_cnt=8 |
| 5-scan | md-device scan located the through-md rot | PASS | scan md@153665536 vs mapped 153665536 (cross-check only) |
| 5-sanity | bounded check over the stripe sees mismatch_cnt==0 (rot arrived through md) | PASS | mismatch_cnt=0 (expected 0) |
| 5-diag | repair diagnoses above-md corruption (exit 3, mismatch_cnt==0 in pre-check, nothing written) | PASS | rc=3 precheck_mismatch=0 outcome=above-md steps=4 reason=pre-check: bounded md check over stripe 468 reports mismatch_cnt==0 while the member block fails its csum — parity agrees with the bad data; |
| 5-sanity2 | below-md rot shows mismatch_cnt>0 in its own stripe | PASS | stripe 473: mismatch_cnt=8 |
| 1r6-a | parity trap repair (RAID6, block 300) | PASS | rc=0 precheck_mismatch=8 postcheck=0 disk=m2 stripe=49 reason= |
| 1r6-a2 | sibling blocks correct with m1 failed (RAID6) | PASS | stripe 49: 0 wrong of 80 4K blocks |
| 1r6-b | parity trap repair (RAID6, block 1000) | PASS | rc=0 postcheck=0 P=m4 Q=m5 reason= |
| 1r6-b2 | sibling blocks correct with P member m4 failed (Q reconstruction) | PASS | stripe 58: 0 wrong of 80 4K blocks |
| 1r5x-a | parity trap repair (RAID5, block 300) | PASS | rc=0 precheck_mismatch=8 postcheck=0 disk=m3 stripe=6 reason= |
| 1r5x-a2 | sibling blocks correct with m1 failed (RAID5) | PASS | stripe 6: 0 wrong of 512 4K blocks |
| 6-scan | marker block found on every RAID1 leg at the same member offset; one leg corrupted behind md | PASS | rot injected on leg m0 (/dev/loop0@16957440); hits: loop0@16957440 loop1@16957440 |
| 6-repair | repair of a one-leg corruption (RAID1, block 300) | PASS | rc=0 postcheck=0 disk=m0 good_legs=[1] reason= |
| 6-legs | block reads back correct on BOTH legs after repair (md wrote every leg) | PASS | rot was on m0; now: m0=ok m1=ok |
| 6-cold | post-repair cold snapshot read of the block matches the original | PASS | eio=[] content_match=True |
| 7-txprobe | the tx-probe transaction touched no DATA chunk (the measured housekeeping set has no blind spot for the R1 assertion) | PASS | 27 band-A blocks measured, 0 in a data chunk |
| 7-scan | oracle scan (members of both arrays) located the segment-2 block on a band-B member | PASS | hit m2 of band B (loop8); verification-side map: m2 of /dev/md126, stripe 46, member offset 26599424 |
| 7-bandA-untouched | no DATA write on band A: every changed band-A sector is btrfs superblock/metadata housekeeping (the R1 assertion) | PASS | changed sectors: 125 — housekeeping=125 data=0 |
| 7-repair | two-band: REPAIR_CMD of the segment-2 (band B) marker block exits 0 using band B's geometry | PASS | rc=0 postcheck=0 n=4 (band B n=4) disk=m2 stripe=46 reason= |
| 7-member | band-B member block equals the original after repair | PASS | loop8@26599424 match=True |
| 7-bcheck | evicted bounded check over band B's stripe reads 0 | PASS | stripe 46 of md126: mismatch_cnt=0 |
| 7-cold | post-repair cold snapshot read of the segment-2 block matches the original | PASS | eio=[] content_match=True |

## Negative controls

| id | control | verdict | detail |
|----|---------|---------|--------|
| 1r5-n1 | naive repair at default rmw_level poisons parity (RAID5) | PASS | bounded check stripe 49: mismatch_cnt=8 (expected >0) |
| 1r5-n2 | sibling blocks BROKEN with m1 failed (RAID5, default rmw) | PASS | stripe 49: 1 wrong of 80 4K blocks (expected >0) |
| 2-neg | repair at the actually corrupt block 300 succeeds (exit 0, not a blanket abort) | PASS | rc=0 postcheck=0 candidate=0x85b3f843 stored=0x85b3f843 |
| 2-neg2 | post-repair cold snapshot read of z1 block 300 matches the original (marker intact) | PASS | eio=[] content_match=True |
| 3-neg | warm live read succeeds while snapshot path EIOs | PASS | live_direct=SUCCESS snapshot_eio_blocks=32 of 1024 (expected: live ok, snapshot EIO) |
| 4-neg | clean run (no injection) repairs, restores knobs, removes its snapshot | PASS | rc=0 postcheck=0 |
| 5-neg | below-md rot proceeds to repair (exit 0, not exit 3) | PASS | rc=0 postcheck=0 reason= |
| 1r6-n1 | naive repair at default rmw_level poisons parity (RAID6) | PASS | bounded check stripe 63: mismatch_cnt=8 (expected >0) |
| 1r6-n2 | sibling blocks BROKEN with m2 failed (RAID6, default rmw) | PASS | stripe 63: 1 wrong of 80 4K blocks (expected >0) |
| 1r5x-n1 | naive repair at default rmw_level poisons parity (RAID5) | PASS | bounded check stripe 6: mismatch_cnt=8 (expected >0) |
| 1r5x-n2 | sibling blocks BROKEN with m1 failed (RAID5, default rmw) | PASS | stripe 6: 1 wrong of 512 4K blocks (expected >0) |
| 6-neg | cold read through md with leg m0 rotten: md served the corrupt leg (btrfs read EIOs) | PASS | rot_on_m0=True eio=[300] (either leg is a legitimate serving; recorded, not asserted) |
| 7-neg | segment-1 (band A) marker repairs normally (both segments reachable) | PASS | rc=0 postcheck=0 scan hit band A m2 (band A expected), disk=m2 stripe=2168 reason= |
| 7-neg2 | post-repair cold snapshot read of the segment-1 block matches the original | PASS | eio=[] content_match=True |

## Notes

- two-band rig: LV is 2 linear segments from the dm table — band A /dev/md127 (RAID5 6×200 MiB, 64K) LV [0, 992 MiB), band B /dev/md126 (RAID5 4×200 MiB, 512K) LV [992, 1584 MiB)

**SUITE: PASS (41/41 cases, 14/14 negative controls)**
