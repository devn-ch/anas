import type { Job } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { JobQueue } from '../../jobs/queue.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { ahrMutationRoutes } from '../ahr-mutate.js'
import { jobRoutes } from '../jobs.js'

/**
 * POST /v1/ahr/:name/repair — Repair from parity (story selfheal.6).
 *
 * The route's whole job is to refuse everything that must not be repaired
 * BEFORE a confirm code exists, then to hand the engine an explicit list. The
 * engine itself is covered by `services/__tests__/selfheal-repair.test.ts` and
 * the job around it by `services/__tests__/ahr-repair.test.ts`; what is
 * asserted here is the door.
 */

const MOUNTPOINT = '/mnt/anas-ahr/ahr0'
const FILE = `${MOUNTPOINT}/movies/a very long name.mkv`

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

/**
 * The dev-mock AHR topology (`ahr0`) with a swappable /proc/mdstat and a
 * swappable findmnt — the mount's `subvol=` option is what decides whether the
 * pool is a §12 layout, and therefore whether it has a top-level mount at all.
 */
function ahrExecutor(mdstat: ExecResult = mockFixtures.ahrMdstat(), findmnt: ExecResult = mockFixtures.ahrFindmnt()): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: mdstat })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
  executor.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: mockFixtures.ahrLsblk() })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
  executor.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
  executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
  executor.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: findmnt })
  executor.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs(MOUNTPOINT), result: mockFixtures.ahrBtrfsUsage() })
  return executor
}

/** `stat -c %s` answers for the paths that exist; everything else is gone. */
function withFiles(executor: MockExecutor, paths: string[]): MockExecutor {
  for (const path of paths)
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', path], result: { stdout: '4096\n', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/stat', result: { stdout: '', stderr: 'No such file or directory', exitCode: 1 } })
  return executor
}

interface TestServer {
  inject: ReturnType<typeof Fastify>['inject']
  close: () => Promise<unknown>
  jobQueue: JobQueue
}

async function serverWith(executor: MockExecutor): Promise<TestServer> {
  const app = Fastify({ logger: false })
  const jobQueue = new JobQueue()
  await app.register(jobRoutes, { prefix: '/v1', jobQueue })
  await app.register(ahrMutationRoutes, {
    prefix: '/v1',
    executor,
    jobQueue,
    confirmStore: new ConfirmStore(),
    diskIdentityCache: new DiskIdentityCache(executor),
    fstabPath: '/nonexistent/fstab',
    kernelRelease: '7.0.14-8-pve',
  })
  const server = app as unknown as TestServer
  server.jobQueue = jobQueue
  return server
}

function body(files: { path: string, blocks: number[] }[]): string {
  return JSON.stringify({ files })
}

async function waitForJob(server: TestServer, id: string): Promise<Job> {
  for (let i = 0; i < 300; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('POST /v1/ahr/:name/repair — validation', () => {
  it('400 on a body that names no file, no block, or a path that is not absolute', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE]))
    for (const payload of [
      body([]),
      body([{ path: FILE, blocks: [] }]),
      JSON.stringify({ files: [{ path: '@snapshots/nightly/x.mkv', blocks: [1] }] }),
      JSON.stringify({}),
    ]) {
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload })
      assert.equal(res.statusCode, 400, payload)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR', payload)
    }
    // …and the message says what a repair CAN take, including why a snapshot
    // finding is not it.
    const snap = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: JSON.stringify({ files: [{ path: '@snapshots/nightly/x.mkv', blocks: [1] }] }) })
    assert.match(snap.json().error.message, /@snapshots/)
    await server.close()
  })

  it('401 without identity headers, 404 for a pool that is not there', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE]))
    const anon = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: { 'content-type': 'application/json' }, payload: body([{ path: FILE, blocks: [1] }]) })
    assert.equal(anon.statusCode, 401)
    const gone = await server.inject({ method: 'POST', url: '/v1/ahr/nosuch/repair', headers: JSON_HEADERS, payload: body([{ path: '/mnt/anas-ahr/nosuch/a.bin', blocks: [1] }]) })
    assert.equal(gone.statusCode, 404)
    await server.close()
  })

  it('400 for a path outside the pool\'s mountpoint — repair is the live @data tree only', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE, '/etc/hosts']))
    for (const path of ['/etc/hosts', MOUNTPOINT]) {
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path, blocks: [1] }]) })
      assert.equal(res.statusCode, 400, path)
      assert.match(res.json().error.message, /live @data tree only/, path)
    }
    await server.close()
  })

  it('409 for a path that no longer exists — deleted since the scrub named it', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE]))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: `${MOUNTPOINT}/gone.bin`, blocks: [1] }]) })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.match(res.json().error.message, /deleted since the scrub/)
    await server.close()
  })
})

