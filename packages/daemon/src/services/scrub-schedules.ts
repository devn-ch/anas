import type { AhrPool, LastScrub, PeriodicScrubState, ScrubCadence, ScrubRunning } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { readAhrPools } from './ahr-topology.js'
import { ForeignUnitError, readScrubSchedule, readScrubTimerNext, removeScrubUnits, SCRUB_SERVICE_NAME, SCRUB_TIMER_NAME, scrubUnitsAreForeign, writeScrubUnits } from './scrub-schedule-units.js'
// The ONE systemd unit dir constant (env-overridable for tests) — reused, not
// duplicated: the snapshot store owns it.
import { DEFAULT_SYSTEMD_DIR } from './snapshot-schedule-units.js'
import { readUnitFile } from './systemd-unit-store.js'

/**
 * Periodic SCRUB — uniform surface, filesystem-native backend (Epic 17.5 +
 * story selfheal.4, docs/SCHEDULES-DESIGN.md §Scrub). The operator sees one
 * "periodic scrub: on/off" control for a ZFS pool and an AHR pool; each flips
 * its own backend:
 *
 *   | fs  | read state            | mechanism                                   |
 *   |-----|-----------------------|---------------------------------------------|
 *   | ZFS | org.debian:periodic-scrub property (GT-2) | PVE's monthly cron, per-pool-gated |
 *   | AHR | anas-scrub.service marker + timer is-enabled | ANAS's node-level two-phase scrub timer |
 *
 * ZFS: the property gates PVE's 2nd-Sunday monthly cron. `-`/unset, `auto`,
 * `enable` all SCRUB (default = on); only `disable` turns it off. ANAS sets
 * `enable`/`disable` — a surgical property write, never a config/unit edit, and
 * never touches the (disabled) systemd `zfs-scrub-*@.timer` so no collision (GT-4).
 *
 * AHR (selfheal.4): the periodic AHR scrub is the WHOLE two-phase scrub —
 * phase 1 md parity per band, then phase 2 btrfs checksums + attribution — run
 * by ONE node-level `anas-scrub.timer` (services/scrub-schedule-units.ts) whose
 * embedded schedule lists the enabled pools. Enabling a pool adds it to that
 * list AND disables mdadm's mdcheck timers (ANAS owns md checks on the node —
 * never double-scheduled); disabling the last pool removes the units and leaves
 * mdcheck OFF (the operator asked for no scrubbing). The `cadence` is
 * node-level: monthly (1st Sunday 03:00) or quarterly.
 */

const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'
const SCRUB_PROPERTY = 'org.debian:periodic-scrub'
/** The mdadm timers ANAS takes over (`start` fires the check, `continue` resumes it). */
const MDCHECK_TIMERS = ['mdcheck_start.timer', 'mdcheck_continue.timer']
/** The one we READ mdcheck state from (`Also=` keeps them in lockstep). */
const MDCHECK_PRIMARY = 'mdcheck_start.timer'

// --- ZFS: org.debian:periodic-scrub property --------------------------------

/**
 * Interpret a `org.debian:periodic-scrub` property VALUE as scrub on/off. Only
 * `disable` turns the monthly cron off; unset (`-`), empty, `auto`, and `enable`
 * all scrub (the distro default is ON) — GT-2.
 */
export function parseZfsScrubEnabled(value: string): boolean {
  return value.trim() !== 'disable'
}

/** `zfs get -Hp -o value org.debian:periodic-scrub <pool>` argv. */
export function zfsScrubGetArgs(pool: string): string[] {
  return ['get', '-Hp', '-o', 'value', SCRUB_PROPERTY, pool]
}

/** `zfs set org.debian:periodic-scrub=<enable|disable> <pool>` argv. */
export function zfsScrubSetArgs(pool: string, enabled: boolean): string[] {
  return ['set', `${SCRUB_PROPERTY}=${enabled ? 'enable' : 'disable'}`, pool]
}

/**
 * Read a ZFS pool's periodic-scrub state (fail-open to enabled = the distro
 * default, so an unreadable property never falsely claims scrubbing is off).
 *
 * `lastScrub` is the pool's last COMPLETED pass and `running` the pass in
 * flight, both read by the caller from the `zpool status` it already runs (see
 * `parseScrubScans`) and passed in so one status read serves every pool. Null =
 * no completed pass on record / nothing running.
 */
