import type { AhrScrubSchedule, ScrubCadence } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AhrScrubSchedule as AhrScrubScheduleSchema } from '@anas/shared'
import { parseSystemdTimestamp } from './systemd-status.js'

/**
 * The node-level AHR periodic-scrub UNITS (story selfheal.4) — the
 * snapshot-schedule unit pattern applied to the whole two-phase scrub: ONE
 * `anas-scrub.service` + `anas-scrub.timer` pair per NODE (not per pool). The
 * unit files ARE the store: the canonical AhrScrubSchedule JSON
 * (`{ kind: 'ahr-scrub', cadence, pools: [...] }`) is embedded as an
 * `X-ANAS-Schedule=` comment — the SINGLE source of truth parsed back, never
 * reverse-engineered from ExecStart. There is no second config file and no
 * custom scheduler (the standing scheduling ruling).
 *
 * The .service fires the compiled runner beside dist/snapshot-task.js
 * (dist/scrub-task.js), which POSTs `/ahr/<pool>/scrub` for each pool in the
 * list IN SEQUENCE — AHR pools on one node share spindles, so pools never scrub
 * concurrently. `Persistent=true` catches a fire missed across a reboot.
 *
 * Per-pool toggles rewrite this one pair (add/remove the pool from the list);
 * the cadence is node-level, so setting it from any pool rewrites the one
 * timer. When the pool list empties, both units are removed. A unit file
 * without our marker is never overwritten — parse-or-skip, fail-open, exactly
 * like the snapshot store.
 */

const SYSTEMCTL = '/usr/bin/systemctl'
/** The timer executes this compiled runner (ships in dist — see scrub-task.ts). */
const RUNNER_NODE = '/usr/bin/node'
const RUNNER_SCRIPT = '/opt/anas/packages/daemon/dist/scrub-task.js'

export const SCRUB_SERVICE_NAME = 'anas-scrub.service'
export const SCRUB_TIMER_NAME = 'anas-scrub.timer'

/** The service-file line that carries the canonical schedule JSON (as a comment). */
const SCHEDULE_MARKER = 'X-ANAS-Schedule='
/** Matches the X-ANAS-Schedule line (with or without a leading `# `), capturing JSON. */
const SCHEDULE_MARKER_RE = /^#?\s*X-ANAS-Schedule=(.*)$/

// --- Cadence → OnCalendar ----------------------------------------------------

/**
 * Both calendars fire the first Sunday of the window at 03:00:
 *   monthly   — 1st Sunday of every month (matches PVE's ZFS cron and mdcheck's
 *               old 1st-Sunday timer).
 *   quarterly — 1st Sunday of Jan/Apr/Jul/Oct.
 * Range days 01..07 with `Sun` are the systemd idiom for "first <weekday>".
 */
const SCRUB_CADENCE_ONCALENDAR: Record<ScrubCadence, string> = {
  monthly: 'Sun *-*-01..07 03:00:00',
  quarterly: 'Sun *-01,04,07,10-01..07 03:00:00',
}

export function scrubCadenceToOnCalendar(cadence: ScrubCadence): string {
  return SCRUB_CADENCE_ONCALENDAR[cadence]
}

// --- Unit rendering ----------------------------------------------------------

/**
 * Render the `.service` unit. The `X-ANAS-Schedule=` comment embeds the
 * canonical schedule JSON (single line) — the ONLY thing the parser reads back.
 * ExecStart fires the runner with the pool list as argv; it is for systemd to
 * actually run and is never parsed by us.
 */
