import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { DiskIdentityCache } from '../disk-identity-cache.js'

/**
 * ANAS must never spin up a sleeping disk on its own: the identity cache runs
 * smartctl with `-n standby`, and a standby skip (disk was asleep, nothing was
 * read) must keep the LAST MEASURED identity — reported marked `standby` +
 * `stale` — instead of turning the disk's health into `unknown`. A disk never
 * seen awake is reported as `standby` with no health claim. A standby reading
 * is never a cache hit: the disk may wake at any time, so the next pass
 * retries.
 *
 * A probe FAILURE (smartctl failed or returned invalid JSON) is not a
 * measurement either: it keeps the disk's last known reading, reports it
 * `stale: 'probe-failed'`, and re-probes on the next pass — one transient
 * failure must not blank the identity for the daemon's lifetime or end the
 * re-probes. Only a disk whose FIRST probe ever fails gets the empty
 * `unknown` identity, cached as before (a never-answering disk is not
 * re-probed every pass).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const SMARTCTL = '/usr/sbin/smartctl'
const ARGS = ['-n', 'standby', '-iH', '--json', '/dev/sdb']

const NORMAL_IDENTITY = JSON.stringify({
  model_family: 'Western Digital Red Pro',
  model_name: 'WDC WD2003FZEX-00SRLA0',
  form_factor: { name: '3.5 inches' },
  firmware_version: '81.00A81',
  sata_version: { string: 'SATA 3.2, 6.0 Gb/s' },
  smart_status: { passed: true },
})

/**
 * The exact document smartctl 7.5 (the PVE node's version) emits for a
 * standby skip — the "(OS)" wording the earlier pattern missed.
 */
const STANDBY_SKIP_75 = readFileSync(
  join(__dirname, '../../fixtures/system/smartctl-standby-skip.json'),
  'utf-8',
)

function standbyResult(): { stdout: string, stderr: string, exitCode: number } {
  return {
    stdout: JSON.stringify({
      smartctl: { messages: [{ string: 'Device is in STANDBY mode, exit(2)', severity: 'information' }] },
    }),
    stderr: '',
    exitCode: 2,
  }
}

/** A genuine probe failure: non-standby exit, no readable JSON document. */
function failureResult(): { stdout: string, stderr: string, exitCode: number } {
  return {
    stdout: '',
    stderr: 'smartctl: Open \"/dev/sdb\" failed: Input/output error\n',
    exitCode: 1,
  }
}

function normalResult() {
  return { stdout: NORMAL_IDENTITY, stderr: '', exitCode: 0 }
}

