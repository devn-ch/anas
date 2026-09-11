import type { AhrPool, AhrScrubFinding, AhrScrubResult, AhrScrubStripe } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { AhrScrubResult as AhrScrubResultSchema } from '@anas/shared'
import { parseFindmnt } from '../parsers/findmnt.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { run } from './ahr-exec.js'
import { ahrLvPath } from './ahr-paths.js'
import { SUBVOL_DATA, subvolFromMountOptions } from './ahr-snapshots.js'
import { pveNotify } from './pve-notify.js'

/**
 * AHR pool scrub (Epic 11 + AHR, docs/AHR-DESIGN.md §4) — behind
 * POST /v1/ahr/:name/scrub. Two phases, strictly SEQUENTIAL — both are
 * full-device reads and would thrash each other concurrently (§4):
 *
 *   1. btrfs scrub (start + poll `btrfs scrub status`) — checksums the
 *      filesystem's view of the data.
 *   2. per-array `mdadm --action=check`, one band at a time, waiting on
 *      /proc/mdstat between arrays — verifies parity/mirror consistency
 *      underneath the filesystem.
 *
 * Between them, when phase 1 found errors, the ATTRIBUTION pass (story
 * selfheal.3) names the corrupt files and their failing 4 KiB blocks. It runs
 * BETWEEN the phases deliberately: its probe reads are tiny, but they are
 * still reads of the array, and §4's rule is that nothing else reads while a
 * check runs.
 *
 * `btrfs scrub status` text is parsed minimally (Status / Bytes scrubbed % /
 * Error summary): like /proc/mdstat it has no structured alternative on the
 * shipped btrfs-progs, so it joins GT-13's sanctioned text exceptions.
 *
 * Findings notify at `warning` via PVE (§7.2); a clean scrub is silent —
 * healthy/idle shows nothing (dashboard policy §7.3).
 */

const BTRFS = '/usr/bin/btrfs'
const MDADM = '/usr/sbin/mdadm'
const CAT = '/usr/bin/cat'
const REALPATH = '/usr/bin/realpath'
const JOURNALCTL = '/usr/bin/journalctl'
const STAT = '/usr/bin/stat'
const DD = '/usr/bin/dd'
const FINDMNT = '/usr/bin/findmnt'

/** `findmnt --json --real <mountpoint>` — the one mount, with its options. */
export const AHR_SCRUB_FINDMNT_ARGS = ['--json', '--real']

/** Default poll interval while waiting on scrub/check progress. */
export const AHR_SCRUB_POLL_MS = 5000

export interface AhrScrubOptions {
  /** Poll interval override (tests use 1). */
  pollIntervalMs?: number
}

/** Minimal structured view of `btrfs scrub status`. */
interface BtrfsScrubStatus {
  /** `Status:` value (running/finished/aborted/…), or null when absent. */
  status: string | null
  /** Percent from the `Bytes scrubbed: … (N%)` line, when present. */
  percent: number | null
  /** `Error summary:` value, or null when absent. */
  errorSummary: string | null
}

const STATUS_RE = /^Status:\s+(\S+)/m
const PERCENT_RE = /^Bytes scrubbed:.*\(([\d.]+)%\)/m
const ERROR_SUMMARY_RE = /^Error summary:\s+(\S.*)$/m
const DEV_PREFIX_RE = /^\/dev\//

/** Parse the human-readable `btrfs scrub status` output (fail-open nulls). */
export function parseBtrfsScrubStatus(text: string): BtrfsScrubStatus {
  return {
    status: text.match(STATUS_RE)?.[1] ?? null,
    percent: PERCENT_RE.test(text) ? Number.parseFloat(text.match(PERCENT_RE)![1]) : null,
    errorSummary: text.match(ERROR_SUMMARY_RE)?.[1].trim() ?? null,
  }
}