describe('POST /v1/ahr/:name/repair — hard refusals, before any confirm code', () => {
  it('409 while the pool is busy — no X-Anas-Confirm-Code to bypass it with', async () => {
    const server = await serverWith(withFiles(ahrExecutor(mockFixtures.ahrMdstatCheck()), [FILE]))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.match(res.json().error.message, /scrubbing|degraded|rebuilding|expanding|building/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    await server.close()
  })

  it('409 while a backup holds the pool\'s top-level mount — said at the door, not by the engine', async () => {
    // A §12 pool: the mount carries `subvol=/@data`, which is what makes the
    // on-demand top-level mount (and therefore the contention) real.
    const layout = JSON.stringify({
      filesystems: [{ target: MOUNTPOINT, source: '/dev/mapper/ahr0-ahr0--vol', fstype: 'btrfs', options: 'rw,relatime,subvol=/@data' }],
    })
    const executor = ahrExecutor(mockFixtures.ahrMdstat(), { stdout: layout, stderr: '', exitCode: 0 })
    // The held mount: `findmnt --mountpoint` answers 0 while someone holds it.
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--mountpoint', '/run/anas-ahr/ahr0.toplevel'], result: { stdout: '/run/anas-ahr/ahr0.toplevel\n', stderr: '', exitCode: 0 } })
    const server = await serverWith(withFiles(executor, [FILE]))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /top-level mount .* is already held/)
    assert.match(res.json().error.message, /backup or snapshot job is in flight/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    await server.close()
  })

  it('409 while a scrub job for this pool is in flight, naming the job', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE]))
    // A scrub that never finishes — the queue's own record is what the route reads.
    server.jobQueue.submit('ahr.scrub', { user: 'root@pam', uid: 0, params: { name: 'ahr0' } }, () => new Promise(() => {}))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /a scrub is in flight/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    // …and the same guard the other way round: no scrub starts mid-repair.
    const server2 = await serverWith(withFiles(ahrExecutor(), [FILE]))
    server2.jobQueue.submit('ahr.repair', { user: 'root@pam', uid: 0, params: { name: 'ahr0' } }, () => new Promise(() => {}))
    const scrub = await server2.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(scrub.statusCode, 409)
    assert.match(scrub.json().error.message, /repair job is in flight/)
    await server.close()
    await server2.close()
  })
})

describe('POST /v1/ahr/:name/repair — the confirm gate and the job', () => {
  it('409 CONFIRMATION_REQUIRED saying exactly what the repair does, then 202', async () => {
    const executor = withFiles(ahrExecutor(), [FILE])
    const server = await serverWith(executor)
    const payload = body([{ path: FILE, blocks: [300, 300, 12] }])

    const first = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload })
    assert.equal(first.statusCode, 409)
    const error = first.json().error
    assert.equal(error.code, 'CONFIRMATION_REQUIRED')
    // The duplicate block is collapsed, so the count is the work, not the ask.
    assert.match(error.message, /2 block\(s\) in 1 file\(s\)/)
    const warnings = (error.warnings as string[]).join('\n')
    assert.match(warnings, /read-only snapshot/)
    assert.match(warnings, /rmw_level, sync_min, sync_max and stripe_cache_size/)
    assert.match(warnings, /restored afterwards/)
    assert.match(warnings, /written THROUGH md/)
    assert.match(warnings, /matches the checksum btrfs stored/)
    assert.match(warnings, /Nothing else on the array is touched/)
    assert.match(warnings, /left exactly as it is/)
    const code = first.headers['x-anas-confirm-code'] as string
    assert.ok(code)
    assert.ok(first.headers['x-anas-confirm-expires'])
    // Nothing was touched on the 409 — the read layer and the stat, and that is all.
    assert.deepEqual(executor.calls.filter(c => ['/usr/bin/dd', '/usr/bin/tee', '/usr/bin/btrfs'].includes(c.command) && c.args[0] === 'subvolume'), [])
    assert.ok(!executor.calls.some(c => c.command === '/usr/bin/dd'))

    const second = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload })
    assert.equal(second.statusCode, 202)
    const ref = second.json().job
    assert.equal(ref.operation, 'ahr.repair')
    const job = await waitForJob(server, ref.id)
    // The engine cannot resolve anything against a mock read layer, so every
    // block comes back unrepairable with its reason — which is the point: a
    // block that cannot be proven is never reported as repaired, and a failing
    // engine never fails the JOB.
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const result = job.result as { pool: string, repaired: number, unrepairable: number, aboveMd: number, blocks: number, files: { path: string, blocks: { block: number }[] }[] }
    assert.equal(result.pool, 'ahr0')
    assert.equal(result.blocks, 2)
    assert.equal(result.repaired, 0)
    assert.equal(result.repaired + result.unrepairable + result.aboveMd, result.blocks)
    assert.equal(result.files[0].path, FILE)
    assert.deepEqual(result.files[0].blocks.map(b => b.block), [12, 300])
    await server.close()
  })

  it('a confirm code minted for one selection does not authorize another', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE, `${MOUNTPOINT}/other.bin`]))
    const first = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    const code = first.headers['x-anas-confirm-code'] as string
    const swapped = await server.inject({
      method: 'POST',
      url: '/v1/ahr/ahr0/repair',
      headers: { ...JSON_HEADERS, 'x-anas-confirm': code },
      payload: body([{ path: `${MOUNTPOINT}/other.bin`, blocks: [300] }]),
    })
    assert.equal(swapped.statusCode, 409)
    assert.equal(swapped.json().error.code, 'CONFIRMATION_REQUIRED')
    await server.close()
  })
})
