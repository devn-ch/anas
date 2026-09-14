import type { AhrPool, SelfhealOutcome, SelfhealOutcomeKind, SelfhealReasonCode } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AhrRepairRequest, AhrRepairResult, SELFHEAL_CSUM_UNREADABLE } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { repairAhrFiles } from '../ahr-repair.js'

/**
 * The repair JOB (story selfheal.6) — the engine is faked here on purpose.
 *
 * `selfheal-repair.test.ts` holds the engine to the captured rigs; what this
 * file holds is the job around it: the three buckets, the one notification, the
 * strictly sequential order, and the rule that a block which THROWS is that
 * block's verdict and never the job's.
 */

const MOUNTPOINT = '/mnt/anas-ahr/tank'

function pool(over?: Partial<AhrPool>): AhrPool {
  return {
    name: 'tank',
    ahrType: 'hybrid',
    mountpoint: MOUNTPOINT,
    mounted: true,
    disks: [],
    arrays: [],
    vg: { name: 'tank', sizeBytes: 0, freeBytes: 0 },
    lv: { name: 'tank-vol', sizeBytes: 0 },
    capacity: { totalBytes: 0, usedBytes: 0, freeBytes: 0, usableBytes: 0, rawBytes: 0, parityBytes: 0 },
    state: 'healthy',
    subvolLayout: true,
    advisories: [],
    ...over,
  } as unknown as AhrPool
}

function outcome(file: string, block: number, kind: SelfhealOutcomeKind, reason: string, code?: SelfhealReasonCode): SelfhealOutcome {
  return { outcome: kind, reason, ...(code ? { reasonCode: code } : {}), file, block, pool: 'tank', array: '/dev/md127', member: '/dev/sdb1', stripe: 1, steps: [] }
}

/** An executor that answers everything (the notification's perl call included). */
function executor(): MockExecutor {
  const exec = new MockExecutor()
  exec.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
  return exec
}

/** The severity + body of the one notification the job emitted. */
function notification(exec: MockExecutor): { severity: string, title: string, body: string } | null {
  const call = exec.calls.find(c => c.command === '/usr/bin/perl')
  if (!call)
    return null
  return { severity: call.args[2], title: call.args[3], body: call.args[4] }
}

describe('AHR repair job — the four honest counts (review R9)', () => {
  it('sorts every verdict into repaired / unrepairable / aboveMd / mappingAbort, each as itself', async () => {
    const exec = executor()
    const verdicts: Record<string, SelfhealOutcomeKind> = {
      '/a.bin:1': 'repaired',
      '/a.bin:2': 'unrepairable',
      '/b.bin:7': 'above-md',
      '/b.bin:8': 'mapping-abort',
    }
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2] }, { path: '/b.bin', blocks: [7, 8] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, verdicts[`${req.file}:${req.block}`], `verdict for ${req.block}`) },
    )

    assert.equal(result.repaired, 1)
    // mapping-abort counts AS ITSELF now (review R9) — not a repair, but the
    // opposite of unrepairable: the block was fine at the mapped location.
    assert.equal(result.unrepairable, 1)
    assert.equal(result.aboveMd, 1)
    assert.equal(result.mappingAbort, 1)
    assert.equal(result.blocks, 4)
    assert.equal(result.repaired + result.unrepairable + result.aboveMd + result.mappingAbort, result.blocks)
    // …and keeps its own name and reason in the per-block entry.
    const b8 = result.files[1].blocks.find(b => b.block === 8)!
    assert.equal(b8.outcome, 'mapping-abort')
    assert.equal(b8.reason, 'verdict for 8')
  })

  it('a block the engine THROWS on is unrepairable with the error text — the job carries on', async () => {
    const exec = executor()
    const seen: number[] = []
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2, 3] }],
      () => {},
      {
        repair: async (_e, req) => {
          seen.push(req.block)
          if (req.block === 2)
            throw new Error('btrfs tree walk died')
          return outcome(req.file, req.block, 'repaired', 'ok')
        },
      },
    )

    assert.deepEqual(seen, [1, 2, 3], 'the blocks after the failure still got their attempt')
    assert.equal(result.repaired, 2)
    assert.equal(result.unrepairable, 1)
    const bad = result.files[0].blocks.find(b => b.block === 2)!
    assert.equal(bad.outcome, 'unrepairable')
    assert.equal(bad.reason, 'btrfs tree walk died')
  })

  it('runs strictly one block at a time, in the order they were asked for', async () => {
    const exec = executor()
    const order: string[] = []
    let inFlight = 0
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [5, 6] }, { path: '/b.bin', blocks: [1] }],
      () => {},
      {
        repair: async (_e, req) => {
          inFlight += 1
          // Two engine runs at once would fight over the same md knobs.
          assert.equal(inFlight, 1, 'a second repair started while one was running')
          await new Promise(resolve => setTimeout(resolve, 1))
          order.push(`${req.file}:${req.block}`)
          inFlight -= 1
          return outcome(req.file, req.block, 'repaired', 'ok')
        },
      },
    )
    assert.deepEqual(order, ['/a.bin:5', '/a.bin:6', '/b.bin:1'])
  })

  it('hands the engine the pool and the pool mountpoint, never a path of its own', async () => {
    const exec = executor()
    const seen: { mountpoint: string, file: string, pool: string | null }[] = []
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: `${MOUNTPOINT}/a.bin`, blocks: [1] }],
      () => {},
      {
        repair: async (_e, req) => {
          seen.push({ mountpoint: req.mountpoint, file: req.file, pool: req.pool?.name ?? null })
          return outcome(req.file, req.block, 'repaired', 'ok')
        },
      },
    )
    assert.deepEqual(seen, [{ mountpoint: MOUNTPOINT, file: `${MOUNTPOINT}/a.bin`, pool: 'tank' }])
  })

  it('progress names the file, the block and the outcome', async () => {
    const exec = executor()
    const progress: string[] = []
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [9] }],
      m => progress.push(m),
      { repair: async (_e, req) => outcome(req.file, req.block, 'above-md', 'parity agrees') },
    )
    assert.ok(progress.some(p => p.includes('/a.bin') && p.includes('9') && p.includes('1/1')), progress.join(' | '))
    assert.ok(progress.includes('/a.bin block 9: above-md'), progress.join(' | '))
  })
})