/** A clean btrfs error summary (`no errors found`). */
function isCleanSummary(summary: string | null): boolean {
  return summary === null || summary === 'no errors found'
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

// ---- Attribution: WHAT is corrupt (story selfheal.3) ------------------------

/**
 * `Error summary: csum=2` says how many, never which. The kernel does say
 * which — every scrub error is logged with the file's subvolume id, inode and
 * byte offset (GT-3):
 *
 *   BTRFS warning (device dm-0): scrub: checksum error at logical 14811136 on
 *   dev /dev/mapper/gtsh-data, physical 14811136 root 256 inode 257 offset
 *   1179648 length 4096 links 1 (path: f1.bin)
 *
 * The journal ENVELOPE is JSON (`journalctl -k -o json`); the MESSAGE inside it
 * is not, and the kernel offers no structured form of it — so this text parse
 * joins `btrfs scrub status` above as a sanctioned Principle-13 exception, for
 * the same reason.
 *
 * Two drill facts shape the rest:
 *   - the reported `offset` is the 64 KiB btrfs STRIPE start, not the failing
 *     4 KiB block, and the line carries no csum values (GT-3) — so the exact
 *     block is evidence ANAS gathers itself, by reading each of the 16 blocks
 *     in the stripe with O_DIRECT (a read error = a bad block);
 *   - `root N` is a subvolume id, so the printed path is subvolume-relative
 *     and names nothing on the node until `btrfs inspect-internal
 *     subvolid-resolve` turns the id into a name (GT-3/GT-6).
 */

/** One kernel scrub error line that named a file. */
export interface ScrubErrorLine {
  /** The `(device X)` name — the dm device btrfs is mounted from. */
  device: string
  logical: number
  /** The `on dev …` member path the error was seen on. */
  dev: string
  physical: number
  /** Subvolume id (`root N`) — resolved to a name before use. */
  root: number
  inode: number
  /** Byte offset within the file: the 64 KiB stripe start (GT-3). */
  offset: number
  /** Length as the kernel printed it (4096 on the drill), kept verbatim. */
  length: number
  links: number
  /** The subvolume-RELATIVE path the kernel printed. */
  path: string
}

/** btrfs file geometry the attribution walks in (GT-3). */
const BLOCK_BYTES = 4096
const STRIPE_BYTES = 65536
const BLOCKS_PER_STRIPE = STRIPE_BYTES / BLOCK_BYTES

/** At most this many FILES ride in a result; the counts always tell the truth. */
export const AHR_SCRUB_FINDINGS_CAP = 200
/** At most this many paths in the notification body, then "and N more". */
const NOTIFY_PATH_LIMIT = 20

/**
 * `dmesg` prefixes a line with the monotonic stamp (`[ 3455.495994] `);
 * journald's MESSAGE does not. Accepted either way, so the drill's recorded
 * captures parse exactly as the live journal does.
 */
const KERNEL_STAMP_RE = /^\[\s*\d+\.\d+\]\s*/

/**
 * A scrub error line that NAMED a file. `checksum error` is the drill's shape;
 * the kind word is left open (`unrecoverable error`, `read error`) because the
 * fields after it are what matter and the kernel spells the kind several ways.
 */
const SCRUB_PATH_RE = new RegExp(
  '^BTRFS \\w+ \\(device ([^)]+)\\): scrub: [\\w ()]*?error at logical (\\d+) on dev (\\S+?),? '
  + 'physical (\\d+) root (\\d+) inode (\\d+) offset (\\d+) length (\\d+) links (\\d+) \\(path: (.*)\\)$',
)

/**
 * An error line with NO path: `unable to fixup (regular) error at logical …`,
 * read errors, super-block errors. The logical is captured so an error already
 * attributed by a path-carrying line is not counted a second time.
 */
const SCRUB_NO_PATH_RE = /^BTRFS \w+ \(device ([^)]+)\): (?:scrub: )?[\w ()]*?error at logical (\d+)\b/

/** Parse ONE kernel MESSAGE into a path-carrying scrub error, or null. */
export function parseScrubWarning(message: string): ScrubErrorLine | null {
  const m = message.replace(KERNEL_STAMP_RE, '').trim().match(SCRUB_PATH_RE)
  if (!m)
    return null
  return {
    device: m[1],
    logical: Number(m[2]),
    dev: m[3],
    physical: Number(m[4]),
    root: Number(m[5]),
    inode: Number(m[6]),
    offset: Number(m[7]),
    length: Number(m[8]),
    links: Number(m[9]),
    path: m[10],
  }
}

/** An error line the kernel could not attach a path to, or null. */
export function parseUnattributedScrubError(message: string): { device: string, logical: number } | null {
  const text = message.replace(KERNEL_STAMP_RE, '').trim()
  if (SCRUB_PATH_RE.test(text))
    return null
  const m = text.match(SCRUB_NO_PATH_RE)
  return m ? { device: m[1], logical: Number(m[2]) } : null
}

