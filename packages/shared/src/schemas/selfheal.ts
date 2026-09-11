import { z } from 'zod'
import { AbsolutePath } from './common.js'

/**
 * Self-heal repair engine schemas (story selfheal.5).
 *
 * The engine is the userspace repair path where the btrfs csum ARBITRATES an
 * md reconstruction: md knows the parity group, btrfs knows what the bytes
 * should be. Everything the engine can say about one 4 KiB block is one of
 * four honest buckets — never "fixed, probably".
 *
 * The vocabulary here is shared because selfheal.6 (the confirm-gated repair
 * job) reports exactly these outcomes per file, and the CLI entry point that
 * drives the selfheal.2 loop-device suite writes the same object.
 */

/**
 * What the engine concluded about one block.
 *
 * - `repaired` — a candidate reconstructed from the other members passed the
 *   stored csum, was written back through md with the parity group rebuilt,
 *   the stripe re-checked clean, and the block read back cold through a fresh
 *   snapshot.
 * - `unrepairable` — there is no source of truth left below the csum tree for
 *   this block (two bad blocks in one stripe, an extent with no csum at all,
 *   a post-check that did not come back clean). Restore from backup.
 * - `above-md` — the stripe's parity AGREES with the bad data, so the
 *   corruption did not arrive from a disk. Nothing is written. The wording is
 *   deliberately "implicates something other than the disks", never a
 *   certainty: md only reports that parity and data are consistent.
 * - `mapping-abort` — the bytes at the computed member location still pass
 *   their stored csum. Either the mapping is wrong or the block was already
 *   repaired; either way the engine refuses to write. "Not corrupt here."
 */
export const SelfhealOutcomeKind = z.enum([
  'repaired',
  'unrepairable',
  'above-md',
  'mapping-abort',
])
export type SelfhealOutcomeKind = z.infer<typeof SelfhealOutcomeKind>

/**
 * The steps of the converged sequence, in order.
 *
 * They are named (and NOT renumbered) because the selfheal.2 suite injects a
 * failure immediately before each one and asserts that every md knob is
 * restored and the transient snapshot destroyed afterwards.
 */
export const SelfhealStepName = z.enum([
  'gates',
  'pin',
  'resolve',
  'reverify',
  'precheck',
  'rmw',
  'reconstruct',
  'arbitrate',
  'guard',
  'write',
  'postcheck',
  'coldread',
])
export type SelfhealStepName = z.infer<typeof SelfhealStepName>

/** One step of the sequence, with what it found. */
export const SelfhealStep = z.object({
  name: SelfhealStepName,
  /** False when this is the step the sequence stopped on. */
  ok: z.boolean(),
  /** What the step observed, in the engine's own words. Never a raw stack. */
  detail: z.string().optional(),
})
export type SelfhealStep = z.infer<typeof SelfhealStep>

/** Which reconstruction produced the candidate that won arbitration. */
export const SelfhealReconstruction = z.enum([
  /** RAID5: XOR of the same member offset on every other member. */
  'xor',
  /** RAID6 with P intact: XOR of every member except the bad one and Q. */
  'p-xor',
  /** RAID6 Q syndrome: GF(2^8) solve for the one missing data block. */
  'q-syndrome',
  /** RAID1: another mirror leg's copy of the same block. */
  'mirror',
])
export type SelfhealReconstruction = z.infer<typeof SelfhealReconstruction>

/**
 * The resolved mapping for one block — the whole chain, kept so an outcome can
 * be audited without re-running it (and so the suite can cross-check the
 * engine's mapping against its own).
 *
 * Every field is the value the engine actually used. `logicalByte` is the
 * btrfs LOGICAL bytenr of the block (GT-2: filefrag's "physical_offset" is
 * this number, NOT a device offset); `lvByte` is after the chunk-tree hop,
 * `mdByte` after the dm linear segment, and `memberOffset` after the md
 * layout.
 */
