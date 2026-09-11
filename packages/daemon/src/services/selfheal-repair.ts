import type {
  AhrPool,
  SelfhealDiagnostics,
  SelfhealMapping,
  SelfhealOutcome,
  SelfhealOutcomeKind,
  SelfhealReconstruction,
  SelfhealStep,
  SelfhealStepName,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { AhrSnapshotOptions } from './ahr-snapshots.js'
import type { MdGeometry, MemberLocation, ResolvedBlock, SelfhealContext } from './selfheal-map.js'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import {
  createAhrSnapshot,
  deleteAhrSnapshot,
  listAhrSnapshots,
  SUBVOL_DATA,
  SUBVOL_SNAPSHOTS,
  topLevelMountPath,
  withTopLevelMount,
} from './ahr-snapshots.js'
import { crc32c, csumHex, readStoredCsum } from './selfheal-csum.js'
import {
  BLOCK_BYTES,
  dropCaches,
  probeFileBlock,
  readDirect,
  readDiscard,
  readMdAttr,
  readMdAttrOrNull,
  sleep,
  writeDirect,
  writeMdAttr,
} from './selfheal-io.js'
import {
  parseDmTable,
  resolveBlock,
  resolveContext,
  SelfhealMapError,
  stripeDataOrder,
  subvolumeIdOf,
} from './selfheal-map.js'

/**
 * The AHR self-heal REPAIR ENGINE (story selfheal.5) — btrfs's checksum
 * arbitrating an md reconstruction, for ONE 4 KiB file block.
 *
 * md knows which disks hold a parity group; btrfs knows what the bytes in it
 * should be. Neither alone can fix silent rot: md's `repair` would happily
 * recompute parity over the junk, and btrfs on a single device has no second
 * copy to fall back to. Put together, the corrupt block is reconstructed from
 * the siblings and the reconstruction is only accepted if it matches the
 * stored crc32c.
 *
 * ## The sequence, and why it is in this order
 *
 * ```
 *  gates       degraded / resyncing / reshaping / recovering / pvmove, and a
 *              top-level mount already held by another job ⇒ refuse
 *  pin         transient read-only snapshot (backup2.3 lifecycle) — through
 *              `ahr-snapshots.ts` for a §12 pool, in place for a flat one
 *  resolve     re-resolve the block AFTER pinning, through the ONE mapping helper
 *  reverify    the bytes AT THE COMPUTED MEMBER LOCATION must FAIL the stored
 *              csum — otherwise "not corrupt here" and nothing is written
 *  precheck    bounded md check over the stripe; mismatch_cnt == 0 while the
 *              block is corrupt ⇒ parity agrees with the bad data ⇒ above-md
 *  rmw         rmw_level = 0 for the write window (GT-7/GT-14)
 *  reconstruct XOR (RAID5) / P-XOR then Q syndrome (RAID6) / the other legs (RAID1)
 *  arbitrate   crc32c(candidate) vs the stored csum — the whole claim of the epic
 *  guard       the md block at the computed offset must equal the member bytes
 *  write       the winner through md, O_DIRECT + fsync
 *  postcheck   bounded check again; anything but 0 is a failure, not a success
 *  coldread    the block through the FRESH SNAPSHOT, O_DIRECT
 *  finally     restore rmw_level / sync_min / sync_max / stripe_cache_size,
 *              destroy the snapshot
 * ```
 *
 * **Why `rmw_level = 0`.** At the default, a write-through of the corrected
 * block does read-modify-write: md reads the OLD (junk) block off the member,
 * xors it out of parity and xors the new one in — restoring the data and
 * poisoning the parity, so failing any other member of that stripe then
 * reconstructs one wrong block (GT-7, and GT-14: this happens whenever the
 * stripe is cache-cold, which is the real-world case). At `rmw_level=0` md
 * takes the reconstruct-write path and rebuilds the whole group.
 *
 * **Why the pin, and why re-resolve after it.** The snapshot freezes the
 * extent under repair for the run: btrfs is copy-on-write, and a file rewritten
 * between the resolve and the write would leave the engine repairing a block
 * that is no longer part of it. It is also the cold-read path at the end — a
 * fresh snapshot's inodes have no page cache behind them, so the final read
 * genuinely goes to the disks. Everything is resolved AFTER the snapshot
 * exists so the mapping describes the pinned state. On a §12 pool the pin IS an
 * AHR snapshot — same `@snapshots` home, same on-demand top-level mount, same
 * verbs (see {@link Pin}) — so there is one snapshot machinery on this
 * filesystem and not two.
 *
 * **Why the trees are never dumped.** Every btrfs lookup the engine makes is a
 * key-directed walk of a handful of 16 KiB nodes (`selfheal-btree.ts`).
 * `dump-tree -t 7` on an 80 TB pool is tens of gigabytes; through the
 * executor's buffer it is not a slow path, it is no path at all.
 *
 * **Why a failed post-check is `unrepairable`.** A repaired data block over a
 * stripe md still disagrees with is worse than an unrepaired one: it reads
 * correct today and reconstructs wrong the day a disk dies. The engine says so.
 *
 * ## What this cut does NOT repair (by design, all `unrepairable`)
 *
 *  - Extents with no stored csum — NOCOW, prealloc, `nodatasum`. Nothing to
 *    arbitrate against; a reconstruction could not be told from junk.
 *  - More than one corrupt on-disk sector inside ONE compressed blob. The
 *    repair unit for a compressed extent is the whole blob and a single
 *    reconstruction covers one sector of it.
 *  - Two corrupt blocks in one RAID5 stripe (the reconstruction then fails
 *    arbitration, which is the point of arbitrating).
 *  - Corruption that arrived THROUGH md — reported as `above-md`, never
 *    "repaired": parity agrees with the bad data, so there is no source of
 *    truth left below the csum tree.
 */

/** What the caller asks to be repaired. */
export interface SelfhealRepairRequest {
  /** The pool's mountpoint — the subvolume the file is reached through. */
  mountpoint: string
  /** Absolute path of the file, under `mountpoint`. */
  file: string
  /** 4 KiB file block index. */
  block: number
  /**
   * The AHR pool, when the caller has it (selfheal.6 does; the dev entry point
   * resolves it from the topology). A §12 pool — `subvolLayout` — pins through
   * the SAME `@snapshots` machinery every other AHR snapshot goes through; a
   * flat pool, or no pool at all, falls back to an in-place snapshot.
   */
  pool?: AhrPool | null
}

/** Knobs the caller may turn; all of them have honest defaults. */
export interface SelfhealRepairOptions {
  /**
   * Called immediately BEFORE each step. Throwing from it aborts the sequence
   * with the full cleanup still running — which is how both the unit tests and
   * the selfheal.2 suite's case 4 prove that every md knob is restored and no
   * transient snapshot survives, at EVERY step boundary.
   */
  beforeStep?: (name: SelfhealStepName) => void | Promise<void>
  /** Seconds a bounded md check may take before the engine gives up. */
  checkTimeoutSeconds?: number
  /** Stripes swept either side of the target when evicting md's stripe cache. */
  evictSpan?: number
  /** Passed straight to the AHR snapshot service (tests point its runtime dir at a temp path). */
  ahrSnapshotOptions?: AhrSnapshotOptions
  /**
   * Milliseconds waited after a bounded check ends before `mismatch_cnt` is
   * read. The default is what the kernel needs (the counter finalizes slightly
   * after `sync_action` flips to idle — read it sooner and you get the PREVIOUS
   * check's number); a fake md in a unit test needs none of it.
   */
  settleMs?: number
}

/** An engine run that ended in something other than one of the four verdicts. */
export class SelfhealRunError extends Error {
  constructor(
    message: string,
    readonly steps: SelfhealStep[],
    readonly diagnostics: SelfhealDiagnostics,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'SelfhealRunError'
  }
}

/** Internal: stop the sequence with one of the four verdicts. */
class Verdict extends Error {
  constructor(readonly kind: SelfhealOutcomeKind, message: string) {
    super(message)
    this.name = 'Verdict'
  }
}

const BTRFS = '/usr/bin/btrfs'
const DMSETUP = '/usr/sbin/dmsetup'
const FINDMNT = '/usr/bin/findmnt'

/** Leading slashes of a `subvolid-resolve` answer. */
const LEADING_SLASH_RE = /^\/+/

/** Prefix of the engine's transient snapshots — its own sweep, nobody else's. */
export const SELFHEAL_SNAPSHOT_PREFIX = 'anas-selfheal-'

/** `array_state` values a repair refuses to write under, with the reason. */
const REFUSED_ARRAY_STATES: Record<string, string> = {
  'inactive': 'the array is inactive',
  'clear': 'the array holds no data yet',
  'readonly': 'the array is read-only',
  'read-auto': 'the array is read-auto (no write has been issued yet)',
  'suspended': 'the array is suspended',
  'broken': 'the array is broken',
}

/** Default seconds a bounded md check may take. */
export const SELFHEAL_CHECK_TIMEOUT_SECONDS = 180

/** Default stripes swept either side of the target during a stripe-cache evict. */
export const SELFHEAL_EVICT_SPAN = 200

/**
 * The floor md accepts for `stripe_cache_size` — below it the write is
 * rejected with EINVAL (probed live). Shrinking to it is what discards the
 * cache; see {@link evictStripeCache}.
 */
const STRIPE_CACHE_FLOOR = '17'

/** Milliseconds `mismatch_cnt` needs to finalize after `sync_action` goes idle. */
const MISMATCH_SETTLE_MS = 1000

/** Trailing slashes of a mountpoint argument. */
const TRAILING_SLASH_RE = /\/+$/
/** Run of whitespace — `sync_completed` prints `<done> / <total>`. */
const WHITESPACE_RE = /\s+/
/** A bare non-negative integer. */
const INTEGER_RE = /^\d+$/

// ---------------------------------------------------------------------------
//  md bounded check
// ---------------------------------------------------------------------------

/** Per-member sectors one stripe occupies. RAID1 has no stripe: a 64 KiB window. */
function windowSectors(geo: MdGeometry): number {
  return geo.raid1 ? 128 : geo.chunkBytes / 512
}

/**
 * Evict md's stripe cache around a stripe so a bounded check reads the MEMBERS.
 *
 * Neither half is sufficient alone (probed live for selfheal.2): a sequential
 * sweep at the default cache size never evicts the target, because released
 * stripes are reused LIFO and only a few slots cycle; and shrinking
 * `stripe_cache_size` discards cached stripes but KEEPS the most recent
 * seventeen — a stripe just written through md survives it. Shrink, then sweep
 * while the cache is small, then restore. Without this a check over a
 * recently-touched stripe compares pre-corruption content and reports
 * `mismatch_cnt = 0` while the member block is junk.
 */
async function evictStripeCache(
  executor: CommandExecutor,
  geo: MdGeometry,
  stripe: number,
  span: number,
): Promise<void> {
  const original = await readMdAttrOrNull(geo.sys, 'stripe_cache_size')
  if (original === null)
    return // RAID1 has no stripe cache
  await writeMdAttr(geo.sys, 'stripe_cache_size', STRIPE_CACHE_FLOOR)
  try {
    const dataDisks = geo.raidDisks - (geo.raid6 ? 2 : 1)
    const memberSectors = Number(await readMdAttr(geo.sys, 'rd0/size'))
    const dataSectors = memberSectors - geo.dataOffsets[0] / 512
    const lastStripe = Math.floor(dataSectors / windowSectors(geo))
    for (let s = Math.max(0, stripe - span); s < Math.min(stripe + span + 1, lastStripe); s++) {
      if (s === stripe)
        continue
      await readDiscard(executor, geo.device, s * dataDisks * geo.chunkBytes, geo.chunkBytes)
    }
  }
  finally {
    await writeMdAttr(geo.sys, 'stripe_cache_size', original)
  }
}

/**
 * Run an md `check` bounded to one stripe and return its `mismatch_cnt`.
 *
 * GT-5/GT-13: a check that reaches `sync_max` before the device end SUSPENDS
 * with `sync_action` still reading `check` — writing `idle` mid-operation is
 * refused (EBUSY), but once `sync_completed >= sync_max` it is accepted and
 * ends the op scoped to the window. And `mismatch_cnt` finalizes slightly
 * AFTER the op ends, so reading it immediately returns the previous check's
 * count — hence the settle.
 */
export async function boundedWindowCheck(
  executor: CommandExecutor,
  geo: MdGeometry,
  stripe: number,
  options?: SelfhealRepairOptions,
): Promise<number> {
  await evictStripeCache(executor, geo, stripe, options?.evictSpan ?? SELFHEAL_EVICT_SPAN)
  const per = windowSectors(geo)
  const low = stripe * per
  const high = (stripe + 1) * per
  await writeMdAttr(geo.sys, 'sync_min', String(low))
  await writeMdAttr(geo.sys, 'sync_max', String(high))
  await writeMdAttr(geo.sys, 'sync_action', 'check')

  const cap = options?.checkTimeoutSeconds ?? SELFHEAL_CHECK_TIMEOUT_SECONDS
  let ended = false
  for (let i = 0; i < cap * 2 && !ended; i++) {
    if ((await readMdAttr(geo.sys, 'sync_action')) === 'idle') {
      ended = true
      break
    }
    const completed = (await readMdAttr(geo.sys, 'sync_completed')).split(WHITESPACE_RE)[0]
    if (INTEGER_RE.test(completed) && Number(completed) >= high) {
      try {
        await writeMdAttr(geo.sys, 'sync_action', 'idle')
        ended = true
        break
      }
      catch {
        // EBUSY: the op has not reached the boundary yet after all — poll on.
      }
    }
    await sleep(500)
  }
  if (!ended)
    throw new Error(`bounded md check over stripe ${stripe} did not settle within ${cap}s`)

  await sleep(options?.settleMs ?? MISMATCH_SETTLE_MS)
  const mismatch = Number(await readMdAttr(geo.sys, 'mismatch_cnt'))
  await restoreSyncKnobs(geo)
  return mismatch
}

/**
 * Put `sync_min` / `sync_max` back the way md ships them.
 *
 * A suspended bounded op has to be widened and ended first: the knob PERSISTS,
 * and a later full check would stop at the old boundary again and silently
 * cover a sliver of the array (GT-13, the trap).
 */
export async function restoreSyncKnobs(geo: MdGeometry): Promise<void> {
  try {
    const action = await readMdAttr(geo.sys, 'sync_action')
    const completed = (await readMdAttr(geo.sys, 'sync_completed')).split(WHITESPACE_RE)[0]
    if (action !== 'idle' && action !== 'none' && INTEGER_RE.test(completed)) {
      await writeMdAttr(geo.sys, 'sync_max', 'max')
      await writeMdAttr(geo.sys, 'sync_action', 'idle')
    }
  }
  catch {
    // Fall through to the unconditional restore below — it is what matters.
  }
  await writeMdAttr(geo.sys, 'sync_min', '0')
  await writeMdAttr(geo.sys, 'sync_max', 'max')
}

// ---------------------------------------------------------------------------
//  GF(2^8) — the RAID6 Q syndrome
// ---------------------------------------------------------------------------

/**
 * GF(2^8) exponent / log tables for md's RAID6 field: generator 2, primitive
 * polynomial x⁸+x⁴+x³+x²+1 (0x11D), the same one `lib/raid6` uses.
 *
 * Q for a stripe is `Σ gᵈ · Dᵈ` over the data disks in md's STRIPE ORDER — d
 * counting from the first data disk after Q, which is precisely the
 * `dataIndex` the mapping helper carries. Verified live against a RAID6 loop
 * rig (7 members, chunk 64 K, left-symmetric): the computed P and Q matched the
 * P and Q members byte-for-byte on three different stripes, and the Q-only
 * reconstruction of a data member reproduced it exactly.
 */
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if ((x & 0x100) !== 0)
      x ^= 0x11D
  }
  for (let i = 255; i < 512; i++)
    GF_EXP[i] = GF_EXP[i - 255]
}

