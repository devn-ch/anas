import type { Job, JobRef } from '@anas/shared'
import type { Requester, RunLoopOptions } from './runner-poll.js'
import { defaultSocket, errorMessage, identityHeaders, RUNNER_POLL_INTERVAL_MS, RUNNER_POLL_MAX_ATTEMPTS, socketRequester } from './runner-poll.js'

/**
 * AHR periodic-scrub RUNNER (story selfheal.4) — the entrypoint the node-level
 * `anas-scrub.timer` fires (via `node dist/scrub-task.js <pool> [<pool> …]`,
 * rendered by services/scrub-schedule-units.ts). A thin, shell-free client of
 * the daemon: it POSTs `/v1/ahr/<pool>/scrub` for each pool IN SEQUENCE — AHR
 * pools on one node share spindles, so pools never scrub concurrently — polls
 * each job to a terminal state BEFORE starting the next, prints each result
 * JSON to stdout (→ journald), and exits 0 only if every submitted pool's scrub
 * completed.
 *
 * A pool that no longer exists (the daemon answers 404 — the list outlived a
 * destroy) is skipped with a journald line and the sequence continues; so does
 * a pool whose job FAILED — one band's rot must not cost the other pools their
 * scrub. Everything here is I/O plumbing, the same shape as snapshot-task.ts:
 * the timer schedules, the daemon does the work.
 */

export type { Requester, RunLoopOptions, RunnerResponse } from './runner-poll.js'
export { socketRequester } from './runner-poll.js'

export interface ScrubRunnerOptions {
  pools: string[]
  socket: string
}

/** The "pool is gone" error scrubPool throws, and runScrubSchedule skips on. */
const GONE_RE = /no longer exists/

/** Parse the runner's argv (already sliced past `node script`). */
export function parseRunnerArgs(argv: string[]): ScrubRunnerOptions {
  const opts: Partial<ScrubRunnerOptions> = { socket: defaultSocket() }
  const pools: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--socket') {
      const value = argv[++i]
      if (value === undefined)
        throw new Error('Missing value for --socket')
      opts.socket = value
      continue
    }
    if (flag.startsWith('--'))
      throw new Error(`Unknown argument: ${flag}`)
    pools.push(flag)
  }
  if (pools.length === 0)
    throw new Error('Missing required pool list')
  opts.pools = pools
  return { pools: opts.pools, socket: opts.socket ?? defaultSocket() }
}

/**
 * Submit ONE pool's scrub and poll it to a terminal state. Resolves with the
 * finished Job (completed OR failed); rejects only when the JOB is gone. A 404
 * on the SUBMIT — the pool is gone — throws a distinct "gone" error the caller
 * skips on.
 */
export async function scrubPool(
  requester: Requester,
  pool: string,
  loop: RunLoopOptions = {},
): Promise<Job> {
  const submit = await requester({
    method: 'POST',
    path: `/v1/ahr/${encodeURIComponent(pool)}/scrub`,
    headers: identityHeaders(),
    body: {},
  })
  if (submit.statusCode === 404)
    throw new Error(`pool '${pool}' no longer exists`)
  if (submit.statusCode !== 202) {
    const detail = errorMessage(submit.body) ?? JSON.stringify(submit.body)
    throw new Error(`scrub submit failed for '${pool}' (HTTP ${submit.statusCode}): ${detail}`)
  }
  const jobRef = (submit.body as { job?: JobRef }).job
  if (!jobRef?.id)
    throw new Error(`scrub submit returned no job id for '${pool}': ${JSON.stringify(submit.body)}`)
  return pollScrubJob(requester, jobRef, loop)
}

/**
 * Poll ONE scrub job to its terminal state — WITHOUT the shared 24 h backstop
 * (review, cut-but-verified). The generic runner cap exists so a healthy
 * multi-hour backup is never declared failed; a scrub is LONGER still (days on
 * real spindles), and worse: the runner would give up on pool 1 and `continue`
 * to pool 2 while pool 1 was still scrubbing — two pools concurrently on
 * shared spindles, the one thing selfheal.4 forbids. So THIS loop keeps its
 * own rule:
 *
 *   - a job that exists and is not terminal is waited for. No cap. The daemon
 *     is the source of truth and the job always terminates; the runner's job
 *     is to mirror it, however long that takes.
 *   - only a job that VANISHES ends the wait: a 404 (the daemon restarted and
 *     its in-memory job list is gone) or a daemon outage, each polled up to
 *     {@link RUNNER_POLL_MAX_ATTEMPTS} attempts (≈ 24 h at the 10 s interval)
 *     before giving up with a journald line — a sanity cap on a missing job,
 *     never a judgment about how long the work should take.
 */
