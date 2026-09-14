#!/usr/bin/env node
import type { CommandExecutor } from '../executor/types.js'
import type { ParityRewriteEvidence, ParityRewritePool } from '../services/ahr-parity-rewrite.js'
import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { AhrParityRewriteResult as AhrParityRewriteResultSchema } from '@anas/shared'
import { ProdExecutor } from '../executor/prod.js'
import { rewriteBandParity } from '../services/ahr-parity-rewrite.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { resolveContext } from '../services/selfheal-map.js'
import { memberDataSectors } from '../services/selfheal-repair.js'

/**
 * `node dist/bin/selfheal-parity.js <mountpoint> <band>` — the DEV/TEST entry
 * point that lets the selfheal.2 suite drive the real parity rewrite as its
 * `PARITY_CMD` (story selfheal.10, case 8).
 *
 * Not an operator tool and not the product path: the rewrite reaches users as
 * the confirm-gated `POST /v1/ahr/:name/parity-rewrite` job, with this same
 * service underneath. What lives here is the argv / exit-code / sidecar shape
 * the suite's contract defines:
 *
 *   exit 0 rewritten · 2 still-mismatched · 3 refused · 1 internal error
 *
 * On a real AHR pool the band is the pool's own band index and the pool comes
 * from the topology. On a loop rig — which is what the suite builds, and which
 * is not an AHR pool — the band is the position of the dm segment in the LV's
 * table (band 1 is the first), resolved through the same `resolveContext` the
 * repair engine maps blocks with, so the rig and the product disagree about
 * nothing.
 *
 * `--assume-mismatch` is DEV-ONLY and exists for exactly one reason: on a rig
 * there is no daemon, no job queue and therefore no completed scrub job to read
 * the band's parity-mismatch count out of. It BYPASSES THE EVIDENCE GATE with
 * a hardcoded count and nothing else — the fresh btrfs scrub, the array gates,
 * the whole-band repair, the verifying check and the `mismatch_cnt == 0` proof
 * all run exactly as they do in the job. The product path never sets it, and
 * the route has no way to.
 *
 * Without the flag the gate is real, and `--evidence <file>` is the rig's
 * stand-in for the completed-scrub job: a JSON file with the bounded check's
 * count (`{"mismatch_cnt": N, ...}`, N > 0), produced by the selfheal.2 suite
 * from a bounded check on the rig. With neither the flag nor a valid evidence
 * file the entry refuses (exit 3, `no-parity-mismatch`) before touching md —
 * the same refusal the product route gives when the lookup has no proof.
 */

const EXIT = {
  'rewritten': 0,
  'internal': 1,
  'still-mismatched': 2,
  'refused': 3,
} as const

const BAND_ARG_RE = /^\d+$/

/**
 * The pool this mountpoint belongs to, or a rig-shaped stand-in built from the
 * dm table.
 *
 * The stand-in carries the three things the rewrite reads: the bands in table
 * order, each band's md device, and the per-member size the duration estimate
 * is computed from (`rd<n>/size`, which is already net of the data offset).
 */
