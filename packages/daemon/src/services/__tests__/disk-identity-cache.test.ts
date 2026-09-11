import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { DiskIdentityCache } from '../disk-identity-cache.js'

/**
 * ANAS must never spin up a sleeping disk on its own: the identity cache runs
 * smartctl with `-n standby`, and a standby result (disk was asleep, nothing
 * read) must NOT be cached — otherwise a disk that was asleep during its first
 * inventory pass would stay identity-less until reboot.
 */

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

function standbyResult(): { stdout: string, stderr: string, exitCode: number } {
  return {
    stdout: JSON.stringify({
      smartctl: { messages: [{ string: 'Device is in STANDBY mode, exit(2)', severity: 'information' }] },
    }),
    stderr: '',
    exitCode: 2,
  }
}

describe('DiskIdentityCache — smartctl never wakes a sleeping disk', () => {
  it('(a) standby result → empty identity, NOT cached (a second get() calls smartctl again)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, result: standbyResult() })
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.deviceModel, null)
    assert.equal(identity.smartHealthy, null)
    assert.equal(identity.trimSupport, false)

    await cache.get('ata-WDC_A', '/dev/sdb')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 2, 'standby identity must not be cached — retry on next pass')
  })

  it('(b) normal result → identity populated and cached (second get() does not call smartctl)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, result: { stdout: NORMAL_IDENTITY, stderr: '', exitCode: 0 } })
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.deviceModel, 'WDC WD2003FZEX-00SRLA0')
    assert.equal(identity.modelFamily, 'Western Digital Red Pro')
    assert.equal(identity.smartHealthy, true)

    await cache.get('ata-WDC_A', '/dev/sdb')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 1, 'a read identity is cached')
  })

  it('(c) smartctl is invoked with -n standby so a sleeping disk is never spun up', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, result: { stdout: NORMAL_IDENTITY, stderr: '', exitCode: 0 } })
    const cache = new DiskIdentityCache(executor)

    await cache.get('ata-WDC_A', '/dev/sdb')
    const call = executor.calls.find(c => c.command === SMARTCTL)
    assert.ok(call)
    assert.deepEqual(call.args.slice(0, 2), ['-n', 'standby'])
  })

  it('a genuine failure still caches the empty identity (existing behaviour unchanged)', async () => {
    const executor = new MockExecutor()
    // No fixture at all → mock's command-not-found (exit 127), invalid JSON.
    const cache = new DiskIdentityCache(executor)

    await cache.get('ata-WDC_A', '/dev/sdb')
    await cache.get('ata-WDC_A', '/dev/sdb')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 1, 'failure result is cached, as before')
  })
})
