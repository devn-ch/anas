import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AhrPool, AhrScrubResult } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import {
  AHR_SCRUB_FINDINGS_CAP,
  attributeScrubErrors,
  countErrorSummary,
  findingPath,
  journalSince,
  kernelJournalMessages,
  parseBtrfsScrubStatus,
  parseScrubWarning,
  parseUnattributedScrubError,
  scrubAhrPool,
} from '../ahr-scrub.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')

/** The drill's verbatim kernel captures (GT-3 / GT-6) — see fixtures/ahr/NOTES.md. */
const GT3_DMESG = readFileSync(join(fixturesDir, 'scrub-dmesg-gt3.txt'), 'utf-8')
const GT6_DMESG = readFileSync(join(fixturesDir, 'scrub-dmesg-gt6.txt'), 'utf-8')
const GT3_LINES = GT3_DMESG.split('\n').filter(l => l.trim() !== '')
const GT6_LINES = GT6_DMESG.split('\n').filter(l => l.trim() !== '')

/**
 * AHR scrub — the two-phase, strictly SEQUENTIAL pass (§4): btrfs scrub
 * completes before the first md check starts; md checks run one band at a
 * time. Findings notify at warning; a clean scrub is silent (§7.3).
 */

const GIB = 1024 ** 3
const SMALL = 'ata-ANAS_SMALL_2G'
const BIG = 'ata-ANAS_BIG_3G'
const MOUNTPOINT = '/mnt/test-ahr/t2'

function pool(mountpoint = MOUNTPOINT): AhrPool {
  const member = (disk: string, part: number) =>
    ({ disk, partition: `/dev/disk/by-id/${disk}-part${part}`, memberState: 'in_sync' as const })
  return AhrPool.parse({
    name: 't2',
    ahrType: 'ahr1',
    mountpoint,
    mounted: !mountpoint.startsWith('/dev/'),
    disks: [
      { id: SMALL, sizeBytes: 2 * GIB, usableBytes: 2 * GIB, model: null, serial: null, role: 'member', partitions: [{ device: `/dev/disk/by-id/${SMALL}-part1`, band: 1, sizeBytes: GIB }] },
      { id: BIG, sizeBytes: 3 * GIB, usableBytes: 3 * GIB, model: null, serial: null, role: 'member', partitions: [{ device: `/dev/disk/by-id/${BIG}-part1`, band: 1, sizeBytes: GIB }] },
    ],
    arrays: [
      { device: '/dev/md/t2-r1', band: 1, level: 'raid1', heightBytes: GIB, members: [member(SMALL, 1), member(BIG, 1)], state: 'clean' },
      { device: '/dev/md/t2-r2', band: 2, level: 'raid1', heightBytes: GIB, members: [member(SMALL, 2), member(BIG, 2)], state: 'clean' },
    ],
    vg: { name: 't2', sizeBytes: 2 * GIB, freeBytes: 0 },
    lv: { name: 't2-vol', sizeBytes: 2 * GIB },
    capacity: { rawBytes: 5 * GIB, usableBytes: 2 * GIB, usedBytes: 0, freeBytes: 2 * GIB, redundancyOverheadBytes: 2 * GIB, unprotectedWastedBytes: GIB, pendingBytes: 0 },
    state: 'healthy',
    subvolLayout: true,
    advisories: [],
  })
}

function scrubStatus(status: string, opts?: { percent?: string, summary?: string }): string {
  return [
    'UUID:             11111111-2222-3333-4444-555555555555',
    'Scrub started:    Wed Jul 23 10:00:00 2026',
    `Status:           ${status}`,
    'Duration:         0:00:04',
    ...(opts?.percent ? [`Bytes scrubbed:   721.09MiB  (${opts.percent}%)`] : ['Total to scrub:   6.66GiB']),
    `Error summary:    ${opts?.summary ?? 'no errors found'}`,
    '',
  ].join('\n')
}

function mdstat(entries: { kernel: string, checkPercent?: number }[]): string {
  const lines = ['Personalities : [raid1] ']
  for (const e of entries) {
    lines.push(`${e.kernel} : active raid1 sdd1[1] sdc1[0]`)
    lines.push('      1044992 blocks super 1.2 [2/2] [UU]')
    if (e.checkPercent !== undefined)
      lines.push(`      [====>.............]  check = ${e.checkPercent.toFixed(1)}% (52224/1044992) finish=0.8min speed=20472K/sec`)
    lines.push('      ')
  }
  lines.push('unused devices: <none>', '')
  return lines.join('\n')
}