/**
 * `journalctl -k -o json` — one JSON object per line. Only the envelope is
 * parsed here; MESSAGE is handed on as text. A MESSAGE the journal stored as a
 * byte array (non-UTF-8 kernel output) is decoded rather than dropped; a line
 * that is not an envelope at all is skipped, so a truncated tail never costs
 * us the lines before it.
 */
export function kernelJournalMessages(stdout: string): string[] {
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (!text)
      continue
    try {
      const entry = JSON.parse(text) as { MESSAGE?: unknown }
      const msg = entry.MESSAGE
      if (typeof msg === 'string')
        out.push(msg)
      else if (Array.isArray(msg) && msg.every(b => typeof b === 'number'))
        out.push(String.fromCharCode(...msg as number[]))
    }
    catch {
      // Not a JSON envelope (a journalctl notice, a truncated tail) — skip it.
    }
  }
  return out
}

/** Every stripe the kernel named for ONE file, in the order it named them. */
export interface ScrubFileGroup {
  root: number
  inode: number
  /** The subvolume-relative path, as the kernel printed it. */
  path: string
  stripes: AhrScrubStripe[]
}

/** What the journal said, grouped per file and capped. */
export interface ScrubAttribution {
  /** The first {@link AHR_SCRUB_FINDINGS_CAP} files, in first-seen order. */
  files: ScrubFileGroup[]
  /** Distinct stripes attributed to a file — ALL of them, cap or no cap. */
  errorsAttributed: number
  /** Distinct error logicals the kernel never attached a path to. */
  unattributed: number
  /** True when more files were seen than the cap carries. */
  truncated: boolean
}

/**
 * Group the window's kernel messages per file.
 *
 * `device`, when given, keeps another pool's concurrent scrub out of this
 * result: the kernel names the dm device the filesystem is mounted from, and
 * only lines from OUR device describe OUR files. An unresolvable device means
 * no filter — fail-open, because the filter's absence costs nothing on a node
 * scrubbing one pool, while a wrong filter would silently drop real findings.
 */
export function attributeScrubErrors(messages: string[], device?: string | null): ScrubAttribution {
  const files = new Map<string, ScrubFileGroup>()
  const seenFiles = new Set<string>()
  const seenStripes = new Set<string>()
  const attributedLogicals = new Set<number>()
  const unattributed = new Set<number>()
  let errorsAttributed = 0

  for (const message of messages) {
    const line = parseScrubWarning(message)
    if (line) {
      if (device && line.device !== device)
        continue
      attributedLogicals.add(line.logical)
      // The same stripe can be reported more than once (both copies of a RAID1
      // band, a re-read): one stripe, one error.
      const stripeKey = `${line.root}:${line.inode}:${line.logical}:${line.offset}`
      if (seenStripes.has(stripeKey))
        continue
      seenStripes.add(stripeKey)
      errorsAttributed += 1
      const key = `${line.root}:${line.inode}`
      seenFiles.add(key)
      const existing = files.get(key)
      if (existing) {
        existing.stripes.push({ logical: line.logical, offset: line.offset, length: line.length })
        continue
      }
      // Past the cap a file is COUNTED but not carried — errorsAttributed keeps
      // counting its stripes, so the numbers never shrink to fit the list.
      if (files.size >= AHR_SCRUB_FINDINGS_CAP)
        continue
      files.set(key, {
        root: line.root,
        inode: line.inode,
        path: line.path,
        stripes: [{ logical: line.logical, offset: line.offset, length: line.length }],
      })
      continue
    }
    const orphan = parseUnattributedScrubError(message)
    if (orphan && (!device || orphan.device === device))
      unattributed.add(orphan.logical)
  }

  // An `unable to fixup … at logical N` that follows the csum error for the
  // SAME logical is the same error said twice, never a second nameless one.
  for (const logical of attributedLogicals)
    unattributed.delete(logical)

  return {
    files: [...files.values()],
    errorsAttributed,
    unattributed: unattributed.size,
    truncated: seenFiles.size > files.size,
  }
}

