import type { AhrArray, AhrPool, AhrRepairBlockOutcome, AhrRepairFile, AhrRepairFileOutcome, AhrRepairResult, AhrScrubParityMismatch, IscsiHeldByLun } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { SelfhealRepairOptions } from './selfheal-repair.js'
import { AhrRepairResult as AhrRepairResultSchema, SELFHEAL_CSUM_UNREADABLE } from '@anas/shared'
import { heldByLunOnce } from './iscsi-held.js'
import { pveNotify } from './pve-notify.js'
import { repairBlock } from './selfheal-repair.js'

/**
 * The Repair-from-parity JOB (story selfheal.6) — the operator-triggered half
 * of the self-heal epic.
 *
 * The engine (`selfheal-repair.ts`) repairs ONE 4 KiB block. This is the job
 * around it: the files and blocks an operator picked out of a scrub's findings,
 * run strictly one at a time, with every verdict landing in one of FIVE honest
 * counts (repaired / unrepairable / above md / not corrupt at the mapped
 * location — review R9 — / not examined at all — seventh pass, F3) and one PVE
 * notification at the end.
 *
 * It also carries out one fact the engine discovers and nothing else could: a
 * block that was repaired and PROVEN while its band still counts mismatching
 * stripes leaves a parity residual (F2), reported in the same row shape a
 * scrub's `parityMismatches` uses so Rewrite parity can act on it without
 * waiting hours for a fresh two-phase scrub.
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
  /**
   * Does an iSCSI LUN back this file (design review 2026-09-14, D10)? Defaults
   * to the ONE claims helper (`heldByLunOnce`, the same configfs read every
   * other gate uses) with the file as the subject — a claim whose backing
   * path IS the file means the block under repair is a LUN image. Fail-open:
   * an unreadable configfs answers "not a LUN" and the ordinary restore
   * advice stands. Tests hand in a fake; a caller may inject the lookup to
   * share one claims read across a whole request.
   */
  lunHeld?: (path: string) => Promise<IscsiHeldByLun | null>
}

/** Files listed in the notification body before it says "…and N more". */
const NOTIFY_FILE_LIMIT = 20

/** Above-md wording — an implication, never a certainty (GT-5/GT-6). */
const ABOVE_MD_SENTENCE = 'parity already agreed with the bad data — this implicates something '
  + 'other than the disks (memory, controller, software)'

/**
 * Unrepairable wording (design review 2026-09-14, D10) — there is one action
 * left, and WHICH one depends on what the file is:
 *
 *  - the ordinary case: a file restore;
 *  - an iSCSI LUN image: restoring "the file" in place is a LUN restore — a
 *    different verb, refused while a session is live — so the advice names
 *    the LUN and the two honest sources for it;
 *  - a `csum-unreadable` block (the D3 code): there was nothing to arbitrate
 *    against YET — the metadata holding the checksum is itself damaged, and
 *    metadata is DUP, so a btrfs scrub repairs its copies. Restore advice
 *    here would overwrite data whose corruption was never confirmed.
 */
const RESTORE_FILE_SENTENCE = 'restore this file from backup'
const CSUM_UNREADABLE_SENTENCE = 'the file\'s checksum could not be read reliably; '
  + 're-scrub after the metadata is repaired — a btrfs scrub repairs metadata copies'

function lunRestoreSentence(held: IscsiHeldByLun): string {
  return `this block backs iSCSI LUN ${held.targetIqn}/${held.index} — restore the LUN image `
    + `from a PBS backup (Backup → Restore as new LUN) or the guest's own backup`
}

/**
 * A csum-unreadable block that is ALSO a LUN image (sixth pass, N5).
 *
 * The two facts are not the same kind of fact. "This is a LUN" says which
 * restore verb would apply; "the checksum could not be read" says a restore is
 * the WRONG ACTION — nothing has confirmed the block is corrupt, and restoring
 * would overwrite data on no evidence. The code used to test LUN-ness first, so
 * a LUN file whose unrepairable blocks were all `csum-unreadable` was told to
 * restore the LUN anyway. Csum-unreadable wins; the LUN identity rides along
 * because the operator still needs to know what the file is, and it is stated
 * without a restore verb.
 */
function csumUnreadableLunSentence(held: IscsiHeldByLun): string {
  return `this block backs iSCSI LUN ${held.targetIqn}/${held.index}, and ${CSUM_UNREADABLE_SENTENCE}`
}

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