export async function readZfsScrubState(
  executor: CommandExecutor,
  pool: string,
  lastScrub: LastScrub | null = null,
  running: ScrubRunning | null = null,
): Promise<PeriodicScrubState> {
  let enabled = true
  try {
    const r = await executor.exec(ZFS, zfsScrubGetArgs(pool))
    if (r.exitCode === 0)
      enabled = parseZfsScrubEnabled(r.stdout)
  }
  catch {
    // fail-open to the distro default (on)
  }
  return {
    target: { kind: 'zfs', pool },
    enabled,
    cadence: 'monthly',
    mechanism: 'zfs-property',
    lastScrub,
    ...(running && { running }),
  }
}

/** Flip a ZFS pool's periodic-scrub property (surgical `zfs set`). Throws on failure. */
export async function setZfsScrubEnabled(
  executor: CommandExecutor,
  pool: string,
  enabled: boolean,
): Promise<void> {
  const r = await executor.exec(ZFS, zfsScrubSetArgs(pool, enabled))
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `zfs set ${SCRUB_PROPERTY} on '${pool}' exited with code ${r.exitCode}`)
}

// --- AHR: the node-level anas-scrub timer (selfheal.4) ----------------------

/** `systemctl is-enabled` output → on/off (`enabled`/`enabled-runtime` = on). */
export function parseIsEnabled(isEnabledStdout: string): boolean {
  // `enabled`, `enabled-runtime` → on; `disabled`, `static`, `masked`, '' → off.
  return isEnabledStdout.trim().startsWith('enabled')
}

/** Interpret `systemctl is-enabled` output for the mdcheck timer as on/off. */
export function parseMdcheckEnabled(isEnabledStdout: string): boolean {
  return parseIsEnabled(isEnabledStdout)
}

/** `systemctl is-enabled <unit>` argv. */
export function isEnabledArgs(unit: string): string[] {
  return ['is-enabled', unit]
}

/** An md array's mismatch counter after a check: `/sys/block/<md>/md/mismatch_cnt`. */
export function mismatchCntArgs(kernelName: string): string[] {
  return [`/sys/block/${kernelName}/md/mismatch_cnt`]
}

/** Context the AHR state read + toggle need beyond the executor itself. */
export interface AhrScrubContext {
  /** The systemd unit directory the `anas-scrub` units live in. */
  dir: string
  /**
   * Kernel names (`md127`) of EVERY md array on the node (from /proc/mdstat)
   * and of the AHR bands — the difference is the arrays ANAS does not scrub,
   * which the state's `note` names rather than hides.
   */
  mdKernelNames?: string[]
  ahrKernelNames?: string[]
}

/** Build the toggle's argv for both mdcheck timers. */
export function mdcheckToggleArgs(enabled: boolean): string[] {
  return [enabled ? 'enable' : 'disable', '--now', ...MDCHECK_TIMERS]
}

async function isMdcheckEnabled(executor: CommandExecutor): Promise<boolean> {
  try {
    const r = await executor.exec(SYSTEMCTL, isEnabledArgs(MDCHECK_PRIMARY))
    // is-enabled exits nonzero for `disabled`/`static` but still prints the word.
    return parseMdcheckEnabled(r.stdout)
  }
  catch {
    return false
  }
}

async function isTimerEnabled(executor: CommandExecutor): Promise<boolean> {
  try {
    const r = await executor.exec(SYSTEMCTL, isEnabledArgs(SCRUB_TIMER_NAME))
    return parseIsEnabled(r.stdout)
  }
  catch {
    return false
  }
}

/** Legacy wording (review R8): mdcheck is the ONLY periodic check running. */
const MDCHECK_LEGACY_SENTENCE = 'mdcheck is the only periodic parity check running (the pre-0.4 '
  + 'mdcheck timer) — it is adopted onto the anas-scrub timer at daemon start'

/**
 * The honest `note` for an AHR state, from what the node actually shows:
 *   - mdcheck AND the ANAS timer both on ⇒ "double parity check — mdcheck is
 *     on": ANAS's phase 1 AND mdcheck would both run parity checks.
 *   - mdcheck on with the ANAS timer OFF ⇒ the LEGACY state (review R8): that
 *     is 0.3.1's mdcheck-based toggle, said as such — and named as what the
 *     daemon-start adoption picks up — never as a "double" about a second
 *     mechanism that is not actually running.
 *   - an md array that is no AHR band ⇒ "<mdN> is not an ANAS pool and is not
 *     scrubbed by ANAS" — never silently.
 * With none of those, the node-level mechanism is described in one sentence.
 */