/** The `key=N` counters in a btrfs `Error summary` line (`csum=2 read=1`). */
const SUMMARY_COUNT_RE = /\b\w+=(\d+)\b/g
const TRAILING_SLASH_RE = /\/+$/
const SURROUNDING_SLASH_RE = /^\/+|\/+$/g
const LEADING_SLASH_RE = /^\/+/

/** Sum of the `key=N` counters in a btrfs `Error summary` (`csum=2 read=1`). */
export function countErrorSummary(summary: string | null): number {
  if (!summary)
    return 0
  let total = 0
  for (const m of summary.matchAll(SUMMARY_COUNT_RE))
    total += Number(m[1])
  return total
}

/** Join non-empty path parts with single slashes. */
function joinParts(parts: (string | null)[]): string {
  return parts.map(p => (p ?? '')).filter(p => p !== '').join('/')
}

/** A subvolume path in its bare form: no leading or trailing slash (`/` → ``). */
function bareSubvol(subvol: string | null): string {
  return (subvol ?? '').replace(SURROUNDING_SLASH_RE, '')
}

/**
 * Where a finding IS, on this node.
 *
 * `subvolid-resolve` answers from the filesystem's TOP LEVEL (`@data`,
 * `@data/photos`, `@snapshots/nightly`), but an AHR pool in the §12 layout is
 * mounted `subvol=@data` AT its mountpoint — so `@data/f1.bin` lives at
 * `<mountpoint>/f1.bin`, and `<mountpoint>/@data/f1.bin` does not exist at all.
 * A flat pool mounts the top level (`subvol=/`) and the resolved path is the
 * relative one. `mounted` is the pool's OWN mounted subvolume, bare.
 *
 * A scrub covers the whole filesystem, so a finding can also land OUTSIDE the
 * mounted tree — `@snapshots/<name>/…` is real and expected, since AHR keeps
 * snapshots as siblings of `@data` (§12). There is no path to it under the
 * mountpoint, and inventing one would send the probe at a file that is not the
 * one the kernel named: those are reported filesystem-relative and flagged.
 */
export function findingPath(
  mountpoint: string,
  mounted: string | null,
  resolved: string | null,
  relative: string,
): { path: string, outsideMount: boolean } {
  const root = mountpoint.replace(TRAILING_SLASH_RE, '')
  const under = bareSubvol(mounted)
  const full = bareSubvol(resolved)
  const rel = relative.replace(LEADING_SLASH_RE, '')
  // Top-level mount: the resolved subvolume IS a directory under the mountpoint.
  if (under === '')
    return { path: joinParts([root, full, rel]), outsideMount: false }
  if (full === under)
    return { path: joinParts([root, rel]), outsideMount: false }
  // Nested under the mounted subvolume — keep the remainder (`@data/photos`
  // mounted at `@data` is `<mountpoint>/photos`).
  if (full.startsWith(`${under}/`))
    return { path: joinParts([root, full.slice(under.length + 1), rel]), outsideMount: false }
  return { path: joinParts([full, rel]), outsideMount: true }
}

/**
 * The pool's mounted subvolume, bare (`@data`, or `` for a top-level mount).
 *
 * Read from the live mount, through the SAME helper the topology's
 * `subvolLayout` comes from — the mount is the source of truth (§5.3), nothing
 * is precomputed. When the mount cannot be read (or an old kernel omits the
 * option), the pool's own `subvolLayout` stands in: it is that same reading,
 * one hop earlier.
 */
async function mountedSubvolume(executor: CommandExecutor, pool: AhrPool): Promise<string> {
  try {
    const r = await executor.exec(FINDMNT, [...AHR_SCRUB_FINDMNT_ARGS, pool.mountpoint])
    if (r.exitCode === 0) {
      const mount = parseFindmnt(r.stdout).find(m => m.target === pool.mountpoint)
      const subvol = mount ? subvolFromMountOptions(mount.options) : null
      if (subvol !== null)
        return bareSubvol(subvol)
    }
  }
  catch {
    // fall through to the pool's own reading
  }
  return pool.subvolLayout ? SUBVOL_DATA : ''
}

/**
 * journalctl's `-S` takes LOCAL wall-clock time in `YYYY-MM-DD HH:MM:SS`.
 * Seconds are floored, which only ever widens the window by under a second —
 * the safe direction: a scrub's own errors can never be older than its start.
 */
