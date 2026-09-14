import type { AhrPool } from '@anas/shared'
import type { CommandExecutor, ExecResult, ExecStreamResult, PipelineResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { reconcileSelfhealState, reconcileWasQuiet } from '../selfheal-reconcile.js'
import { SELFHEAL_SNAPSHOT_PREFIX } from '../selfheal-repair.js'

/**
 * D4 (design review 2026-09-14) — the daemon-start reconciliation.
 *
 * The repair engine restores every md knob it turns in a `finally`, and a
 * `finally` does not run for SIGKILL, the OOM killer, or a package upgrade
 * restarting anasd mid-sequence. What is left behind is invisible and lasts
 * for the life of the assembly: `sync_max` bounded to ONE STRIPE (so the next
 * monthly parity check covers that stripe and suspends there — GT-13's trap —
 * and the scrub's finish-wait then holds the pool's job exclusion for seven
 * days), `rmw_level=0`, `stripe_cache_size` at its 17-slot eviction floor, and
 * an `anas-selfheal-<ts>` snapshot pinning an extent.
 *
 * Every value here is read off the kernel and compared with the one md itself
 * ships (GT-1) — reading the system and restoring a known default, not a
 * shadow database of what ANAS believes it owns (Principle 11).
 */

/** A fake node whose md sysfs knobs are real files, plus the btrfs verbs. */
class FakeNode implements CommandExecutor {
  readonly root: string
  readonly mountpoint: string
  readonly calls: { command: string, args: string[] }[] = []
  readonly deleted: string[] = []
  /** What `btrfs subvolume list` reports (the §12 sweep reads it). */
  subvolList = ''

  constructor(bands: { kernel: string, knobs: Record<string, string> }[]) {
    this.root = mkdtempSync(join(tmpdir(), 'anas-reconcile-'))
    this.mountpoint = join(this.root, 'mnt')
    mkdirSync(this.mountpoint, { recursive: true })
    for (const band of bands) {
      const sys = join(this.root, 'sys/block', band.kernel, 'md')
      mkdirSync(sys, { recursive: true })
      for (const [key, value] of Object.entries(band.knobs)) {
        const path = join(sys, key)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, `${value}\n`)
      }
    }
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }

  knob(kernel: string, key: string): string {
    return readFileSync(join(this.root, 'sys/block', kernel, 'md', key), 'utf-8').trim()
  }

  async exec(command: string, args: string[]): Promise<ExecResult> {
    this.calls.push({ command, args })
    const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
    if (command === '/usr/bin/readlink') {
      // /dev/md/tank-r1 → md127, /dev/md/tank-r2 → md126.
      const band = args[1].endsWith('-r1') ? 'md127' : 'md126'
      return ok(`/dev/${band}\n`)
    }
    if (command === '/usr/bin/mount' || command === '/usr/bin/umount')
      return ok('')
    if (command === '/usr/bin/btrfs') {
      if (args[0] === 'subvolume' && args[1] === 'list')
        return ok(this.subvolList)
      if (args[0] === 'subvolume' && args[1] === 'delete') {
        this.deleted.push(args[2])
        return ok('')
      }
    }
    if (command === '/usr/bin/findmnt')
      return { stdout: '', stderr: '', exitCode: 1 }
    return { stdout: '', stderr: `unexpected ${command}`, exitCode: 127 }
  }

  async pipeline(): Promise<PipelineResult> {
    throw new Error('not used')
  }

  async execToStream(): Promise<ExecStreamResult> {
    throw new Error('not used')
  }
}

/** md's own values on a freshly built RAID5 band (GT-1, captured verbatim). */
function healthy(): Record<string, string> {
  return {
    level: 'raid5',
    sync_action: 'idle',
    sync_min: '0',
    sync_max: 'max',
    rmw_level: '1',
    stripe_cache_size: '256',
  }
}

/** What a repair that never reached its `finally` leaves behind. */
function killedMidRepair(): Record<string, string> {
  return {
    level: 'raid5',
    sync_action: 'idle',
    sync_min: '6272',
    sync_max: '6400',
    rmw_level: '0',
    stripe_cache_size: '17',
  }
}

function pool(node: FakeNode, bands = 1): AhrPool {
  return {
    name: 'tank',
    mountpoint: node.mountpoint,
    mounted: true,
    subvolLayout: true,
    lv: { name: 'tank-vol', sizeBytes: 0 },
    arrays: Array.from({ length: bands }, (_, i) => ({ device: `/dev/md/tank-r${i + 1}`, band: i + 1 })),
  } as unknown as AhrPool
}

let node: FakeNode

function use(build: () => FakeNode): void {
  beforeEach(() => {
    node = build()
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = node.root
  })
  afterEach(() => {
    delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
    node.cleanup()
  })
}

describe('selfheal reconcile — knobs a killed repair left turned aside', () => {
  use(() => new FakeNode([{ kernel: 'md127', knobs: killedMidRepair() }]))

  it('puts the sync window, rmw_level and stripe cache back to md\'s own values', async () => {
    const report = await reconcileSelfhealState(node, { pools: [pool(node)] })

    assert.equal(node.knob('md127', 'sync_min'), '0')
    assert.equal(node.knob('md127', 'sync_max'), 'max')
    assert.equal(node.knob('md127', 'rmw_level'), '1')
    assert.equal(node.knob('md127', 'stripe_cache_size'), '256')
    assert.equal(report.skipped.length, 0)
    assert.deepEqual(report.errors, [])
  })

  it('says what it found, per band, in one journald line each', async () => {
    const report = await reconcileSelfhealState(node, { pools: [pool(node)] })
    assert.equal(report.restored.length, 3, report.restored.join(' | '))
    assert.ok(report.restored.some(l => l.startsWith('tank-r1: sync window restored to 0..max') && l.includes('was 6272..6400')), report.restored.join(' | '))
    assert.ok(report.restored.includes('tank-r1: rmw_level restored to 1 (was 0)'))
    assert.ok(report.restored.includes('tank-r1: stripe_cache_size restored to 256 (was 17)'))
    assert.equal(reconcileWasQuiet(report), false)
  })
})