function baseExecutor(): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/sbin/mdadm', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/md/t2-r1'], result: { stdout: '/dev/md127\n', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/md/t2-r2'], result: { stdout: '/dev/md126\n', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
  return executor
}

describe('scrubAhrPool (Epic 11 + AHR)', () => {
  it('runs btrfs scrub to completion, THEN per-array checks sequentially; clean → silent', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], results: [
      { stdout: scrubStatus('running', { percent: '42.50' }), stderr: '', exitCode: 0 },
      { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 },
    ] })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], results: [
      // r1's check runs, then finishes; then r2's check runs, then finishes.
      { stdout: mdstat([{ kernel: 'md127', checkPercent: 10 }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126', checkPercent: 55 }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
    ] })

    const progress: string[] = []
    const result = await scrubAhrPool(executor, pool(), m => progress.push(m), { pollIntervalMs: 1 })
    assert.deepEqual(result, { scrubbed: 't2', btrfsErrors: null, checkedArrays: 2 })

    const calls = executor.calls
    const idx = (pred: (c: { command: string, args: string[] }) => boolean) => calls.findIndex(pred)
    const scrubStart = idx(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'start')
    let lastStatus = -1
    for (const [i, c] of calls.entries()) {
      if (c.command === '/usr/bin/btrfs' && c.args[1] === 'status')
        lastStatus = i
    }
    const checkR1 = idx(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === '/dev/md/t2-r1')
    const checkR2 = idx(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === '/dev/md/t2-r2')
    assert.ok(scrubStart >= 0 && lastStatus >= 0 && checkR1 >= 0 && checkR2 >= 0)
    // Never concurrent: btrfs finished before md; r1's check awaited before r2 starts.
    assert.ok(lastStatus < checkR1, 'btrfs scrub completes before any md check starts')
    assert.ok(checkR1 < checkR2, 'md checks run band by band')
    const waitBetween = calls.slice(checkR1 + 1, checkR2).some(c => c.command === '/usr/bin/cat')
    assert.ok(waitBetween, 'r1 check is awaited via /proc/mdstat before r2 starts')

    // Clean scrub → NO notification (dashboard policy §7.3).
    assert.ok(!calls.some(c => c.command === '/usr/bin/perl'))
    // Progress reported on every poll.
    assert.ok(progress.some(m => m.includes('42.5')))
    assert.ok(progress.some(m => m.includes('t2-r1')) && progress.some(m => m.includes('t2-r2')))
  })

  // Regression: array.kernelName in the pool object is captured at ROUTE time
  // (the topology read), but phase 2 runs AFTER an unbounded btrfs scrub. md
  // kernel numbers re-enumerate and get REUSED across any reassembly in that
  // window, so a stale md-number could match a DIFFERENT array in mdstat (or
  // none) and make scrub wait on the wrong device — or skip the wait entirely,
  // breaking the strictly-sequential guarantee (§4). Scrub must resolve the
  // CURRENT kernel name from the stable pin symlink (realpath array.device) at
  // point-of-use and ignore the route-time value.
  it('ignores a STALE route-time array.kernelName — resolves fresh via the pin symlink', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    // r1's check runs one poll then finishes; then r2's. The realpath fixtures
    // (baseExecutor) map t2-r1→md127, t2-r2→md126 — the ONLY correct handles.
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], results: [
      { stdout: mdstat([{ kernel: 'md127', checkPercent: 10 }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126', checkPercent: 55 }]), stderr: '', exitCode: 0 },
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 },
    ] })

    // Poison the pool with STALE kernel names that no longer exist in mdstat
    // (md0/md1). If scrub trusted them, mdstat.find would miss and it would
    // NEVER wait — no /proc/mdstat poll would land between the two checks.
    const stale = pool()
    stale.arrays[0].kernelName = 'md0'
    stale.arrays[1].kernelName = 'md1'

    const result = await scrubAhrPool(executor, stale, () => {}, { pollIntervalMs: 1 })
    assert.equal(result.checkedArrays, 2)

    const calls = executor.calls
    // The stable pin symlink is what gets resolved — never the stale name.
    assert.ok(calls.some(c => c.command === '/usr/bin/realpath' && c.args[0] === '/dev/md/t2-r1'))
    const checkR1 = calls.findIndex(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === '/dev/md/t2-r1')
    const checkR2 = calls.findIndex(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === '/dev/md/t2-r2')
    assert.ok(checkR1 >= 0 && checkR2 > checkR1, 'both checks issued, r1 before r2')
    // r1's check WAS awaited via realpath-resolved md127 — polls sit between the
    // two checks. A stale-name trust would produce zero polls between them.
    const catsBetween = calls.slice(checkR1 + 1, checkR2).filter(c => c.command === '/usr/bin/cat').length
    assert.ok(catsBetween >= 2, `r1 was awaited before r2 despite the stale kernelName (saw ${catsBetween} poll(s))`)
  })

  it('btrfs findings → PVE warning notification', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=2' }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    // A journal with nothing in the window: the count still notifies, and the
    // body says so rather than printing an empty file list (selfheal.3).
    executor.addFixture({ command: '/usr/bin/journalctl', result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1 })
    assert.equal(result.btrfsErrors, 'csum=2')
    assert.equal(result.errorsReported, 2)
    assert.deepEqual(result.findings, [])

    const notify = executor.calls.find(c => c.command === '/usr/bin/perl')
    assert.ok(notify, 'findings must notify')
    assert.equal(notify!.args[2], 'warning')
    assert.equal(notify!.args[3], 'AHR scrub found errors')
    assert.ok(notify!.args[4].includes('csum=2'))
  })

  // Bug #7 (code review): a `resync=PENDING` md check (syncPending set, sync
  // still null — e.g. an auto-read-only array parks its check) is IN-FLIGHT,
  // not finished. Treating it as done lets the next band's check start; when
  // the pending one later fires, two full-device reads run concurrently,
  // breaking the strictly-sequential guarantee (§4).
  it('treats a resync=PENDING md check as in-flight — waits it out before the next band', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })

    // md127's check parks as PENDING first, then runs, then finishes; only then
    // may md126's check start.
    const pendingR1 = [
      'Personalities : [raid1] ',
      'md127 : active raid1 sdd1[1] sdc1[0]',
      '      1044992 blocks super 1.2 [2/2] [UU]',
      '      \tresync=PENDING',
      '      ',
      'md126 : active raid1 sdf1[1] sde1[0]',
      '      1044992 blocks super 1.2 [2/2] [UU]',
      '      ',
      'unused devices: <none>',
      '',
    ].join('\n')
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], results: [
      { stdout: pendingR1, stderr: '', exitCode: 0 }, // r1 PENDING → must NOT advance to r2
      { stdout: mdstat([{ kernel: 'md127', checkPercent: 20 }, { kernel: 'md126' }]), stderr: '', exitCode: 0 }, // r1 running
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 }, // r1 done → r2
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126', checkPercent: 60 }]), stderr: '', exitCode: 0 }, // r2 running
      { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 }, // r2 done
    ] })

    const result = await scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1 })
    assert.equal(result.checkedArrays, 2)

    const calls = executor.calls
    const checkR1 = calls.findIndex(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === '/dev/md/t2-r1')
    const checkR2 = calls.findIndex(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check' && c.args[1] === '/dev/md/t2-r2')
    assert.ok(checkR1 >= 0 && checkR2 > checkR1, 'both checks issued, r1 before r2')
    // The PENDING poll must NOT release r2: the pending + running polls both sit
    // between the two checks. Without the fix, r2 starts right after the single
    // PENDING poll (one cat between).
    const catsBetween = calls.slice(checkR1 + 1, checkR2).filter(c => c.command === '/usr/bin/cat').length
    assert.ok(catsBetween >= 2, `r1 was waited through PENDING before r2 started (saw ${catsBetween} poll(s))`)
  })

  it('aborted btrfs scrub fails the job', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', result: { stdout: scrubStatus('aborted'), stderr: '', exitCode: 0 } })
    await assert.rejects(scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1 }), /aborted/)
  })

  it('refuses an unmounted pool', async () => {
    const executor = baseExecutor()
    await assert.rejects(scrubAhrPool(executor, pool('/dev/t2/t2-vol'), () => {}), /not mounted/)
    assert.equal(executor.calls.length, 0)
  })
})