/** Multiply in GF(2^8). */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0)
    return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/** `2^n` in GF(2^8) — the Q coefficient of the n-th data disk of a stripe. */
export function gfPow2(n: number): number {
  return GF_EXP[n % 255]
}

/** Multiplicative inverse in GF(2^8). */
export function gfInv(a: number): number {
  if (a === 0)
    throw new Error('GF(2^8): 0 has no inverse')
  return GF_EXP[(255 - GF_LOG[a]) % 255]
}

/** XOR `b` into `a`, in place. */
function xorInto(a: Buffer, b: Buffer): void {
  for (let i = 0; i < a.length; i++)
    a[i] ^= b[i]
}

/**
 * Reconstruct one data block from the Q syndrome and the surviving data blocks.
 *
 * `blocks` is keyed by data index (position in md's stripe order); the entry at
 * `missing` is ignored. P is not consulted at all, which is the point: this is
 * the path for a stripe whose P member is ALSO bad.
 */
export function reconstructFromQ(blocks: (Buffer | null)[], q: Buffer, missing: number): Buffer {
  const partial = Buffer.alloc(q.length)
  for (let d = 0; d < blocks.length; d++) {
    const block = blocks[d]
    if (d === missing || !block)
      continue
    const coefficient = gfPow2(d)
    for (let i = 0; i < partial.length; i++)
      partial[i] ^= gfMul(coefficient, block[i])
  }
  const inverse = gfInv(gfPow2(missing))
  const out = Buffer.alloc(q.length)
  for (let i = 0; i < out.length; i++)
    out[i] = gfMul(inverse, partial[i] ^ q[i])
  return out
}