/**
 * What each `not-examined` reason code means, and what would have to change
 * before a re-scrub could say anything (seventh pass, F3/F9/F11).
 *
 * The bucket exists because every one of these used to be reported with the
 * mapping-abort sentence above, which asserts a POSITIVE fact about the bytes.
 * That sentence is true of exactly one case — the re-verify READ the block and
 * it passed — and false of all of these: nothing here was examined at all, and
 * some of them are reachable on any ANAS-created LUN (`hole`: every LUN image
 * is created sparse with `ftruncate`).
 *
 * Each entry is the clause after "re-scrub after" — what would make the block
 * examinable, never a promise that it is fine.
 */
const NOT_EXAMINED_ADVICE: Record<string, string> = {
  'inline-extent': 'the file is rewritten so its tail no longer lives in the metadata tree — an inline extent has no on-disk location to read, arbitrate or write',
  'hole': 'the range has been written — a hole has nothing on disk, and every LUN image ANAS creates is sparse, so a hole says nothing about the LUN\'s data',
  'owner-scan-truncated': 'the extent has fewer references — the back-reference scan hit its bound, so what it found is a prefix and not this file\'s extents in that stripe',
  'band-unreadable': 'the band\'s md geometry can be read again — the array was not answering when the lookup ran',
  'unresolvable': 'the mapping and the array agree again — nothing about this block was established',
  'inode-changed': 'a fresh scrub has named the file that is at this path now — the file the finding describes is not the file there',
}

