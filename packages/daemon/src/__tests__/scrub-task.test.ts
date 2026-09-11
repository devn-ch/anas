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
})