// ---------------------------------------------------------------------------
//  The sequence
// ---------------------------------------------------------------------------

interface Candidate {
  bytes: Buffer
  how: SelfhealReconstruction
  detail: string
}

/**
 * Repair one 4 KiB block. Never throws for a verdict — the four buckets are
 * all returned as an outcome; it throws only for an internal failure (and for
 * whatever `beforeStep` throws), with the partial steps attached.
 */
export async function repairBlock(
  executor: CommandExecutor,
  request: SelfhealRepairRequest,
  options?: SelfhealRepairOptions,
): Promise<SelfhealOutcome> {
  const steps: SelfhealStep[] = []
  const diagnostics: SelfhealDiagnostics = { cleanupErrors: [] }

  const file = isAbsolute(request.file) ? request.file : join(request.mountpoint, request.file)
  const mountpoint = request.mountpoint.replace(TRAILING_SLASH_RE, '')
  if (relative(resolvePath(mountpoint), resolvePath(file)).startsWith('..'))
    throw new SelfhealRunError(`${file} is not under ${mountpoint}`, steps, diagnostics)

  let pin: Pin | null = null
  let geometry: MdGeometry | null = null
  let savedRmwLevel: string | null = null
  let savedStripeCache: string | null = null

  /** The step currently running — what `note` annotates and `fail` marks failed. */
  let current: SelfhealStep | null = null

  async function step(name: SelfhealStepName): Promise<void> {
    await options?.beforeStep?.(name)
    current = { name, ok: true }
    steps.push(current)
  }

  /** Record what the current step observed. */
  function note(detail: string): void {
    if (current)
      current.detail = detail
  }

  function fail(kind: SelfhealOutcomeKind, reason: string): never {
    if (current) {
      current.ok = false
      current.detail = reason
    }
    throw new Verdict(kind, reason)
  }

  try {
    // ---- gates ----------------------------------------------------------
    await step('gates')
    const context = await resolveContext(executor, mountpoint)
    geometry = context.geometry
    savedStripeCache = await readMdAttrOrNull(geometry.sys, 'stripe_cache_size')
    const refusal = await gateRefusal(executor, context, request.pool ?? null, options)
    if (refusal)
      fail('unrepairable', `refused: ${refusal}`)

    // ---- pin ------------------------------------------------------------
    await step('pin')
    try {
      pin = await takePin(executor, mountpoint, file, request.pool ?? null, diagnostics, options)
    }
    catch (error) {
      throw new SelfhealRunError(`cannot pin ${mountpoint}: ${errorText(error)}`, steps, diagnostics, { cause: error })
    }
    note(pin.describe)

    // ---- resolve (AFTER the pin, so the mapping describes the pinned state)
    await step('resolve')
    const pinned = await resolveContext(executor, mountpoint)
    geometry = pinned.geometry
    const resolved = await resolveBlock(executor, pinned, file, request.block)
    diagnostics.mapping = mappingOf(resolved, pinned.geometry)
    note(`m${resolved.sectors[0].memberIndex}@${resolved.sectors[0].memberOffset} `
      + `md@${resolved.sectors[0].mdByte} stripe ${resolved.sectors[0].stripe ?? 'n/a'}`)

    // ---- reverify -------------------------------------------------------
    await step('reverify')
    const verdict = await reverify(executor, pinned, resolved)
    diagnostics.badSectors = verdict.badSectors
    if (verdict.abort)
      fail(verdict.abort.kind, verdict.abort.reason)
    const target = resolved.sectors[verdict.badSectors[0]]
    const corruptBytes = verdict.corruptBytes
    const storedCsum = verdict.storedCsum
    diagnostics.storedCsum = csumHex(storedCsum)
    if (verdict.badMirror !== null && diagnostics.mapping) {
      diagnostics.mapping.memberIndex = verdict.badMirror
      diagnostics.mapping.memberDevice = pinned.geometry.members[verdict.badMirror] as string
    }

    // ---- precheck -------------------------------------------------------
    await step('precheck')
    const stripe = target.stripe ?? Math.floor(target.mdByte / (windowSectors(pinned.geometry) * 512))
    const before = await boundedWindowCheck(executor, pinned.geometry, stripe, options)
    diagnostics.precheckMismatch = before
    note(`mismatch_cnt=${before}`)
    if (before === 0) {
      fail('above-md', `the bounded md check over stripe ${stripe} reports mismatch_cnt=0 while the block fails its stored csum — parity agrees with the bad data, which implicates something other than the disks. Nothing was written.`)
    }

    // ---- rmw ------------------------------------------------------------
    await step('rmw')
    savedRmwLevel = await readMdAttrOrNull(pinned.geometry.sys, 'rmw_level')
    if (savedRmwLevel !== null)
      await writeMdAttr(pinned.geometry.sys, 'rmw_level', '0')

    // ---- reconstruct ----------------------------------------------------
    await step('reconstruct')
    const candidates = await reconstruct(executor, pinned.geometry, target, verdict.goodMirrors)
    if (candidates.length === 0)
      fail('unrepairable', `no candidate could be reconstructed for ${file} block ${request.block}`)
    note(candidates.map(c => c.how).join(', '))

    // ---- arbitrate ------------------------------------------------------
    await step('arbitrate')
    let winner: Candidate | null = null
    const tried: string[] = []
    for (const candidate of candidates) {
      const value = crc32c(candidate.bytes)
      tried.push(`${candidate.how}=${csumHex(value)}`)
      if (value === storedCsum) {
        winner = candidate
        diagnostics.candidateCsum = csumHex(value)
        diagnostics.reconstruction = candidate.how
        break
      }
    }
    note(`${tried.join(' ')} stored=${csumHex(storedCsum)}`)
    if (!winner) {
      fail('unrepairable', `no reconstruction matches the stored csum ${csumHex(storedCsum)} (tried ${tried.join(', ')}) — more than one block of this stripe is damaged. Restore ${file} from backup.`)
    }

    // ---- guard ----------------------------------------------------------
    await step('guard')
    const throughMd = await readDirect(executor, pinned.geometry.device, target.mdByte, BLOCK_BYTES)
    if (!throughMd.equals(corruptBytes)) {
      fail('unrepairable', `read-back guard failed: the md block at ${target.mdByte} does not match the bytes read from ${target.memberDevice} at ${target.memberOffset}. The mapping and the array disagree; nothing was written.`)
    }

    // ---- write ----------------------------------------------------------
    await step('write')
    await writeDirect(executor, pinned.geometry.device, target.mdByte, winner.bytes)

    // ---- postcheck ------------------------------------------------------
    await step('postcheck')
    const after = await boundedWindowCheck(executor, pinned.geometry, stripe, options)
    diagnostics.postcheckMismatch = after
    note(`mismatch_cnt=${after}`)
    if (after !== 0) {
      fail('unrepairable', `the block was written back but the bounded md check over stripe ${stripe} still reports mismatch_cnt=${after} — the parity group is not consistent. Restore ${file} from backup.`)
    }

    // ---- coldread -------------------------------------------------------
    await step('coldread')
    const bad = await coldRead(executor, pin, resolved)
    if (bad.length > 0) {
      fail('unrepairable', `the repaired region still reads back with an error through a fresh snapshot (blocks ${bad.join(', ')})`)
    }
    note('read back clean through the pin snapshot')

    return outcome('repaired', `${file} block ${request.block} reconstructed from ${winner.detail} and verified against the stored csum ${csumHex(storedCsum)}`)
  }
  catch (error) {
    if (error instanceof Verdict)
      return outcome(error.kind, error.message)
    if (error instanceof SelfhealRunError)
      throw error
    if (error instanceof SelfhealMapError)
      return outcome('mapping-abort', error.message)
    throw new SelfhealRunError(errorText(error), steps, diagnostics, { cause: error })
  }
  finally {
    await cleanup()
  }

  // -- helpers that close over the run's state -----------------------------

  function outcome(kind: SelfhealOutcomeKind, reason: string): SelfhealOutcome {
    const map = diagnostics.mapping
    return {
      outcome: kind,
      reason,
      file,
      block: request.block,
      pool: request.pool?.name ?? null,
      array: geometry?.device ?? null,
      member: map?.memberDevice ?? null,
      stripe: map?.stripe ?? null,
      steps,
      diagnostics,
    }
  }

  async function cleanup(): Promise<void> {
    if (geometry && savedRmwLevel !== null) {
      try {
        await writeMdAttr(geometry.sys, 'rmw_level', savedRmwLevel)
      }
      catch (error) {
        diagnostics.cleanupErrors.push(`rmw_level not restored to ${savedRmwLevel}: ${errorText(error)}`)
      }
    }
    if (geometry) {
      try {
        await restoreSyncKnobs(geometry)
      }
      catch (error) {
        diagnostics.cleanupErrors.push(`sync knobs not restored: ${errorText(error)}`)
      }
      if (savedStripeCache !== null) {
        try {
          if ((await readMdAttrOrNull(geometry.sys, 'stripe_cache_size')) !== savedStripeCache)
            await writeMdAttr(geometry.sys, 'stripe_cache_size', savedStripeCache)
        }
        catch (error) {
          diagnostics.cleanupErrors.push(`stripe_cache_size not restored to ${savedStripeCache}: ${errorText(error)}`)
        }
      }
    }
    if (pin) {
      try {
        await pin.destroy()
      }
      catch (error) {
        diagnostics.cleanupErrors.push(`transient snapshot ${pin.describe} not destroyed: ${errorText(error)}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  Steps
// ---------------------------------------------------------------------------

/** Why this repair must not run right now, or null when it may. */
async function gateRefusal(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  pool: AhrPool | null,
  options?: SelfhealRepairOptions,
): Promise<string | null> {
  const geo = ctx.geometry
  const degraded = await readMdAttrOrNull(geo.sys, 'degraded')
  if (degraded !== null && degraded !== '0') {
    return `${geo.device} is degraded (${degraded} member${degraded === '1' ? '' : 's'} missing) — a reconstruction needs every other member of the stripe`
  }
  if (geo.members.includes(null))
    return `${geo.device} is missing a member — a reconstruction needs every other member of the stripe`

  const action = await readMdAttr(geo.sys, 'sync_action')
  if (action !== 'idle')
    return `${geo.device} is busy (sync_action=${action}) — resync, recovery, reshape and check all move or re-read the bytes this repair depends on`

  const reshape = await readMdAttrOrNull(geo.sys, 'reshape_position')
  if (reshape !== null && reshape !== 'none')
    return `${geo.device} is mid-reshape (reshape_position=${reshape}) — the layout under this block is changing`

  const state = await readMdAttr(geo.sys, 'array_state')
  if (REFUSED_ARRAY_STATES[state])
    return `${geo.device}: ${REFUSED_ARRAY_STATES[state]} (array_state=${state})`

  // An in-flight pvmove replaces the LV's linear target with a mirror and moves
  // extents underneath it: every byte offset this chain computes would be stale.
  const tables = await executor.exec(DMSETUP, ['table'])
  if (tables.exitCode === 0) {
    for (const line of tables.stdout.split('\n')) {
      const name = line.split(':')[0].trim()
      if (name.startsWith('pvmove'))
        return `a pvmove is in flight (${name}) — the physical extents under this pool are moving`
    }
  }
  // Re-parse the pool's own table: a non-linear target here is the other face
  // of the same problem, and parseDmTable refuses it by name.
  const own = await executor.exec(DMSETUP, ['table', ctx.srcDevice])
  if (own.exitCode === 0 && own.stdout.trim()) {
    try {
      parseDmTable(own.stdout)
    }
    catch (error) {
      return errorText(error)
    }
  }

  // A §12 pin needs the pool's on-demand top-level mount, and `withTopLevelMount`
  // serialises on that ONE path: a second holder (a backup run, which keeps every
  // pool's top level mounted across one pbc invocation) would make this repair
  // wait behind it, and a repair that silently blocks for hours is worse than one
  // that says why. Check before pinning rather than racing.
  if (pool?.subvolLayout) {
    const mnt = topLevelMountPath(pool, options?.ahrSnapshotOptions)
    if ((await executor.exec(FINDMNT, ['--mountpoint', mnt])).exitCode === 0)
      return `the top-level mount for pool '${pool.name}' is already held at ${mnt} — a backup or snapshot job is in flight. Repair needs that mount to itself; retry when the other job has finished`
  }
  return null
}

// ---------------------------------------------------------------------------
//  The pin
// ---------------------------------------------------------------------------

/**
 * How this run pinned the block, and how the cold read gets at it.
 *
 * TWO shapes, because AHR has two pool layouts:
 *
 *  - **§12 (`subvolLayout`)** — the pool mounts `@data` at its mountpoint and
 *    keeps `@snapshots` beside it, OUTSIDE the mounted tree. The pin then goes
 *    through the SAME `ahr-snapshots.ts` verbs every other AHR snapshot goes
 *    through — `createAhrSnapshot` / `deleteAhrSnapshot` / `listAhrSnapshots`,
 *    with the cold read reaching `@snapshots/<name>/…` through
 *    `withTopLevelMount`, exactly as a backup run reads its own transients.
 *    One snapshot machinery, one mount discipline, one place to fix.
 *  - **flat pool, or no pool at all** — there is no `@snapshots` to put
 *    anything in, so the pin is a read-only snapshot of the file's own
 *    subvolume placed inside the mountpoint. That is also what the selfheal.2
 *    loop-device rigs are, which is why the suite exercises this branch.
 *
 * Both carry the backup2.3 lifecycle: an `anas-selfheal-<ts>` name, a
 * stale-prefix sweep before taking a new one, destruction in a `finally`, and
 * a leftover that could not be destroyed NAMED in `cleanupErrors` rather than
 * swallowed.
 */
interface Pin {
  /** What to call it in an outcome or an error. */
  describe: string
  /** Read those file blocks cold through the snapshot; returns the ones that failed. */
  coldRead: (blocks: number[]) => Promise<number[]>
  destroy: () => Promise<void>
}

function noProgress(): void {}

/**
 * The `@data`-relative path of the subvolume holding `file`, or null when the
 * file is in `@data` itself.
 *
 * A btrfs read-only snapshot does NOT recurse into nested subvolumes — each is
 * left an empty placeholder (GT-52/55) — so a file inside one has to be pinned
 * by snapshotting THAT subvolume, which is the same reason backup2.3 takes one
 * snapshot per subvolume.
 */
async function nestedSubvolumeOf(
  executor: CommandExecutor,
  pool: AhrPool,
  file: string,
): Promise<string | null> {
  const id = await subvolumeIdOf(executor, file)
  const r = await executor.exec(BTRFS, ['inspect-internal', 'subvolid-resolve', String(id), pool.mountpoint])
  if (r.exitCode !== 0)
    throw new Error(`cannot resolve subvolume ${id} of ${file}: ${r.stderr.trim()}`)
  const resolved = r.stdout.trim().replace(LEADING_SLASH_RE, '')
  if (resolved === SUBVOL_DATA)
    return null
  if (resolved.startsWith(`${SUBVOL_DATA}/`))
    return resolved.slice(SUBVOL_DATA.length + 1)
  throw new Error(`${file} resolves to '${resolved}', which is not under ${SUBVOL_DATA} — it is not in the pool's mounted tree`)
}

/** Take the transient pin, sweeping any leftover of a crashed earlier run first. */
async function takePin(
  executor: CommandExecutor,
  mountpoint: string,
  file: string,
  pool: AhrPool | null,
  diagnostics: SelfhealDiagnostics,
  options?: SelfhealRepairOptions,
): Promise<Pin> {
  const name = `${SELFHEAL_SNAPSHOT_PREFIX}${Math.floor(Date.now() / 1000)}`
  const ahrOptions = options?.ahrSnapshotOptions

  if (pool?.subvolLayout && pool.mounted) {
    for (const stale of await listAhrSnapshots(executor, pool, ahrOptions)) {
      if (!stale.name.startsWith(SELFHEAL_SNAPSHOT_PREFIX))
        continue
      try {
        await deleteAhrSnapshot(executor, pool, stale.name, noProgress, ahrOptions)
      }
      catch (error) {
        diagnostics.cleanupErrors.push(`stale transient snapshot ${pool.name}:${SUBVOL_SNAPSHOTS}/${stale.name} could not be swept: ${errorText(error)}`)
      }
    }
    const nested = await nestedSubvolumeOf(executor, pool, file)
    await createAhrSnapshot(executor, pool, name, noProgress, {
      ...ahrOptions,
      ...(nested ? { subvolume: nested } : {}),
    })
    // The file's path INSIDE the snapshot is relative to the subvolume that was
    // snapshotted, not to the pool mountpoint.
    const base = nested ? join(mountpoint, nested) : mountpoint
    const within = relative(base, file)
    return {
      describe: `${pool.name}:${SUBVOL_SNAPSHOTS}/${name}`,
      coldRead: async (blocks) => {
        return withTopLevelMount(executor, pool, async (top) => {
          const path = join(top, SUBVOL_SNAPSHOTS, name, within)
          const bad: number[] = []
          for (const block of blocks) {
            if (!(await probeFileBlock(executor, path, block)))
              bad.push(block)
          }
          return bad
        }, ahrOptions)
      },
      destroy: async () => {
        await deleteAhrSnapshot(executor, pool, name, noProgress, ahrOptions)
      },
    }
  }

  // Flat pool (or no pool): no @snapshots to put it in, so the snapshot goes
  // inside the mountpoint and is swept from there.
  await sweepStaleSnapshots(executor, mountpoint, diagnostics)
  const path = join(mountpoint, name)
  const r = await executor.exec(BTRFS, ['subvolume', 'snapshot', '-r', mountpoint, path])
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `btrfs subvolume snapshot exited ${r.exitCode}`)
  const within = relative(mountpoint, file)
  return {
    describe: path,
    coldRead: async (blocks) => {
      const bad: number[] = []
      for (const block of blocks) {
        if (!(await probeFileBlock(executor, join(path, within), block)))
          bad.push(block)
      }
      return bad
    },
    destroy: async () => {
      const d = await executor.exec(BTRFS, ['subvolume', 'delete', path])
      if (d.exitCode !== 0)
        throw new Error(d.stderr.trim() || `btrfs subvolume delete exited ${d.exitCode}`)
    },
  }
}

/** Destroy leftovers of a crashed earlier run — this engine's own prefix only. */
async function sweepStaleSnapshots(
  executor: CommandExecutor,
  mountpoint: string,
  diagnostics: SelfhealDiagnostics,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(mountpoint)
  }
  catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(SELFHEAL_SNAPSHOT_PREFIX))
      continue
    const r = await executor.exec(BTRFS, ['subvolume', 'delete', join(mountpoint, entry)])
    if (r.exitCode !== 0)
      diagnostics.cleanupErrors.push(`stale transient snapshot ${entry} could not be swept: ${r.stderr.trim()}`)
  }
}

