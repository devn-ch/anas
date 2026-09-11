import type { CommandExecutor } from '../executor/types.js'

/**
 * KEY-DIRECTED btrfs b-tree navigation for the self-heal engine
 * (story selfheal.5).
 *
 * ## Why this exists
 *
 * `btrfs inspect-internal dump-tree -t <tree>` prints a WHOLE tree. On the
 * loop-device rig that is a few kilobytes; on a real 80 TB pool the csum tree
 * alone is tens of gigabytes and the chunk tree tens of megabytes — through the
 * executor's 10 MB buffer, which means the engine could map nothing and
 * arbitrate nothing on the pools it exists for.
 *
 * So the engine never dumps a tree. It takes the tree's ROOT bytenr from
 * `dump-tree -r` (one line per tree root — a few hundred bytes even with a
 * thousand snapshots), then reads ONE NODE AT A TIME with
 * `dump-tree -b <bytenr>`, at each level descending into the child whose key is
 * the greatest one ≤ the key it is looking for, until it reaches the leaf that
 * would hold it. A btrfs node is `nodesize` (16 KiB), so each of those reads is
 * tens of kilobytes of text, and tree height is small — a handful of bounded
 * execs per lookup regardless of pool size.
 *
 * The bound is on what crosses the executor. btrfs-progs still opens the
 * filesystem and reads the chunk tree into its OWN memory to resolve `-b`; that
 * is its business and it has always done it.
 *
 * ## Keys
 *
 * A btrfs key is `(objectid, type, offset)`, compared in that order, all three
 * as UNSIGNED 64-bit (type is 8-bit). `dump-tree` prints objectids and types
 * symbolically where it has a name, so the tables below turn the names back
 * into numbers. **An unrecognised name is refused, never guessed**: a key
 * mis-ordered by one position sends the descent into the wrong subtree and the
 * lookup comes back confidently wrong, which for a repair engine is the worst
 * possible failure. Negative objectid constants (`EXTENT_CSUM` is -10) are
 * carried as their unsigned 64-bit values, which is how btrfs sorts them.
 *
 * Text parsing is the sanctioned exception again — btrfs-progs has no
 * structured form of a tree dump.
 */

const BTRFS = '/usr/bin/btrfs'

/** Depth guard: a real btrfs tree is at most 8 levels; anything deeper is a loop. */
export const MAX_TREE_DEPTH = 16

/** A btrfs key, as btrfs itself orders it. */
export interface BtrfsKey {
  objectid: bigint
  type: number
  offset: bigint
}

/**
 * Symbolic objectids `print-tree.c` emits. Negative constants are their
 * unsigned 64-bit values — `EXTENT_CSUM` (-10) sorts near the top, not below 0.
 */
export const BTRFS_OBJECTIDS: Record<string, bigint> = {
  DEV_STATS: 0n,
  ROOT_TREE: 1n,
  DEV_ITEMS: 1n,
  EXTENT_TREE: 2n,
  CHUNK_TREE: 3n,
  DEV_TREE: 4n,
  FS_TREE: 5n,
  ROOT_TREE_DIR: 6n,
  CSUM_TREE: 7n,
  QUOTA_TREE: 8n,
  UUID_TREE: 9n,
  FREE_SPACE_TREE: 10n,
  BLOCK_GROUP_TREE: 11n,
  RAID_STRIPE_TREE: 12n,
  FIRST_CHUNK_TREE: 256n,
  BALANCE: (1n << 64n) - 4n,
  ORPHAN: (1n << 64n) - 5n,
  TREE_LOG: (1n << 64n) - 6n,
  LOG_FIXUP: (1n << 64n) - 7n,
  TREE_RELOC: (1n << 64n) - 8n,
  DATA_RELOC_TREE: (1n << 64n) - 9n,
  EXTENT_CSUM: (1n << 64n) - 10n,
  FREE_SPACE: (1n << 64n) - 11n,
  FREE_INO: (1n << 64n) - 12n,
  MULTIPLE: (1n << 64n) - 255n,
}

