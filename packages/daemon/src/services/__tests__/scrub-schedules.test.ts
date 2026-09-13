import type { AhrArraySync, AhrPool } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { readScrubSchedule, renderScrubTimerUnit, SCRUB_SERVICE_NAME, SCRUB_TIMER_NAME, writeScrubUnits } from '../scrub-schedule-units.js'
import {
  adoptMdcheckScrub,
  ahrScrubNote,
  ahrScrubRunning,
  foreignMdArrays,
  isEnabledArgs,
  mdcheckToggleArgs,
  parseIsEnabled,
  parseMdcheckEnabled,
  parseZfsScrubEnabled,
  readAhrScrubState,
  readZfsScrubState,
  setAhrScrubEnabled,
  setZfsScrubEnabled,
  zfsScrubGetArgs,
  zfsScrubSetArgs,
} from '../scrub-schedules.js'

const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'

describe('scrub schedules — ZFS org.debian:periodic-scrub property (GT-2)', () => {
  it('only `disable` reads as off; unset/auto/enable all scrub (default on)', () => {
    assert.equal(parseZfsScrubEnabled('disable'), false)
    assert.equal(parseZfsScrubEnabled('-'), true)
    assert.equal(parseZfsScrubEnabled(''), true)
    assert.equal(parseZfsScrubEnabled('auto'), true)
    assert.equal(parseZfsScrubEnabled('enable'), true)
    assert.equal(parseZfsScrubEnabled(' disable \n'), false)
  })

  it('readZfsScrubState reflects the property and fails open to enabled', async () => {
    const on = new MockExecutor()
    on.addFixture({ command: ZFS, args: zfsScrubGetArgs('tank'), result: { stdout: '-\n', stderr: '', exitCode: 0 } })
    assert.deepEqual(await readZfsScrubState(on, 'tank'), { target: { kind: 'zfs', pool: 'tank' }, enabled: true, cadence: 'monthly', mechanism: 'zfs-property', lastScrub: null })

    const off = new MockExecutor()
    off.addFixture({ command: ZFS, args: zfsScrubGetArgs('tank'), result: { stdout: 'disable\n', stderr: '', exitCode: 0 } })
    assert.equal((await readZfsScrubState(off, 'tank')).enabled, false)

    // Unreadable → fail-open to on (never a false "scrubbing is off").
    const err = new MockExecutor()
    err.addFixture({ command: ZFS, args: zfsScrubGetArgs('tank'), result: { stdout: '', stderr: 'no such pool', exitCode: 1 } })
    assert.equal((await readZfsScrubState(err, 'tank')).enabled, true)

    // The caller's last-scrub verdict (read once from `zpool status` for every
    // pool) rides the state; absent, the pool honestly records none.
    const verdict = {
      function: 'SCRUB',
      state: 'FINISHED',
      finishedAt: '2026-08-03T07:23:11.000Z',
      durationSeconds: 19391,
      repairedBytes: 0,
      errors: 0,
    } as const
    assert.deepEqual((await readZfsScrubState(on, 'tank', verdict)).lastScrub, verdict)
  })

  it('readZfsScrubState carries the running pass, and omits the key when idle', async () => {
    const on = new MockExecutor()
    on.addFixture({ command: ZFS, args: zfsScrubGetArgs('tank'), result: { stdout: '-\n', stderr: '', exitCode: 0 } })
    const running = { function: 'SCRUB', percent: 43.2 } as const
    assert.deepEqual((await readZfsScrubState(on, 'tank', null, running)).running, running)
    // Idle: the field is ABSENT, not a null — an old daemon's payload exactly.
    assert.equal('running' in (await readZfsScrubState(on, 'tank')), false)
  })

  it('setZfsScrubEnabled writes enable/disable surgically', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    await setZfsScrubEnabled(mock, 'tank', false)
    await setZfsScrubEnabled(mock, 'tank', true)
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.deepEqual(cmds, [
      zfsScrubSetArgs('tank', false).join(' '),
      zfsScrubSetArgs('tank', true).join(' '),
    ])
    assert.equal(zfsScrubSetArgs('tank', false).join(' '), 'set org.debian:periodic-scrub=disable tank')
  })

  it('setZfsScrubEnabled throws on a failed set', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: 'permission denied', exitCode: 1 } })
    await assert.rejects(() => setZfsScrubEnabled(mock, 'tank', true), /permission denied/)
  })
})