interface Reverified {
  /** Indexes (within the repair unit) of the on-disk sectors that failed their csum. */
  badSectors: number[]
  /** The corrupt bytes as read from the member — the read-back guard compares against these. */
  corruptBytes: Buffer
  /** The stored csum of the sector under repair. */
  storedCsum: number
  /** RAID1: the leg that failed; null on parity levels. */
  badMirror: number | null
  /** RAID1: legs that still pass their csum — the candidate source. */
  goodMirrors: number[]
  /** Set when the sequence must stop here. */
  abort: { kind: SelfhealOutcomeKind, reason: string } | null
}

/**
 * Re-read the bytes AT THE COMPUTED MEMBER LOCATION and require they FAIL the
 * current stored csum.
 *
 * This is what makes a wrong mapping harmless: pointed at a healthy block that
 * happens to hold identical content (a zero-filled region of an image, say),
 * the engine finds a passing csum and aborts with "not corrupt here" instead of
 * writing a correct-looking block over a healthy one.
 */
async function reverify(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  resolved: ResolvedBlock,
): Promise<Reverified> {
  const geo = ctx.geometry
  const badSectors: number[] = []
  let corruptBytes: Buffer = Buffer.alloc(0)
  let storedCsum = 0
  let badMirror: number | null = null
  let goodMirrors: number[] = []

  for (let k = 0; k < resolved.sectors.length; k++) {
    const location = resolved.sectors[k]
    const stored = await readStoredCsum(executor, ctx, location.logical)
    if (stored === null) {
      return {
        badSectors,
        corruptBytes,
        storedCsum,
        badMirror,
        goodMirrors,
        abort: {
          kind: 'unrepairable',
          reason: `btrfs stored no checksum for logical byte ${location.logical} (a NOCOW file, a prealloc extent, or nodatasum) — there is nothing to arbitrate a reconstruction against. Restore ${resolved.file} from backup.`,
        },
      }
    }
    if (geo.raid1) {
      const good: number[] = []
      let bad: number | null = null
      for (const leg of location.mirrors) {
        const device = geo.members[leg] as string
        const bytes = await readMemberWithRetry(executor, device, location.memberOffset, stored)
        if (crc32c(bytes.value) === stored) {
          good.push(leg)
        }
        else if (bad === null) {
          bad = leg
          corruptBytes = bytes.value
          storedCsum = stored
        }
      }
      if (bad !== null) {
        badSectors.push(k)
        badMirror = bad
        goodMirrors = good
      }
    }
    else {
      const bytes = await readDirect(executor, location.memberDevice, location.memberOffset, BLOCK_BYTES)
      if (crc32c(bytes) !== stored) {
        badSectors.push(k)
        if (badSectors.length === 1) {
          corruptBytes = bytes
          storedCsum = stored
        }
      }
    }
  }

  if (badSectors.length === 0) {
    return {
      badSectors,
      corruptBytes,
      storedCsum,
      badMirror,
      goodMirrors,
      abort: {
        kind: 'mapping-abort',
        reason: `not corrupt here: the content at (m${resolved.sectors[0].memberIndex}, ${resolved.sectors[0].memberOffset}) passes the stored csum for ${resolved.file} block ${resolved.block}. Nothing was written.`,
      },
    }
  }
  if (badSectors.length > 1) {
    return {
      badSectors,
      corruptBytes,
      storedCsum,
      badMirror,
      goodMirrors,
      abort: {
        kind: 'unrepairable',
        reason: `${badSectors.length} on-disk sectors of one ${resolved.compressed ? 'compressed blob' : 'extent'} fail their stored csum (sectors ${badSectors.join(', ')}) — this cut reconstructs one sector at a time. Restore ${resolved.file} from backup.`,
      },
    }
  }
  if (geo.raid1 && goodMirrors.length === 0) {
    return {
      badSectors,
      corruptBytes,
      storedCsum,
      badMirror,
      goodMirrors,
      abort: {
        kind: 'unrepairable',
        reason: `every mirror leg fails the stored csum for ${resolved.file} block ${resolved.block} — there is no good copy left. Restore from backup.`,
      },
    }
  }
  return { badSectors, corruptBytes, storedCsum, badMirror, goodMirrors, abort: null }
}