/** Symbolic key types, from btrfs's `ctree.h` — the numbers ARE the sort order. */
export const BTRFS_KEY_TYPES: Record<string, number> = {
  UNTYPED: 0,
  INODE_ITEM: 1,
  INODE_REF: 12,
  INODE_EXTREF: 13,
  XATTR_ITEM: 24,
  VERITY_DESC_ITEM: 36,
  VERITY_MERKLE_ITEM: 37,
  ORPHAN_ITEM: 48,
  DIR_LOG_ITEM: 60,
  DIR_LOG_INDEX: 72,
  DIR_ITEM: 84,
  DIR_INDEX: 96,
  EXTENT_DATA: 108,
  EXTENT_CSUM: 128,
  ROOT_ITEM: 132,
  ROOT_BACKREF: 144,
  ROOT_REF: 156,
  EXTENT_ITEM: 168,
  METADATA_ITEM: 169,
  EXTENT_OWNER_REF: 172,
  TREE_BLOCK_REF: 176,
  EXTENT_DATA_REF: 178,
  EXTENT_REF_V0: 180,
  SHARED_BLOCK_REF: 182,
  SHARED_DATA_REF: 184,
  BLOCK_GROUP_ITEM: 192,
  FREE_SPACE_INFO: 198,
  FREE_SPACE_EXTENT: 199,
  FREE_SPACE_BITMAP: 200,
  DEV_EXTENT: 204,
  DEV_ITEM: 216,
  CHUNK_ITEM: 228,
  RAID_STRIPE: 230,
  QGROUP_STATUS: 240,
  QGROUP_INFO: 242,
  QGROUP_LIMIT: 244,
  QGROUP_RELATION: 246,
  TEMPORARY_ITEM: 248,
  PERSISTENT_ITEM: 249,
  DEV_REPLACE: 250,
  UUID_KEY_SUBVOL: 251,
  UUID_KEY_RECEIVED_SUBVOL: 252,
  STRING_ITEM: 253,
}

/** Raised when the tree cannot be navigated. The message IS the operator's reason. */
export class SelfhealTreeError extends Error {}

const INTEGER_RE = /^\d+$/
/** Run of whitespace — the three fields inside `key (…)`. */
const WHITESPACE_RE = /\s+/
/** `UNKNOWN.228` — how print-tree renders a type it has no name for. */
const UNKNOWN_TYPE_RE = /^UNKNOWN\.(\d+)$/
/** `node <bytenr> level <n> items <n>` — an internal node's header. */
const NODE_HEADER_RE = /^node (\d+) level (\d+) items \d+/
/** `leaf <bytenr> items <n>` — a leaf's header. */
const LEAF_HEADER_RE = /^leaf (\d+) items \d+/
/** `key (<key>) block <bytenr> gen <n>` — one child pointer of an internal node. */
const CHILD_RE = /^\s*key \((.+?)\) block (\d+) gen \d+/
/** `root tree: <bytenr> level <n>` / `chunk tree: <bytenr> level <n>`. */
const BARE_ROOT_RE = /^(\w[\w ]*) tree: (\d+) level \d+$/
/** `… key (<objectid> ROOT_ITEM <gen>) <bytenr> level <n>`. */
const KEYED_ROOT_RE = /key \((\S+) ROOT_ITEM \d+\) (\d+) level \d+/