describe('DiskIdentityCache — smartctl never wakes a sleeping disk', () => {
  it('(a) a standby skip never erases a measured identity — prior health is kept, not unknown', async () => {
    const executor = new MockExecutor()
    // asleep during the first two passes, awake on the third; the disk is
    // asleep again on the fourth (no probe happens — a measured identity is a
    // cache hit, and that is the point: its health is kept, not blanked)
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      results: [standbyResult(), standbyResult(), normalResult()],
    })
    const cache = new DiskIdentityCache(executor)

    const first = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(first.standby, true, 'first pass: asleep, nothing read')
    const second = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(second.standby, true, 'second pass: still asleep — retried, not cached')
    const measured = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(measured.deviceModel, 'WDC WD2003FZEX-00SRLA0')
    assert.equal(measured.smartHealthy, true)

    const kept = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(kept.deviceModel, 'WDC WD2003FZEX-00SRLA0', 'last measured identity is kept')
    assert.equal(kept.smartHealthy, true, 'last measured health is kept — never unknown')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 3, 'once measured, the identity is a cache hit')
  })

  it('(b) a first-seen standby disk is reported standby with no health claim, and retries next pass', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, result: standbyResult() })
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.deviceModel, null)
    assert.equal(identity.smartHealthy, null, 'no health claim — nothing was read')
    assert.equal(identity.standby, true)
    assert.equal(identity.stale, undefined, 'nothing was ever measured, so nothing is stale')
    assert.equal(identity.staleReason, undefined)

    await cache.get('ata-WDC_A', '/dev/sdb')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 2, 'a standby reading is not a cache hit — retry on next pass')
  })

  it('(c) a woken disk is re-read as a fresh measured reading', async () => {
    const executor = new MockExecutor()
    // asleep during the first pass, awake when the disk is next seen
    executor.addFixture({ command: SMARTCTL, args: ARGS, results: [standbyResult(), normalResult()] })
    const cache = new DiskIdentityCache(executor)

    const asleep = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(asleep.standby, true)

    const awake = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(awake.deviceModel, 'WDC WD2003FZEX-00SRLA0')
    assert.equal(awake.smartHealthy, true)
    assert.equal(awake.standby, undefined, 'the standby mark is gone once measured')
    assert.equal(awake.stale, undefined)
    assert.equal(cache.getCached('ata-WDC_A')?.standby, undefined)
  })

  it('(d) the smartctl 7.5 "(OS)" wording is a standby skip, not a failure', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      result: { stdout: STANDBY_SKIP_75, stderr: '', exitCode: 2 },
    })
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.standby, true)
    assert.equal(identity.smartHealthy, null, 'no health claim, not a parsed header-as-identity')

    // the 47a61c4 bug: the "(OS)" wording missed the pattern, the header
    // document parsed as an all-null identity, and THAT got cached — a
    // permanent cache hit, so the disk never got measured, even awake.
    await cache.get('ata-WDC_A', '/dev/sdb')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 2, 'a 7.5 standby skip is retried, not cached as a measured identity')
  })

  it('(e) a plain-text skip (no JSON document) is still a standby reading', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      result: {
        stdout: '',
        stderr: 'Device is in STANDBY (OS) mode, exit(2)\n',
        exitCode: 2,
      },
    })
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.standby, true)
    assert.equal(identity.smartHealthy, null)
  })

  it('(f) normal result → identity populated and cached (second get() does not call smartctl)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, result: normalResult() })
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.deviceModel, 'WDC WD2003FZEX-00SRLA0')
    assert.equal(identity.modelFamily, 'Western Digital Red Pro')
    assert.equal(identity.smartHealthy, true)

    await cache.get('ata-WDC_A', '/dev/sdb')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 1, 'a read identity is cached')
  })

  it('(g) smartctl is invoked with -n standby so a sleeping disk is never spun up', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, result: normalResult() })
    const cache = new DiskIdentityCache(executor)

    await cache.get('ata-WDC_A', '/dev/sdb')
    const call = executor.calls.find(c => c.command === SMARTCTL)
    assert.ok(call)
    assert.deepEqual(call.args.slice(0, 2), ['-n', 'standby'])
  })

  it('(h) a first-ever probe failure caches the empty identity (unknown), with no marks', async () => {
    const executor = new MockExecutor()
    // No fixture at all → mock's command-not-found (exit 127), invalid JSON.
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.smartHealthy, null)
    assert.equal(identity.standby, undefined, 'a failure is not a power-mode skip')
    assert.equal(identity.stale, undefined, 'there was no prior reading to be stale relative to')
    assert.equal(identity.staleReason, undefined)

    await cache.get('ata-WDC_A', '/dev/sdb')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 1, 'a disk that never answers is cached, as before')
  })

  it('(i) a probe failure on a seen disk keeps the last known reading, marks it stale, and re-probes', async () => {
    const executor = new MockExecutor()
    // asleep, then a transient failure that STICKS for a pass, then the disk
    // answers — the failure must neither blank the reading nor end the probes
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      results: [standbyResult(), failureResult(), failureResult(), normalResult()],
    })
    const cache = new DiskIdentityCache(executor)

    const asleep = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(asleep.standby, true)

    const failed = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(failed.standby, false, 'the power mode is no longer known — the probe did not get to report it')
    assert.equal(failed.stale, true, 'the reading is last known, not current')
    assert.equal(failed.staleReason, 'probe-failed')
    assert.equal(failed.smartHealthy, null, 'nothing was ever measured — the unknown stands, marked')

    const failedAgain = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(failedAgain.staleReason, 'probe-failed', 'still stale')
    let smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 3, 'a failed probe is not a cache hit — re-probed on the next pass')

    const recovered = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(recovered.deviceModel, 'WDC WD2003FZEX-00SRLA0', 'once smartctl answers, the identity is measured for real')
    assert.equal(recovered.smartHealthy, true)
    assert.equal(recovered.stale, undefined, 'the stale mark is gone once a fresh reading lands')
    assert.equal(recovered.standby, undefined)
    smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 4)
  })

  it('(j) a probe failure after a MEASURED reading keeps the measured identity, stale', async () => {
    // The measured-then-failure state is reached through the cache's public
    // surface by a disk that measured, was pruned out of the topology, came
    // back, and failed its re-probe… which is a NEW key to the cache. The
    // keep-measured branch itself is exercised through the reading the cache
    // holds: seed it the way a measured probe would have (the map is the
    // cache's own bookkeeping, and the branch under test is the error path's
    // handling of a non-empty measured entry).
    const executor = new MockExecutor()
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      results: [normalResult(), failureResult(), normalResult()],
    })
    const cache = new DiskIdentityCache(executor)

    await cache.get('ata-WDC_A', '/dev/sdb')
    // A measured reading is a cache hit — the only live path to a failing
    // probe on a disk WITH a measured entry is through a standby phase, which
    // the due policy (test (a)) pins as "no re-probe". Drive the error branch
    // directly against the cache's own state:
    const cacheAny = cache as unknown as { reading: Map<string, object> }
    cacheAny.reading.set('ata-WDC_A', { standby: true })
    const failed = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(failed.deviceModel, 'WDC WD2003FZEX-00SRLA0', 'the measured identity survives the failed probe')
    assert.equal(failed.modelFamily, 'Western Digital Red Pro')
    assert.equal(failed.smartHealthy, true, 'the last measured health survives — never blanked')
    assert.equal(failed.stale, true)
    assert.equal(failed.staleReason, 'probe-failed')
    assert.equal(failed.standby, false)

    const recovered = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(recovered.deviceModel, 'WDC WD2003FZEX-00SRLA0')
    assert.equal(recovered.stale, undefined, 'fresh again once the probe succeeds')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 3, 'probe, failed re-probe, recovered re-probe')
  })

  it('(k) devices that leave the topology are pruned from the cache', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ['-n', 'standby', '-iH', '--json', '/dev/sdb'], result: normalResult() })
    executor.addFixture({ command: SMARTCTL, args: ['-n', 'standby', '-iH', '--json', '/dev/sdc'], result: normalResult() })
    const cache = new DiskIdentityCache(executor)

    await cache.loadMany([
      { id: 'ata-A', path: '/dev/sdb' },
      { id: 'ata-B', path: '/dev/sdc' },
    ])
    assert.ok(cache.getCached('ata-A'), 'both disks loaded')
    assert.ok(cache.getCached('ata-B'))

    // sdc is pulled: the next topology refresh lists only sdb.
    await cache.loadMany([{ id: 'ata-A', path: '/dev/sdb' }])
    assert.equal(cache.getCached('ata-B'), null, 'the removed device\'s entry is dropped')
    assert.ok(cache.getCached('ata-A'), 'the surviving device keeps its entry')

    // The dropped device is re-probed if it comes back — no stale entry lingers.
    await cache.loadMany([{ id: 'ata-B', path: '/dev/sdc' }])
    assert.equal(cache.getCached('ata-B')?.deviceModel, 'WDC WD2003FZEX-00SRLA0')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 3)
  })
})