describe('scrub schedules — AHR node-level anas-scrub timer (selfheal.4)', () => {
  const TIMER_IS_ENABLED = { command: SYSTEMCTL, args: isEnabledArgs(SCRUB_TIMER_NAME), result: { stdout: 'enabled\n', stderr: '', exitCode: 0 } }
  const TIMER_IS_DISABLED = { command: SYSTEMCTL, args: isEnabledArgs(SCRUB_TIMER_NAME), result: { stdout: 'disabled\n', stderr: '', exitCode: 1 } }
  const MDCHECK_ON = { command: SYSTEMCTL, args: isEnabledArgs('mdcheck_start.timer'), result: { stdout: 'enabled\n', stderr: '', exitCode: 0 } }
  const MDCHECK_OFF = { command: SYSTEMCTL, args: isEnabledArgs('mdcheck_start.timer'), result: { stdout: 'disabled\n', stderr: '', exitCode: 1 } }
  const TIMER_NEXT = {
    command: SYSTEMCTL,
    args: ['show', SCRUB_TIMER_NAME, '-p', 'NextElapseUSecRealtime'],
    result: { stdout: 'NextElapseUSecRealtime=Sun 2026-10-04 03:00:00 UTC\n', stderr: '', exitCode: 0 },
  }

  async function stateExecutor(opts: {
    timer?: 'on' | 'off'
    mdcheck?: 'on' | 'off'
    next?: boolean
  }): Promise<MockExecutor> {
    const mock = new MockExecutor()
    mock.addFixture(opts.timer === 'off' ? TIMER_IS_DISABLED : TIMER_IS_ENABLED)
    mock.addFixture(opts.mdcheck === 'on' ? MDCHECK_ON : MDCHECK_OFF)
    if (opts.next !== false)
      mock.addFixture(TIMER_NEXT)
    // Everything else systemctl is asked (daemon-reload, enable --now) succeeds;
    // the exact-args fixtures above still win where they match.
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    return mock
  }

  it('parseMdcheckEnabled / parseIsEnabled read systemctl is-enabled output', () => {
    assert.equal(parseMdcheckEnabled('enabled\n'), true)
    assert.equal(parseIsEnabled('enabled-runtime\n'), true)
    assert.equal(parseMdcheckEnabled('disabled\n'), false)
    assert.equal(parseIsEnabled('static\n'), false)
    assert.equal(parseIsEnabled(''), false)
  })

  it('enabled = in the timer\'s pool list AND the timer enabled; cadence + nextRun + phases ride along', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-scrub-state-'))
    try {
      const exec = await stateExecutor({ timer: 'on' })
      await writeScrubUnits(exec, dir, { kind: 'ahr-scrub', cadence: 'quarterly', pools: ['ahr0'] })
      const st = await readAhrScrubState(exec, 'ahr0', null, { dir })
      assert.equal(st.enabled, true)
      assert.equal(st.cadence, 'quarterly')
      assert.equal(st.mechanism, 'anas-scrub-timer')
      assert.equal(st.nextRun, '2026-10-04T03:00:00.000Z')
      assert.deepEqual(st.phases, ['md-parity', 'btrfs-checksums'])
      assert.equal(st.lastScrub, null, 'md keeps no completion record — never manufactured')

      // A pool NOT in the list is off even though the timer runs.
      const other = await readAhrScrubState(exec, 'ahr9', null, { dir })
      assert.equal(other.enabled, false)
      assert.equal(other.nextRun, null, 'an off pool claims no next run')
      assert.deepEqual(other.phases, ['md-parity', 'btrfs-checksums'])
      // And a listed pool with the timer disabled is off too.
      const timerOff = await stateExecutor({ timer: 'off' })
      await writeScrubUnits(timerOff, dir, { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0'] })
      const st2 = await readAhrScrubState(timerOff, 'ahr0', null, { dir })
      assert.equal(st2.enabled, false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the note is honest: mdcheck on ⇒ "double parity check"; foreign md arrays are named', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-scrub-note-'))
    try {
      const exec = await stateExecutor({ mdcheck: 'on' })
      await writeScrubUnits(exec, dir, { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0'] })
      const st = await readAhrScrubState(exec, 'ahr0', null, {
        dir,
        mdKernelNames: ['md127', 'md126', 'md9'],
        ahrKernelNames: ['md127', 'md126'],
      })
      assert.match(st.note ?? '', /double parity check — mdcheck is on/)
      assert.match(st.note ?? '', /md9 is not an ANAS pool and is not scrubbed by ANAS/)

      // With mdcheck off and no foreign arrays, the mechanism sentence stands.
      const quiet = await stateExecutor({ mdcheck: 'off' })
      const st2 = await readAhrScrubState(quiet, 'ahr0', null, {
        dir,
        mdKernelNames: ['md127'],
        ahrKernelNames: ['md127'],
      })
      assert.match(st2.note ?? '', /node-level timer/)
      assert.doesNotMatch(st2.note ?? '', /mdcheck is on/)
      assert.equal(ahrScrubNote(false, []), 'one node-level timer scrubs the enabled AHR pools sequentially (phase 1 md parity, then phase 2 btrfs checksums)')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the note distinguishes the LEGACY mdcheck state (timer off, mdcheck on) from a true double (review R8)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-scrub-legacy-'))
    try {
      // An upgraded 0.3.1 node before adoption: ANAS timer off, mdcheck on.
      // That is the ONLY parity check running — a "double" warning would be
      // about a second mechanism that does not exist.
      const exec = await stateExecutor({ timer: 'off', mdcheck: 'on' })
      const st = await readAhrScrubState(exec, 'ahr0', null, { dir })
      assert.equal(st.enabled, false)
      assert.match(st.note ?? '', /mdcheck is the only periodic parity check running/)
      assert.match(st.note ?? '', /adopted onto the anas-scrub timer at daemon start/)
      assert.doesNotMatch(st.note ?? '', /double parity check/)

      // Both on is the true double — unchanged wording.
      assert.equal(ahrScrubNote(true, [], true), 'double parity check — mdcheck is on')
      // Timer off + mdcheck on names the legacy state; pure note function.
      assert.match(ahrScrubNote(true, [], false), /only periodic parity check/)
      assert.equal(ahrScrubNote(false, [], false), 'one node-level timer scrubs the enabled AHR pools sequentially (phase 1 md parity, then phase 2 btrfs checksums)')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('foreignMdArrays diffs /proc/mdstat names against the AHR bands (fail-open to none)', () => {
    assert.deepEqual(foreignMdArrays(['md127', 'md9'], ['md127']), ['md9'])
    assert.deepEqual(foreignMdArrays(['md127'], ['md127']), [])
    assert.deepEqual(foreignMdArrays(undefined, ['md127']), [])
    assert.deepEqual(foreignMdArrays([], undefined), [])
  })

  it('carries a running check, and omits the key when idle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-scrub-running-'))
    try {
      const exec = await stateExecutor({})
      await writeScrubUnits(exec, dir, { kind: 'ahr-scrub', cadence: 'monthly', pools: ['tank'] })
      const running = { percent: 12.4 }
      assert.deepEqual((await readAhrScrubState(exec, 'tank', running, { dir })).running, running)
      assert.equal('running' in (await readAhrScrubState(exec, 'tank', null, { dir })), false)
      // The absence of a COMPLETION record (the sanctioned divergence) is
      // unaffected by the presence of live progress — they are different facts.
      assert.equal((await readAhrScrubState(exec, 'tank', running, { dir })).lastScrub, null)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  describe('setAhrScrubEnabled — the pool list + mdcheck handover', () => {
    let dir: string
    let mock: MockExecutor

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'anas-scrub-toggle-'))
      mock = new MockExecutor()
      mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('enabling the FIRST pool creates the units (monthly default) and DISABLES mdcheck', async () => {
      await setAhrScrubEnabled(mock, 'ahr0', true, { dir })
      assert.deepEqual(await readScrubSchedule(dir), { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0'] })
      const cmds = mock.calls.map(c => c.args.join(' '))
      assert.ok(cmds.includes(`enable --now ${SCRUB_TIMER_NAME}`))
      assert.ok(cmds.includes('disable --now mdcheck_start.timer mdcheck_continue.timer'), 'ANAS owns md checks on this node — mdcheck must go off on enable')
    })

    it('enabling ADDS to the list without disturbing the other pools or the cadence', async () => {
      await setAhrScrubEnabled(mock, 'ahr0', true, { dir, cadence: 'quarterly' })
      mock.calls.length = 0
      await setAhrScrubEnabled(mock, 'ahr1', true, { dir })
      assert.deepEqual(await readScrubSchedule(dir), { kind: 'ahr-scrub', cadence: 'quarterly', pools: ['ahr0', 'ahr1'] })
      // Every enable takes mdcheck over again — idempotent, never double-scheduled.
      assert.ok(mock.calls.some(c => c.args[0] === 'disable' && c.args.includes('mdcheck_start.timer')))
    })

    it('an explicit cadence rewrites the ONE node-level timer from any pool', async () => {
      await setAhrScrubEnabled(mock, 'ahr0', true, { dir })
      await setAhrScrubEnabled(mock, 'ahr0', true, { dir, cadence: 'quarterly' })
      assert.deepEqual(await readScrubSchedule(dir), { kind: 'ahr-scrub', cadence: 'quarterly', pools: ['ahr0'] })
      assert.match(renderScrubTimerUnit((await readScrubSchedule(dir))!), /OnCalendar=Sun \*-01,04,07,10-01\.\.07 03:00:00/)
    })

    it('disabling removes the pool; the units are removed when the list empties; mdcheck stays OFF', async () => {
      await setAhrScrubEnabled(mock, 'ahr0', true, { dir })
      await setAhrScrubEnabled(mock, 'ahr1', true, { dir })
      await setAhrScrubEnabled(mock, 'ahr0', false, { dir })
      assert.deepEqual((await readScrubSchedule(dir))?.pools, ['ahr1'])
      const cmds = mock.calls.map(c => c.args.join(' '))
      assert.ok(!cmds.some(c => c.startsWith('enable --now mdcheck')), 'disabling never re-arms mdcheck')

      await setAhrScrubEnabled(mock, 'ahr1', false, { dir })
      assert.equal(await readScrubSchedule(dir), null, 'the empty list removes the units')
      assert.deepEqual(await readdir(dir), [], 'both unit files are gone')
    })

    it('a FAILED mdcheck disable is logged, not thrown — the toggle still lands', async () => {
      const lines: string[] = []
      const origErr = process.stderr.write.bind(process.stderr)
      process.stderr.write = (s: string | Uint8Array) => {
        lines.push(String(s))
        return true
      }
      try {
        mock.addFixture({
          command: SYSTEMCTL,
          args: mdcheckToggleArgs(false),
          result: { stdout: '', stderr: 'unit not found', exitCode: 1 },
        })
        await setAhrScrubEnabled(mock, 'ahr0', true, { dir })
        assert.deepEqual((await readScrubSchedule(dir))?.pools, ['ahr0'])
        assert.ok(lines.some(l => l.includes('mdcheck')), 'the failure is said in journald, never silent')
      }
      finally {
        process.stderr.write = origErr
      }
    })

    it('a foreign anas-scrub unit is refused on BOTH directions — never rewritten, never deleted (review R10)', async () => {
      await writeFile(join(dir, SCRUB_SERVICE_NAME), '[Unit]\nDescription=someone else\'s unit\n')
      await assert.rejects(
        () => setAhrScrubEnabled(mock, 'ahr0', true, { dir }),
        (err: NodeJS.ErrnoException) => (err as Error).name === 'ForeignUnitError',
      )
      await assert.rejects(
        () => setAhrScrubEnabled(mock, 'ahr0', false, { dir }),
        /not an ANAS unit/,
      )
      // The foreign file is untouched — nothing was written, nothing deleted.
      assert.equal(await readFile(join(dir, SCRUB_SERVICE_NAME), 'utf-8'), '[Unit]\nDescription=someone else\'s unit\n')
      assert.equal(await readScrubSchedule(dir), null)
    })
  })
})

// The ONE-TIME upgrade migration from 0.3.1 (review R8): 0.3.1's periodic-scrub
// toggle flipped the mdcheck timers, and selfheal.4's replacement disabled
// mdcheck only inside the toggle — so an upgraded node with the toggle ON read
// every pool OFF while mdcheck kept firing. The adoption runs at daemon start
// when (and only when) the legacy state is unambiguous.
describe('adoptMdcheckScrub — the 0.3.1 mdcheck upgrade migration (review R8)', () => {
  let dir: string
  let mock: MockExecutor
  const lines: string[] = []
  let origErr: typeof process.stderr.write

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-scrub-adopt-'))
    mock = new MockExecutor()
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    // No mdcheck is-enabled fixture here: MockExecutor is first-fixture-wins on
    // identical command+args, so each test registers its own mdcheck answer.
    lines.length = 0
    origErr = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string | Uint8Array) => {
      lines.push(String(s))
      return true
    }
  })
  afterEach(async () => {
    process.stderr.write = origErr
    await rm(dir, { recursive: true, force: true })
  })

  it('ADOPTS: every AHR pool onto the timer (monthly), mdcheck disabled, one audit line', async () => {
    mock.addFixture({
      command: SYSTEMCTL,
      args: isEnabledArgs('mdcheck_start.timer'),
      result: { stdout: 'enabled\n', stderr: '', exitCode: 0 },
    })
    const report = await adoptMdcheckScrub(mock, { dir, pools: ['ahr0', 'ahr1'] })
    assert.deepEqual(report, { adopted: true, reason: 'adopted', pools: ['ahr0', 'ahr1'] })
    assert.deepEqual(await readScrubSchedule(dir), { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0', 'ahr1'] })
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(cmds.includes(`enable --now ${SCRUB_TIMER_NAME}`))
    assert.ok(cmds.includes('disable --now mdcheck_start.timer mdcheck_continue.timer'), 'ANAS owns md checks on this node from here on')
    assert.ok(lines.some(l => l.includes('ADOPTED the legacy mdcheck periodic scrub') && l.includes('ahr0, ahr1')), lines.join(' | '))
  })

  it('is a NO-OP when mdcheck is not enabled (the operator never had the 0.3.1 toggle on)', async () => {
    mock.addFixture({
      command: SYSTEMCTL,
      args: isEnabledArgs('mdcheck_start.timer'),
      result: { stdout: 'disabled\n', stderr: '', exitCode: 1 },
    })
    const report = await adoptMdcheckScrub(mock, { dir, pools: ['ahr0'] })
    assert.deepEqual(report, { adopted: false, reason: 'mdcheck-not-enabled', pools: [] })
    assert.equal(await readScrubSchedule(dir), null, 'no units written')
    assert.ok(!mock.calls.some(c => c.args[0] === 'disable' && c.args.includes('mdcheck_start.timer')), 'mdcheck untouched')
  })

  it('is a NO-OP when there is no AHR pool to adopt', async () => {
    mock.addFixture({
      command: SYSTEMCTL,
      args: isEnabledArgs('mdcheck_start.timer'),
      result: { stdout: 'enabled\n', stderr: '', exitCode: 0 },
    })
    const report = await adoptMdcheckScrub(mock, { dir, pools: [] })
    assert.deepEqual(report, { adopted: false, reason: 'no-ahr-pools', pools: [] })
    assert.equal(await readScrubSchedule(dir), null)
  })

  it('is a NO-OP when the anas-scrub units already exist (already migrated, or deliberately off)', async () => {
    await writeScrubUnits(mock, dir, { kind: 'ahr-scrub', cadence: 'quarterly', pools: ['ahr0'] })
    const callsBefore = mock.calls.length
    const report = await adoptMdcheckScrub(mock, { dir, pools: ['ahr0'] })
    assert.deepEqual(report, { adopted: false, reason: 'anas-scrub-units-present', pools: [] })
    // The existing schedule is untouched, and mdcheck was never even asked
    // about — the units' presence is the whole answer.
    assert.deepEqual(await readScrubSchedule(dir), { kind: 'ahr-scrub', cadence: 'quarterly', pools: ['ahr0'] })
    assert.equal(mock.calls.length, callsBefore, 'no new systemctl calls at all')
  })

  it('is a NO-OP when a FOREIGN unit squats on the anas-scrub name — never touched', async () => {
    await writeFile(join(dir, SCRUB_SERVICE_NAME), '[Unit]\nDescription=not ours\n')
    const report = await adoptMdcheckScrub(mock, { dir, pools: ['ahr0'] })
    assert.deepEqual(report, { adopted: false, reason: 'foreign-unit', pools: [] })
    assert.equal(await readFile(join(dir, SCRUB_SERVICE_NAME), 'utf-8'), '[Unit]\nDescription=not ours\n')
    assert.equal(await readScrubSchedule(dir), null)
  })
})

// md reports progress PER ARRAY and an AHR pool is a stack of band arrays, so
// the pool-level figure has to say something honest about several of them
// (Epic 17 stage 6). Everything here comes from the sync state the topology read
// already parsed out of /proc/mdstat — no new read for the Scrubs screen.
describe('ahrScrubRunning — the pool-level md check in flight', () => {
  const sync = (over: Partial<AhrArraySync>): AhrArraySync => ({
    action: 'check',
    percent: 50,
    speedBytesSec: 1024,
    etaSeconds: 60,
    ...over,
  })

  /** An AHR pool carrying only what this derivation looks at: its arrays' sync. */
  function poolWith(...syncs: (AhrArraySync | undefined)[]): AhrPool {
    return { arrays: syncs.map(s => (s ? { sync: s } : {})) } as unknown as AhrPool
  }

  it('one checking band reports its percent, speed and ETA', () => {
    assert.deepEqual(
      ahrScrubRunning(poolWith(sync({ percent: 12.4, speedBytesSec: 66355200, etaSeconds: 72 }))),
      { percent: 12.4, speedBytesSec: 66355200, etaSeconds: 72 },
    )
  })

  it('several checking bands: least-advanced percent, summed speed, longest ETA', () => {
    // The pool's check is not done until the LAST band is, its bands are
    // distinct devices whose throughputs add up, and the ETA is a floor.
    assert.deepEqual(
      ahrScrubRunning(poolWith(
        sync({ percent: 61.9, speedBytesSec: 100, etaSeconds: 18 }),
        sync({ percent: 12.4, speedBytesSec: 200, etaSeconds: 72 }),
      )),
      { percent: 12.4, speedBytesSec: 300, etaSeconds: 72 },
    )
  })

  it('a check md gave no rate or finish time for omits those fields, never zeroes them', () => {
    assert.deepEqual(
      ahrScrubRunning(poolWith(sync({ percent: 3, speedBytesSec: 0, etaSeconds: 0 }))),
      { percent: 3 },
    )
  })

  it('a band with no progress line at all (queued check) contributes nothing', () => {
    assert.equal(ahrScrubRunning(poolWith(undefined, undefined)), null)
  })

  it('a rebuild or a reshape is not a check — nothing is reported as running', () => {
    assert.equal(ahrScrubRunning(poolWith(sync({ action: 'recover' }), sync({ action: 'reshape' }))), null)
    assert.equal(ahrScrubRunning(poolWith(sync({ action: 'resync' }))), null)
  })

  it('an idle pool reports nothing', () => {
    assert.equal(ahrScrubRunning(poolWith()), null)
  })
})