describe('AHR repair job — the one notification', () => {
  it('everything repaired notifies at info and says so', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'repaired', 'ok') },
    )
    const notify = notification(exec)!
    assert.equal(exec.calls.filter(c => c.command === '/usr/bin/perl').length, 1, 'exactly one notification')
    assert.equal(notify.severity, 'info')
    assert.match(notify.body, /2 repaired, 0 unrepairable, 0 above md/)
    assert.match(notify.body, /\/a\.bin — 2 repaired/)
    // Nothing to act on, so neither piece of advice appears.
    assert.doesNotMatch(notify.body, /restore this file from backup/)
    assert.doesNotMatch(notify.body, /implicates something other than the disks/)
  })

  it('anything unrepairable or above md notifies at warning, in the epic\'s words', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }, { path: '/b.bin', blocks: [2] }],
      () => {},
      {
        repair: async (_e, req) => outcome(
          req.file,
          req.block,
          req.file === '/a.bin' ? 'unrepairable' : 'above-md',
          'because',
        ),
      },
    )
    const notify = notification(exec)!
    assert.equal(notify.severity, 'warning')
    assert.match(notify.body, /restore this file from backup/)
    assert.match(notify.body, /parity already agreed with the bad data — this implicates something other than the disks \(memory, controller, software\)/)
    // An implication, never a certainty.
    assert.doesNotMatch(notify.body, /proves|definitely/)
  })

  it('a mapping-abort is never told to restore from backup — it means the block is FINE (selfheal.7 F2, R9)', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'mapping-abort', 'not corrupt here') },
    )
    const notify = notification(exec)!
    // Still a warning and now counted AS ITSELF — nothing was repaired.
    assert.equal(notify.severity, 'warning')
    assert.match(notify.body, /0 repaired, 0 unrepairable, 0 above md, 2 not corrupt at the mapped location/)
    assert.match(notify.body, /\/a\.bin — 2 mapping-abort/)
    // But the advice is the opposite of "restore from backup", and it reads the
    // ONE number (review R9).
    assert.doesNotMatch(notify.body, /restore this file from backup/)
    assert.match(notify.body, /still pass their stored checksum/)
    assert.match(notify.body, /they need no restore/)
  })

  it('a mix keeps each sentence with the blocks it belongs to (selfheal.7 F2, R9)', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }, { path: '/b.bin', blocks: [2] }],
      () => {},
      {
        repair: async (_e, req) => outcome(
          req.file,
          req.block,
          req.file === '/a.bin' ? 'unrepairable' : 'mapping-abort',
          'because',
        ),
      },
    )
    const notify = notification(exec)!
    assert.match(notify.body, /0 repaired, 1 unrepairable, 0 above md, 1 not corrupt at the mapped location/)
    // "restore from backup" belongs to the TRUE unrepairable only.
    assert.match(notify.body, /restore this file from backup/)
    assert.match(notify.body, /they need no restore/)
  })

  // Design review 2026-09-14, D10 — "restore this file from backup" was wrong
  // for two shapes: an iSCSI LUN image (a different restore verb, refused while
  // a session is live) and a csum-unreadable block (nothing was confirmed yet).
  it('a LUN-backed unrepairable file is told to restore the LUN, not the file (D10)', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: `${MOUNTPOINT}/lun-images/win.lun`, blocks: [4] }],
      () => {},
      {
        repair: async (_e, req) => outcome(req.file, req.block, 'unrepairable', 'both legs unreadable'),
        lunHeld: async path => path === `${MOUNTPOINT}/lun-images/win.lun`
          ? {
              targetIqn: 'iqn.2026-01.org.anas:storage.tank',
              index: 3,
              name: 'win-lun-3',
              backingPath: `${MOUNTPOINT}/lun-images/win.lun`,
              connectedInitiators: [],
              detail: 'held by iqn.1998-01.com.vmware:esx1',
            }
          : null,
      },
    )
    const notify = notification(exec)!
    assert.match(
      notify.body,
      new RegExp(`${MOUNTPOINT.replace(/\//g, '\\/')}/lun-images\\/win\\.lun — this block backs iSCSI LUN iqn\\.2026-01\\.org\\.anas:storage\\.tank/3`),
    )
    assert.match(notify.body, /Restore as new LUN/)
    assert.doesNotMatch(notify.body, /restore this file from backup/)
  })

  it('a csum-unreadable unrepairable block is told to re-scrub, not restore (D10)', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }],
      () => {},
      {
        repair: async (_e, req) => outcome(
          req.file,
          req.block,
          'unrepairable',
          'the metadata copy holding the checksum is damaged',
          SELFHEAL_CSUM_UNREADABLE,
        ),
        // No LUN claim is even consulted: csum-unreadable classification stands
        // on its own, and the default configfs lookup fail-opens to null.
      },
    )
    const notify = notification(exec)!
    assert.match(notify.body, /\/a\.bin — the file's checksum could not be read reliably; re-scrub after the metadata is repaired/)
    assert.doesNotMatch(notify.body, /restore this file from backup/)
  })

  it('the engine\'s reason CODE rides into the per-block entry — the result is what a parser reads', async () => {
    const exec = executor()
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2] }],
      () => {},
      {
        repair: async (_e, req) => outcome(
          req.file,
          req.block,
          req.block === 1 ? 'unrepairable' : 'repaired',
          req.block === 1 ? 'the metadata copy holding the checksum is damaged' : 'written back and read cold',
          req.block === 1 ? SELFHEAL_CSUM_UNREADABLE : undefined,
        ),
      },
    )
    // Carried through, and ONLY on the block that earned it — the other entry
    // has no code at all rather than a null.
    assert.equal(result.files[0].blocks[0].reasonCode, SELFHEAL_CSUM_UNREADABLE)
    assert.equal(result.files[0].blocks[1].reasonCode, undefined)
    // And it survives the shared schema on the way out (Principle 6).
    assert.equal(AhrRepairResult.parse(result).files[0].blocks[0].reasonCode, SELFHEAL_CSUM_UNREADABLE)
  })

  it('the advice keys on the CODE, not on the reason text — a reworded sentence still classifies', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }],
      () => {},
      {
        // The sentence says nothing a grep could match; only the code does.
        repair: async (_e, req) => outcome(req.file, req.block, 'unrepairable', 'nothing arbitrated this block', SELFHEAL_CSUM_UNREADABLE),
      },
    )
    const notify = notification(exec)!
    assert.match(notify.body, /re-scrub after the metadata is repaired/)
    assert.doesNotMatch(notify.body, /restore this file from backup/)
  })

  it('a MIXED unrepairable file (one csum-unreadable, one other) keeps the ordinary restore advice (D10)', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2] }],
      () => {},
      {
        repair: async (_e, req) => outcome(
          req.file,
          req.block,
          'unrepairable',
          req.block === 1 ? 'the metadata copy holding the checksum is damaged' : 'both legs unreadable',
          req.block === 1 ? SELFHEAL_CSUM_UNREADABLE : undefined,
        ),
      },
    )
    const notify = notification(exec)!
    assert.match(notify.body, /\/a\.bin — restore this file from backup/)
  })

  it('the notification names all four counts, and they add up (review R9)', async () => {
    const exec = executor()
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2, 3, 4] }],
      () => {},
      {
        repair: async (_e, req) => outcome(req.file, req.block, ({
          1: 'repaired',
          2: 'unrepairable',
          3: 'above-md',
          4: 'mapping-abort',
        } as Record<number, SelfhealOutcomeKind>)[req.block], 'because'),
      },
    )
    assert.equal(result.repaired + result.unrepairable + result.aboveMd + result.mappingAbort, result.blocks)
    const notify = notification(exec)!
    assert.match(notify.body, /1 repaired, 1 unrepairable, 1 above md, 1 not corrupt at the mapped location, of 4 block\(s\)/)
  })

  it('caps the file list at 20 and says how many more', async () => {
    const exec = executor()
    const files = Array.from({ length: 23 }, (_, i) => ({ path: `/f${i}.bin`, blocks: [1] }))
    await repairAhrFiles(
      exec,
      pool(),
      files,
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'repaired', 'ok') },
    )
    const notify = notification(exec)!
    assert.match(notify.body, /…and 3 more/)
    assert.ok(notify.body.includes('/f19.bin'), 'the 20th file is listed')
    assert.ok(!notify.body.includes('/f20.bin'), 'the 21st is not')
  })

  it('a notification that cannot be delivered never fails the repair', async () => {
    const exec = new MockExecutor()
    exec.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: 'no such target', exitCode: 1 } })
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'repaired', 'ok') },
    )
    assert.equal(result.repaired, 1)
  })
})