export const SelfhealMapping = z.object({
  /** md level as sysfs reports it (`raid1`, `raid5`, `raid6`). */
  level: z.string(),
  /** `raid_disks` from sysfs. */
  raidDisks: z.number().int().positive(),
  /** `chunk_size` from sysfs, in bytes. 0 on RAID1 (no chunking). */
  chunkBytes: z.number().int().nonnegative(),
  /** Decoded `layout` (`left-symmetric`); null on RAID1, where it has no meaning. */
  layout: z.string().nullable(),
  /** The repaired member's data offset in bytes (`rd<n>/offset` × 512). */
  dataOffset: z.number().int().nonnegative(),
  /** btrfs logical bytenr of the block's own content. */
  logicalByte: z.number().int().nonnegative(),
  /**
   * btrfs logical bytenr of the REPAIR UNIT's start. For an uncompressed
   * extent that is the block itself; for a compressed one it is the extent's
   * on-disk blob, which carries one csum entry per on-disk sector and is
   * therefore the smallest thing that can be checked (suite note, extends GT-9).
   */
  blobLogical: z.number().int().nonnegative(),
  /** On-disk sectors in the repair unit: 1 uncompressed, ⌈disk_nr/4096⌉ compressed. */
  blobSectors: z.number().int().positive(),
  /** The extent is compressed — the repair unit is the blob, not the 4 KiB block. */
  compressed: z.boolean(),
  /** Start of the btrfs chunk covering the block (chunk-tree hop, GT-2). */
  chunkLogical: z.number().int().nonnegative(),
  /** That chunk's device offset — the per-chunk delta GT-2 corrected for. */
  chunkDevice: z.number().int().nonnegative(),
  /** Byte offset inside the btrfs device (the LV). */
  lvByte: z.number().int().nonnegative(),
  /** The dm linear segment's offset into the md device, in 512-byte sectors. */
  startSector: z.number().int().nonnegative(),
  /** Byte offset inside the md array. */
  mdByte: z.number().int().nonnegative(),
  /** Role index of the member holding the block. */
  memberIndex: z.number().int().nonnegative(),
  /** That member's device node, resolved live. */
  memberDevice: z.string(),
  /** Byte offset inside the member device. */
  memberOffset: z.number().int().nonnegative(),
  /** Role index of the stripe's P member; null on RAID1. */
  parityIndex: z.number().int().nonnegative().nullable(),
  /** Role index of the stripe's Q member; null unless RAID6. */
  qIndex: z.number().int().nonnegative().nullable(),
  /** Stripe index within the array; null on RAID1. */
  stripe: z.number().int().nonnegative().nullable(),
})
export type SelfhealMapping = z.infer<typeof SelfhealMapping>

/**
 * The numbers behind the verdict. Optional throughout: a sequence that stopped
 * at the gates has none of them, and an outcome must still parse.
 */
export const SelfhealDiagnostics = z.object({
  mapping: SelfhealMapping.optional(),
  /** `mismatch_cnt` from the bounded md check BEFORE anything was written. */
  precheckMismatch: z.number().int().nonnegative().optional(),
  /** `mismatch_cnt` from the bounded md check after the write. 0 is the only pass. */
  postcheckMismatch: z.number().int().nonnegative().optional(),
  /** On-disk sectors of the repair unit that failed their stored csum. */
  badSectors: z.array(z.number().int().nonnegative()).optional(),
  /** crc32c of the winning candidate, hex. */
  candidateCsum: z.string().optional(),
  /** The stored crc32c it was arbitrated against, hex. */
  storedCsum: z.string().optional(),
  /** Which reconstruction produced that candidate. */
  reconstruction: SelfhealReconstruction.optional(),
  /**
   * Cleanup that did not complete — a knob that could not be restored, a
   * snapshot that could not be destroyed. NEVER swallowed: a repaired block
   * with a leftover snapshot is still repaired, and the operator has to be
   * told what is left behind.
   */
  cleanupErrors: z.array(z.string()),
})
export type SelfhealDiagnostics = z.infer<typeof SelfhealDiagnostics>

/**
 * The engine's verdict on ONE 4 KiB file block.
 *
 * `pool`, `array`, `member` and `stripe` are nullable because the sequence can
 * stop before it knows them (a refused gate knows the array but not the
 * member; a mountpoint the engine was handed directly has no pool name until
 * selfheal.6 hands one in).
 */
