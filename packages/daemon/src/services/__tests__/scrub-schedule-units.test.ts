import type { AhrScrubSchedule } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  parseScrubServiceUnit,
  readScrubSchedule,
  readScrubTimerNext,
  removeScrubUnits,
  renderScrubServiceUnit,
  renderScrubTimerUnit,
  SCRUB_SERVICE_NAME,
  SCRUB_TIMER_NAME,
  scrubCadenceToOnCalendar,
  writeScrubUnits,
} from '../scrub-schedule-units.js'

const SYSTEMCTL = '/usr/bin/systemctl'

function schedule(over: Partial<AhrScrubSchedule> = {}): AhrScrubSchedule {
  return { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0'], ...over }
}

describe('scrub schedule units — cadence → OnCalendar (selfheal.4)', () => {
  it('monthly = 1st Sunday 03:00 (matches PVE\'s ZFS cron and old mdcheck)', () => {
    assert.equal(scrubCadenceToOnCalendar('monthly'), 'Sun *-*-01..07 03:00:00')
  })

  it('quarterly = 1st Sunday of Jan/Apr/Jul/Oct 03:00', () => {
    assert.equal(scrubCadenceToOnCalendar('quarterly'), 'Sun *-01,04,07,10-01..07 03:00:00')
  })

  it('the timer unit carries the OnCalendar, Persistent=true and the install target', () => {
    for (const cadence of ['monthly', 'quarterly'] as const) {
      const timer = renderScrubTimerUnit(schedule({ cadence }))
      assert.match(timer, new RegExp(`OnCalendar=${scrubCadenceToOnCalendar(cadence).replace(/\*/g, '\\*')}`))
      assert.match(timer, /Persistent=true/)
      assert.match(timer, /WantedBy=timers\.target/)
    }
  })
})

describe('scrub schedule units — the unit files ARE the store', () => {
  it('schedule ⇄ service unit round-trips through the X-ANAS-Schedule JSON', () => {
    for (const s of [
      schedule(),
      schedule({ cadence: 'quarterly', pools: ['ahr0', 'ahr1'] }),
      schedule({ pools: [] }),
    ]) {
      const unit = renderScrubServiceUnit(s)
      assert.deepEqual(parseScrubServiceUnit(unit), s)
      // ExecStart fires the runner with the pool list as argv; never parsed back.
      assert.match(unit, new RegExp(`ExecStart=.*scrub-task\\.js( ${s.pools.join(' ')})?$`, 'm'))
      assert.match(unit, /Type=oneshot/)
      // The marker rides a comment — a file systemd itself parses never chokes.
      assert.match(unit, /^# X-ANAS-Schedule=/m)
    }
  })

  it('parseScrubServiceUnit returns null without the marker or with bad JSON/schema', () => {
    assert.equal(parseScrubServiceUnit('[Unit]\nDescription=x\n'), null)
    assert.equal(parseScrubServiceUnit('# X-ANAS-Schedule={not json\n'), null)
    // A marker with the WRONG kind (a snapshot schedule copy-pasted in) never adopts.
    assert.equal(parseScrubServiceUnit('# X-ANAS-Schedule={"kind":"snapshot","id":"x"}\n'), null)
  })

  it('a unit without our marker is never adopted (readScrubSchedule → null)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-scrub-units-'))
    try {
      await writeFile(join(dir, SCRUB_SERVICE_NAME), '[Unit]\nDescription=someone else\'s\n')
      assert.equal(await readScrubSchedule(dir), null)
      assert.equal(await readScrubSchedule(join(dir, 'nope')), null)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('scrub schedule units — CRUD lifecycle (temp dir + mocked systemctl)', () => {
  let dir: string
  let mock: MockExecutor

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-scrub-units-'))
    mock = new MockExecutor()
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writeScrubUnits writes both files, reloads, enables the timer', async () => {
    await writeScrubUnits(mock, dir, schedule({ pools: ['ahr0', 'ahr1'] }))
    assert.deepEqual((await readdir(dir)).sort(), [SCRUB_SERVICE_NAME, SCRUB_TIMER_NAME].sort())
    assert.deepEqual(await readScrubSchedule(dir), schedule({ pools: ['ahr0', 'ahr1'] }))
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(cmds.includes('daemon-reload'))
    assert.ok(cmds.includes(`enable --now ${SCRUB_TIMER_NAME}`))
  })

  it('removeScrubUnits disables the timer, deletes both files, reloads', async () => {
    await writeScrubUnits(mock, dir, schedule())
    await removeScrubUnits(mock, dir)
    assert.deepEqual(await readdir(dir), [])
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(cmds.includes(`disable --now ${SCRUB_TIMER_NAME}`))
    assert.equal(cmds.filter(c => c === 'daemon-reload').length, 2)
  })

  it('writeScrubUnits throws on a systemctl failure so the mutation surfaces it', async () => {
    // Exact-args match wins over the beforeEach success fixture.
    mock.addFixture({ command: SYSTEMCTL, args: ['daemon-reload'], result: { stdout: '', stderr: 'failed to reload', exitCode: 1 } })
    await assert.rejects(() => writeScrubUnits(mock, dir, schedule()), /failed to reload/)
  })

  it('readScrubTimerNext parses the NextElapseUSecRealtime property (null when absent)', async () => {
    const next = new MockExecutor()
    next.addFixture({
      command: SYSTEMCTL,
      args: ['show', SCRUB_TIMER_NAME, '-p', 'NextElapseUSecRealtime'],
      result: { stdout: 'NextElapseUSecRealtime=Sun 2026-10-04 03:00:00 UTC\n', stderr: '', exitCode: 0 },
    })
    assert.equal(await readScrubTimerNext(next), '2026-10-04T03:00:00.000Z')

    const none = new MockExecutor()
    none.addFixture({
      command: SYSTEMCTL,
      result: { stdout: 'NextElapseUSecRealtime=0\n', stderr: '', exitCode: 1 },
    })
    assert.equal(await readScrubTimerNext(none), null)
  })
})