describe('parseBtrfsScrubStatus', () => {
  it('extracts status, percent, and error summary', () => {
    const st = parseBtrfsScrubStatus(scrubStatus('running', { percent: '42.50', summary: 'csum=2' }))
    assert.deepEqual(st, { status: 'running', percent: 42.5, errorSummary: 'csum=2' })
  })
  it('fail-opens to nulls on empty output', () => {
    assert.deepEqual(parseBtrfsScrubStatus(''), { status: null, percent: null, errorSummary: null })
  })
})

/**
 * Story selfheal.3 — the scrub names WHAT is corrupt.
 *
 * Every parser case below is fed the drill's verbatim kernel lines
 * (fixtures/ahr/scrub-dmesg-gt3.txt, scrub-dmesg-gt6.txt — GT-3 and GT-6 of
 * docs/AHR-SELF-HEAL-GROUND-TRUTH.md), never a hand-written approximation of
 * them.
 */
describe('parseScrubWarning (GT-3 kernel lines)', () => {
  it('parses the drill\'s checksum-error line field for field', () => {
    assert.deepEqual(parseScrubWarning(GT3_LINES[0]), {
      device: 'dm-0',
      logical: 14811136,
      dev: '/dev/mapper/gtsh-data',
      physical: 14811136,
      root: 256,
      inode: 257,
      offset: 1179648,
      length: 4096,
      links: 1,
      path: 'f1.bin',
    })
  })

  it('parses the GT-6 line (corruption written THROUGH md) the same way', () => {
    const line = parseScrubWarning(GT6_LINES[0])
    assert.equal(line?.inode, 258)
    assert.equal(line?.path, 'f2.bin')
    assert.equal(line?.logical, 19005440)
  })

  it('reads the same line from journald (no dmesg timestamp prefix)', () => {
    const bare = GT3_LINES[0].replace(/^\[\s*\d+\.\d+\]\s*/, '')
    assert.deepEqual(parseScrubWarning(bare), parseScrubWarning(GT3_LINES[0]))
  })

  it('ignores the bdev error-COUNTER line that follows it — not an error event', () => {
    assert.equal(parseScrubWarning(GT3_LINES[1]), null)
    assert.equal(parseUnattributedScrubError(GT3_LINES[1]), null)
    // …and the scrub-summary line the capture script appends is not one either.
    assert.equal(parseUnattributedScrubError(GT6_LINES[1]), null)
  })

  it('a path-less error line is unattributed, never a file', () => {
    const line = 'BTRFS error (device dm-0): unable to fixup (regular) error at logical 24000000 on dev /dev/mapper/gtsh-data physical 24000000'
    assert.equal(parseScrubWarning(line), null)
    assert.deepEqual(parseUnattributedScrubError(line), { device: 'dm-0', logical: 24000000 })
  })
})

