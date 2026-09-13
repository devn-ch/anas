import type { AhrPool, AhrRepairBlockOutcome, AhrRepairFile, AhrRepairFileOutcome, AhrRepairResult } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { SelfhealRepairOptions } from './selfheal-repair.js'
import { AhrRepairResult as AhrRepairResultSchema } from '@anas/shared'
import { pveNotify } from './pve-notify.js'
import { repairBlock } from './selfheal-repair.js'

/**
 * The Repair-from-parity JOB (story selfheal.6) — the operator-triggered half
 * of the self-heal epic.
 *
 * The engine (`selfheal-repair.ts`) repairs ONE 4 KiB block. This is the job
 * around it: the files and blocks an operator picked out of a scrub's findings,
 * run strictly one at a time, with every verdict landing in one of four honest
 * counts (repaired / unrepairable / above md / not corrupt at the mapped
 * location — review R9) and one PVE notification at the end.
 *
 * Two boundaries from the epic hold here and are not negotiable:
 *   - repair is NEVER automatic — this service only ever runs from the
 *     confirm-gated route, on a named file, with named blocks;
 *   - repair is NEVER a read-path heal — nothing in ANAS repairs a block
 *     because someone read it.
 *
 * **Strictly sequential.** Two repairs at once would fight over the same md
 * knobs (`rmw_level`, `sync_min`/`sync_max`, `stripe_cache_size`) and over the
 * bounded check each one needs to finish before the next begins. The engine
 * saves and restores those knobs around its own run, which is only sound while
 * exactly one run is in flight.
 *
 * **A thrown block is `unrepairable`, never a failed job.** The engine returns
 * all four verdicts and throws only on an internal failure. If block 3 of 50
 * dies on a btrfs lookup, the other 49 still deserve their attempt — the error
 * text becomes that block's reason and the job carries on. The job fails only
 * if something outside the per-block loop does.
 */

/** The engine call this job makes — injectable so a test can fake the verdicts. */
export type RepairBlockFn = typeof repairBlock

export interface AhrRepairOptions {
  /** The repair engine. Defaults to the real one; tests hand in a fake. */
  repair?: RepairBlockFn
  /** Passed straight through to the engine (tests point its runtime dir at a temp path). */
  repairOptions?: SelfhealRepairOptions
}

/** Files listed in the notification body before it says "…and N more". */
const NOTIFY_FILE_LIMIT = 20

/** Above-md wording — an implication, never a certainty (GT-5/GT-6). */
const ABOVE_MD_SENTENCE = 'parity already agreed with the bad data — this implicates something '
  + 'other than the disks (memory, controller, software)'

/** Unrepairable wording — there is one action left, and it is not another repair. */
const UNREPAIRABLE_SENTENCE = 'restore this file from backup'

/**
 * Mapping-abort wording (selfheal.7 live proof, F2; its own count since
 * review R9 — no longer folded into `unrepairable`).
 *
 * A `mapping-abort` means the OPPOSITE of `unrepairable`. The bytes at the
 * computed member location still pass the checksum btrfs stored for them, so
 * there is nothing wrong with the block and nothing was written. Telling the
 * operator to restore that file from backup is advice to overwrite good data,
 * so it gets its own count and its own sentence.
 */
const MAPPING_ABORT_SENTENCE = 'Blocks reported "not corrupt here" were left alone: the bytes on '
  + 'the member still pass their stored checksum, so there was nothing to reconstruct — either '
  + 'the block was already repaired or the finding no longer describes it. Nothing was written, '
  + 'and they need no restore.'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One file's line in the notification body: what happened to its blocks. */
function fileLine(file: AhrRepairFileOutcome): string {
  const counts = new Map<string, number>()
  for (const b of file.blocks)
    counts.set(b.outcome, (counts.get(b.outcome) ?? 0) + 1)
  const parts: string[] = []
  for (const [outcome, n] of counts)
    parts.push(`${n} ${outcome}`)
  return `  ${file.path} — ${parts.join(', ')}`
}

/**
 * The notification body: the counts, then the files, then — only when they
 * apply — the two sentences that say what the operator does next.
 */
