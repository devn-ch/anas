import type { CommandExecutor } from '../executor/types.js'
import type { SelfhealContext } from './selfheal-map.js'
import { csumItemKey, findLeaf } from './selfheal-btree.js'
import { BLOCK_BYTES, readDirect } from './selfheal-io.js'
import { coveringChunk, SelfhealMapError } from './selfheal-map.js'

/**
 * The stored btrfs checksum for one on-disk sector, and the crc32c that
 * arbitrates against it (story selfheal.5).
 *
 * This is the OTHER half of the engine's claim: md knows the parity group,
 * btrfs knows what the bytes should be. Without a stored csum there is nothing
 * to arbitrate with and the only honest answer is `unrepairable` — which is
 * exactly what a NOCOW or prealloc extent gets.
 *
 * ## Why the csum tree and not the kernel's scrub line
 *
 * Kernel 7.0's scrub warning names the 64 KiB stripe, the path and the inode
 * but prints NEITHER the found nor the expected csum (GT-3 — the drill brief
 * expected `csum 0x… expected csum 0x…` and the kernel emits no such thing).
 * So the expected value is read out of the EXTENT_CSUM tree directly, exactly
 * as the drill did, through the LV.
 *
 * ## Layout facts this depends on (GT-4 + the selfheal.2 live probe)
 *
 *  - A csum is crc32c stored LITTLE-ENDIAN, 4 bytes, one entry per 4 KiB
 *    ON-DISK sector.
 *  - Compressed extents are no exception: entry *k* of an extent is
 *    `crc32c(sector k of the compressed blob)`, keyed contiguously from the
 *    extent's logical start — across csum-item boundaries. Lookup is therefore
 *    "the greatest EXTENT_CSUM item start ≤ the logical byte", never "the item
 *    whose printed range contains it".
 *  - Item payloads are addressed from the END of the 101-byte leaf header:
 *    `leaf + 101 + itemoff + index × 4`.
 *  - The leaf's own logical bytenr needs the chunk-tree hop like any other
 *    logical byte, and metadata chunks are `DUP` — stripe 0 is the copy read.
 */

/** Bytes of a btrfs leaf header, past which item payloads are addressed (GT-4). */
export const LEAF_HEADER_BYTES = 101

/** btrfs metadata nodesize on every filesystem AHR creates. */
export const NODE_BYTES = 16384

/** Bytes per stored csum entry (crc32c). */
export const CSUM_BYTES = 4

/**
 * CRC-32C (Castagnoli) — reflected polynomial 0x82F63B78, init and final xor
 * 0xFFFFFFFF. Table-driven, built once; no dependency, because adding one for
 * 40 lines of table lookup is not a trade this project makes.
 */
const CRC32C_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let bit = 0; bit < 8; bit++)
      c = (c & 1) !== 0 ? (c >>> 1) ^ 0x82F63B78 : c >>> 1
    table[i] = c
  }
  return table
})()

/** crc32c of a byte range, as an unsigned 32-bit number. */
export function crc32c(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++)
    crc = CRC32C_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/** `0x0b894db02`-style rendering used in outcomes and logs. */
export function csumHex(value: number): string {
  return `0x${value.toString(16).padStart(8, '0')}`
}

/** Node-pointer line of a multi-leaf csum tree — the leaf a following item is in. */
const CSUM_NODE_RE = /key \(EXTENT_CSUM EXTENT_CSUM \d+\) block (\d+) gen/
/** Leaf header line. */
const LEAF_HEADER_RE = /^leaf (\d+) /
/** One EXTENT_CSUM item line. */
const CSUM_ITEM_RE = /item \d+ key \(EXTENT_CSUM EXTENT_CSUM (\d+)\) itemoff (\d+) itemsize (\d+)/

/** One EXTENT_CSUM item, with the leaf it was printed under. */
export interface CsumItem {
  /** Logical byte the item's first entry covers. */
  start: number
  /** Payload offset from the end of the leaf header. */
  itemOffset: number
  /** Payload size in bytes; `itemSize / 4` entries. */
  itemSize: number
  /** Logical bytenr of the leaf holding it. */
  leaf: number
}

/**
 * Parse `btrfs inspect-internal dump-tree -t 7`.
 *
 * Each item is paired with the leaf whose header PRECEDED it in the dump — a
 * multi-leaf csum tree (anything past a few GiB of data) must not map every
 * item onto the last leaf printed.
 */
