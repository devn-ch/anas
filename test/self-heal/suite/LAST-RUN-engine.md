# AHR self-heal loop-device suite — report

- date: 2026-09-11 20:33:27  node: anas-pve  kernel: 7.0.14-12-pve
- mdadm: 4.4  btrfs-progs: 6.14
- REPAIR_CMD: `node /opt/anas/packages/daemon/dist/bin/selfheal-repair.js`
- rigs: RAID5 (6 × 200 MiB loops) and RAID6 (7 × 200 MiB loops), built fresh per run, torn down after (see test/self-heal/gt/00-rig.sh)

## Cases

| id | case | verdict | detail |
|----|------|---------|--------|
| 1r5-a | parity trap repair (RAID5, block 300) | PASS | rc=0 precheck_mismatch=8 postcheck=0 disk=m0 stripe=49 reason=/mnt/gtsh/@data/c1.bin block 300 reconstructed from the XOR of the other 5 members of stripe 49 and verified against the |
| 1r5-a2 | sibling blocks correct with m1 failed (RAID5) | PASS | stripe 49: 0 wrong of 80 4K blocks |
| 2-scan | oracle scan+flip disambiguation picked the data slot (zeros file) | PASS | scan hit /dev/loop2@30130176 vs mapped m2@30130176 (cross-check only) |
| 2-wrong-index | repair at healthy zero block 200 aborts (exit 4 mapping-abort) | PASS | rc=4 (expected 4) reason=not corrupt here: the content at (m2, 30048256) passes the stored csum for /mnt/gtsh/@data/z1.bin block 200. Nothing was written. |
| 3-map | corrupted compressed sector mapped back to a file block (verification side) | PASS | m0@53383168 -> c3.bin block 288 (compressed=True, extent disk 199856128 nr 4096 ram 131072) |
| 3-repair | repair of compressed extent (block 288) arbitrated against the on-disk-sector csum | PASS | rc=0 postcheck=0 candidate=0x30ff786b stored=0x30ff786b reason=/mnt/gtsh/@data/c3.bin block 288 reconstructed from the XOR of the other 5 members of stripe 798 and verified against the stored csum 0x30ff |
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
| 4-endcheck | bounded check suspends one stripe short of the array end (coverage 0..end-128 proven) | PASS | suspended=True completed=201600/201728 mismatch_cnt=8 |
| 4-fullcheck | full md check (sync_max=max) reaches idle — the whole array is covered again | PASS | final=idle sampled_completed=382200/407552 mismatch_cnt=8 |
| 5-scan | md-device scan located the through-md rot | PASS | scan md@153665536 vs mapped 153665536 (cross-check only) |
| 5-sanity | bounded check over the stripe sees mismatch_cnt==0 (rot arrived through md) | PASS | mismatch_cnt=0 (expected 0) |
| 5-diag | repair diagnoses above-md corruption (exit 3, mismatch_cnt==0 in pre-check, nothing written) | PASS | rc=3 precheck_mismatch=0 outcome=above-md steps=4 reason=the bounded md check over stripe 468 reports mismatch_cnt=0 while the block fails its stored csum — parity agrees with the bad data, which i |
| 5-sanity2 | below-md rot shows mismatch_cnt>0 in its own stripe | PASS | stripe 473: mismatch_cnt=8 |
| 1r6-a | parity trap repair (RAID6, block 300) | PASS | rc=0 precheck_mismatch=8 postcheck=0 disk=m2 stripe=49 reason=/mnt/gtsh/@data/r1.bin block 300 reconstructed from the P parity of stripe 49 and its other data members and verified ag |
| 1r6-a2 | sibling blocks correct with m1 failed (RAID6) | PASS | stripe 49: 0 wrong of 80 4K blocks |
| 1r6-b | parity trap repair (RAID6, block 1000) | PASS | rc=0 postcheck=0 P=m4 Q=m5 reason=/mnt/gtsh/@data/r1.bin block 1000 reconstructed from the P parity of stripe 58 and its other data members and verified a |
| 1r6-b2 | sibling blocks correct with P member m4 failed (Q reconstruction) | PASS | stripe 58: 0 wrong of 80 4K blocks |

## Negative controls

| id | control | verdict | detail |
|----|---------|---------|--------|
| 1r5-n1 | naive repair at default rmw_level poisons parity (RAID5) | PASS | bounded check stripe 49: mismatch_cnt=8 (expected >0) |
| 1r5-n2 | sibling blocks BROKEN with m1 failed (RAID5, default rmw) | PASS | stripe 49: 1 wrong of 80 4K blocks (expected >0) |
| 2-neg | repair at the actually corrupt block 300 succeeds (exit 0, not a blanket abort) | PASS | rc=0 postcheck=0 candidate=0x85b3f843 stored=0x85b3f843 |
| 2-neg2 | post-repair cold snapshot read of z1 block 300 matches the original (marker intact) | PASS | eio=[] content_match=True |
| 3-neg | warm live read succeeds while snapshot path EIOs | PASS | live_direct=SUCCESS snapshot_eio_blocks=32 of 1024 (expected: live ok, snapshot EIO) |
| 4-neg | clean run (no injection) repairs, restores knobs, removes its snapshot | PASS | rc=0 postcheck=0 |
| 5-neg | below-md rot proceeds to repair (exit 0, not exit 3) | PASS | rc=0 postcheck=0 reason=/mnt/gtsh/@data/c5.bin block 700 reconstructed from the XOR of the other 5 members of stripe 473 and verified against the stored csum 0xa8ae |
| 1r6-n1 | naive repair at default rmw_level poisons parity (RAID6) | PASS | bounded check stripe 63: mismatch_cnt=8 (expected >0) |
| 1r6-n2 | sibling blocks BROKEN with m2 failed (RAID6, default rmw) | PASS | stripe 63: 1 wrong of 80 4K blocks (expected >0) |

## Notes

- none — every stage behaved as expected

**SUITE: PASS (28/28 cases, 9/9 negative controls)**