describe('selfheal reconcile — a band md is already working on', () => {
  use(() => new FakeNode([{ kernel: 'md127', knobs: { ...killedMidRepair(), sync_action: 'recover' } }]))

  /**
   * D2 from the other side. Widening `sync_max` resumes and then re-bounds an
   * operation ANAS did not start — on a `recover` that is a rebuild onto a
   * spare. The window stays exactly as md has it and the band is reported.
   */
  it('leaves the sync window alone and reports the band instead', async () => {
    const report = await reconcileSelfhealState(node, { pools: [pool(node)] })

    assert.equal(node.knob('md127', 'sync_min'), '6272', 'the running recovery\'s window was not touched')
    assert.equal(node.knob('md127', 'sync_max'), '6400')
    assert.equal(node.knob('md127', 'sync_action'), 'recover')
    assert.equal(report.skipped.length, 1)
    assert.match(report.skipped[0], /^tank-r1: sync_min=6272 sync_max=6400 left as they are — md is running recover$/)
    // The two knobs that change how md WRITES, never what it is DOING, are
    // still put back: a rebuild at rmw_level=0 is correct, only slower.
    assert.equal(node.knob('md127', 'rmw_level'), '1')
    assert.equal(node.knob('md127', 'stripe_cache_size'), '256')
  })
})

describe('selfheal reconcile — a healthy node', () => {
  use(() => new FakeNode([
    { kernel: 'md127', knobs: healthy() },
    { kernel: 'md126', knobs: healthy() },
  ]))

  it('writes nothing and says nothing', async () => {
    const report = await reconcileSelfhealState(node, { pools: [pool(node, 2)] })
    assert.ok(reconcileWasQuiet(report), JSON.stringify(report))
    assert.equal(node.knob('md127', 'sync_max'), 'max')
    assert.equal(node.knob('md126', 'sync_max'), 'max')
  })

  it('leaves a RAID1 band alone — it has neither knob at all (GT-16)', async () => {
    const mirror = new FakeNode([{ kernel: 'md127', knobs: { level: 'raid1', sync_action: 'idle', sync_min: '0', sync_max: 'max' } }])
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = mirror.root
    try {
      const report = await reconcileSelfhealState(mirror, { pools: [pool(mirror)] })
      assert.ok(reconcileWasQuiet(report), JSON.stringify(report))
    }
    finally {
      process.env.ANAS_SELFHEAL_KERNEL_ROOT = node.root
      mirror.cleanup()
    }
  })
})

describe('selfheal reconcile — transient snapshots a killed repair pinned', () => {
  use(() => new FakeNode([{ kernel: 'md127', knobs: healthy() }]))

  it('sweeps the engine\'s own prefix out of @snapshots, and nothing else', async () => {
    node.subvolList = [
      'ID 256 gen 9 top level 5 path @data',
      'ID 257 gen 9 top level 5 path @snapshots',
      `ID 258 gen 9 top level 257 path @snapshots/${SELFHEAL_SNAPSHOT_PREFIX}1700000000`,
      'ID 259 gen 9 top level 257 path @snapshots/nightly-2026-09-01',
      '',
    ].join('\n')

    const report = await reconcileSelfhealState(node, {
      pools: [pool(node)],
      ahrSnapshotOptions: { runtimeDir: join(node.root, 'run-ahr') },
    })

    assert.equal(report.snapshots.length, 1)
    assert.equal(report.snapshots[0], `tank:@snapshots/${SELFHEAL_SNAPSHOT_PREFIX}1700000000`)
    assert.ok(node.deleted.some(p => p.endsWith(`${SELFHEAL_SNAPSHOT_PREFIX}1700000000`)))
    assert.ok(!node.deleted.some(p => p.endsWith('nightly-2026-09-01')), 'the operator\'s own snapshot was left alone')
  })

  it('sweeps a FLAT pool\'s in-place pin from inside the mountpoint', async () => {
    mkdirSync(join(node.mountpoint, `${SELFHEAL_SNAPSHOT_PREFIX}1700000001`))
    mkdirSync(join(node.mountpoint, 'photos'))

    const flat = { ...pool(node), subvolLayout: false } as AhrPool
    const report = await reconcileSelfhealState(node, { pools: [flat] })

    assert.deepEqual(report.snapshots, [join(node.mountpoint, `${SELFHEAL_SNAPSHOT_PREFIX}1700000001`)])
    assert.deepEqual(node.deleted, [join(node.mountpoint, `${SELFHEAL_SNAPSHOT_PREFIX}1700000001`)])
  })
})

describe('selfheal reconcile — it never throws', () => {
  use(() => new FakeNode([{ kernel: 'md127', knobs: killedMidRepair() }]))

  it('carries the failure of one band and still fixes the next', async () => {
    const twoBands = pool(node, 2) // md126 has no sysfs at all in this fake
    const report = await reconcileSelfhealState(node, { pools: [twoBands] })
    assert.equal(node.knob('md127', 'rmw_level'), '1', 'the readable band was still put back')
    assert.deepEqual(report.errors, [], 'an unassembled band is the boot scan\'s problem, not an error here')
  })
})