export function ahrScrubNote(
  mdcheckOn: boolean,
  foreignArrays: string[],
  anasTimerOn = true,
): string {
  const parts: string[] = []
  if (mdcheckOn)
    parts.push(anasTimerOn ? 'double parity check — mdcheck is on' : MDCHECK_LEGACY_SENTENCE)
  for (const name of foreignArrays)
    parts.push(`${name} is not an ANAS pool and is not scrubbed by ANAS`)
  if (parts.length === 0)
    parts.push('one node-level timer scrubs the enabled AHR pools sequentially (phase 1 md parity, then phase 2 btrfs checksums)')
  return parts.join('; ')
}

/**
 * The md arrays in `/proc/mdstat` that are NOT one of the AHR bands — the ones
 * this node's scrub never covers. An unreadable mdstat yields none (fail-open:
 * the filter's absence costs the note, never a false claim).
 */
export function foreignMdArrays(
  mdKernelNames: string[] | undefined,
  ahrKernelNames: string[] | undefined,
): string[] {
  if (!mdKernelNames?.length)
    return []
  const ours = new Set(ahrKernelNames ?? [])
  return mdKernelNames.filter(name => !ours.has(name))
}

/**
 * Read an AHR pool's periodic-scrub state (selfheal.4). `enabled` is the pool
 * being IN the node timer's list AND the timer enabled — a pool left in a list
 * whose units were removed by other means is not reported as on.
 *
 * `lastScrub` is ALWAYS null, and that is the honest answer, not a gap: md
 * keeps no completion record of a check — no last-run timestamp, no verdict. We
 * neither mine journald for one nor keep a state file to manufacture one
 * (stateless — the system is the source of truth). The Scrubs screen says so in
 * words rather than leaving the cell blank.
 *
 * `running` — what md IS willing to tell us — is passed in from the topology
 * the caller already read (see {@link ahrScrubRunning}). The absence of a
 * completion record does not mean md is silent while a check runs.
 */
export async function readAhrScrubState(
  executor: CommandExecutor,
  pool: string,
  running: ScrubRunning | null = null,
  ctx?: AhrScrubContext,
): Promise<PeriodicScrubState> {
  const schedule = ctx ? await readScrubSchedule(ctx.dir) : null
  const [timerEnabled, mdcheckOn, nextRun] = await Promise.all([
    isTimerEnabled(executor),
    isMdcheckEnabled(executor),
    readScrubTimerNext(executor),
  ])
  const enabled = timerEnabled && (schedule?.pools.includes(pool) ?? false)
  const foreign = ctx ? foreignMdArrays(ctx.mdKernelNames, ctx.ahrKernelNames) : []
  return {
    target: { kind: 'ahr', pool },
    enabled,
    cadence: schedule?.cadence ?? 'monthly',
    mechanism: 'anas-scrub-timer',
    nextRun: enabled ? nextRun : null,
    phases: ['md-parity', 'btrfs-checksums'],
    note: ahrScrubNote(mdcheckOn, foreign, timerEnabled),
    lastScrub: null,
    ...(running && { running }),
  }
}

/**
 * Toggle an AHR pool's periodic scrub (selfheal.4) — a surgical edit of the
 * node timer's embedded schedule, with the units as the store:
 *
 *   enable  → add the pool to the list (units created if absent, timer enabled)
 *             AND disable the mdcheck timers — ANAS owns md checks on this node,
 *             never double-scheduled.
 *   disable → remove the pool from the list; units removed when the list
 *             empties; mdcheck stays OFF either way.
 *
 * `cadence` (optional, node-level) rewrites the one timer from any pool;
 * absent means keep the current one (default `monthly`). Throws on unit-write
 * failure so the mutation surfaces it. The mdcheck disable is best-effort —
 * with our timer already on, a failed mdcheck disable must still be surfaced
 * (journald line) rather than leave the job "failed" with BOTH mechanisms on.
 */