/** Parse the three fields btrfs prints inside `key (…)`. */
export function parseKeyText(text: string): BtrfsKey {
  const parts = text.trim().split(WHITESPACE_RE)
  if (parts.length !== 3)
    throw new SelfhealTreeError(`unparseable btrfs key '${text}'`)
  const [objectidText, typeText, offsetText] = parts

  let objectid: bigint
  if (INTEGER_RE.test(objectidText)) {
    objectid = BigInt(objectidText)
  }
  else {
    const known = BTRFS_OBJECTIDS[objectidText]
    if (known === undefined) {
      throw new SelfhealTreeError(
        `unknown btrfs objectid '${objectidText}' in key '${text}' — refusing to place it in the key order rather than descending into the wrong subtree`,
      )
    }
    objectid = known
  }

  let type: number
  const unknown = UNKNOWN_TYPE_RE.exec(typeText)
  if (unknown) {
    type = Number(unknown[1])
  }
  else if (INTEGER_RE.test(typeText)) {
    type = Number(typeText)
  }
  else {
    const known = BTRFS_KEY_TYPES[typeText]
    if (known === undefined) {
      throw new SelfhealTreeError(
        `unknown btrfs key type '${typeText}' in key '${text}' — refusing to place it in the key order rather than descending into the wrong subtree`,
      )
    }
    type = known
  }

  if (!INTEGER_RE.test(offsetText))
    throw new SelfhealTreeError(`unparseable btrfs key offset in '${text}'`)
  return { objectid, type, offset: BigInt(offsetText) }
}

/** btrfs key order: objectid, then type, then offset — all unsigned. */
export function compareKeys(a: BtrfsKey, b: BtrfsKey): number {
  if (a.objectid !== b.objectid)
    return a.objectid < b.objectid ? -1 : 1
  if (a.type !== b.type)
    return a.type < b.type ? -1 : 1
  if (a.offset !== b.offset)
    return a.offset < b.offset ? -1 : 1
  return 0
}

/** Convenience constructors for the three keys this engine ever looks up. */
export function chunkItemKey(logical: number): BtrfsKey {
  return { objectid: BTRFS_OBJECTIDS.FIRST_CHUNK_TREE, type: BTRFS_KEY_TYPES.CHUNK_ITEM, offset: BigInt(logical) }
}
export function csumItemKey(logical: number): BtrfsKey {
  return { objectid: BTRFS_OBJECTIDS.EXTENT_CSUM, type: BTRFS_KEY_TYPES.EXTENT_CSUM, offset: BigInt(logical) }
}
export function extentDataKey(inode: number, fileOffset: number): BtrfsKey {
  return { objectid: BigInt(inode), type: BTRFS_KEY_TYPES.EXTENT_DATA, offset: BigInt(fileOffset) }
}

/** One tree block, as `dump-tree -b` printed it. */
export interface TreeBlock {
  bytenr: number
  /** True when this block holds items; false when it holds child pointers. */
  leaf: boolean
  level: number
  /** Child pointers, in key order. Empty for a leaf. */
  children: { key: BtrfsKey, block: number }[]
  /** The dump verbatim — a leaf's items are parsed by the existing parsers. */
  text: string
}

/** Parse one `dump-tree -b <bytenr>` output. */
export function parseTreeBlock(dump: string): TreeBlock {
  for (const line of dump.split('\n')) {
    const leaf = LEAF_HEADER_RE.exec(line)
    if (leaf)
      return { bytenr: Number(leaf[1]), leaf: true, level: 0, children: [], text: dump }
    const node = NODE_HEADER_RE.exec(line)
    if (!node)
      continue
    const children: { key: BtrfsKey, block: number }[] = []
    for (const child of dump.split('\n')) {
      const m = CHILD_RE.exec(child)
      if (m)
        children.push({ key: parseKeyText(m[1]), block: Number(m[2]) })
    }
    return { bytenr: Number(node[1]), leaf: false, level: Number(node[2]), children, text: dump }
  }
  throw new SelfhealTreeError('btrfs dump-tree -b printed neither a node nor a leaf header')
}

/**
 * The child to descend into: the one with the GREATEST key ≤ `target`.
 *
 * When every child's key is greater than the target — the target sorts before
 * everything in this subtree — the leftmost child is taken, so the caller's own
 * "no item covers this" check is what reports it, rather than a throw from
 * halfway down a tree.
 */
export function chooseChild(block: TreeBlock, target: BtrfsKey): number {
  if (block.children.length === 0)
    throw new SelfhealTreeError(`btrfs node ${block.bytenr} has no children`)
  let chosen = block.children[0].block
  for (const child of block.children) {
    if (compareKeys(child.key, target) > 0)
      break
    chosen = child.block
  }
  return chosen
}