export function parseCsumItems(dump: string): CsumItem[] {
  const items: CsumItem[] = []
  let leaf: number | null = null
  for (const raw of dump.split('\n')) {
    const line = raw.trim()
    const node = CSUM_NODE_RE.exec(line)
    if (node) {
      leaf = Number(node[1])
      continue
    }
    const header = LEAF_HEADER_RE.exec(line)
    if (header) {
      leaf = Number(header[1])
      continue
    }
    const item = CSUM_ITEM_RE.exec(line)
    if (item && leaf !== null) {
      items.push({
        start: Number(item[1]),
        itemOffset: Number(item[2]),
        itemSize: Number(item[3]),
        leaf,
      })
    }
  }
  return items
}

/** Where one logical byte's stored csum sits inside the tree. */
export interface CsumEntryLocation {
  item: CsumItem
  /** Entry index inside the item. */
  index: number
  /** Byte offset of the entry from the start of the leaf. */
  leafOffset: number
}

/**
 * Locate the stored csum entry for a logical byte, or null when there is none.
 *
 * Null is a real answer, not an error: a NOCOW file, a prealloc extent, or the
 * `nodatasum` flag all mean btrfs never wrote a csum, and the engine reports
 * `unrepairable` with that reason rather than arbitrating against nothing.
 */
export function findCsumEntry(items: CsumItem[], logical: number): CsumEntryLocation | null {
  let best: CsumItem | null = null
  for (const item of items) {
    if (item.start <= logical && (best === null || item.start > best.start))
      best = item
  }
  if (!best)
    return null
  const entries = Math.floor(best.itemSize / CSUM_BYTES)
  if (logical >= best.start + entries * BLOCK_BYTES)
    return null
  const index = Math.floor((logical - best.start) / BLOCK_BYTES)
  return { item: best, index, leafOffset: LEAF_HEADER_BYTES + best.itemOffset + index * CSUM_BYTES }
}

/** Extract the little-endian stored csum from a leaf's raw bytes. */
export function csumFromLeafBytes(leaf: Buffer, location: CsumEntryLocation): number {
  if (location.leafOffset + CSUM_BYTES > leaf.length)
    throw new SelfhealMapError(`csum entry at leaf offset ${location.leafOffset} is past the ${leaf.length}-byte leaf read`)
  return leaf.readUInt32LE(location.leafOffset)
}

/**
 * Add newly-read csum items to the run's cache, without duplicating.
 *
 * The cache is what makes a compressed blob's sectors — or several blocks of
 * one extent — cost ONE leaf between them: csum items do not overlap, so a
 * cached item whose range contains the logical byte IS the answer.
 */
function mergeCsums(ctx: SelfhealContext, items: CsumItem[]): void {
  for (const item of items) {
    if (!ctx.csums.some(c => c.start === item.start && c.leaf === item.leaf))
      ctx.csums.push(item)
  }
}

/**
 * The csum item covering a logical byte, fetching ONE csum-tree leaf when the
 * run's cache does not already hold it.
 *
 * The csum tree is the one that makes a whole-tree dump impossible on a real
 * pool — 8 TB of data carries 8 GB of checksums — so it is walked by key and
 * never dumped. Null is a real answer: a NOCOW file, a prealloc extent or
 * `nodatasum` means btrfs never wrote a csum, and the engine reports
 * `unrepairable` with that reason rather than arbitrating against nothing.
 */
export async function findStoredCsumEntry(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  logical: number,
): Promise<CsumEntryLocation | null> {
  const cached = findCsumEntry(ctx.csums, logical)
  if (cached)
    return cached
  const leaf = await findLeaf(executor, ctx.srcDevice, ctx.roots.csum, csumItemKey(logical))
  mergeCsums(ctx, parseCsumItems(leaf))
  return findCsumEntry(ctx.csums, logical)
}

/**
 * The stored crc32c for one logical byte, read through the LV.
 *
 * Returns null when btrfs stored no csum for it. The csum VALUES are not in the
 * tree dump (btrfs-progs prints them only under `--csum-items`, which would
 * mean pulling every checksum of a 16 KiB leaf through the executor to use
 * four bytes of it), so the leaf is read off the LV directly — with O_DIRECT,
 * so a stale page of the block device cannot answer with a csum from before
 * the last commit. The leaf's own logical bytenr needs the chunk hop like any
 * other logical byte, and metadata chunks are DUP: stripe 0 is the copy read.
 */
export async function readStoredCsum(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  logical: number,
): Promise<number | null> {
  const location = await findStoredCsumEntry(executor, ctx, logical)
  if (!location)
    return null
  const chunk = await coveringChunk(executor, ctx, location.item.leaf)
  const leafLv = location.item.leaf - chunk.logical + chunk.deviceOffset
  const aligned = leafLv - (leafLv % BLOCK_BYTES)
  const skew = leafLv - aligned
  const bytes = await readDirect(executor, ctx.srcDevice, aligned, NODE_BYTES + BLOCK_BYTES)
  return csumFromLeafBytes(bytes.subarray(skew), location)
}
