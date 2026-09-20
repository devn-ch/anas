# AHR self-heal loop-device suite — report

- date: 2026-09-15 04:05:12  node: anas-pve  kernel: 7.0.14-17-pve
- mdadm: 4.4  btrfs-progs: 6.14
- REPAIR_CMD: `node /opt/anas/packages/daemon/dist/bin/selfheal-repair.js`
- PARITY_CMD: `python3 /root/gtsh/suite/parity-ref.py`
- MIRROR_CMD: `python3 /root/gtsh/suite/mirror-ref.py`
- rigs: RAID5 (6 × 200 MiB loops), RAID6 (7 × 200 MiB loops), RAID5 at md's 512 KiB chunk (6 × 200 MiB loops, parity case only), RAID1 (2 × 200 MiB loops), a second RAID1 rig for the mirror-reconcile cases, a second RAID5 rig for the parity-rewrite case, and the two-band AHR shape (RAID5 6 × 200 MiB @ 64K + RAID5 4 × 200 MiB @ 512K in one VG/LV, case 7) — built fresh per run, torn down after (see test/self-heal/gt/00-rig.sh and 00-rig-twoband.sh)

## Cases

| id | case | verdict | detail |
|----|------|---------|--------|
| 1r5-a | parity trap repair (RAID5, block 300) | PASS | rc=0 precheck_mismatch=8 postcheck=0 disk=m0 stripe=49 reason=/mnt/gtsh/@data/c1.bin block 300 reconstructed from the XOR of the other 5 members of stripe 49 and verified against the |
| 1r5-a2 | sibling blocks correct with m1 failed (RAID5) | PASS | stripe 49: 0 wrong of 80 4K blocks — chunk 0: 0 wrong of 16; chunk 1: 0 wrong of 16; chunk 2: 0 wrong of 16; chunk 3: 0 wrong of 16; chunk 4: 0 wrong of 16 |
| 2-scan | oracle scan+flip disambiguation picked the data slot (zeros file) — LOAD-BEARING: the rest of the case repairs the block the scan hit, so a wrong-slot pick stops the case here | PASS | scan hit /dev/loop2@30130176 vs mapped m2@30130176 |
| 2-wrong-index | repair at healthy zero block 200 aborts (exit 4 mapping-abort) | PASS | rc=4 (expected 4) reason=not corrupt here: the content at (m2, 30048256) passes the stored csum for /mnt/gtsh/@data/z1.bin block 200. Nothing was written. |
| 3-map | corrupted compressed sector mapped back to a file block (verification side); the forward mapping of that block lands on the scan's member sector | PASS | m0@53383168 -> c3.bin block 288 -> m0@53383168 (blob 1 sector(s); compressed=True, extent disk 199856128 nr 4096 ram 131072) |
| 3-repair | repair of compressed extent (block 288) arbitrated against the on-disk-sector csum | PASS | rc=0 postcheck=0 candidate=0x30ff786b stored=0x30ff786b reason=/mnt/gtsh/@data/c3.bin block 288 reconstructed from the XOR of the other 5 members of stripe 798 and verified against the stored csum 0x30ff |
| 3-cold | fresh-snapshot cold read of the whole extent matches the original content | PASS | blocks 288..319: eio=[] content_mismatch=[] |
| 4-pin | REPAIR_FAIL_AT=pin: exit 70, knobs restored, no transient pin survives (subvolume set unchanged) | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} subvolumes=unchanged |
| 4-resolve | REPAIR_FAIL_AT=resolve: exit 70, knobs restored, no transient pin survives (subvolume set unchanged) | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} subvolumes=unchanged |
| 4-reverify | REPAIR_FAIL_AT=reverify: exit 70, knobs restored, no transient pin survives (subvolume set unchanged) | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} subvolumes=unchanged |
| 4-precheck | REPAIR_FAIL_AT=precheck: exit 70, knobs restored, no transient pin survives (subvolume set unchanged) | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} subvolumes=unchanged |
| 4-rmw | REPAIR_FAIL_AT=rmw: exit 70, knobs restored, no transient pin survives (subvolume set unchanged) | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} subvolumes=unchanged |
| 4-reconstruct | REPAIR_FAIL_AT=reconstruct: exit 70, knobs restored, no transient pin survives (subvolume set unchanged) | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} subvolumes=unchanged |
| 4-arbitrate | REPAIR_FAIL_AT=arbitrate: exit 70, knobs restored, no transient pin survives (subvolume set unchanged) | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} subvolumes=unchanged |
| 4-guard | REPAIR_FAIL_AT=guard: exit 70, knobs restored, no transient pin survives (subvolume set unchanged) | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} subvolumes=unchanged |
| 4-write | REPAIR_FAIL_AT=write: exit 70, knobs restored, no transient pin survives (subvolume set unchanged) | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} subvolumes=unchanged |
| 4-postcheck | REPAIR_FAIL_AT=postcheck: exit 70, knobs restored, no transient pin survives (subvolume set unchanged) | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} subvolumes=unchanged |
| 4-coldread | REPAIR_FAIL_AT=coldread: exit 70, knobs restored, no transient pin survives (subvolume set unchanged) | PASS | rc=70 (expected 70) knobs={'rmw_level': '1', 'sync_min': '0', 'sync_max': 'max', 'sync_action': 'idle'} subvolumes=unchanged |
| 4-endcheck | bounded check suspends one stripe short of the array end (coverage 0..end-1 stripe proven) | PASS | suspended=True completed=201600/201728 (stripe=128 sectors) mismatch_cnt=8 |
| 4-fullcheck | full md check (sync_max=max) reaches idle — the whole array is covered again | PASS | final=idle sampled_completed=407552/407552 mismatch_cnt=8 |
| 5-scan | md-device scan located the through-md rot — LOAD-BEARING: every later assertion is about the block the scan found, so a wrong hit stops the case here | PASS | scan md@153665536 vs mapped 153665536 |
| 5-sanity | bounded check over the stripe sees mismatch_cnt==0 (rot arrived through md) | PASS | mismatch_cnt=0 (expected 0) |
| 5-diag | repair diagnoses above-md corruption (exit 3, mismatch_cnt==0 in pre-check) | PASS | rc=3 precheck_mismatch=0 outcome=above-md steps=4 reason=the bounded md check over stripe 468 reports mismatch_cnt=0 and a direct read of all 6 member rows of stripe 468: the XOR of the 5 data rows |
| 5-disk | nothing was written: the rot's bytes are exactly the injector's (undisturbed) and every changed member sector is btrfs housekeeping (measured mirrors + non-DATA chunks) | PASS | rot at md@153665536 unchanged=True; changed sectors classified: housekeeping=54 data=0 content=0 |
| 5-sanity2 | below-md rot shows mismatch_cnt>0 in its own stripe | PASS | stripe 473: mismatch_cnt=8 |
| 1r6-a | parity trap repair (RAID6, block 300) | PASS | rc=0 precheck_mismatch=8 postcheck=0 disk=m2 stripe=49 reason=/mnt/gtsh/@data/r1.bin block 300 reconstructed from the P parity of stripe 49 and its other data members and verified ag |
| 1r6-a2 | sibling blocks correct with m1 failed (RAID6) | PASS | stripe 49: 0 wrong of 80 4K blocks — chunk 0: 0 wrong of 16; chunk 1: 0 wrong of 16; chunk 2: 0 wrong of 16; chunk 3: 0 wrong of 16; chunk 4: 0 wrong of 16 |
| 1r6-b | parity trap repair (RAID6, block 1000) | PASS | rc=0 postcheck=0 P=m4 Q=m5 reason=/mnt/gtsh/@data/r1.bin block 1000 reconstructed from the P parity of stripe 58 and its other data members and verified a |
| 1r6-b2 | sibling blocks correct with P member m4 failed (Q reconstruction) | PASS | stripe 58: 0 wrong of 80 4K blocks — chunk 0: 0 wrong of 16; chunk 1: 0 wrong of 16; chunk 2: 0 wrong of 16; chunk 3: 0 wrong of 16; chunk 4: 0 wrong of 16 |
| 1r5x-a | parity trap repair (RAID5, block 300) | PASS | rc=0 precheck_mismatch=8 postcheck=0 disk=m2 stripe=55 reason=/mnt/gtsh/@data/c1.bin block 300 reconstructed from the XOR of the other 5 members of stripe 55 and verified against the |
| 1r5x-a2 | sibling blocks correct with m0 failed (RAID5) | PASS | stripe 55: 0 wrong of 544 4K blocks — chunk 0: 0 wrong of 32 (96 row blocks outside the file's extent or past EOF — not counted); chunk 1: 0 wrong of 128; chunk 2: 0 wrong of 128; chunk 3: 0 wrong of 128; chunk 4: 0 wrong of 128 |
| 6-scan | marker block found on every RAID1 leg at the same member offset; one leg corrupted behind md | PASS | rot injected on leg m0 (/dev/loop0@16957440); hits: loop0@16957440 loop1@16957440 |
| 6-repair | repair of a one-leg corruption (RAID1, block 300) | PASS | rc=0 postcheck=0 disk=m0 good_legs=None reason=/mnt/gtsh/@data/l1.bin block 300 reconstructed from the copy on /dev/loop1 and verified against the stored csum 0x2835f5 |
| 6-legs | block reads back correct on BOTH legs after repair (md wrote every leg) | PASS | rot was on m0; now: m0=ok m1=ok |
| 6-cold | post-repair cold snapshot read of the block matches the original | PASS | eio=[] content_match=True |
| 9a-inject | fresh rot on the leg md serves reads from (the cold read through btrfs EIOs) | PASS | rot on m0 (loop0)@16957440; legs now: m0=BAD m1=ok |
| 9a-md-sees-it | a whole-band md check counts the legs disagreeing | PASS | mismatch_cnt=128 (expected > 0; GT-22: one rotted 4 KiB block counts 128 on a mirror) |
| 9a-reconcile | the verb reconciles the band (exit 0) | PASS | rc=0 outcome=reconciled arm=compare passes=None rows_written={'leg0': 0, 'leg1': 1} reason= |
| 9a-legs | both legs hold the ORIGINAL block afterwards | PASS | rot was on m0; now: m0=ok m1=ok |
| 9a-clean | an independent whole-band check reads 0 | PASS | mismatch_cnt=0 |
| 9a-no-md-repair | md NEVER ran a repair on the mirror band (the kernel's own log is the witness) | PASS | no `md: repair of RAID array` line for this array |
| 9b-inject | rot on the leg md does NOT serve: the file still reads correctly, so a scrub has nothing to correct | PASS | rot on m1 (loop1)@21151744; cold read MATCH |
| 9b-md-sees-it | md still counts the legs disagreeing, while btrfs sees nothing at all | PASS | mismatch_cnt=128 |
| 9b-compare | compare-legs wrote the GOOD leg's row back through md (exit 0, one row, from the leg that matched) | PASS | rc=0 outcome=reconciled arm=compare rows_compared=50944 rows_differing=1 rows_written={'leg0': 1, 'leg1': 0} (the good leg is m0); unchecked=0 free=0 unresolved=0 reason= |
| 9b-legs | both legs hold the ORIGINAL block afterwards (md wrote every leg) | PASS | rot was on m1; now: m0=ok m1=ok |
| 9b-clean | an independent whole-band check reads 0 | PASS | mismatch_cnt=0 |
| 9b-no-md-repair | md NEVER ran a repair on the mirror band | PASS | no `md: repair of RAID array` line for this array |
| 8-inject | parity member's stripe row corrupted behind md (data members untouched) — the row on disk actually changed | PASS | data m0(loop0) scan-located at 4308992; rot injected on PARITY m4(loop4)@4308992, stripe 49; parity row 7763ca990ce3 -> 0ab9d749ab4b |
| 8-md-sees-it | bounded md check over the stripe counts mismatches | PASS | mismatch_cnt=8 (expected > 0) |
| 8-data-intact | the file still reads correctly through btrfs (parity rot is invisible above md) — against the regen ground truth | PASS | cold read MATCH |
| 8-rewrite | the verb rewrites the band's parity (exit 0, mismatch_cnt 0 afterwards) | PASS | rc=0 outcome=rewritten before=8 after=0 reason= |
| 8-clean | an independent bounded check over the stripe reads 0 | PASS | mismatch_cnt=0 |
| 8-match | the file still reads MATCH after the rewrite — against the regen ground truth | PASS | cold read MATCH |
| 8-xor | the parity row is the XOR of the data rows again | PASS | parity row == XOR(data rows): True — m0[data]=082b369d784f m1[data]=8cc9526e950d m2[data]=697c8ae2b18a m3[data]=19991ea19396 m4[PARITY]=7763ca990ce3 m5[data]=284b6a2abfb2 |
| 7-txprobe | the tx-probe transaction touched no DATA chunk (the measured housekeeping set has no blind spot for the R1 assertion) | PASS | 52 band-A blocks measured, 0 in a data chunk |
| 7-scan | oracle scan (members of both arrays) located the segment-2 block on a band-B member | PASS | hit m1 of band B (loop7); verification-side map: m1 of /dev/md126, stripe 48, member offset 27590656 |
| 7-bandA-untouched | no DATA write on band A: every changed band-A sector is btrfs superblock/metadata housekeeping, and none is a copy of the repair's candidate (the R1 assertion, incl. the F6 content check) | PASS | changed sectors: 122 — housekeeping=122 data=0 content=0 |
| 7-repair | two-band: REPAIR_CMD of the segment-2 (band B) marker block exits 0 using band B's geometry | PASS | rc=0 postcheck=0 n=4 (band B n=4) disk=m1 stripe=48 reason=/mnt/gtsh/@data/b1.bin block 80000 reconstructed from the XOR of the other 3 members of stripe 48 and verified against t |
| 7-member | band-B member block equals the original after repair | PASS | loop7@27590656 match=True |
| 7-bcheck | evicted bounded check over band B's stripe reads 0 | PASS | stripe 48 of md126: mismatch_cnt=0 |
| 7-cold | post-repair cold snapshot read of the segment-2 block matches the original | PASS | eio=[] content_match=True |

## Negative controls

| id | control | verdict | detail |
|----|---------|---------|--------|
| 1r5-n1 | naive repair at default rmw_level poisons parity; the no-eviction canary proves the cache can hide rot (RAID5) | PASS | bounded check stripe 49: mismatch_cnt=8 (evicted, expected >0); canary block 1500, stripe 64: no-eviction mismatch_cnt=0 (expected 0 — the stale cache hid the rot behind md); whole-array check mismatch_cnt=8 (expected >0 — the wide window recycles the cache and reveals it) |
| 1r5-n2 | sibling blocks BROKEN with m1 failed (RAID5, default rmw) | PASS | stripe 49: 1 wrong of 80 4K blocks (expected >0) — chunk 0: 0 wrong of 16; chunk 1: 0 wrong of 16; chunk 2: 1 wrong of 16; chunk 3: 0 wrong of 16; chunk 4: 0 wrong of 16 |
| 2-neg | repair at the actually corrupt block 300 succeeds (exit 0, not a blanket abort) | PASS | rc=0 postcheck=0 candidate=0x85b3f843 stored=0x85b3f843 |
| 2-neg2 | post-repair cold snapshot read of z1 block 300 matches the original (marker intact) | PASS | eio=[] content_match=True |
| 3-neg | warm live read succeeds while snapshot path EIOs | PASS | live_direct=SUCCESS snapshot_eio_blocks=32 of 1024 (expected: live ok, snapshot EIO) |
| 4-neg | clean run (no injection) repairs, restores knobs, leaves the subvolume set unchanged | PASS | rc=0 postcheck=0 |
| 5-neg | below-md rot proceeds to repair (exit 0, not exit 3) | PASS | rc=0 postcheck=0 reason=/mnt/gtsh/@data/c5.bin block 700 reconstructed from the XOR of the other 5 members of stripe 473 and verified against the stored csum 0xa8ae |
| 1r6-n1 | naive repair at default rmw_level poisons parity; the no-eviction canary proves the cache can hide rot (RAID6) | PASS | bounded check stripe 63: mismatch_cnt=8 (evicted, expected >0); canary block 1900, stripe 69: no-eviction mismatch_cnt=0 (expected 0 — the stale cache hid the rot behind md); whole-array check mismatch_cnt=8 (expected >0 — the wide window recycles the cache and reveals it) |
| 1r6-n2 | sibling blocks BROKEN with m2 failed (RAID6, default rmw) | PASS | stripe 63: 1 wrong of 80 4K blocks (expected >0) — chunk 0: 0 wrong of 16; chunk 1: 1 wrong of 16; chunk 2: 0 wrong of 16; chunk 3: 0 wrong of 16; chunk 4: 0 wrong of 16 |
| 1r5x-n1 | naive repair at default rmw_level poisons parity; the no-eviction canary proves the cache can hide rot (RAID5) | PASS | bounded check stripe 55: mismatch_cnt=8 (evicted, expected >0); canary block 1500, stripe 57: no-eviction mismatch_cnt=0 (expected 0 — the stale cache hid the rot behind md); whole-array check mismatch_cnt=8 (expected >0 — the wide window recycles the cache and reveals it) |
| 1r5x-n2 | sibling blocks BROKEN with m0 failed (RAID5, default rmw) | PASS | stripe 55: 1 wrong of 544 4K blocks (expected >0) — chunk 0: 0 wrong of 32 (96 row blocks outside the file's extent or past EOF — not counted); chunk 1: 1 wrong of 128; chunk 2: 0 wrong of 128; chunk 3: 0 wrong of 128; chunk 4: 0 wrong of 128 |
| 6-neg | with the other leg FAILED, md can only serve the corrupt leg — the cold read EIOs (deterministic observability) | PASS | rot re-injected on m0, m1 failed: eio=[300] (expected [300]); m1 re-added, rebuild waited out (it re-propagates the rot — the rig is torn down after) |
| 9-neg-inject | both legs corrupted, with DIFFERENT junk on each | PASS | m0=2015be83ec9e m1=39f3ea88c311 @109232128 |
| 9-neg | NEITHER leg can be proven, so nothing is written and the run is a RESIDUAL (exit 2) | PASS | rc=2 outcome=residual unresolved=1 rows_written={'leg0': 0, 'leg1': 0} mismatch_before=128 mismatch_after=128 reason=1 row(s) could not be arbitrated: neither leg satisfies the checksum btrfs stored for them |
| 9-neg-untouched | both legs are byte-identical to the junk that was injected — the verb wrote nothing at all | PASS | m0 2015be83ec9e -> 2015be83ec9e; m1 39f3ea88c311 -> 39f3ea88c311 |
| 9-neg-no-md-repair | and md NEVER ran a repair on the band — a repair there would have copied leg 0's junk onto leg 1 and blessed it (GT-22(f)) | PASS | no `md: repair of RAID array` line for this array |
| 8-no-evidence | the verb REFUSES without the evidence gate (exit 3, no-parity-mismatch) and issues no md action | PASS | rc=3 code=no-parity-mismatch reason=refused: no parity-mismatch evidence provided — the product's precondition is the pool's last completed scrub job counti; last_sync_action check -> check; parity row unchanged=True |
| 8-neg-inject | data-member rot injected below md | PASS | m4(loop4)@5160960 stripe 62: mismatch_cnt=8 |
| 8-neg | the verb REFUSES data rot (exit 3, data-corruption-found) instead of blessing it | PASS | rc=3 outcome=refused code=data-corruption-found reason=refused: data corruption found; repair data first (selfheal.6) — the fresh btrfs scrub reported: csum=1 |
| 8-neg-no-repair | md never ran a repair on the band — on disk: the stripe still counts the mismatch and the parity row is byte-identical to its pre-refusal digest | PASS | last_sync_action check -> check; bounded check mismatch_cnt=8 (expected >0); parity row unchanged=True |
| 7-neg | segment-1 (band A) marker repairs normally (both segments reachable) | PASS | rc=0 postcheck=0 scan hit band A m2 (band A expected), disk=m2 stripe=2168 reason=/mnt/gtsh/@data/b1.bin block 300 reconstructed from the XOR of the other 5 members of stripe 2168 and verified against t |
| 7-neg2 | post-repair cold snapshot read of the segment-1 block matches the original | PASS | eio=[] content_match=True |

## Notes

- two-band rig: LV is 2 linear segments from the dm table — band A /dev/md127 (RAID5 6×200 MiB, 64K) LV [0, 992 MiB), band B /dev/md126 (RAID5 4×200 MiB, 512K) LV [992, 1584 MiB)

**SUITE: PASS (61/61 cases, 22/22 negative controls)**