describe('AHR repair schemas — round trips', () => {
  it('a request carries files with at least one block each', () => {
    const req = AhrRepairRequest.parse({ files: [{ path: '/mnt/anas-ahr/tank/a.bin', blocks: [1, 2] }] })
    assert.deepEqual(req.files[0].blocks, [1, 2])
    // A file with no blocks names nothing to repair.
    assert.throws(() => AhrRepairRequest.parse({ files: [{ path: '/mnt/anas-ahr/tank/a.bin', blocks: [] }] }))
    // …and a request with no files even less.
    assert.throws(() => AhrRepairRequest.parse({ files: [] }))
    // Relative paths (a finding inside @snapshots is filesystem-relative) and
    // traversal are refused at the schema, at both boundaries.
    assert.throws(() => AhrRepairRequest.parse({ files: [{ path: '@snapshots/nightly/a.bin', blocks: [1] }] }))
    assert.throws(() => AhrRepairRequest.parse({ files: [{ path: '/mnt/../etc/shadow', blocks: [1] }] }))
  })

  it('a result parses back with its buckets, and an unknown verdict does not', () => {
    const value = {
      pool: 'tank',
      files: [{ path: '/a.bin', blocks: [{ block: 1, outcome: 'mapping-abort', reason: 'not corrupt here' }] }],
      repaired: 0,
      unrepairable: 0,
      aboveMd: 0,
      mappingAbort: 1,
      blocks: 1,
    }
    assert.deepEqual(AhrRepairResult.parse(value), value)
    assert.throws(() => AhrRepairResult.parse({ ...value, files: [{ path: '/a.bin', blocks: [{ block: 1, outcome: 'fixed', reason: '' }] }] }))
  })

  it('a pre-R9 payload without mappingAbort parses (additive field, default 0)', () => {
    const legacy = {
      pool: 'tank',
      files: [{ path: '/a.bin', blocks: [{ block: 1, outcome: 'unrepairable', reason: 'two bad blocks' }] }],
      repaired: 0,
      unrepairable: 1,
      aboveMd: 0,
      blocks: 1,
    }
    const parsed = AhrRepairResult.parse(legacy)
    assert.equal(parsed.mappingAbort, 0, 'the new count defaults to 0, never undefined')
  })
})
