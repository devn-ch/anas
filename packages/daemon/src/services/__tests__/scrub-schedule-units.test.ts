import type { AhrScrubSchedule } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  ForeignUnitError,
  parseScrubServiceUnit,
  readScrubSchedule,
  readScrubTimerNext,
  removeScrubUnits,
  renderScrubServiceUnit,
  renderScrubTimerUnit,
  SCRUB_SERVICE_NAME,
  SCRUB_TIMER_NAME,
  scrubCadenceToOnCalendar,
  scrubStampPath,
  scrubUnitsAreForeign,
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
  let stampDir: string
  let mock: MockExecutor

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-scrub-units-'))
    // The stamp path is computed per call from this env override, so the test
    // never touches the real /var/lib/systemd/timers — and it sits OUTSIDE the
    // unit dir, whose contents the lifecycle tests assert on.
    stampDir = await mkdtemp(join(tmpdir(), 'anas-scrub-stamp-'))
    process.env.ANAS_TIMERS_STAMP_DIR = stampDir
    mock = new MockExecutor()
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
  })
  afterEach(async () => {
    delete process.env.ANAS_TIMERS_STAMP_DIR
    await rm(dir, { recursive: true, force: true })
    await rm(stampDir, { recursive: true, force: true })
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

  it('writeScrubUnits REFUSES a marker-less existing unit — never overwritten (review R10)', async () => {
    const foreign = '[Unit]\nDescription=someone else\'s unit on ANAS\'s fixed name\n'
    await writeFile(join(dir, SCRUB_SERVICE_NAME), foreign)
    await assert.rejects(
      () => writeScrubUnits(mock, dir, schedule()),
      (err: Error) => err instanceof ForeignUnitError && err.code === 'foreign-unit',
    )
    // The file is byte-identical, the timer file was never created, and systemd
    // was never asked to do anything.
    assert.equal(await readFile(join(dir, SCRUB_SERVICE_NAME), 'utf-8'), foreign)
    assert.deepEqual(await readdir(dir), [SCRUB_SERVICE_NAME])
    assert.equal(mock.calls.length, 0)
    // The route's pre-check reads the same answer.
    assert.equal(await scrubUnitsAreForeign(dir), true)
  })

  it('a file WITH the marker is ours to rewrite, even with corrupt JSON inside', async () => {
    await writeFile(join(dir, SCRUB_SERVICE_NAME), '# X-ANAS-Schedule={not json\n')
    assert.equal(await scrubUnitsAreForeign(dir), false, 'corrupt but OURS — not foreign')
    await writeScrubUnits(mock, dir, schedule())
    assert.deepEqual(await readScrubSchedule(dir), schedule())
  })

  it('removeScrubUnits clears the timer\'s Persistent stamp (review R10)', async () => {
    await writeScrubUnits(mock, dir, schedule())
    // The stamp lives outside the unit dir; create it where the module points.
    const stamp = scrubStampPath()
    await mkdir(dirname(stamp), { recursive: true })
    await writeFile(stamp, '')
    try {
      await removeScrubUnits(mock, dir)
      assert.deepEqual(await readdir(dir), [], 'both unit files are gone')
      await assert.rejects(() => readFile(stamp, 'utf-8'), /ENOENT/, 'the stamp is gone — the next enable cannot catch up a stale occurrence')
    }
    finally {
      await rm(dirname(stamp), { recursive: true, force: true })
    }
  })

  it('removeScrubUnits tolerates an absent stamp (idempotent)', async () => {
    await writeScrubUnits(mock, dir, schedule())
    await removeScrubUnits(mock, dir)
    await removeScrubUnits(mock, dir)
    assert.deepEqual(await readdir(dir), [])
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