export function renderScrubServiceUnit(schedule: AhrScrubSchedule): string {
  const execStart = [RUNNER_NODE, RUNNER_SCRIPT, ...schedule.pools].join(' ')
  return [
    '[Unit]',
    `Description=ANAS periodic AHR scrub (${schedule.cadence}) — md parity, then btrfs checksums`,
    `# ${SCHEDULE_MARKER}${JSON.stringify(schedule)}`,
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${execStart}`,
    '',
  ].join('\n')
}

/** Render the `.timer` unit for the node's scrub cadence. */
export function renderScrubTimerUnit(schedule: AhrScrubSchedule): string {
  return [
    '[Unit]',
    'Description=ANAS periodic AHR scrub timer',
    '',
    '[Timer]',
    `OnCalendar=${scrubCadenceToOnCalendar(schedule.cadence)}`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n')
}

/**
 * Parse the canonical AhrScrubSchedule out of the `.service` unit's body via
 * its `X-ANAS-Schedule=` line (with or without the leading `# `), zod-validated.
 * Returns null when the marker is absent or the JSON is invalid — a unit we did
 * not write is never adopted (and never overwritten by a toggle).
 */
export function parseScrubServiceUnit(content: string): AhrScrubSchedule | null {
  for (const line of content.split('\n')) {
    const m = line.match(SCHEDULE_MARKER_RE)
    if (!m)
      continue
    try {
      const parsed = AhrScrubScheduleSchema.safeParse(JSON.parse(m[1]))
      return parsed.success ? parsed.data : null
    }
    catch {
      return null
    }
  }
  return null
}

// --- Store: read ------------------------------------------------------------

/**
 * The node's scrub schedule, parsed from the unit files. Null when the units
 * are absent (no pool enabled yet) or carry no valid marker (not ours).
 */
export async function readScrubSchedule(dir: string): Promise<AhrScrubSchedule | null> {
  try {
    return parseScrubServiceUnit(await readFile(join(dir, SCRUB_SERVICE_NAME), 'utf-8'))
  }
  catch {
    return null
  }
}

/**
 * The timer's next elapse, parsed to ISO — or null when the unit is absent,
 * disabled, or unreadable. Fail-open: one broken read costs the date on the
 * screen, never the row.
 */
export async function readScrubTimerNext(executor: CommandExecutor): Promise<string | null> {
  try {
    const r = await executor.exec(SYSTEMCTL, ['show', SCRUB_TIMER_NAME, '-p', 'NextElapseUSecRealtime'])
    if (r.exitCode !== 0 && !r.stdout.trim())
      return null
    const raw = r.stdout.split('=').slice(1).join('=').trim()
    return raw ? parseSystemdTimestamp(raw) : null
  }
  catch {
    return null
  }
}

// --- Store: write + remove --------------------------------------------------

/**
 * Write (or rewrite) the node's service+timer pair — ALWAYS with the marker —
 * reload systemd, and enable the timer. Throws on any systemctl failure so the
 * mutation surfaces it.
 */
export async function writeScrubUnits(
  executor: CommandExecutor,
  dir: string,
  schedule: AhrScrubSchedule,
): Promise<void> {
  await writeFile(join(dir, SCRUB_SERVICE_NAME), renderScrubServiceUnit(schedule), 'utf-8')
  await writeFile(join(dir, SCRUB_TIMER_NAME), renderScrubTimerUnit(schedule), 'utf-8')
  await runSystemctl(executor, ['daemon-reload'])
  await runSystemctl(executor, ['enable', '--now', SCRUB_TIMER_NAME])
}

/**
 * Remove the node's scrub units: stop+disable the timer, delete both files,
 * reload systemd. Used when the pool list empties — the operator asked for no
 * scrubbing, so nothing is left firing.
 */
export async function removeScrubUnits(executor: CommandExecutor, dir: string): Promise<void> {
  // Best-effort disable first (ignore failure — the unit may already be gone).
  await executor.exec(SYSTEMCTL, ['disable', '--now', SCRUB_TIMER_NAME])
  await Promise.all([unlinkQuiet(join(dir, SCRUB_SERVICE_NAME)), unlinkQuiet(join(dir, SCRUB_TIMER_NAME))])
  await runSystemctl(executor, ['daemon-reload'])
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path)
  }
  catch {
    // Missing file is fine — the goal state (absent) already holds.
  }
}

async function runSystemctl(executor: CommandExecutor, args: string[]): Promise<void> {
  const r = await executor.exec(SYSTEMCTL, args)
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `systemctl ${args.join(' ')} exited with code ${r.exitCode}`)
}