describe('kernelJournalMessages (journalctl -k -o json)', () => {
  it('takes MESSAGE out of the JSON envelope, string or byte array', () => {
    const ndjson = [
      JSON.stringify({ MESSAGE: GT3_LINES[0], _TRANSPORT: 'kernel' }),
      JSON.stringify({ MESSAGE: Array.from(GT6_LINES[0], c => c.charCodeAt(0)) }),
      'not json at all',
      '',
      JSON.stringify({ PRIORITY: '6' }),
    ].join('\n')
    assert.deepEqual(kernelJournalMessages(ndjson), [GT3_LINES[0], GT6_LINES[0]])
  })
})

describe('attributeScrubErrors (grouping, cap, honesty counts)', () => {
  const dmesg = (opts: { device?: string, root?: number, inode: number, logical: number, offset: number, path: string }): string =>
    `BTRFS warning (device ${opts.device ?? 'dm-0'}): scrub: checksum error at logical ${opts.logical} `
    + `on dev /dev/mapper/gtsh-data, physical ${opts.logical} root ${opts.root ?? 256} inode ${opts.inode} `
    + `offset ${opts.offset} length 4096 links 1 (path: ${opts.path})`

  it('groups every stripe of one file into one finding', () => {
    const a = attributeScrubErrors([
      GT3_LINES[0],
      dmesg({ inode: 257, logical: 14876672, offset: 1245184, path: 'f1.bin' }),
      GT6_LINES[0],
    ])
    assert.equal(a.files.length, 2)
    assert.equal(a.files[0].inode, 257)
    assert.deepEqual(a.files[0].stripes.map(s => s.offset), [1179648, 1245184])
    assert.equal(a.files[1].inode, 258)
    assert.equal(a.errorsAttributed, 3)
    assert.equal(a.truncated, false)
  })

  it('counts a stripe reported twice (both copies of a mirror) once', () => {
    const a = attributeScrubErrors([GT3_LINES[0], GT3_LINES[0]])
    assert.equal(a.errorsAttributed, 1)
    assert.equal(a.files[0].stripes.length, 1)
  })

  it('same inode number in a DIFFERENT subvolume is a different file', () => {
    const a = attributeScrubErrors([
      GT3_LINES[0],
      dmesg({ root: 257, inode: 257, logical: 15000000, offset: 0, path: 'f1.bin' }),
    ])
    assert.equal(a.files.length, 2)
    assert.deepEqual(a.files.map(f => f.root), [256, 257])
  })

  it(`caps the list at ${AHR_SCRUB_FINDINGS_CAP} files but keeps counting every error`, () => {
    const lines: string[] = []
    for (let i = 0; i < AHR_SCRUB_FINDINGS_CAP + 5; i++) {
      lines.push(dmesg({ inode: 1000 + i, logical: 20000000 + i * 65536, offset: 0, path: `f${i}.bin` }))
      // A second stripe for each file — the cap is on FILES, not on errors.
      lines.push(dmesg({ inode: 1000 + i, logical: 30000000 + i * 65536, offset: 65536, path: `f${i}.bin` }))
    }
    const a = attributeScrubErrors(lines)
    assert.equal(a.files.length, AHR_SCRUB_FINDINGS_CAP)
    assert.equal(a.truncated, true)
    assert.equal(a.errorsAttributed, (AHR_SCRUB_FINDINGS_CAP + 5) * 2)
  })

  it('errors with no path are counted unattributed — and never counted twice', () => {
    const a = attributeScrubErrors([
      GT3_LINES[0],
      // The same error said again, this time without a path: still ONE error.
      'BTRFS error (device dm-0): unable to fixup (regular) error at logical 14811136 on dev /dev/mapper/gtsh-data physical 14811136',
      // A genuinely nameless one.
      'BTRFS error (device dm-0): unable to fixup (regular) error at logical 24000000 on dev /dev/mapper/gtsh-data physical 24000000',
    ])
    assert.equal(a.errorsAttributed, 1)
    assert.equal(a.unattributed, 1)
  })

  it('another pool scrubbing at the same time is not attributed to this one', () => {
    const a = attributeScrubErrors([
      GT3_LINES[0],
      dmesg({ device: 'dm-9', inode: 9999, logical: 40000000, offset: 0, path: 'other-pool.bin' }),
      'BTRFS error (device dm-9): unable to fixup (regular) error at logical 40000000 on dev /dev/mapper/other-data physical 40000000',
    ], 'dm-0')
    assert.equal(a.files.length, 1)
    assert.equal(a.files[0].inode, 257)
    assert.equal(a.unattributed, 0)
  })

  it('an unresolvable device filters nothing (fail-open)', () => {
    assert.equal(attributeScrubErrors([GT3_LINES[0]], null).files.length, 1)
  })
})