export function journalSince(when: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} `
    + `${p(when.getHours())}:${p(when.getMinutes())}:${p(when.getSeconds())}`
}

/** The pool LV's kernel dm name (`dm-0`) — the name the kernel lines carry. */
async function poolDmName(executor: CommandExecutor, pool: AhrPool): Promise<string | null> {
  try {
    const r = await executor.exec(REALPATH, [ahrLvPath(pool.name)])
    const name = r.exitCode === 0 ? r.stdout.trim().replace(DEV_PREFIX_RE, '') : ''
    return name === '' ? null : name
  }
  catch {
    return null
  }
}

/** Resolve a subvolume id to its name (`@data`), once per id; null when it does not resolve. */
async function resolveSubvolume(
  executor: CommandExecutor,
  mountpoint: string,
  root: number,
  cache: Map<number, string | null>,
): Promise<string | null> {
  const cached = cache.get(root)
  if (cached !== undefined)
    return cached
  let name: string | null = null
  try {
    const r = await executor.exec(BTRFS, ['inspect-internal', 'subvolid-resolve', String(root), mountpoint])
    const text = r.exitCode === 0 ? r.stdout.trim() : ''
    name = text === '' ? null : text
  }
  catch {
    name = null
  }
  cache.set(root, name)
  return name
}

/**
 * The failing 4 KiB blocks inside ONE named 64 KiB stripe: read each of the 16
 * blocks with O_DIRECT and collect the ones that error (GT-3 — the kernel names
 * the stripe, never the block). O_DIRECT is what makes this a real read: a
 * cached page would answer from memory and every block would look fine.
 *
 * A block past EOF reads zero bytes and exits 0, so a file that shrank is not
 * reported as sixteen bad blocks.
 */
async function probeStripe(executor: CommandExecutor, path: string, offset: number): Promise<number[]> {
  const bad: number[] = []
  const base = Math.floor(offset / BLOCK_BYTES)
  for (let i = 0; i < BLOCKS_PER_STRIPE; i++) {
    const block = base + i
    const r = await executor.exec(DD, [
      `if=${path}`,
      'iflag=direct',
      `bs=${BLOCK_BYTES}`,
      `skip=${block}`,
      'count=1',
      'of=/dev/null',
    ])
    if (r.exitCode !== 0)
      bad.push(block)
  }
  return bad
}

/** Does the path still exist? A file deleted since the scrub is reported, not probed. */
async function pathExists(executor: CommandExecutor, path: string): Promise<boolean> {
  try {
    return (await executor.exec(STAT, ['-c', '%s', path])).exitCode === 0
  }
  catch {
    return false
  }
}

/**
 * Turn the grouped kernel reports into findings: resolve each subvolume once,
 * then probe every named stripe of every file that still exists.
 */
async function buildFindings(
  executor: CommandExecutor,
  pool: AhrPool,
  groups: ScrubFileGroup[],
  updateProgress: (message: string) => void,
): Promise<AhrScrubFinding[]> {
  const subvols = new Map<number, string | null>()
  const findings: AhrScrubFinding[] = []
  const mounted = await mountedSubvolume(executor, pool)
  for (const [i, group] of groups.entries()) {
    const subvolume = await resolveSubvolume(executor, pool.mountpoint, group.root, subvols)
    // An unresolvable subvolume id (deleted since the scrub) leaves only the
    // relative path the kernel printed — reported as it was printed, and marked
    // missing rather than dressed up as a path on the node.
    if (subvolume === null) {
      updateProgress(`Attributing scrub errors: ${i + 1}/${groups.length} (${group.path})`)
      findings.push({ path: group.path, subvolume, inode: group.inode, stripes: group.stripes, badBlocks: [], missing: true })
      continue
    }
    const where = findingPath(pool.mountpoint, mounted, subvolume, group.path)
    updateProgress(`Attributing scrub errors: ${i + 1}/${groups.length} (${where.path})`)
    // Outside the mounted tree (a snapshot under `@snapshots`, §12): real, and
    // reachable only through a top-level mount this job does not take. Reported
    // filesystem-relative and flagged — never probed at a path that is not it.
    if (where.outsideMount) {
      findings.push({ path: where.path, subvolume, inode: group.inode, stripes: group.stripes, badBlocks: [], outsideMount: true })
      continue
    }
    if (!(await pathExists(executor, where.path))) {
      findings.push({ path: where.path, subvolume, inode: group.inode, stripes: group.stripes, badBlocks: [], missing: true })
      continue
    }
    const badBlocks: number[] = []
    for (const stripe of group.stripes)
      badBlocks.push(...await probeStripe(executor, where.path, stripe.offset))
    findings.push({ path: where.path, subvolume, inode: group.inode, stripes: group.stripes, badBlocks })
  }
  return findings
}

/**
 * Read the kernel journal for THIS scrub's window and name what is corrupt.
 *
 * Best-effort by construction: a scrub that found errors and said so is worth
 * having even when the journal is unreadable or a probe fails, so every failure
 * here degrades to "no attribution" instead of failing the job.
 */
async function attributeScrub(
  executor: CommandExecutor,
  pool: AhrPool,
  startedAt: Date,
  updateProgress: (message: string) => void,
): Promise<Pick<AhrScrubResult, 'findings' | 'errorsAttributed' | 'unattributed' | 'truncated'>> {
  updateProgress('Reading the kernel journal for the scrub\'s errors')
  const r = await executor.exec(JOURNALCTL, ['-k', '-o', 'json', '-S', journalSince(startedAt), '--no-pager'])
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `journalctl exited ${r.exitCode}`)
  const attribution = attributeScrubErrors(kernelJournalMessages(r.stdout), await poolDmName(executor, pool))
  const findings = await buildFindings(executor, pool, attribution.files, updateProgress)
  return {
    findings,
    errorsAttributed: attribution.errorsAttributed,
    unattributed: attribution.unattributed,
    truncated: attribution.truncated,
  }
}

/** The notification body: the summary sentence, then the files it is about. */
function findingsBody(pool: AhrPool, btrfsErrors: string, result: AhrScrubResult): string {
  const head = `btrfs scrub on pool '${pool.name}' reported: ${btrfsErrors}. `
    + `Latent corruption was surfaced — check 'btrfs scrub status ${pool.mountpoint}' and the pool's disks.`
  const findings = result.findings ?? []
  if (findings.length === 0) {
    // Errors with nothing to name: rate-limited kernel warnings, or errors the
    // kernel never attached a path to. Say which, rather than print an empty list.
    return result.unattributed
      ? `${head}\n\n${result.unattributed} error(s) name no file (read/IO or metadata errors) — no per-file attribution.`
      : head
  }
  const lines = findings.slice(0, NOTIFY_PATH_LIMIT).map((f) => {
    const blocks = f.outsideMount
      ? 'in a snapshot, outside the mounted tree'
      : (f.missing ? 'deleted since the scrub' : `${f.badBlocks.length} bad 4K block(s)`)
    return `  ${f.path} — ${blocks}`
  })
  if (findings.length > NOTIFY_PATH_LIMIT)
    lines.push(`  …and ${findings.length - NOTIFY_PATH_LIMIT} more`)
  const counts = [
    `${result.errorsAttributed ?? 0} of ${result.errorsReported ?? 0} reported error(s) attributed`,
    ...(result.unattributed ? [`${result.unattributed} naming no file`] : []),
    ...(result.truncated ? [`only the first ${AHR_SCRUB_FINDINGS_CAP} files are listed`] : []),
  ].join(', ')
  return `${head}\n\nAffected files (${counts}):\n${lines.join('\n')}`
}