async function poolFor(executor: CommandExecutor, mountpoint: string): Promise<ParityRewritePool> {
  try {
    const pool = (await readAhrPools(executor)).find(p => p.mounted && p.mountpoint === mountpoint)
    if (pool)
      return pool
  }
  catch {
    // Not a node with AHR pools — fall through to the rig shape.
  }
  const ctx = await resolveContext(executor, mountpoint)
  const arrays = []
  for (const [index, band] of ctx.bands.entries()) {
    if (band.geometry === null)
      throw new Error(`band ${index + 1} (${band.device}): ${band.error ?? 'its geometry could not be read'}`)
    const sectors = await memberDataSectors(band.geometry)
    arrays.push({
      band: index + 1,
      device: band.geometry.device,
      heightBytes: (sectors ?? 0) * 512,
      members: band.geometry.members.filter(m => m !== null),
    })
  }
  return { name: 'rig', mountpoint, mounted: true, arrays }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const assumeMismatch = argv.includes('--assume-mismatch')
  // `--evidence <file>`: the suite's bounded-check evidence file. Its VALUE
  // is not a flag, so it must be consumed here or it would be parsed as the
  // band.
  const evidenceIdx = argv.indexOf('--evidence')
  const evidenceFile = evidenceIdx >= 0 && evidenceIdx + 1 < argv.length ? argv[evidenceIdx + 1] : null
  const [mountpoint, bandText] = argv
    .filter((a, i) => evidenceIdx < 0 || (i !== evidenceIdx && i !== evidenceIdx + 1))
    .filter(a => !a.startsWith('--'))
  if (!mountpoint || !bandText || !BAND_ARG_RE.test(bandText)) {
    process.stderr.write('usage: selfheal-parity <mountpoint> <band> [--assume-mismatch | --evidence <file>]\n')
    return EXIT.internal
  }
  const band = Number(bandText)
  const executor = new ProdExecutor()

  // The rig's stand-in for "the last completed scrub counted mismatches on
  // this band and its checksum pass was clean". `--assume-mismatch` bypasses
  // the gate with a hardcoded count; without it, `--evidence <file>` (the
  // suite's bounded-check JSON, mismatch_cnt > 0) supplies the proof; with
  // neither the answer is the honest one for a rig: no such scrub on record.
  const evidence = async (): Promise<ParityRewriteEvidence> => {
    if (assumeMismatch)
      return { ok: true, mismatchCnt: 8, jobId: 'dev:--assume-mismatch' }
    if (evidenceFile) {
      try {
        const parsed = JSON.parse(await readFile(evidenceFile, 'utf8')) as { mismatch_cnt?: unknown }
        if (typeof parsed.mismatch_cnt === 'number' && parsed.mismatch_cnt > 0)
          return { ok: true, mismatchCnt: parsed.mismatch_cnt, jobId: `dev:--evidence ${evidenceFile}` }
      }
      catch {
        // an unreadable or malformed evidence file is no evidence
      }
      return {
        ok: false,
        code: 'no-parity-mismatch',
        reason: `the evidence file ${evidenceFile} records no parity mismatch on this band — it must be a JSON file with the bounded check's mismatch_cnt > 0`,
      }
    }
    return {
      ok: false,
      code: 'no-parity-mismatch',
      reason: 'no completed scrub job is on record (this dev entry has no job queue) — pass --assume-mismatch to bypass the evidence gate on a test rig, or --evidence <file> with a bounded check\'s count',
    }
  }

  try {
    const result = await rewriteBandParity(executor, await poolFor(executor, mountpoint), band, {
      updateProgress: message => process.stderr.write(`${message}\n`),
      evidence,
      // The rig polls fast: a 200 MiB band's repair and check are seconds, and
      // the product's 5 s poll would watch the whole thing happen between two
      // looks.
      pollIntervalMs: 250,
      startTimeoutMs: 15000,
    })
    AhrParityRewriteResultSchema.parse(result)
    process.stdout.write(`${JSON.stringify(result, null, 1)}\n`)
    if (process.env.PARITY_REPORT)
      await writeFile(process.env.PARITY_REPORT, `${JSON.stringify(sidecar(result), null, 1)}\n`)
    return EXIT[result.outcome]
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    if (process.env.PARITY_REPORT) {
      await writeFile(process.env.PARITY_REPORT, `${JSON.stringify({
        outcome: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }, null, 1)}\n`)
    }
    return EXIT.internal
  }
}

/** The suite reads snake_case keys; the service speaks the shared schema. */
function sidecar(result: ReturnType<typeof AhrParityRewriteResultSchema.parse>): Record<string, unknown> {
  return {
    outcome: result.outcome,
    reason: result.reason ?? '',
    pool: result.pool,
    band: result.band,
    array: result.array,
    mismatch_before: result.mismatchBefore,
    mismatch_after: result.mismatchAfter,
    reason_code: result.reasonCode ?? null,
    btrfs_errors: result.btrfsErrors ?? null,
    errors_reported: result.errorsReported ?? null,
    findings: (result.findings ?? []).map(f => f.path),
    durations: result.durations,
  }
}

main().then(
  (code) => { process.exitCode = code },
  (error: unknown) => {
    process.stderr.write(`selfheal-parity internal error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = EXIT.internal
  },
)