/** The not-examined bucket's sentence for one block, with its own reason. */
function notExaminedSentence(reasonCode: string | undefined, reason: string): string {
  const advice = (reasonCode && NOT_EXAMINED_ADVICE[reasonCode]) ?? NOT_EXAMINED_ADVICE.unresolvable
  return `this block could not be examined: ${reasonCode ?? 'unresolvable'} — ${reason} `
    + `Nothing was written, and nothing is known about this file's bytes; re-scrub after ${advice}.`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The band's md level, for the `parityMismatches` row a residual becomes.
 *
 * It rides because the row's consumers branch on it: a RAID1 band is never
 * offered Rewrite parity (N1), and a row that cannot say which level it is must
 * not be offered the verb either. Absent when the pool has no such band.
 */
function arrayLevelOf(pool: AhrPool, bandIndex: number): AhrArray['level'] | undefined {
  return pool.arrays.find(a => a.band === bandIndex)?.level
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
 * apply — the sentences that say what the operator does next. Unrepairable
 * advice is PER FILE (D10): the same bucket can hold a plain data file, a LUN
 * image and a csum-unreadable block, and the one sentence "restore this file
 * from backup" was wrong for two of the three.
 */
function repairBody(
  pool: string,
  result: AhrRepairResult,
  unrepairableFiles: { path: string, advice: string }[],
  notExaminedFiles: { path: string, advice: string }[],
): string {
  const head = `Repair from parity on AHR pool '${pool}': `
    + `${result.repaired} repaired, ${result.unrepairable} unrepairable, `
    + `${result.aboveMd} above md, ${result.mappingAbort} not corrupt at the mapped location, `
    + `${result.notExamined} not examined, `
    + `of ${result.blocks} block(s) in ${result.files.length} file(s).`
  const lines = result.files.slice(0, NOTIFY_FILE_LIMIT).map(fileLine)
  if (result.files.length > NOTIFY_FILE_LIMIT)
    lines.push(`  …and ${result.files.length - NOTIFY_FILE_LIMIT} more`)
  const tail: string[] = []
  // Each bucket reads ITS OWN count (review R9) — "restore from backup" rides
  // only the true `unrepairable`, never the mapping-aborts that mean the block
  // was fine all along.
  if (result.unrepairable > 0) {
    const advice = unrepairableFiles.slice(0, NOTIFY_FILE_LIMIT)
      .map(f => `  ${f.path} — ${f.advice}`)
    if (unrepairableFiles.length > NOTIFY_FILE_LIMIT)
      advice.push(`  …and ${unrepairableFiles.length - NOTIFY_FILE_LIMIT} more`)
    tail.push('Unrepairable blocks have no source of truth left below the checksum tree'
      + ` — what to restore, per file:\n${advice.join('\n')}`)
  }
  if (result.mappingAbort > 0)
    tail.push(MAPPING_ABORT_SENTENCE)
  // The not-examined bucket gets its own paragraph and its own per-file reason
  // (seventh pass, F3): "nothing was written" is all these blocks share, and
  // the reason is the only thing that says what a re-scrub would need.
  if (result.notExamined > 0) {
    const advice = notExaminedFiles.slice(0, NOTIFY_FILE_LIMIT).map(f => `  ${f.path} — ${f.advice}`)
    if (notExaminedFiles.length > NOTIFY_FILE_LIMIT)
      advice.push(`  …and ${notExaminedFiles.length - NOTIFY_FILE_LIMIT} more`)
    tail.push('Blocks that could not be EXAMINED were not written, and nothing is known about their'
      + ` bytes — this is neither a clean bill of health nor a reason to restore:\n${advice.join('\n')}`)
  }
  if (result.aboveMd > 0)
    tail.push(`Blocks diagnosed above md were not written: ${ABOVE_MD_SENTENCE}.`)
  // F2 — a repaired block whose band still counts a parity mismatch. The file
  // is right; the band's parity is not, and Rewrite parity is the verb for it.
  // Said here so the operator does not have to wait hours for a fresh two-phase
  // scrub to rediscover a residual this run already measured.
  if (result.parityResiduals.length > 0) {
    const bands = result.parityResiduals
      .map(r => `  ${r.band} (${r.array}) — mismatch_cnt ${r.mismatchCnt}`)
    tail.push('Blocks were repaired and PROVEN against their stored checksum, and md still counts'
      + ' mismatching stripes on their band: the data is right and the parity (or Q) member is what'
      + ` disagrees. Run Rewrite parity on:\n${bands.join('\n')}`)
  }
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
  // The LUN lookup (D10). Only asked for files that actually came back
  // unrepairable — the one bucket whose advice names a restore verb.
  const lunHeld = options?.lunHeld ?? (async (path: string): Promise<IscsiHeldByLun | null> => {
    try {
      return await heldByLunOnce(executor, { path })
    }
    catch {
      return null
    }
  })
  const total = files.reduce((n, f) => n + f.blocks.length, 0)
  const outcomes: AhrRepairFileOutcome[] = []
  /** Per-file restore advice for the notification (D10), in request order. */
  const unrepairableFiles: { path: string, advice: string }[] = []
  /** Per-file "what could not be examined, and why" (seventh pass, F3). */
  const notExaminedFiles: { path: string, advice: string }[] = []
  /**
   * Bands a repaired block left a parity/Q mismatch on (F2), by band label —
   * many blocks of one file live on one band, and the operator rewrites the
   * band once. The highest count seen wins: md's counter is the band's, not the
   * block's, and understating it would understate the work.
   */
  const residuals = new Map<string, AhrScrubParityMismatch>()
  let repaired = 0
  let unrepairable = 0
  let aboveMd = 0
  let mappingAbort = 0
  let notExamined = 0
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
          {
            mountpoint: pool.mountpoint,
            file: file.path,
            block,
            pool,
            // F11 — the finding's inode, when the caller carried it. The engine
            // stats the path before it pins anything and refuses a mismatch by
            // name; omitted, nothing changes.
            ...(file.inode !== undefined ? { inode: file.inode } : {}),
          },
          options?.repairOptions,
        )
        // The engine's reason CODE rides through untouched (D3/D10). It is the
        // one thing in the verdict a parser may key on — the job result, the
        // notification and the Scrubs window all tell a `csum-unreadable`
        // block from one that genuinely needs a restore by this field, never
        // by grepping the operator's sentence.
        entry = {
          block,
          outcome: outcome.outcome,
          reason: outcome.reason,
          ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
          ...(outcome.parityResidual ? { parityResidual: outcome.parityResidual } : {}),
        }
        // F2 — the residual is a fact about the BAND, rolled up so the result
        // can hand it on in the shape the Scrubs parity indicator and Rewrite
        // parity already read. A residual the engine could not tie to a band
        // index (the loop-device rigs, a pool the caller did not hand in) stays
        // on the per-block entry and is not promoted to a row: a
        // `parityMismatches` row with no band number names nothing.
        const residual = outcome.parityResidual
        if (residual && residual.bandIndex !== null) {
          const prior = residuals.get(residual.band)
          if (!prior || residual.mismatchCnt > prior.mismatchCnt) {
            residuals.set(residual.band, {
              band: residual.band,
              bandIndex: residual.bandIndex,
              array: residual.array,
              mismatchCnt: residual.mismatchCnt,
              ...(arrayLevelOf(pool, residual.bandIndex) ? { level: arrayLevelOf(pool, residual.bandIndex) } : {}),
            })
          }
        }
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
      else if (entry.outcome === 'not-examined')
        notExamined += 1
      else
        unrepairable += 1
      updateProgress(`${file.path} block ${block}: ${entry.outcome}`)
      blocks.push(entry)
    }
    outcomes.push({ path: file.path, blocks })
    // Advice classification (D10), once per file that needs it. LUN-ness is a
    // property of the FILE (its blocks all live in the image); csum-unreadable
    // is per BLOCK — a file whose unrepairable blocks ALL carry the code gets
    // the re-scrub advice, a mixed one gets the ordinary restore advice
    // (which is still true of it: nothing else can prove those blocks).
    //
    // CSUM-UNREADABLE IS TESTED FIRST (sixth pass, N5). It is the one verdict
    // that says a restore is the wrong action — the checksum that would have
    // proven the block corrupt is itself damaged — so it outranks the question
    // of WHICH restore verb a LUN would need. The LUN identity is composed into
    // that sentence instead of replacing it.
    //
    // The classification reads `reasonCode`, not the reason TEXT: the sentence
    // is the operator's and may be reworded, the code is the contract.
    // The not-examined bucket's per-file line (F3). One sentence per distinct
    // reason code the file's blocks carried — the reason IS the advice, and a
    // file whose blocks failed for two different reasons deserves both.
    const notExaminedBlocks = blocks.filter(b => b.outcome === 'not-examined')
    if (notExaminedBlocks.length > 0) {
      const seen = new Set<string>()
      const sentences: string[] = []
      for (const b of notExaminedBlocks) {
        const key = b.reasonCode ?? 'unresolvable'
        if (seen.has(key))
          continue
        seen.add(key)
        sentences.push(notExaminedSentence(b.reasonCode, b.reason))
      }
      notExaminedFiles.push({ path: file.path, advice: sentences.join(' ') })
    }
    const unrepairableBlocks = blocks.filter(b => b.outcome === 'unrepairable')
    if (unrepairableBlocks.length > 0) {
      const held = await lunHeld(file.path)
      const allCsumUnreadable = unrepairableBlocks
        .every(b => b.reasonCode === SELFHEAL_CSUM_UNREADABLE)
      unrepairableFiles.push({
        path: file.path,
        advice: allCsumUnreadable
          ? (held ? csumUnreadableLunSentence(held) : CSUM_UNREADABLE_SENTENCE)
          : held
            ? lunRestoreSentence(held)
            : RESTORE_FILE_SENTENCE,
      })
    }
  }

  // Band order, so the notification and the Scrubs window read bottom-up like
  // every other band list. Built fresh here, so sorting in place mutates
  // nothing anyone else holds.
  const residualRows = [...residuals.values()]
  residualRows.sort((a, b) => a.bandIndex - b.bandIndex)

  const result = AhrRepairResultSchema.parse({
    pool: pool.name,
    files: outcomes,
    repaired,
    unrepairable,
    aboveMd,
    mappingAbort,
    notExamined,
    parityResiduals: residualRows,
    blocks: total,
  })

  // ONE notification, whatever the outcome — the operator asked for this and is
  // owed the answer even when the browser has moved on (a repair outruns the
  // UI's job-poll budget exactly as a scrub does). A mapping-abort block was
  // left exactly as it was — still not a repair, so the notification stays a
  // warning when any block ended unrepaired.
  // A parity residual is NOT a clean run either: the block is repaired, and the
  // band md counts mismatching stripes on still needs Rewrite parity.
  const clean = unrepairable === 0 && aboveMd === 0 && mappingAbort === 0
    && notExamined === 0 && residuals.size === 0
  await pveNotify(
    executor,
    clean ? 'info' : 'warning',
    clean ? 'AHR repair from parity completed' : 'AHR repair from parity left blocks unrepaired',
    repairBody(pool.name, result, unrepairableFiles, notExaminedFiles),
  )

  return result
}