export async function pollScrubJob(
  requester: Requester,
  jobRef: JobRef,
  loop: RunLoopOptions = {},
): Promise<Job> {
  const intervalMs = loop.intervalMs ?? RUNNER_POLL_INTERVAL_MS
  const vanishCap = loop.maxAttempts ?? RUNNER_POLL_MAX_ATTEMPTS
  const sleep = loop.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const headers = identityHeaders()

  let missing = 0
  let outage = 0
  for (;;) {
    let poll
    try {
      poll = await requester({
        method: 'GET',
        path: `/v1/jobs/${jobRef.id}`,
        headers,
      })
      outage = 0
    }
    catch (err) {
      outage += 1
      if (outage >= vanishCap) {
        const message = `scrub job ${jobRef.id} unreachable — the daemon has been answering for `
          + `${outage} consecutive polls (${Math.round(outage * intervalMs / 1000)}s); giving up on this pool's wait: ${
            err instanceof Error ? err.message : String(err)}`
        process.stderr.write(`scrub-task: ${message}\n`)
        throw new Error(message)
      }
      await sleep(intervalMs)
      continue
    }
    if (poll.statusCode === 200) {
      missing = 0
      const job = (poll.body as { job?: Job }).job
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
    }
    else {
      missing += 1
      if (missing >= vanishCap) {
        const message = `scrub job ${jobRef.id} vanished — HTTP ${poll.statusCode} for `
          + `${missing} consecutive polls (the daemon restarted and its job list is gone?); giving up on this pool's wait`
        process.stderr.write(`scrub-task: ${message}\n`)
        throw new Error(message)
      }
    }
    await sleep(intervalMs)
  }
}

/** The outcome of one pool's pass through the sequence. */
export interface ScrubRunOutcome {
  results: { pool: string, job: Job }[]
  skipped: { pool: string, reason: string }[]
  failures: { pool: string, message: string }[]
}

/**
 * The whole sequence: one pool at a time, each awaited to its terminal state
 * before the next starts. Submit failures land in `skipped` (gone pool) or
 * `failures`; a FAILED job lands in `failures` — the sequence never aborts on
 * one pool.
 */
export async function runScrubSchedule(
  requester: Requester,
  pools: string[],
  loop: RunLoopOptions = {},
): Promise<ScrubRunOutcome> {
  const outcome: ScrubRunOutcome = { results: [], skipped: [], failures: [] }
  for (const pool of pools) {
    let job: Job
    try {
      job = await scrubPool(requester, pool, loop)
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (GONE_RE.test(message)) {
        // journald (the unit's stderr) — the skip is said, never silent.
        process.stderr.write(`scrub-task: skipping ${pool}: ${message}\n`)
        outcome.skipped.push({ pool, reason: message })
      }
      else {
        process.stderr.write(`scrub-task: ${message}\n`)
        outcome.failures.push({ pool, message })
      }
      continue
    }
    if (job.status === 'completed') {
      process.stdout.write(`${JSON.stringify({ pool, result: job.result })}\n`)
      outcome.results.push({ pool, job })
    }
    else {
      const message = job.error?.message ?? 'scrub job failed'
      process.stderr.write(`scrub-task: scrub on ${pool} failed: ${message}\n`)
      outcome.failures.push({ pool, message })
    }
  }
  return outcome
}

/** CLI entrypoint. Exits 0 on all completed, 1 if any scrub failed, 2 on bad args/transport. */
export async function main(argv: string[]): Promise<number> {
  let opts: ScrubRunnerOptions
  try {
    opts = parseRunnerArgs(argv)
  }
  catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  try {
    const outcome = await runScrubSchedule(socketRequester(opts.socket), opts.pools)
    return outcome.failures.length === 0 ? 0 : 1
  }
  catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

// Run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
}
