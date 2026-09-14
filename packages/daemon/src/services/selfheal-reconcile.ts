import type { AhrPool } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { AhrSnapshotOptions } from './ahr-snapshots.js'
import { readAhrPools } from './ahr-topology.js'
import {
  kernelName,
  MD_DEFAULT_RMW_LEVEL,
  MD_DEFAULT_STRIPE_CACHE_SIZE,
  MD_DEFAULT_SYNC_MAX,
  MD_DEFAULT_SYNC_MIN,
  mdSysPath,
  readMdAttrOrNull,
  writeMdAttr,
} from './selfheal-io.js'
import { sweepSelfhealPins } from './selfheal-repair.js'
import { isIdleSyncAction } from './selfheal-syncop.js'

/**
 * Daemon-start reconciliation for the self-heal engine (design review
 * 2026-09-14, D4).
 *
 * ## What goes wrong without it
 *
 * The repair engine turns four md knobs aside for the duration of ONE 4 KiB
 * block — `sync_min`/`sync_max` down to a single stripe, `rmw_level` to 0,
 * `stripe_cache_size` to its 17-slot floor — and puts every one of them back in
 * a `finally`. A `finally` does not run for SIGKILL, for the OOM killer, or for
 * a package upgrade restarting anasd mid-sequence. The knobs then persist for
 * the LIFE OF THE ASSEMBLY, and none of it is visible:
 *
 *  - `sync_max` bounded to one stripe is GT-13's trap. The next monthly parity
 *    check covers that one stripe, suspends there, and the scrub's finish-wait
 *    then holds the pool's job exclusion for seven days. A whole band goes
 *    unchecked and the pool reports a scrub that "ran".
 *  - `rmw_level=0` makes every ordinary write to that array a
 *    reconstruct-write — correct, and much slower.
 *  - `stripe_cache_size=17` is the eviction floor, not a working size.
 *  - the transient `anas-selfheal-<ts>` snapshot pins an extent for ever.
 *
 * ## Why this is not shadow state (Principle 11)
 *
 * Nothing is remembered between runs and nothing is asserted about what ANAS
 * "owns". Every value is READ off the running kernel and compared with the
 * value md itself ships (GT-1: `rmw_level=1`, `sync_min=0`, `sync_max=max`,
 * `stripe_cache_size=256`); the snapshot sweep matches ANAS's own transient
 * prefix and destroys nothing else. Reading the system and putting a known
 * default back is the opposite of a shadow database.
 *
 * ## What it will not touch
 *
 * A band md is mid-operation on keeps its `sync_min`/`sync_max` exactly as they
 * are and is REPORTED instead (D2 is the same rule from the other direction: a
 * recovery onto a spare is not ours to widen or interrupt). `rmw_level` and
 * `stripe_cache_size` are safe to set under a running op — they change how md
 * writes, never what it is doing — so those are restored regardless.
 */

/** What one reconciliation pass did, one sentence per line, for journald. */
export interface SelfhealReconcileReport {
  /** Knobs put back, one line per band. */
  restored: string[]
  /** Transient snapshots destroyed. */
  snapshots: string[]
  /** Bands left alone because md was running something. */
  skipped: string[]
  /** Anything that could not be read or written — never fatal. */
  errors: string[]
}

export interface SelfhealReconcileOptions {
  /** Pools to walk. Default: the node's, read live. */
  pools?: AhrPool[]
  /** Passed to the snapshot service (tests point its runtime dir at a temp path). */
  ahrSnapshotOptions?: AhrSnapshotOptions
  /**
   * Is a self-heal job IN FLIGHT on this pool right now (sixth pass, N9)?
   *
   * The reconciliation runs from `index.ts` AFTER the socket is listening, and
   * the boot scan it chains off can take minutes on a real node. An operator
   * who hits Repair or Rewrite parity in that window gets a job whose transient
   * snapshot this sweep would destroy and whose `sync_min`/`sync_max` this
   * walk would widen out from under it — the engine's OWN knobs, read as a
   * killed run's leftovers because they look exactly alike.
   *
   * The daemon wires the job queue's `findActive` for `ahr.repair`,
   * `ahr.parity-rewrite` and `ahr.scrub`. Absent (the direct/test call), every
   * pool is reconciled — the queue is in memory, so on a genuine cold start
   * there is nothing in flight to protect and the answer would be "no" anyway.
   */
  activeJob?: (pool: string) => { operation: string, id: string } | null | undefined
}

/** True when the report has nothing worth a journald line. */
export function reconcileWasQuiet(report: SelfhealReconcileReport): boolean {
  return report.restored.length === 0
    && report.snapshots.length === 0
    && report.skipped.length === 0
    && report.errors.length === 0
}