describe('scrub summary counts + path assembly', () => {
  it('sums the Error summary counters', () => {
    assert.equal(countErrorSummary('csum=2'), 2)
    assert.equal(countErrorSummary('read=1 csum=12 super=1'), 14)
    assert.equal(countErrorSummary(null), 0)
  })

  // `subvolid-resolve` answers from the filesystem's TOP LEVEL, but a §12 pool
  // is mounted `subvol=@data` AT the mountpoint — so the resolved path has to be
  // taken RELATIVE to the mounted subvolume. Getting this wrong points every
  // probe at a path that does not exist on a real pool.
  const MP = '/mnt/anas-ahr/t2'

  it('§12 layout: a file at the root of the MOUNTED subvolume sits at the mountpoint', () => {
    assert.deepEqual(findingPath(MP, '@data', '@data', 'f1.bin'), { path: `${MP}/f1.bin`, outsideMount: false })
    // …and the same with the slashes btrfs and findmnt actually print.
    assert.deepEqual(findingPath(`${MP}/`, '/@data', '@data/', '/movies/a.mkv'), { path: `${MP}/movies/a.mkv`, outsideMount: false })
  })

  it('§12 layout: a NESTED subvolume keeps its remainder under the mountpoint', () => {
    assert.deepEqual(
      findingPath(MP, '@data', '@data/photos', '2026/a.jpg'),
      { path: `${MP}/photos/2026/a.jpg`, outsideMount: false },
    )
  })

  it('§12 layout: a snapshot is OUTSIDE the mounted tree — filesystem-relative, flagged', () => {
    assert.deepEqual(
      findingPath(MP, '@data', '@snapshots/nightly', 'f1.bin'),
      { path: '@snapshots/nightly/f1.bin', outsideMount: true },
    )
    // A sibling whose name merely STARTS with the mounted one is outside too.
    assert.equal(findingPath(MP, '@data', '@database', 'f1.bin').outsideMount, true)
  })

  it('flat pool (top level mounted): the resolved subvolume is a directory under it', () => {
    assert.deepEqual(findingPath(MP, '', '@data', 'f1.bin'), { path: `${MP}/@data/f1.bin`, outsideMount: false })
    assert.deepEqual(findingPath(MP, '/', '/', 'f1.bin'), { path: `${MP}/f1.bin`, outsideMount: false })
  })

  it('formats the journal window as journalctl -S takes it (local wall clock)', () => {
    assert.equal(journalSince(new Date(2026, 8, 11, 7, 5, 3)), '2026-09-11 07:05:03')
  })
})