/**
 * Read one member block, retrying a read whose content does not pass the csum.
 *
 * A mirror leg can hand back a TORN read (a write that landed on one leg while
 * the read was in flight) which is not rot and passes on the next attempt.
 * Three tries, then whatever the last one said.
 */
async function readMemberWithRetry(
  executor: CommandExecutor,
  device: string,
  offset: number,
  stored: number,
): Promise<{ value: Buffer, attempts: number }> {
  let last: Buffer = Buffer.alloc(0)
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await readDirect(executor, device, offset, BLOCK_BYTES)
    if (crc32c(last) === stored)
      return { value: last, attempts: attempt }
  }
  return { value: last, attempts: 3 }
}

/**
 * Build every candidate for the corrupt block, best first.
 *
 * RAID5 has exactly one: the XOR of the same stripe row on every other member.
 * RAID6 has two — the P-based XOR (all members but the bad one and Q), and, if
 * that fails arbitration because P is ALSO damaged, the Q syndrome solve which
 * never touches P. RAID1's candidates are the surviving legs themselves.
 */
async function reconstruct(
  executor: CommandExecutor,
  geo: MdGeometry,
  target: MemberLocation,
  goodMirrors: number[],
): Promise<Candidate[]> {
  if (geo.raid1) {
    const out: Candidate[] = []
    for (const leg of goodMirrors) {
      const device = geo.members[leg] as string
      out.push({
        bytes: await readDirect(executor, device, target.memberOffset, BLOCK_BYTES),
        how: 'mirror',
        detail: `the copy on ${device}`,
      })
    }
    return out
  }

  const stripe = target.stripe as number
  const row = async (member: number): Promise<Buffer> => {
    const device = geo.members[member] as string
    const offset = geo.dataOffsets[member] + stripe * geo.chunkBytes + (target.mdByte % geo.chunkBytes)
    return readDirect(executor, device, offset, BLOCK_BYTES)
  }

  if (!geo.raid6) {
    const candidate = Buffer.alloc(BLOCK_BYTES)
    for (let i = 0; i < geo.raidDisks; i++) {
      if (i === target.memberIndex)
        continue
      xorInto(candidate, await row(i))
    }
    return [{
      bytes: candidate,
      how: 'xor',
      detail: `the XOR of the other ${geo.raidDisks - 1} members of stripe ${stripe}`,
    }]
  }

  const qIndex = target.qIndex as number
  const pXor = Buffer.alloc(BLOCK_BYTES)
  for (let i = 0; i < geo.raidDisks; i++) {
    if (i === target.memberIndex || i === qIndex)
      continue
    xorInto(pXor, await row(i))
  }

  const order = stripeDataOrder(geo, stripe)
  const dataBlocks: (Buffer | null)[] = []
  for (let d = 0; d < order.length; d++)
    dataBlocks.push(order[d] === target.memberIndex ? null : await row(order[d]))
  const qBytes = await row(qIndex)
  const missing = target.dataIndex ?? order.indexOf(target.memberIndex)

  return [
    {
      bytes: pXor,
      how: 'p-xor',
      detail: `the P parity of stripe ${stripe} and its other data members`,
    },
    {
      bytes: reconstructFromQ(dataBlocks, qBytes, missing),
      how: 'q-syndrome',
      detail: `the Q syndrome of stripe ${stripe} (P not consulted)`,
    },
  ]
}

