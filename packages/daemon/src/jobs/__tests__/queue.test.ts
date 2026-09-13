import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JobQueue } from '../queue.js'

/**
 * The job queue's correlation queries.
 *
 * `findByOperation` answers "how did the latest attempt on this resource end?"
 * and `findActive` answers "is one of these running on it right now?" — two
 * different questions, and the second one is what a mutual-exclusion gate has
 * to ask (review R7). Asking the first let a newer TERMINAL job hide an older
 * running one, and the exclusion silently stopped holding.
 */

async function noop(): Promise<void> {}
async function forever(): Promise<void> {
  return new Promise(() => {})
}

/** Let the queue drain so submitted jobs reach their terminal state. */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('JobQueue.findActive', () => {
  it('finds a job still in flight for the operation and target', () => {
    const queue = new JobQueue()
    const ref = queue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'tank' } }, forever)
    assert.equal(queue.findActive('ahr.repair', 'tank')?.id, ref.id)
    assert.equal(queue.findActive('ahr.repair', 'other'), undefined)
    assert.equal(queue.findActive('ahr.scrub', 'tank'), undefined)
  })

  it('is NOT hidden by a newer terminal job for the same pool', async () => {
    const queue = new JobQueue()
    const running = queue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'tank' } }, forever)
    queue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'tank' } }, noop)
    await settle()

    // The question the old gate asked answers with the FINISHED job…
    assert.equal(queue.findByOperation('ahr.repair', 'tank')?.status, 'completed')
    // …while the repair is still running, and this is the one that says so.
    assert.equal(queue.findActive('ahr.repair', 'tank')?.id, running.id)
  })

  it('answers for a SET of operations, and ignores terminal ones', async () => {
    const queue = new JobQueue()
    queue.submit('ahr.scrub', { user: 'u', uid: 0, params: { name: 'tank' } }, noop)
    await settle()
    assert.equal(queue.findActive(['ahr.scrub', 'ahr.repair'], 'tank'), undefined)

    const running = queue.submit('ahr.scrub', { user: 'u', uid: 0, params: { name: 'tank' } }, forever)
    assert.equal(queue.findActive(['ahr.scrub', 'ahr.repair'], 'tank')?.id, running.id)
  })

  it('queued counts as in flight — the gate is at SUBMIT, not at start', () => {
    const queue = new JobQueue({ concurrency: 1 })
    queue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'a' } }, forever)
    const queued = queue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'b' } }, forever)
    assert.equal(queue.get(queued.id)?.status, 'queued')
    assert.equal(queue.findActive('ahr.repair', 'b')?.id, queued.id)
  })

  it('matches on the named param key, and never on a job with no params', () => {
    const queue = new JobQueue()
    const ref = queue.submit('backup.restore.image', { user: 'u', uid: 0, params: { target: 'iqn.x' } }, forever)
    assert.equal(queue.findActive('backup.restore.image', 'iqn.x', 'target')?.id, ref.id)
    assert.equal(queue.findActive('backup.restore.image', 'iqn.x'), undefined, 'the default key is params.name')
    queue.submit('ahr.repair', { user: 'u', uid: 0 }, forever)
    assert.equal(queue.findActive('ahr.repair', ''), undefined)
  })

  it('returns the OLDEST job still in flight when several are', () => {
    const queue = new JobQueue()
    const first = queue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'tank' } }, forever)
    queue.submit('ahr.scrub', { user: 'u', uid: 0, params: { name: 'tank' } }, forever)
    assert.equal(queue.findActive(['ahr.scrub', 'ahr.repair'], 'tank')?.id, first.id)
  })
})