function repairBody(pool: string, result: AhrRepairResult): string {
  const head = `Repair from parity on AHR pool '${pool}': `
    + `${result.repaired} repaired, ${result.unrepairable} unrepairable, `
    + `${result.aboveMd} above md, ${result.mappingAbort} not corrupt at the mapped location, `
    + `of ${result.blocks} block(s) in ${result.files.length} file(s).`
  const lines = result.files.slice(0, NOTIFY_FILE_LIMIT).map(fileLine)
  if (result.files.length > NOTIFY_FILE_LIMIT)
    lines.push(`  …and ${result.files.length - NOTIFY_FILE_LIMIT} more`)
  const tail: string[] = []
  // Each bucket reads ITS OWN count (review R9) — "restore from backup" rides
  // only the true `unrepairable`, never the mapping-aborts that mean the block
  // was fine all along.
  if (result.unrepairable > 0)
    tail.push(`Unrepairable blocks have no source of truth left below the checksum tree — ${UNREPAIRABLE_SENTENCE}.`)
  if (result.mappingAbort > 0)
    tail.push(MAPPING_ABORT_SENTENCE)
  if (result.aboveMd > 0)
    tail.push(`Blocks diagnosed above md were not written: ${ABOVE_MD_SENTENCE}.`)
  return [`${head}\n\nFiles:\n${lines.join('\n')}`, ...tail].join('\n\n')
}

/**
 * Repair the named blocks of the named files on one AHR pool.
 *
 * Returns the three-bucket result, validated against the shared schema before
 * it leaves (Principle 6), and emits exactly ONE PVE notification: `warning`
 * when anything came back unrepairable or above md, `info` when every block
 * was repaired.
 */
export async function repairAhrFiles(
  executor: CommandExecutor,
  pool: AhrPool,
  files: AhrRepairFile[],
  updateProgress: (message: string) => void,
  options?: AhrRepairOptions,
): Promise<AhrRepairResult> {
  const repair = options?.repair ?? repairBlock
  const total = files.reduce((n, f) => n + f.blocks.length, 0)
  const outcomes: AhrRepairFileOutcome[] = []
  let repaired = 0
  let unrepairable = 0
  let aboveMd = 0
  let mappingAbort = 0
  let done = 0

  for (const file of files) {
    const blocks: AhrRepairBlockOutcome[] = []
    for (const block of file.blocks) {
      done += 1
      updateProgress(`Repairing ${file.path} block ${block} (${done}/${total})`)
      let entry: AhrRepairBlockOutcome
      try {
        const outcome = await repair(
          executor,
          { mountpoint: pool.mountpoint, file: file.path, block, pool },
          options?.repairOptions,
        )
        entry = { block, outcome: outcome.outcome, reason: outcome.reason }
      }
      catch (error) {
        // The engine threw rather than reaching a verdict. That block cannot be
        // proven repaired, so it is unrepairable — with the error as its reason,
        // and the remaining blocks still get their attempt.
        entry = { block, outcome: 'unrepairable', reason: errorText(error) }
      }
      // `mapping-abort` counts AS ITSELF (review R9) — it is not a repair, but
      // it is the opposite of `unrepairable`: the block was not corrupt at the
      // mapped location, nothing was written, nothing to restore. The
      // per-block entry keeps the outcome and its own reason either way.
      if (entry.outcome === 'repaired')
        repaired += 1
      else if (entry.outcome === 'above-md')
        aboveMd += 1
      else if (entry.outcome === 'mapping-abort')
        mappingAbort += 1
      else
        unrepairable += 1
      updateProgress(`${file.path} block ${block}: ${entry.outcome}`)
      blocks.push(entry)
    }
    outcomes.push({ path: file.path, blocks })
  }

  const result = AhrRepairResultSchema.parse({
    pool: pool.name,
    files: outcomes,
    repaired,
    unrepairable,
    aboveMd,
    mappingAbort,
    blocks: total,
  })

  // ONE notification, whatever the outcome — the operator asked for this and is
  // owed the answer even when the browser has moved on (a repair outruns the
  // UI's job-poll budget exactly as a scrub does). A mapping-abort block was
  // left exactly as it was — still not a repair, so the notification stays a
  // warning when any block ended unrepaired.
  const clean = unrepairable === 0 && aboveMd === 0 && mappingAbort === 0
  await pveNotify(
    executor,
    clean ? 'info' : 'warning',
    clean ? 'AHR repair from parity completed' : 'AHR repair from parity left blocks unrepaired',
    repairBody(pool.name, result),
  )

  return result
}