export const SelfhealOutcome = z.object({
  outcome: SelfhealOutcomeKind,
  /** Why, in one sentence, for the operator — not for a parser. */
  reason: z.string(),
  /** Absolute path of the file on the node. */
  file: z.string(),
  /** 4 KiB file block index (byte offset / 4096). */
  block: z.number().int().nonnegative(),
  /** The AHR pool, when the caller knew it. */
  pool: z.string().nullable(),
  /** The md array device the block lives on (`/dev/md127`). */
  array: z.string().nullable(),
  /** The member device holding the block (`/dev/sdb1`). */
  member: z.string().nullable(),
  /** Stripe index within the array; null on RAID1 and before `resolve`. */
  stripe: z.number().int().nonnegative().nullable(),
  /** Every step the sequence ran, in order, including the one it stopped on. */
  steps: z.array(SelfhealStep),
  diagnostics: SelfhealDiagnostics.optional(),
})
export type SelfhealOutcome = z.infer<typeof SelfhealOutcome>

// ---------------------------------------------------------------------------
//  The repair JOB (story selfheal.6) — POST /v1/ahr/:name/repair
// ---------------------------------------------------------------------------

/**
 * One file the operator asked to have repaired, with the exact blocks.
 *
 * The request is always EXPLICIT: the blocks come from the findings the
 * operator selected in the Scrubs window, never from "everything the daemon
 * thinks is bad". A repair writes through md, and what it writes over is named
 * by the caller.
 *
 * `path` is absolute and under the pool's mountpoint. A scrub finding that
 * lives OUTSIDE the mounted tree (`outsideMount` — a corrupt block inside
 * `@snapshots/…`) is filesystem-relative and is refused here rather than
 * silently reinterpreted: repair works on the live `@data` tree in this cut.
 */
export const AhrRepairFile = z.object({
  path: AbsolutePath,
  /** 4 KiB file block indexes, as `AhrScrubFinding.badBlocks` reports them. */
  blocks: z.array(z.number().int().nonnegative()).min(1, 'name at least one block'),
})
export type AhrRepairFile = z.infer<typeof AhrRepairFile>

/** Body of POST /v1/ahr/:name/repair. */
export const AhrRepairRequest = z.object({
  files: z.array(AhrRepairFile).min(1, 'name at least one file'),
})
export type AhrRepairRequest = z.infer<typeof AhrRepairRequest>

/** What the engine concluded about one requested block. */
export const AhrRepairBlockOutcome = z.object({
  block: z.number().int().nonnegative(),
  outcome: SelfhealOutcomeKind,
  /** The engine's own sentence — including a `refused:` gate and an error text. */
  reason: z.string(),
})
export type AhrRepairBlockOutcome = z.infer<typeof AhrRepairBlockOutcome>

/** Every requested block of one file, in the order they were attempted. */
export const AhrRepairFileOutcome = z.object({
  path: z.string(),
  blocks: z.array(AhrRepairBlockOutcome),
})
export type AhrRepairFileOutcome = z.infer<typeof AhrRepairFileOutcome>

/**
 * The result of a repair job.
 *
 * THREE honest buckets, and no fourth place to hide a block in:
 *
 *  - `repaired` — the reconstruction matched the stored checksum, was written
 *    through md, re-checked clean and read back cold.
 *  - `unrepairable` — nothing below the csum tree can be proven right for this
 *    block. `mapping-abort` counts here too (the bytes still pass their stored
 *    csum, so the engine refused to write) and keeps its own reason in the
 *    per-block entry. Restore the file from backup.
 *  - `aboveMd` — parity already agreed with the bad data. Nothing was written.
 *
 * `blocks` is every block attempted, so the three buckets always add up to it.
 */
export const AhrRepairResult = z.object({
  /** The AHR pool the repair ran on. */
  pool: z.string(),
  files: z.array(AhrRepairFileOutcome),
  repaired: z.number().int().nonnegative(),
  unrepairable: z.number().int().nonnegative(),
  aboveMd: z.number().int().nonnegative(),
  /** Total blocks attempted — repaired + unrepairable + aboveMd. */
  blocks: z.number().int().nonnegative(),
})
export type AhrRepairResult = z.infer<typeof AhrRepairResult>