/**
 * Walk every AHR band, put back any self-heal knob a killed repair left turned
 * aside, and sweep the engine's transient snapshots. Never throws — a
 * reconciliation that cannot read one band still fixes the others.
 */
export async function reconcileSelfhealState(
  executor: CommandExecutor,
  options?: SelfhealReconcileOptions,
): Promise<SelfhealReconcileReport> {
  const report: SelfhealReconcileReport = { restored: [], snapshots: [], skipped: [], errors: [] }

  let pools: AhrPool[]
  try {
    pools = options?.pools ?? await readAhrPools(executor)
  }
  catch (error) {
    report.errors.push(`AHR pools could not be read: ${errorText(error)}`)
    return report
  }

  for (const pool of pools) {
    // A pool with a self-heal job in flight is left ENTIRELY alone — knobs and
    // snapshots both (N9). The ordering is unchanged: reconcile still runs
    // after the boot scan, it just refuses to reconcile over a live run.
    const active = options?.activeJob?.(pool.name)
    if (active) {
      report.skipped.push(
        `${pool.name}: not reconciled — ${active.operation} job ${active.id} is in flight on this pool, and its md knobs and transient snapshot are in USE, not leftovers`,
      )
      continue
    }
    for (const array of pool.arrays) {
      const label = `${pool.name}-r${array.band}`
      try {
        await reconcileBand(executor, label, array.device, report)
      }
      catch (error) {
        report.errors.push(`${label}: ${errorText(error)}`)
      }
    }
    try {
      const sweep = await sweepSelfhealPins(executor, pool, pool.mountpoint, options?.ahrSnapshotOptions)
      report.snapshots.push(...sweep.swept)
      report.errors.push(...sweep.errors)
    }
    catch (error) {
      report.errors.push(`${pool.name}: transient self-heal snapshots could not be swept: ${errorText(error)}`)
    }
  }
  return report
}

/** One band's four knobs, read and put back where they are not md's own. */
async function reconcileBand(
  executor: CommandExecutor,
  label: string,
  device: string,
  report: SelfhealReconcileReport,
): Promise<void> {
  const sys = mdSysPath(await kernelName(executor, device))
  if ((await readMdAttrOrNull(sys, 'level')) === null)
    return // not assembled — the boot scan's problem, not this one's

  const action = await readMdAttrOrNull(sys, 'sync_action')
  const syncMin = await readMdAttrOrNull(sys, 'sync_min')
  const syncMax = await readMdAttrOrNull(sys, 'sync_max')

  const windowNarrowed = (syncMax !== null && syncMax !== MD_DEFAULT_SYNC_MAX)
    || (syncMin !== null && syncMin !== MD_DEFAULT_SYNC_MIN)
  if (windowNarrowed) {
    if (!isIdleSyncAction(action)) {
      // Widening `sync_max` under a running recovery resumes and then re-bounds
      // an operation that is not ours. Say what was found; the next pass, or
      // the scrub's own pre-issue check, puts it back once md is done.
      report.skipped.push(
        `${label}: sync_min=${syncMin ?? 'unreadable'} sync_max=${syncMax ?? 'unreadable'} left as they are — md is running ${action ?? 'an operation whose sync_action could not be read'}`,
      )
    }
    else {
      await writeMdAttr(sys, 'sync_min', MD_DEFAULT_SYNC_MIN)
      await writeMdAttr(sys, 'sync_max', MD_DEFAULT_SYNC_MAX)
      report.restored.push(
        `${label}: sync window restored to ${MD_DEFAULT_SYNC_MIN}..${MD_DEFAULT_SYNC_MAX} (was ${syncMin ?? '?'}..${syncMax ?? '?'} — a repair left it bounded to one stripe, which would have made the next parity check cover that stripe alone)`,
      )
    }
  }

  const rmw = await readMdAttrOrNull(sys, 'rmw_level')
  if (rmw !== null && rmw !== MD_DEFAULT_RMW_LEVEL) {
    await writeMdAttr(sys, 'rmw_level', MD_DEFAULT_RMW_LEVEL)
    report.restored.push(`${label}: rmw_level restored to ${MD_DEFAULT_RMW_LEVEL} (was ${rmw})`)
  }

  const cache = await readMdAttrOrNull(sys, 'stripe_cache_size')
  const cacheSize = cache === null ? null : Number(cache)
  if (cacheSize !== null && Number.isFinite(cacheSize) && cacheSize < MD_DEFAULT_STRIPE_CACHE_SIZE) {
    await writeMdAttr(sys, 'stripe_cache_size', String(MD_DEFAULT_STRIPE_CACHE_SIZE))
    report.restored.push(`${label}: stripe_cache_size restored to ${MD_DEFAULT_STRIPE_CACHE_SIZE} (was ${cache})`)
  }
}

/** An error's message, without a stack, for a line an operator reads. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