/**
 * Scrub an AHR pool: btrfs first, THEN each md array's check — never
 * concurrent. Progress is reported on every poll (never an unbounded silent
 * wait); scrub duration itself is unbounded by design (hours on real disks).
 */
export async function scrubAhrPool(
  executor: CommandExecutor,
  pool: AhrPool,
  updateProgress: (message: string) => void,
  opts?: AhrScrubOptions,
): Promise<AhrScrubResult> {
  const { name } = pool
  const interval = opts?.pollIntervalMs ?? AHR_SCRUB_POLL_MS
  if (!pool.mounted)
    throw new Error(`pool '${name}' is not mounted — btrfs scrub needs the filesystem online`)

  // --- Phase 1: btrfs scrub ---------------------------------------------------
  // Stamped BEFORE the scrub starts: the kernel journal read below is bounded to
  // THIS scrub's window, so an older scrub's errors are never re-reported as
  // this one's findings (selfheal.3).
  const startedAt = new Date()
  updateProgress('Starting btrfs scrub')
  await run(executor, BTRFS, ['scrub', 'start', pool.mountpoint])
  let btrfsErrors: string | null = null
  for (;;) {
    const st = parseBtrfsScrubStatus((await run(executor, BTRFS, ['scrub', 'status', pool.mountpoint])).stdout)
    if (st.status === 'running') {
      updateProgress(`btrfs scrub running${st.percent !== null ? ` (${st.percent.toFixed(1)}%)` : ''}`)
      await sleep(interval)
      continue
    }
    if (st.status === 'aborted')
      throw new Error(`btrfs scrub on '${name}' was aborted${isCleanSummary(st.errorSummary) ? '' : ` (${st.errorSummary})`}`)
    // finished — or no Status line at all (nothing to report): done either way.
    if (!isCleanSummary(st.errorSummary))
      btrfsErrors = st.errorSummary
    break
  }

  // --- Attribution: which files, which blocks (selfheal.3) -------------------
  let attribution: Pick<AhrScrubResult, 'findings' | 'errorsAttributed' | 'unattributed' | 'truncated'> = {}
  if (btrfsErrors !== null) {
    try {
      attribution = await attributeScrub(executor, pool, startedAt, updateProgress)
    }
    catch (err) {
      // Never fails the scrub: the count and the notification stand on their own.
      console.error(`ahr-scrub: could not attribute '${name}' scrub errors: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // --- Phase 2: md checks, one array at a time (sequenced, §4) ----------------
  // Band-ascending order without copying the pool's array list.
  const order = pool.arrays.map((_, i) => i)
  order.sort((x, y) => pool.arrays[x].band - pool.arrays[y].band)
  for (const i of order) {
    const array = pool.arrays[i]
    const label = `${name}-r${array.band}`
    updateProgress(`Starting md check on ${label}`)
    await run(executor, MDADM, ['--action=check', array.device])

    // /proc/mdstat keys arrays by transient kernel names (GT-2). Resolve the
    // CURRENT kernel name from the stable pin symlink (array.device is always
    // /dev/md/<pool>-r<band>) at point-of-use — NEVER trust array.kernelName
    // from the route-time topology read: the btrfs scrub above is unbounded
    // (hours), and md kernel numbers re-enumerate AND get reused across any
    // reassembly in that window, so a stale md127 could match a DIFFERENT
    // array in mdstat and make us wait on the wrong device (or none).
    const rp = await executor.exec(REALPATH, [array.device])
    const kernelName = rp.exitCode === 0 ? rp.stdout.trim().replace(DEV_PREFIX_RE, '') : null
    if (!kernelName) {
      updateProgress(`Cannot resolve ${array.device} to a kernel device — not waiting on its check`)
      continue
    }
    for (;;) {
      const md = parseMdstat((await run(executor, CAT, MDSTAT_CAT_ARGS)).stdout)
        .find(a => a.kernelName === kernelName)
      // Array gone from mdstat, or its check finished (and is not queued/parked
      // behind another sync): move to the next band. A `resync=PENDING` check
      // (syncPending, sync still null — e.g. an auto-read-only array parks its
      // check until first write, GT-9) is IN-FLIGHT, not finished: treating it
      // as done lets the next band's check start and the pending one later
      // fires concurrently, breaking the strictly-sequential guarantee (§4).
      if (!md || (md.sync?.action !== 'check' && !md.syncDelayed && !md.syncPending))
        break
      updateProgress(`md check on ${label}${md.sync ? ` (${md.sync.percent.toFixed(1)}%)` : ' (queued)'}`)
      await sleep(interval)
    }
  }

  // Validated at the daemon boundary before it leaves as a job result — the
  // shared schema is the contract, here as at every other boundary (Principle 6).
  const result = AhrScrubResultSchema.parse({
    scrubbed: name,
    btrfsErrors,
    checkedArrays: pool.arrays.length,
    ...(btrfsErrors !== null ? { errorsReported: countErrorSummary(btrfsErrors) } : {}),
    ...attribution,
  })

  // --- Findings: warn on errors, stay silent when clean (§7.3) ----------------
  // ONE notification, a richer body: the paths ride the warning the scrub always
  // sent, never a second message about the same event.
  if (btrfsErrors !== null)
    await pveNotify(executor, 'warning', 'AHR scrub found errors', findingsBody(pool, btrfsErrors, result))

  return result
}