/**
 * Read the repaired region back through the FRESH SNAPSHOT, cold.
 *
 * The snapshot's inodes are the cold-read guarantee — a warm page of the live
 * file would answer from memory and hide everything (GT-9a: a live buffered
 * read of a corrupt block SUCCEEDS while the snapshot path EIOs). `drop_caches`
 * and O_DIRECT are defense in depth on top of that. For a compressed extent
 * the whole logical extent is read: one corrupt on-disk sector takes out all
 * 128 KiB of it, so the block alone would not prove anything.
 */
async function coldRead(
  executor: CommandExecutor,
  pin: Pin,
  resolved: ResolvedBlock,
): Promise<number[]> {
  await dropCaches(executor)
  const span = resolved.extent.length ?? resolved.extent.ram ?? BLOCK_BYTES
  const blocks = resolved.compressed
    ? Array.from(
        { length: Math.ceil(span / BLOCK_BYTES) },
        (_, i) => Math.floor(resolved.extent.fileOffset / BLOCK_BYTES) + i,
      )
    : [resolved.block]
  return pin.coldRead(blocks)
}

/** The resolved chain, flattened for the outcome's audit trail. */
function mappingOf(resolved: ResolvedBlock, geo: MdGeometry): SelfhealMapping {
  const first = resolved.sectors[0]
  return {
    level: geo.level,
    raidDisks: geo.raidDisks,
    chunkBytes: geo.chunkBytes,
    layout: geo.layout,
    dataOffset: geo.dataOffsets[first.memberIndex],
    logicalByte: resolved.logicalByte,
    blobLogical: resolved.blobLogical,
    blobSectors: resolved.blobSectors,
    compressed: resolved.compressed,
    chunkLogical: first.chunkLogical,
    chunkDevice: first.chunkDevice,
    lvByte: first.lvByte,
    startSector: first.startSector,
    mdByte: first.mdByte,
    memberIndex: first.memberIndex,
    memberDevice: first.memberDevice,
    memberOffset: first.memberOffset,
    parityIndex: first.parityIndex,
    qIndex: first.qIndex,
    stripe: first.stripe,
  }
}

/** An error's message, without a stack, for a field an operator reads. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