/** Where each tree's root block is, from `btrfs inspect-internal dump-tree -r`. */
export interface TreeRoots {
  /** The chunk tree (tree 3). */
  chunk: number
  /** The checksum tree (tree 7). */
  csum: number
  /** Subvolume id → its fs tree root. `FS_TREE` is recorded under id 5. */
  bySubvolume: Map<number, number>
}

/**
 * Parse `dump-tree -r`, which prints one short line per tree root — the whole
 * output is a few hundred bytes even on a pool with a thousand snapshots, which
 * is what makes it the right place to start a bounded walk.
 */
export function parseTreeRoots(dump: string): TreeRoots {
  let chunk: number | null = null
  let csum: number | null = null
  const bySubvolume = new Map<number, number>()
  for (const line of dump.split('\n')) {
    const bare = BARE_ROOT_RE.exec(line.trim())
    if (bare) {
      if (bare[1] === 'chunk')
        chunk = Number(bare[2])
      continue
    }
    const keyed = KEYED_ROOT_RE.exec(line)
    if (!keyed)
      continue
    const objectid = keyed[1]
    const bytenr = Number(keyed[2])
    if (objectid === 'CSUM_TREE')
      csum = bytenr
    else if (objectid === 'FS_TREE')
      bySubvolume.set(5, bytenr)
    else if (INTEGER_RE.test(objectid))
      bySubvolume.set(Number(objectid), bytenr)
  }
  if (chunk === null)
    throw new SelfhealTreeError('btrfs dump-tree -r named no chunk tree root')
  if (csum === null)
    throw new SelfhealTreeError('btrfs dump-tree -r named no checksum tree root — a filesystem with no csum tree has nothing to arbitrate against')
  return { chunk, csum, bySubvolume }
}

/** Read every tree root of the filesystem on `device`. One bounded exec. */
export async function readTreeRoots(executor: CommandExecutor, device: string): Promise<TreeRoots> {
  const r = await executor.exec(BTRFS, ['inspect-internal', 'dump-tree', '-r', device])
  if (r.exitCode !== 0)
    throw new SelfhealTreeError(`btrfs dump-tree -r ${device} failed: ${r.stderr.trim()}`)
  return parseTreeRoots(r.stdout)
}

/** Read ONE tree block by its logical bytenr. */
export async function readTreeBlock(
  executor: CommandExecutor,
  device: string,
  bytenr: number,
): Promise<TreeBlock> {
  const r = await executor.exec(BTRFS, ['inspect-internal', 'dump-tree', '-b', String(bytenr), device])
  if (r.exitCode !== 0)
    throw new SelfhealTreeError(`btrfs dump-tree -b ${bytenr} ${device} failed: ${r.stderr.trim()}`)
  return parseTreeBlock(r.stdout)
}

/**
 * Descend from a tree root to the LEAF that would hold `target`, and return its
 * dump verbatim for the existing item parsers.
 *
 * Because the descent always takes the greatest key ≤ the target, the leaf it
 * reaches holds the greatest key ≤ the target that exists at all — which is
 * exactly what every one of this engine's three lookups wants: the chunk
 * COVERING a logical byte, the csum item COVERING it, and the extent COVERING a
 * file offset.
 */
export async function findLeaf(
  executor: CommandExecutor,
  device: string,
  root: number,
  target: BtrfsKey,
): Promise<string> {
  let bytenr = root
  const seen = new Set<number>()
  for (let depth = 0; depth < MAX_TREE_DEPTH; depth++) {
    if (seen.has(bytenr))
      throw new SelfhealTreeError(`btrfs tree walk revisited block ${bytenr} — refusing to loop`)
    seen.add(bytenr)
    const block = await readTreeBlock(executor, device, bytenr)
    if (block.leaf)
      return block.text
    bytenr = chooseChild(block, target)
  }
  throw new SelfhealTreeError(`btrfs tree walk from ${root} exceeded ${MAX_TREE_DEPTH} levels`)
}
