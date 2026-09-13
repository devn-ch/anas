import type { Requester, RunnerResponse } from '../scrub-task.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRunnerArgs, runScrubSchedule, scrubPool } from '../scrub-task.js'

/**
 * The node-level scrub timer's RUNNER (selfheal.4): POST /v1/ahr/<pool>/scrub
 * per pool IN SEQUENCE, each job awaited to its terminal state before the next
 * starts; a pool that no longer exists is skipped, and one pool's failure never
 * costs the others their scrub.
 */

describe('scrub-task runner (selfheal.4 — timer entrypoint)', () => {
  describe('parseRunnerArgs', () => {
    it('parses the positional pool list and defaults the socket', () => {
      const opts = parseRunnerArgs(['p1', 'p2'])
      assert.deepEqual(opts.pools, ['p1', 'p2'])
      assert.equal(opts.socket, process.env.ANASD_SOCKET ?? '/run/anas/anasd.sock')
    })

    it('accepts an explicit --socket between pools', () => {
      assert.deepEqual(parseRunnerArgs(['p1', '--socket', '/run/y.sock', 'p2']).pools, ['p1', 'p2'])
      assert.equal(parseRunnerArgs(['p1', '--socket', '/run/y.sock']).socket, '/run/y.sock')
    })

    it('throws on an empty pool list and on unknown flags', () => {
      assert.throws(() => parseRunnerArgs([]), /Missing required pool list/)
      assert.throws(() => parseRunnerArgs(['--bogus', 'x']), /Unknown argument: --bogus/)
      assert.throws(() => parseRunnerArgs(['--socket']), /Missing value for --socket/)
    })
  })

  const noSleep = async (): Promise<void> => {}

  /** A requester driven by a script, recording every call IN ORDER. */
  function scripted(script: { posts: Record<string, RunnerResponse>, polls: RunnerResponse[] }): { requester: Requester, calls: string[] } {
    const calls: string[] = []
    let pollIdx = 0
    const requester: Requester = async (req) => {
      calls.push(`${req.method} ${req.path}`)
      if (req.method === 'POST') {
        const hit = script.posts[req.path]
        return hit ?? { statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'no such pool' } } }
      }
      return script.polls[Math.min(pollIdx++, script.polls.length - 1)]
    }
    return { requester, calls }
  }

  it('scrubs pools IN SEQUENCE — the second POST only after the first job is terminal', async () => {
    // The polls interleave: p1's job must reach `completed` (a poll answer
    // carrying it) BEFORE p2's submit can appear in the call log.
    const { requester, calls } = scripted({
      posts: {
        '/v1/ahr/p1/scrub': { statusCode: 202, body: { job: { id: 'j1', status: 'queued' } } },
        '/v1/ahr/p2/scrub': { statusCode: 202, body: { job: { id: 'j2', status: 'queued' } } },
      },
      polls: [
        { statusCode: 200, body: { job: { id: 'j1', status: 'running' } } },
        { statusCode: 200, body: { job: { id: 'j1', status: 'completed', result: { scrubbed: 'p1' } } } },
        { statusCode: 200, body: { job: { id: 'j2', status: 'completed', result: { scrubbed: 'p2' } } } },
      ],
    })
    const outcome = await runScrubSchedule(requester, ['p1', 'p2'], { sleep: noSleep })
    assert.equal(outcome.results.length, 2)
    assert.equal(outcome.failures.length, 0)
    const postP2 = calls.indexOf('POST /v1/ahr/p2/scrub')
    const j1Done = calls.findIndex(c => c === 'GET /v1/jobs/j1')
    // The last j1 poll (completed) sits BEFORE p2's submit.
    const j1CompletedPoll = calls.lastIndexOf('GET /v1/jobs/j1')
    assert.ok(j1CompletedPoll < postP2, `p1's job was awaited before p2 started (${calls.join(' | ')})`)
    assert.notEqual(j1Done, -1)
  })

  it('a pool that no longer exists (404) is skipped with a journald line, sequence continues', async () => {
    const lines: string[] = []
    const origErr = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string | Uint8Array) => {
      lines.push(String(s))
      return true
    }
    try {
      const { requester, calls } = scripted({
        posts: { '/v1/ahr/p2/scrub': { statusCode: 202, body: { job: { id: 'j2', status: 'queued' } } } },
        polls: [{ statusCode: 200, body: { job: { id: 'j2', status: 'completed', result: {} } } }],
      })
      const outcome = await runScrubSchedule(requester, ['gone', 'p2'], { sleep: noSleep })
      assert.equal(outcome.skipped.length, 1)
      assert.equal(outcome.skipped[0].pool, 'gone')
      assert.equal(outcome.results.length, 1)
      assert.equal(outcome.failures.length, 0)
      assert.ok(lines.some(l => l.includes('gone')), 'the skip is said on stderr (journald via the unit)')
      assert.ok(calls.includes('POST /v1/ahr/p2/scrub'), 'the sequence continued to the next pool')
    }
    finally {
      process.stderr.write = origErr
    }
  })

  it('a FAILED job lands in failures and the next pool still scrubs', async () => {
    const { requester } = scripted({
      posts: {
        '/v1/ahr/p1/scrub': { statusCode: 202, body: { job: { id: 'j1', status: 'queued' } } },
        '/v1/ahr/p2/scrub': { statusCode: 202, body: { job: { id: 'j2', status: 'queued' } } },
      },
      polls: [
        { statusCode: 200, body: { job: { id: 'j1', status: 'failed', error: { code: 'JOB_FAILED', message: 'aborted' } } } },
        { statusCode: 200, body: { job: { id: 'j2', status: 'completed', result: {} } } },
      ],
    })
    const outcome = await runScrubSchedule(requester, ['p1', 'p2'], { sleep: noSleep })
    assert.deepEqual(outcome.failures.map(f => f.pool), ['p1'])
    assert.equal(outcome.results.map(r => r.pool)[0], 'p2')
  })

  it('a submit that is neither 202 nor 404 is a failure, not a skip', async () => {
    const { requester } = scripted({
      posts: { '/v1/ahr/p1/scrub': { statusCode: 409, body: { error: { code: 'CONFLICT', message: 'already scrubbing' } } } },
      polls: [],
    })
    const outcome = await runScrubSchedule(requester, ['p1'], { sleep: noSleep })
    assert.equal(outcome.failures.length, 1)
    assert.match(outcome.failures[0].message, /409/)
  })

  it('scrubPool polls the submitted job to its terminal state', async () => {
    const { requester, calls } = scripted({
      posts: { '/v1/ahr/p1/scrub': { statusCode: 202, body: { job: { id: 'j1', status: 'queued' } } } },
      polls: [
        { statusCode: 200, body: { job: { id: 'j1', status: 'running' } } },
        { statusCode: 200, body: { job: { id: 'j1', status: 'completed', result: { scrubbed: 'p1' } } } },
      ],
    })
    const job = await scrubPool(requester, 'p1', { sleep: noSleep })
    assert.equal(job.status, 'completed')
    assert.equal(calls[0], 'POST /v1/ahr/p1/scrub')
    assert.ok(calls.slice(1).every(c => c === 'GET /v1/jobs/j1'))
  })

  // --- The poll has NO duration cap on a live job (review, cut-but-verified) --
  //
  // The shared runner backstop (≈24h at 10s) gave up on pool 1 and CONTINUED to
  // pool 2 while pool 1 was still scrubbing — two pools concurrently on shared
  // spindles, the one thing selfheal.4 forbids. The scrub runner's own loop
  // waits as long as the job exists; only a vanished job / daemon outage is
  // capped.
  it('a job still running past the old 24h backstop keeps being polled — no cap on a live job', async () => {
    // 8700 running polls — 60 past the 8640 backstop the shared loop would have
    // thrown on — then completed.
    const running: RunnerResponse = { statusCode: 200, body: { job: { id: 'j1', status: 'running' } } }
    // fill() widens to unknown[] in TS — the cast names the element type back.
    const polls = Array.from({ length: 8700 }).fill(running) as RunnerResponse[]
    polls.push({ statusCode: 200, body: { job: { id: 'j1', status: 'completed', result: { scrubbed: 'p1' } } } })
    let pollIdx = 0
    const requester: Requester = async (req) => {
      if (req.method === 'POST')
        return { statusCode: 202, body: { job: { id: 'j1', status: 'queued' } } }
      return polls[Math.min(pollIdx++, polls.length - 1)]
    }
    const job = await scrubPool(requester, 'p1', { sleep: noSleep })
    assert.equal(job.status, 'completed')
    assert.ok(pollIdx >= 8700, `polled past the old cap (${pollIdx} polls)`)
  })

  it('a VANISHED job (404) ends the wait after 3 confirmations, with a journald line (review F9)', async () => {
    const lines: string[] = []
    const origErr = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string | Uint8Array) => {
      lines.push(String(s))
      return true
    }
    try {
      let pollIdx = 0
      const requester: Requester = async (req) => {
        if (req.method === 'POST')
          return { statusCode: 202, body: { job: { id: 'j1', status: 'queued' } } }
        pollIdx++
        return { statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'no such job' } } }
      }
      // No maxAttempts override: the 3-confirmation window is the DEFAULT — the
      // old code polled a vanished job 8640 × 10 s (24 h) before giving up.
      await assert.rejects(
        () => scrubPool(requester, 'p1', { sleep: noSleep }),
        /vanished \(daemon restarted\?\) — moving to the next pool/,
      )
      assert.equal(pollIdx, 3, 'three 404s confirm the job is gone — a job id cannot come back')
      assert.ok(lines.some(l => l.includes('moving to the next pool')), 'the give-up is said on stderr (journald via the unit)')
    }
    finally {
      process.stderr.write = origErr
    }
  })

  it('a vanished job does NOT block pools 2..n — the sequence proceeds within seconds (review F9)', async () => {
    let j1Polls = 0
    const requester: Requester = async (req) => {
      if (req.method === 'POST')
        return { statusCode: 202, body: { job: { id: req.path.includes('p1') ? 'j1' : 'j2', status: 'queued' } } }
      if (req.path === '/v1/jobs/j1') {
        j1Polls++
        // The daemon restarted mid-scrub: its in-memory job list is gone.
        return { statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'no such job' } } }
      }
      return { statusCode: 200, body: { job: { id: 'j2', status: 'completed', result: {} } } }
    }
    const outcome = await runScrubSchedule(requester, ['p1', 'p2'], { sleep: noSleep })
    assert.equal(j1Polls, 3, 'p1 wait ended at the third 404 — not 8640 polls later')
    assert.deepEqual(outcome.failures.map(f => f.pool), ['p1'], 'the vanished pool is reported honestly — its outcome is unknown')
    assert.equal(outcome.results.map(r => r.pool)[0], 'p2', 'the next pool was not blocked for a day')
  })

  it('one 404 blip is not a vanish — the wait continues (review F9)', async () => {
    let polls = 0
    const requester: Requester = async (req) => {
      if (req.method === 'POST')
        return { statusCode: 202, body: { job: { id: 'j1', status: 'queued' } } }
      polls++
      if (polls === 2)
        return { statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'no such job' } } }
      return { statusCode: 200, body: { job: { id: 'j1', status: 'completed', result: { scrubbed: 'p1' } } } }
    }
    const job = await scrubPool(requester, 'p1', { sleep: noSleep })
    assert.equal(job.status, 'completed', 'a lone 404 never abandons the wait')
  })

  it('a non-404 between 404s resets the vanish count — only CONSECUTIVE 404s confirm it (third pass)', async () => {
    // 404, 503, 404, 404 — two real 404s split by an outage. The old counter
    // was never reset by non-404s, so this sequence declared the job vanished
    // on the FOURTH poll after only two consecutive 404s.
    const sequence: RunnerResponse[] = [
      { statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'no such job' } } },
      { statusCode: 503, body: { error: { code: 'UNAVAILABLE', message: 'overloaded' } } },
      { statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'no such job' } } },
      { statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'no such job' } } },
      { statusCode: 200, body: { job: { id: 'j1', status: 'completed', result: { scrubbed: 'p1' } } } },
    ]
    let pollIdx = 0
    const requester: Requester = async (req) => {
      if (req.method === 'POST')
        return { statusCode: 202, body: { job: { id: 'j1', status: 'queued' } } }
      return sequence[Math.min(pollIdx++, sequence.length - 1)]
    }
    const job = await scrubPool(requester, 'p1', { sleep: noSleep, maxAttempts: 10 })
    assert.equal(job.status, 'completed', '404, 503, 404, 404 is not three consecutive 404s')
  })

  it('a non-404 failure (500) is an outage, not a vanish — bounded by the outage cap, not 3 polls', async () => {
    const lines: string[] = []
    const origErr = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string | Uint8Array) => {
      lines.push(String(s))
      return true
    }
    try {
      let polls = 0
      const requester: Requester = async (req) => {
        if (req.method === 'POST')
          return { statusCode: 202, body: { job: { id: 'j1', status: 'queued' } } }
        polls++
        return { statusCode: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } }
      }
      await assert.rejects(
        () => scrubPool(requester, 'p1', { sleep: noSleep, maxAttempts: 2 }),
        /kept failing/,
      )
      assert.equal(polls, 2, 'the outage cap bounds it — the 3-poll vanish window is for 404s only')
    }
    finally {
      process.stderr.write = origErr
    }
  })

  it('a daemon OUTAGE ends the wait at the sanity cap, with a journald line', async () => {
    const lines: string[] = []
    const origErr = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string | Uint8Array) => {
      lines.push(String(s))
      return true
    }
    try {
      let polls = 0
      const requester: Requester = async (req) => {
        if (req.method === 'POST')
          return { statusCode: 202, body: { job: { id: 'j1', status: 'queued' } } }
        polls++
        throw new Error('socket gone')
      }
      await assert.rejects(
        () => scrubPool(requester, 'p1', { sleep: noSleep, maxAttempts: 2 }),
        /unreachable/,
      )
      assert.equal(polls, 2)
      assert.ok(lines.some(l => l.includes('unreachable')), 'the outage is said on stderr (journald via the unit)')
    }
    finally {
      process.stderr.write = origErr
    }
  })

  it('a brief outage recovers — the poll resumes and reaches the terminal state', async () => {
    let polls = 0
    const requester: Requester = async (req) => {
      if (req.method === 'POST')
        return { statusCode: 202, body: { job: { id: 'j1', status: 'queued' } } }
      polls++
      if (polls <= 2)
        throw new Error('daemon restarting')
      return { statusCode: 200, body: { job: { id: 'j1', status: 'completed', result: { scrubbed: 'p1' } } } }
    }
    const job = await scrubPool(requester, 'p1', { sleep: noSleep, maxAttempts: 100 })
    assert.equal(job.status, 'completed', 'an outage shorter than the cap never abandons the pool')
  })

  it('the sequence never submits pool 2 while pool 1 is still running (even far past 24h)', async () => {
    let j1Polls = 0
    const requester: Requester = async (req) => {
      if (req.method === 'POST')
        return { statusCode: 202, body: { job: { id: req.path.includes('p1') ? 'j1' : 'j2', status: 'queued' } } }
      if (req.path === '/v1/jobs/j1') {
        j1Polls++
        // Completed only after far more polls than the old backstop.
        return j1Polls >= 8650
          ? { statusCode: 200, body: { job: { id: 'j1', status: 'completed', result: { scrubbed: 'p1' } } } }
          : { statusCode: 200, body: { job: { id: 'j1', status: 'running' } } }
      }
      return { statusCode: 200, body: { job: { id: 'j2', status: 'completed', result: { scrubbed: 'p2' } } } }
    }
    const outcome = await runScrubSchedule(requester, ['p1', 'p2'], { sleep: noSleep })
    assert.equal(outcome.results.length, 2, 'both pools scrubbed, strictly one at a time')
  })
})