describe('scrubAhrPool — findings (story selfheal.3)', () => {
  // The pool is the §12 layout — `subvol=@data` mounted AT the mountpoint — so
  // the kernel's `root 256` (`@data`) file `f1.bin` is `<mountpoint>/f1.bin`.
  // `<mountpoint>/@data/f1.bin` does not exist on such a pool.
  const F1 = `${MOUNTPOINT}/f1.bin`
  const F2 = `${MOUNTPOINT}/f2.bin`

  /** The journalctl -o json envelope around a set of kernel lines. */
  function journal(lines: string[]): string {
    return `${lines.map(l => JSON.stringify({ _TRANSPORT: 'kernel', MESSAGE: l })).join('\n')}\n`
  }

  /** `findmnt --json --real <mountpoint>` for a pool mounted `subvol=<subvol>`. */
  function findmnt(subvol: string): string {
    return `${JSON.stringify({
      filesystems: [{
        target: MOUNTPOINT,
        source: `/dev/mapper/t2-t2--vol[${subvol}]`,
        fstype: 'btrfs',
        options: `rw,relatime,space_cache=v2,subvol=${subvol}`,
      }],
    })}\n`
  }

  function findingsExecutor(): MockExecutor {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real', MOUNTPOINT], result: { stdout: findmnt('/@data'), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=2' }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([...GT3_LINES, ...GT6_LINES]), stderr: '', exitCode: 0 } })
    // The pool LV's dm name — the name the kernel lines carry.
    executor.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/dm-0\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '256', MOUNTPOINT], result: { stdout: '@data\n', stderr: '', exitCode: 0 } })
    // Every probe read succeeds unless a fixture below says otherwise.
    executor.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })
    return executor
  }

  /** Both files still exist (the ordinary case). */
  function bothPresent(executor: MockExecutor): void {
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F1], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F2], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
  }

  /** GT-3's rot sits in file block 300 — inside the named stripe (288–303). */
  function badBlock300(executor: MockExecutor): void {
    executor.addFixture({
      command: '/usr/bin/dd',
      args: [`if=${F1}`, 'iflag=direct', 'bs=4096', 'skip=300', 'count=1', 'of=/dev/null'],
      result: { stdout: '', stderr: 'dd: error reading', exitCode: 1 },
    })
  }

  it('names the corrupt file, its stripe, and the exact failing 4 KiB block', async () => {
    const executor = findingsExecutor()
    bothPresent(executor)
    badBlock300(executor)

    const result = await scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1 })

    assert.equal(result.errorsReported, 2)
    assert.equal(result.errorsAttributed, 2)
    assert.equal(result.unattributed, 0)
    assert.equal(result.truncated, false)
    assert.deepEqual(result.findings?.[0], {
      path: F1,
      subvolume: '@data',
      inode: 257,
      stripes: [{ logical: 14811136, offset: 1179648, length: 4096 }],
      badBlocks: [300],
    })
    assert.deepEqual(result.findings?.[1].badBlocks, [])
    assert.equal(result.findings?.[1].path, F2)

    // The window is bounded to THIS scrub, and the envelope is asked for as JSON.
    const journalCall = executor.calls.find(c => c.command === '/usr/bin/journalctl')
    assert.ok(journalCall)
    assert.deepEqual(journalCall!.args.slice(0, 4), ['-k', '-o', 'json', '-S'])
    assert.match(journalCall!.args[4], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

    // 16 O_DIRECT reads per named stripe — the whole stripe, nothing else.
    const ddF1 = executor.calls.filter(c => c.command === '/usr/bin/dd' && c.args[0] === `if=${F1}`)
    assert.equal(ddF1.length, 16)
    assert.deepEqual(ddF1.map(c => c.args[3]), Array.from({ length: 16 }, (_, i) => `skip=${288 + i}`))
    assert.ok(ddF1.every(c => c.args.includes('iflag=direct')), 'a cached read would find nothing')

    // One subvolume id → ONE resolve, however many files it holds.
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/btrfs' && c.args[1] === 'subvolid-resolve').length, 1)

    // The path is taken relative to the subvolume the pool actually MOUNTS —
    // read from the live mount table, not assumed.
    assert.ok(executor.calls.some(c => c.command === '/usr/bin/findmnt' && c.args.includes(MOUNTPOINT)))
  })

  it('carries the paths in the SAME warning notification — never a second one', async () => {
    const executor = findingsExecutor()
    bothPresent(executor)
    badBlock300(executor)

    await scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1 })

    const notifies = executor.calls.filter(c => c.command === '/usr/bin/perl')
    assert.equal(notifies.length, 1, 'one event, one notification')
    const body = notifies[0].args[4]
    assert.ok(body.includes('csum=2'), 'the summary sentence is unchanged')
    assert.ok(body.includes(F1) && body.includes(F2), 'both paths are named in full')
    assert.ok(body.includes('1 bad 4K block(s)'))
    assert.ok(body.includes('2 of 2 reported error(s) attributed'))
  })

  it('a file deleted since the scrub is reported as missing, not as a failure', async () => {
    const executor = findingsExecutor()
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F1], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F2], result: { stdout: '', stderr: 'No such file or directory', exitCode: 1 } })

    const result = await scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1 })
    assert.equal(result.findings?.[1].missing, true)
    assert.deepEqual(result.findings?.[1].badBlocks, [])
    // Nothing was probed for it — a missing path is never dd'd sixteen times.
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/dd' && c.args[0] === `if=${F2}`).length, 0)
    // …and the deletion is said in the notification rather than counted as blocks.
    const body = executor.calls.find(c => c.command === '/usr/bin/perl')!.args[4]
    assert.ok(body.includes('deleted since the scrub'))
  })

  it('an unreadable journal never fails the scrub — the count still stands', async () => {
    const executor = baseExecutor()
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=2' }), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/journalctl', result: { stdout: '', stderr: 'Failed to open journal', exitCode: 1 } })

    const result = await scrubAhrPool(executor, pool(), () => {}, { pollIntervalMs: 1 })
    assert.equal(result.btrfsErrors, 'csum=2')
    assert.equal(result.errorsReported, 2)
    assert.equal(result.findings, undefined, 'no attribution rather than an invented one')
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/perl').length, 1)
  })

  it('a clean scrub reads no journal and probes nothing', async () => {
    const clean = baseExecutor()
    clean.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
    clean.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished'), stderr: '', exitCode: 0 } })
    clean.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })

    const result = await scrubAhrPool(clean, pool(), () => {}, { pollIntervalMs: 1 })
    assert.deepEqual(result, { scrubbed: 't2', btrfsErrors: null, checkedArrays: 2 })
    assert.ok(!clean.calls.some(c => c.command === '/usr/bin/journalctl'))
    assert.ok(!clean.calls.some(c => c.command === '/usr/bin/dd'))
  })

  /** A kernel scrub warning for one file, in the drill's exact shape. */
  function warning(root: number, inode: number, logical: number, path: string): string {
    return `BTRFS warning (device dm-0): scrub: checksum error at logical ${logical} `
      + `on dev /dev/mapper/t2-t2--vol, physical ${logical} root ${root} inode ${inode} `
      + `offset 1179648 length 4096 links 1 (path: ${path})`
  }

  it('a NESTED subvolume keeps its remainder, and a SNAPSHOT is reported outside the mount', async () => {
    const e = baseExecutor()
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=2' }), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real', MOUNTPOINT], result: { stdout: findmnt('/@data'), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/dm-0\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([
      warning(257, 300, 20000000, '2026/a.jpg'),
      warning(258, 301, 21000000, 'f1.bin'),
    ]), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '257', MOUNTPOINT], result: { stdout: '@data/photos\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '258', MOUNTPOINT], result: { stdout: '@snapshots/nightly\n', stderr: '', exitCode: 0 } })
    const NESTED = `${MOUNTPOINT}/photos/2026/a.jpg`
    e.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', NESTED], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/dd', args: [`if=${NESTED}`, 'iflag=direct', 'bs=4096', 'skip=290', 'count=1', 'of=/dev/null'], result: { stdout: '', stderr: '', exitCode: 1 } })

    const result = await scrubAhrPool(e, pool(), () => {}, { pollIntervalMs: 1 })

    // `@data/photos` under a mounted `@data` is <mountpoint>/photos — probed.
    assert.equal(result.findings?.[0].path, NESTED)
    assert.deepEqual(result.findings?.[0].badBlocks, [290])
    assert.equal(result.findings?.[0].outsideMount, undefined)

    // `@snapshots/nightly` has NO path under the mountpoint: reported
    // filesystem-relative, flagged, and never probed at a path that is not it.
    assert.equal(result.findings?.[1].path, '@snapshots/nightly/f1.bin')
    assert.equal(result.findings?.[1].outsideMount, true)
    assert.equal(result.findings?.[1].missing, undefined, 'outside the mount is not "deleted"')
    assert.deepEqual(result.findings?.[1].badBlocks, [])
    assert.equal(e.calls.filter(c => c.command === '/usr/bin/stat').length, 1, 'the snapshot path is never stat-ed')
    assert.ok(!e.calls.some(c => c.command === '/usr/bin/dd' && c.args[0].includes('@snapshots')))

    const body = e.calls.find(c => c.command === '/usr/bin/perl')!.args[4]
    assert.ok(body.includes('in a snapshot, outside the mounted tree'), body)
  })

  it('a FLAT pool mounts the top level — the resolved subvolume IS a directory under it', async () => {
    const e = baseExecutor()
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=1' }), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/findmnt', args: ['--json', '--real', MOUNTPOINT], result: { stdout: findmnt('/'), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/dm-0\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([GT3_LINES[0]]), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '256', MOUNTPOINT], result: { stdout: '@data\n', stderr: '', exitCode: 0 } })
    const FLAT = `${MOUNTPOINT}/@data/f1.bin`
    e.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', FLAT], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })

    const flat = pool()
    flat.subvolLayout = false
    const result = await scrubAhrPool(e, flat, () => {}, { pollIntervalMs: 1 })
    assert.equal(result.findings?.[0].path, FLAT)
    assert.equal(result.findings?.[0].outsideMount, undefined)
    assert.equal(e.calls.filter(c => c.command === '/usr/bin/dd').length, 16)
  })

  it('an unreadable mount table falls back to the pool\'s own subvolLayout reading', async () => {
    const e = baseExecutor()
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'start', MOUNTPOINT], result: { stdout: '', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['scrub', 'status', MOUNTPOINT], result: { stdout: scrubStatus('finished', { summary: 'csum=1' }), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat([{ kernel: 'md127' }, { kernel: 'md126' }]), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/realpath', args: ['/dev/t2/t2-vol'], result: { stdout: '/dev/dm-0\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal([GT3_LINES[0]]), stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/btrfs', args: ['inspect-internal', 'subvolid-resolve', '256', MOUNTPOINT], result: { stdout: '@data\n', stderr: '', exitCode: 0 } })
    // No findmnt fixture: the mock answers 127. The pool says subvolLayout —
    // which is the SAME mount reading, one hop earlier — so the path still
    // resolves under the mounted @data.
    e.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', F1], result: { stdout: '4194304\n', stderr: '', exitCode: 0 } })
    e.addFixture({ command: '/usr/bin/dd', result: { stdout: '', stderr: '', exitCode: 0 } })

    const result = await scrubAhrPool(e, pool(), () => {}, { pollIntervalMs: 1 })
    assert.equal(result.findings?.[0].path, F1)
  })
})