export async function setAhrScrubEnabled(
  executor: CommandExecutor,
  pool: string,
  enabled: boolean,
  opts?: { dir: string, cadence?: ScrubCadence },
): Promise<void> {
  const dir = opts?.dir ?? DEFAULT_SYSTEMD_DIR
  // A unit file without our marker is someone else's on ANAS's fixed name:
  // never rewritten on enable, and never DELETED on disable either (review
  // R10). The route surfaces this before the job even starts (409).
  if (await scrubUnitsAreForeign(dir))
    throw new ForeignUnitError(`an anas-scrub unit without an X-ANAS-Schedule marker exists in ${dir} — not an ANAS unit; nothing was changed`)
  const current = await readScrubSchedule(dir)
  const pools = current?.pools ?? []
  const cadence: ScrubCadence = opts?.cadence ?? current?.cadence ?? 'monthly'

  if (enabled) {
    const nextPools = pools.includes(pool) ? pools : [...pools, pool]
    await writeScrubUnits(executor, dir, { kind: 'ahr-scrub', cadence, pools: nextPools })
    try {
      const r = await executor.exec(SYSTEMCTL, mdcheckToggleArgs(false))
      if (r.exitCode !== 0)
        console.error(`scrub-schedules: could not disable the mdcheck timers: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
    }
    catch (err) {
      console.error(`scrub-schedules: could not disable the mdcheck timers: ${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }

  const nextPools = pools.filter(p => p !== pool)
  if (nextPools.length === 0)
    await removeScrubUnits(executor, dir)
  else
    await writeScrubUnits(executor, dir, { kind: 'ahr-scrub', cadence, pools: nextPools })
}

/**
 * The md check RUNNING RIGHT NOW on an AHR pool, derived from the band arrays'
 * sync state the topology read ALREADY parsed out of /proc/mdstat — no new
 * command, no new file read (stage 6). Null when no band is checking.
 *
 * md reports its progress per ARRAY; an AHR pool is a stack of band arrays, so
 * the pool-level figure has to say something honest about several of them:
 *   - `percent`   the LEAST-ADVANCED checking band — the pool's check is not
 *                 done until the last band is, so the lowest is the true floor.
 *   - `speed`     the sum across checking bands: they are distinct devices and
 *                 their throughputs genuinely add up.
 *   - `eta`       the longest of theirs, and still only a FLOOR — bands queued
 *                 behind these (our scrub job runs them strictly sequentially)
 *                 are not in the figure. The screen says so in its tooltip.
 * A band whose check is queued (`resync=PENDING`, no progress line) reports no
 * numbers at all; it contributes nothing rather than a made-up zero.
 */
export function ahrScrubRunning(pool: AhrPool): ScrubRunning | null {
  const checks = pool.arrays
    .map(a => a.sync)
    .filter((s): s is NonNullable<typeof s> => s?.action === 'check')
  if (checks.length === 0)
    return null
  const speeds = checks.map(s => s.speedBytesSec).filter(v => v > 0)
  const etas = checks.map(s => s.etaSeconds).filter(v => v > 0)
  return {
    percent: Math.min(...checks.map(s => s.percent)),
    ...(speeds.length > 0 && { speedBytesSec: speeds.reduce((sum, v) => sum + v, 0) }),
    ...(etas.length > 0 && { etaSeconds: Math.round(Math.max(...etas)) }),
  }
}

// --- Upgrade migration: adopt 0.3.1's mdcheck-based toggle (review R8) -------

/**
 * Why the adoption did not run, when it did not. `mdcheck-not-enabled` and
 * `no-ahr-pools` are the everyday answers on nodes that never used 0.3.1's
 * toggle; `anas-scrub-units-present` is the already-migrated (or
 * deliberately-off) node; `foreign-unit` means ANAS's fixed names are taken by
 * a unit that is not ours — never touched.
 */
export type MdcheckAdoptionReason
  = | 'adopted'
    | 'anas-scrub-units-present'
    | 'mdcheck-not-enabled'
    | 'no-ahr-pools'
    | 'foreign-unit'

export interface MdcheckAdoptionReport {
  adopted: boolean
  reason: MdcheckAdoptionReason
  /** The pools moved onto the timer (empty unless `reason: 'adopted'`). */
  pools: string[]
}

export interface MdcheckAdoptionOptions {
  /** The systemd unit dir the `anas-scrub` units live in (default the real one). */
  dir?: string
  /**
   * AHR pool names. Default: read live from the topology (`readAhrPools`,
   * fail-open to []). Tests inject.
   */
  pools?: string[]
  /** Log sink (default console.error — journald via the daemon unit). */
  log?: (line: string) => void
}

/**
 * ONE-TIME upgrade migration from 0.3.1 (review R8). In 0.3.1 the periodic-scrub
 * toggle flipped mdadm's mdcheck timers; selfheal.4 replaced that with the
 * `anas-scrub` timer and only disabled mdcheck INSIDE the toggle. An upgraded
 * node whose operator had the toggle ON therefore reads every pool as OFF while
 * mdcheck keeps firing — no parity check at all after an uninstall of the old
 * units, a "double" warning about nothing. This adoption closes that gap at
 * daemon start, when — and only when — the legacy state is unambiguous:
 *
 *   no `anas-scrub` units exist  (the adoption's own output is the no-op's
 *                                 absence check — one-time by construction)
 *   AND the mdcheck timers ARE enabled   (the operator's 0.3.1 toggle was ON)
 *   AND there is at least one AHR pool   (nothing to adopt otherwise)
 *
 * then: ALL AHR pools move onto the `anas-scrub` timer at the `monthly`
 * default, mdcheck is disabled (ANAS owns md checks — exactly what enabling
 * the toggle does today), and ONE journald audit line says so. Non-blocking,
 * fail-soft: every branch is a logged reason, never a daemon failure.
 *
 * Known edge, accepted by the ruling: an operator who deliberately disabled
 * the ANAS scrub AND re-armed mdcheck by hand has re-created the legacy state,
 * and a daemon restart re-adopts. The audit line says what happened, and the
 * Scrubs toggle undoes it in one click.
 */
export async function adoptMdcheckScrub(
  executor: CommandExecutor,
  opts: MdcheckAdoptionOptions = {},
): Promise<MdcheckAdoptionReport> {
  const dir = opts.dir ?? DEFAULT_SYSTEMD_DIR
  const log = opts.log ?? ((line: string) => console.error(line))
  const say = (reason: MdcheckAdoptionReason, pools: string[] = []): MdcheckAdoptionReport => {
    log(`scrub-schedules: mdcheck adoption skipped (${reason})`)
    return { adopted: false, reason, pools }
  }

  // 1. Units already there — migrated, or deliberately off. Never re-adopt.
  //    A foreign file on ANAS's fixed name is its own answer (never touched,
  //    the foreign case is a 409 at the toggle), checked before the plain
  //    units-present so the two are told apart.
  if (await scrubUnitsAreForeign(dir))
    return say('foreign-unit')
  const serviceContent = await readUnitFile(dir, SCRUB_SERVICE_NAME)
  if (serviceContent !== null)
    return say('anas-scrub-units-present')

  // 2. The legacy toggle must actually have been ON (mdcheck timers enabled).
  if (!await isMdcheckEnabled(executor))
    return say('mdcheck-not-enabled')

  // 3. At least one AHR pool to adopt.
  const pools = opts.pools ?? await readAhrPools(executor)
    .then(pools => pools.map(p => p.name))
    .catch(() => [])
  if (pools.length === 0)
    return say('no-ahr-pools')

  // 4. Adopt: the units with every AHR pool at the monthly default, mdcheck
  //    off (best-effort, surfaced), one audit line.
  try {
    await writeScrubUnits(executor, dir, { kind: 'ahr-scrub', cadence: 'monthly', pools })
  }
  catch (err) {
    log(`scrub-schedules: mdcheck adoption failed to write the anas-scrub units: ${err instanceof Error ? err.message : String(err)}`)
    return { adopted: false, reason: 'foreign-unit', pools }
  }
  try {
    const r = await executor.exec(SYSTEMCTL, mdcheckToggleArgs(false))
    if (r.exitCode !== 0)
      log(`scrub-schedules: mdcheck adoption could not disable the mdcheck timers: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
  }
  catch (err) {
    log(`scrub-schedules: mdcheck adoption could not disable the mdcheck timers: ${err instanceof Error ? err.message : String(err)}`)
  }
  log(`scrub-schedules: ADOPTED the legacy mdcheck periodic scrub — AHR pool(s) ${pools.join(', ')} moved onto the anas-scrub timer (monthly), the mdcheck timers are now off (upgrade migration, review R8)`)
  return { adopted: true, reason: 'adopted', pools }
}