describe('AhrScrubResult schema (shared, additive)', () => {
  it('still parses a result from a daemon that knew nothing of findings', () => {
    const old = AhrScrubResult.parse({ scrubbed: 't2', btrfsErrors: null, checkedArrays: 2 })
    assert.deepEqual(old, { scrubbed: 't2', btrfsErrors: null, checkedArrays: 2 })
  })

  it('round-trips a full finding through JSON unchanged', () => {
    const full = {
      scrubbed: 't2',
      btrfsErrors: 'csum=2',
      checkedArrays: 2,
      findings: [
        {
          path: '/mnt/anas-ahr/t2/@data/f1.bin',
          subvolume: '@data',
          inode: 257,
          stripes: [{ logical: 14811136, offset: 1179648, length: 4096 }],
          badBlocks: [300],
        },
        {
          path: '/mnt/anas-ahr/t2/@data/gone.bin',
          subvolume: '@data',
          inode: 258,
          stripes: [{ logical: 19005440, offset: 1179648, length: 4096 }],
          badBlocks: [],
          missing: true,
        },
      ],
      errorsReported: 2,
      errorsAttributed: 2,
      unattributed: 0,
      truncated: false,
    }
    assert.deepEqual(AhrScrubResult.parse(JSON.parse(JSON.stringify(full))), full)
  })

  it('refuses a negative count and a finding without its stripes', () => {
    assert.equal(AhrScrubResult.safeParse({ scrubbed: 't2', btrfsErrors: null, checkedArrays: -1 }).success, false)
    assert.equal(AhrScrubResult.safeParse({
      scrubbed: 't2',
      btrfsErrors: 'csum=1',
      checkedArrays: 1,
      findings: [{ path: '/x', subvolume: '@data', inode: 1, badBlocks: [] }],
    }).success, false)
  })
})
