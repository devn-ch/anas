import type { CommandExecutor } from '../executor/types.js'
import type { TreeRoots } from './selfheal-btree.js'
import type { CsumItem } from './selfheal-csum.js'
import { chunkItemKey, extentDataKey, extentItemKey, findLeaf, readTreeRoots } from './selfheal-btree.js'
import { BLOCK_BYTES, kernelName, mdSysPath, readMdAttrOrNull } from './selfheal-io.js'

/**
 * THE mapping helper for the self-heal repair engine (story selfheal.5).
 *
 * One file block → the exact bytes on one member disk, and back. Both halves
 * of the repair derive from this module and nothing else: the READ side
 * (re-verify the corruption, reconstruct a candidate from the siblings) and
 * the WRITE side (where the corrected block goes through md). The read-back
 * guard in `selfheal-repair.ts` is the PROOF of that — it compares the md
 * block at the mapping's `mdByte` with the member bytes at the mapping's
 * `memberOffset`, which can only agree if one resolution produced both.
 *
 * ## The chain (GT-2, with its correction)
 *
 *   file + 4 KiB block
 *     → btrfs LOGICAL bytenr            EXTENT_DATA in the subvolume tree
 *     → LV byte                         chunk-tree hop, per-chunk delta
 *     → md byte                         dm linear segment
 *     → (member, member offset)         md layout, read live from sysfs
 *
 * `filefrag`'s "physical_offset" is the btrfs LOGICAL bytenr, not a device
 * offset (GT-2), and it LIES outright on compressed extents (`physical_hi` is
 * bogus — suite note), so the authority is
 * `btrfs inspect-internal dump-tree`. It is run against the LV and NEVER
 * against the md device: the filesystem starts at the dm linear segment's
 * offset into md, so every tree offset read through md is shifted by it.
 *
 * There can be SEVERAL data chunks with different device deltas — on the drill
 * rig an 8 MiB first chunk had delta 0 and the 112 MiB second one delta
 * 60,358,656 — so the hop must select the chunk COVERING the logical byte, not
 * the first one.
 *
 * ## Layouts
 *
 * Nothing here is hardcoded. Chunk size, layout, disk count and every member's
 * own data offset are read live from md sysfs on each call; the member roles
 * come from `mdadm --detail --export` (KEY=VALUE — structured output, §13).
 * Only `left-symmetric` (sysfs `layout=2`, the mdadm default and what AHR
 * creates) is supported for RAID5/6; anything else is REFUSED by name rather
 * than mapped with a formula that does not describe it. RAID1 has no layout
 * and no stripe — every leg carries the same bytes at the same offset.
 *
 * ## Text parsing
 *
 * `dump-tree` and `dmsetup table` have no structured form (no `--json`, no
 * `-Hp`), so they are parsed as text — the same sanctioned exception as
 * `btrfs scrub status` and the kernel scrub lines in `ahr-scrub.ts`. Everything
 * else in this module is sysfs (one value per file) or KEY=VALUE.
 */

const BTRFS = '/usr/bin/btrfs'
const MDADM = '/usr/sbin/mdadm'
const DMSETUP = '/usr/sbin/dmsetup'
const FINDMNT = '/usr/bin/findmnt'
const STAT = '/usr/bin/stat'

// --- Regexes for the two text formats with no structured alternative -------
/** A dm table line's leading `<start> <len>` (the name-prefixed form has none). */
const DM_LEADING_NUMBER_RE = /^\s*\d/
/** Run of whitespace — the field separator of every text format parsed here. */
const WHITESPACE_RE = /\s+/
/** `<major>:<minor>` in a dm target. */
const DM_MAJOR_MINOR_RE = /^(\d+):(\d+)$/
/** A bare non-negative integer. */
const INTEGER_RE = /^\d+$/
/** `item N key (FIRST_CHUNK_TREE CHUNK_ITEM <logical>)`. */
const CHUNK_KEY_RE = /item \d+ key \(FIRST_CHUNK_TREE CHUNK_ITEM (\d+)\)/
/** Any `item N key (…)` — what closes another item's body. */
const ANY_ITEM_KEY_RE = /item \d+ key \(/
/** `length <n> owner <n> stripe_len <n> type <type>`. */
const CHUNK_GEOMETRY_RE = /length (\d+) owner \d+ stripe_len \d+ type (\S+)/
/** `stripe 0 devid <n> offset <n>` — the first copy of a DUP chunk. */
const CHUNK_STRIPE0_RE = /stripe 0 devid \d+ offset (\d+)/
/** A chunk `type` naming DATA. */
const CHUNK_TYPE_DATA_RE = /\bDATA\b/
/** `item N key (<inode> EXTENT_DATA <file offset>)`. */
const EXTENT_KEY_RE = /item \d+ key \((\d+) EXTENT_DATA (\d+)\)/
/** `generation <n> type <n> (regular|prealloc|inline)`. */
const EXTENT_KIND_RE = /generation \d+ type \d+ \((\w+)\)/
/** `extent data disk byte <logical> nr <on-disk length>`. */
const EXTENT_DISK_RE = /extent data disk byte (\d+) nr (\d+)/
/** `extent data offset <n> nr <length> ram <uncompressed length>`. */
const EXTENT_SPAN_RE = /extent data offset \d+ nr (\d+) ram (\d+)/
/** `extent compression <n> (<name>)`. */
const EXTENT_COMPRESSION_RE = /extent compression \d+ \((\w+)\)/
/** `inline extent data size <n> ram_bytes <n> compression <n> (<name>)` — no on-disk extent. */
const EXTENT_INLINE_RE = /inline extent data size \d+ ram_bytes (\d+) compression \d+ \((\w+)\)/
/** `MD_DEVICE_<name>_ROLE=<n>` from `mdadm --detail --export`. */
const MD_DEVICE_ROLE_RE = /^MD_DEVICE_(\S+)_ROLE=(\d+)$/
/** `MD_DEVICE_<name>_DEV=<path>` from `mdadm --detail --export`. */
const MD_DEVICE_DEV_RE = /^MD_DEVICE_(\S+)_DEV=(\S+)$/
/** `Subvolume ID: <n>` from `btrfs subvolume show`. */
const SUBVOLUME_ID_RE = /Subvolume ID:\s*(\d+)/

/** Raised when the chain cannot be followed. The message IS the operator's reason. */
export class SelfhealMapError extends Error {}

/** sysfs `layout` → md's name for it. RAID5/6 only; RAID1 reports 0 and means nothing by it. */
export const MD_LAYOUT_NAMES: Record<number, string> = {
  0: 'left-asymmetric',
  1: 'right-asymmetric',
  2: 'left-symmetric',
  3: 'right-symmetric',
}

/** The one parity layout this engine maps. Anything else is refused by name. */
export const SUPPORTED_PARITY_LAYOUT = 'left-symmetric'

/** Live md geometry — every field read at the moment of use, never cached across runs. */
export interface MdGeometry {
  /** `/dev/md127`, as resolved from the dm table. */
  device: string
  /** `md127` — the sysfs key. */
  kernel: string
  /** `/sys/block/md127/md`. */
  sys: string
  /** sysfs `level`: `raid1`, `raid5`, `raid6`. */
  level: string
  raid6: boolean
  raid1: boolean
  /** sysfs `raid_disks`. */
  raidDisks: number
  /** sysfs `chunk_size` in bytes; 0 on RAID1. */
  chunkBytes: number
  /** Decoded sysfs `layout`; null on RAID1. */
  layout: string | null
  /** Role index → member device path. A missing role (degraded) is null. */
  members: (string | null)[]
  /** Role index → that member's own data offset in bytes (`rd<n>/offset` × 512). */
  dataOffsets: number[]
}

/** One `linear` segment of a dm table. */
export interface DmSegment {
  /** First sector of the segment within the mapped device. */
  startSector: number
  lengthSectors: number
  /** The underlying device, as `major:minor` (dm's own notation). */
  major: number
  minor: number
  /** Offset of the segment's first sector within that underlying device. */
  offsetSector: number
}

/** One CHUNK_ITEM of the chunk tree. */
export interface ChunkItem {
  logical: number
  length: number
  /** First stripe's device offset — the delta GT-2 corrected for. */
  deviceOffset: number
  /** `DATA|single`, `METADATA|DUP`, … verbatim. */
  type: string
}

/**
 * One EXTENT_DATA item of a subvolume tree.
 *
 * Everything past `fileOffset` is optional because an INLINE extent has none
 * of it — its bytes are in the metadata item itself. Treating those fields as
 * present would turn "this file's tail lives in the tree" into a confident
 * mapping onto logical byte 0.
 */
export interface ExtentItem {
  /** Offset of the extent within the file. */
  fileOffset: number
  /** btrfs logical bytenr of the on-disk data; 0 means a hole. */
  diskByte?: number
  /** On-disk length (the compressed blob's length when compressed). */
  diskLength?: number
  /** Length within the file this item covers. */
  length?: number
  /** Uncompressed length of the extent. */
  ram?: number
  /** `none`, `zlib`, `lzo`, `zstd`. */
  compression: string
  /** `regular`, `prealloc`, `inline`. */
  type: string
}

/** Where one on-disk sector of a repair unit physically is. */
export interface MemberLocation {
  /** btrfs logical bytenr of this on-disk sector. */
  logical: number
  /** Byte offset within the btrfs device (the LV). */
  lvByte: number
  /** Byte offset within the md array. */
  mdByte: number
  /** Role index of the member carrying it (RAID1: the first leg — see `mirrors`). */
  memberIndex: number
  memberDevice: string
  /** Byte offset within that member device. */
  memberOffset: number
  /** Stripe index within the array; null on RAID1. */
  stripe: number | null
  /** Role index of this stripe's P member; null on RAID1. */
  parityIndex: number | null
  /** Role index of this stripe's Q member; null unless RAID6. */
  qIndex: number | null
  /**
   * This member's index among the stripe's DATA disks, in md's stripe order —
   * the exponent of the RAID6 Q coefficient (`g^dataIndex`). Null on RAID1.
   */
  dataIndex: number | null
  /** Every role holding a copy of these bytes: the RAID1 legs, or just one. */
  mirrors: number[]
  /** The dm segment's offset into md, in sectors — kept for the audit trail. */
  startSector: number
  /** The covering chunk's logical start and device offset (the GT-2 hop). */
  chunkLogical: number
  chunkDevice: number
}

/**
 * Everything about one pool that does not change between blocks of one run.
 *
 * `chunks` and `csums` are CACHES, not dumps: each starts empty and gains the
 * items of whichever leaf a bounded walk had to read. Two lookups in the same
 * chunk cost one walk; a lookup whose covering item is already cached costs
 * none. Nothing outside a leaf the run actually needed is ever read.
 */
export interface SelfhealContext {
  mountpoint: string
  /** The btrfs device — the LV. Every tree read runs against THIS, never md. */
  srcDevice: string
  /** The dm table's linear segments; a btrfs straight on md gets one synthetic identity segment. */
  segments: DmSegment[]
  geometry: MdGeometry
  /** Where each btrfs tree's root block is (`dump-tree -r`, one bounded exec). */
  roots: TreeRoots
  /** CHUNK_ITEMs learned so far, leaf at a time. */
  chunks: ChunkItem[]
  /** EXTENT_CSUM items learned so far, leaf at a time (filled by selfheal-csum). */
  csums: CsumItem[]
}

/** The repair unit for one file block: its on-disk sectors, each fully located. */
export interface ResolvedBlock {
  file: string
  block: number
  extent: ExtentItem
  compressed: boolean
  /** btrfs logical bytenr of the repair unit's first on-disk sector. */
  blobLogical: number
  /** On-disk sectors in the repair unit. */
  blobSectors: number
  /** btrfs logical bytenr of the block's own content (inside the blob when compressed). */
  logicalByte: number
  /** One entry per on-disk sector of the repair unit, in order. */
  sectors: MemberLocation[]
}

// ---------------------------------------------------------------------------
//  Pure parsers — every one of them unit-tested against captured rig output
// ---------------------------------------------------------------------------

/**
 * Parse `dmsetup table <device>`: `<start> <len> <target> <major:minor> <offset>`.
 *
 * ONLY `linear` targets are accepted. An LVM LV spanning several AHR bands is
 * a concatenation of linear segments, which this handles; anything else
 * (`striped`, `mirror`, `raid`, a snapshot origin, or the `mirror` target an
 * in-flight `pvmove` inserts) means the bytes do not sit where this chain
 * would put them, and the caller must refuse rather than guess.
 */
export function parseDmTable(text: string): DmSegment[] {
  const segments: DmSegment[] = []
  for (const raw of text.split('\n')) {
    // `dmsetup table` with no device argument prefixes each line with `name: `.
    const line = raw.includes(':') && !DM_LEADING_NUMBER_RE.test(raw) ? raw.slice(raw.indexOf(':') + 1) : raw
    const parts = line.trim().split(WHITESPACE_RE)
    if (parts.length < 3 || !INTEGER_RE.test(parts[0]))
      continue
    if (parts[2] !== 'linear')
      throw new SelfhealMapError(`dm target '${parts[2]}' is not linear — this pool's bytes are not where a linear map would put them (pvmove in flight, or a striped/mirrored LV)`)
    const m = DM_MAJOR_MINOR_RE.exec(parts[3] ?? '')
    if (!m || !INTEGER_RE.test(parts[4] ?? ''))
      throw new SelfhealMapError(`unparseable linear dm target: ${line.trim()}`)
    segments.push({
      startSector: Number(parts[0]),
      lengthSectors: Number(parts[1]),
      major: Number(m[1]),
      minor: Number(m[2]),
      offsetSector: Number(parts[4]),
    })
  }
  if (segments.length === 0)
    throw new SelfhealMapError('dmsetup table produced no linear segment')
  return segments
}

/** The linear segment covering an LV byte. */
export function segmentForLvByte(segments: DmSegment[], lvByte: number): DmSegment {
  const sector = Math.floor(lvByte / 512)
  const seg = segments.find(s => sector >= s.startSector && sector < s.startSector + s.lengthSectors)
  if (!seg)
    throw new SelfhealMapError(`no dm linear segment covers LV byte ${lvByte}`)
  return seg
}

/**
 * Parse the CHUNK_ITEMs of `btrfs inspect-internal dump-tree -t 3`.
 *
 * Only `stripe 0` is read: on `DUP` metadata both stripes hold the same bytes
 * and the first copy is the one the csum reader follows.
 */
export function parseChunkItems(dump: string): ChunkItem[] {
  const items: ChunkItem[] = []
  let current: Partial<ChunkItem> | null = null
  for (const line of dump.split('\n')) {
    const key = CHUNK_KEY_RE.exec(line)
    if (key) {
      current = { logical: Number(key[1]) }
      continue
    }
    if (ANY_ITEM_KEY_RE.test(line)) {
      current = null
      continue
    }
    if (!current)
      continue
    const geom = CHUNK_GEOMETRY_RE.exec(line)
    if (geom) {
      current.length = Number(geom[1])
      current.type = geom[2]
      continue
    }
    const stripe = CHUNK_STRIPE0_RE.exec(line)
    if (stripe && current.length !== undefined) {
      current.deviceOffset = Number(stripe[1])
      items.push(current as ChunkItem)
      current = null
    }
  }
  return items
}

/** The chunk covering a logical byte. `dataOnly` restricts it to DATA chunks. */
export function chunkForLogical(chunks: ChunkItem[], logical: number, dataOnly = false): ChunkItem {
  const hit = chunks.find(c =>
    logical >= c.logical && logical < c.logical + c.length
    && (!dataOnly || CHUNK_TYPE_DATA_RE.test(c.type)),
  )
  if (!hit)
    throw new SelfhealMapError(`no ${dataOnly ? 'DATA ' : ''}chunk covers logical byte ${logical}`)
  return hit
}

/** logical byte → LV byte, through the covering chunk's own delta (GT-2). */
export function logicalToLvByte(chunks: ChunkItem[], logical: number, dataOnly = false): { lvByte: number, chunk: ChunkItem } {
  const chunk = chunkForLogical(chunks, logical, dataOnly)
  return { lvByte: logical - chunk.logical + chunk.deviceOffset, chunk }
}

/**
 * Parse the EXTENT_DATA items of ONE inode out of a subvolume tree dump.
 *
 * Body lines attach only within their own item: with several files in the tree
 * the next `item N key (…)` belongs to another inode and must close the body,
 * or one file inherits the next one's extents.
 */
export function parseExtentItems(dump: string, inode: number): ExtentItem[] {
  const items: ExtentItem[] = []
  let current: Partial<ExtentItem> | null = null
  let inBody = false
  for (const line of dump.split('\n')) {
    const key = EXTENT_KEY_RE.exec(line)
    if (key) {
      inBody = true
      current = null
      if (Number(key[1]) === inode) {
        current = { fileOffset: Number(key[2]), compression: 'none', type: 'regular' }
        items.push(current as ExtentItem)
      }
      continue
    }
    if (ANY_ITEM_KEY_RE.test(line)) {
      inBody = false
      current = null
      continue
    }
    if (!inBody || !current)
      continue
    const kind = EXTENT_KIND_RE.exec(line)
    if (kind) {
      current.type = kind[1]
      continue
    }
    const disk = EXTENT_DISK_RE.exec(line)
    if (disk) {
      current.diskByte = Number(disk[1])
      current.diskLength = Number(disk[2])
      continue
    }
    const span = EXTENT_SPAN_RE.exec(line)
    if (span) {
      current.length = Number(span[1])
      current.ram = Number(span[2])
      continue
    }
    const comp = EXTENT_COMPRESSION_RE.exec(line)
    if (comp) {
      current.compression = comp[1]
      continue
    }
    // An INLINE extent has no `disk byte` and no `offset/nr/ram` line at all —
    // its bytes are in the metadata item. Give it a length anyway so the
    // covering-extent lookup FINDS it and `resolveBlock` can refuse it by name,
    // instead of the file looking like it has a hole where its tail is.
    const inline = EXTENT_INLINE_RE.exec(line)
    if (inline) {
      current.length = Number(inline[1])
      current.ram = Number(inline[1])
      current.compression = inline[2]
    }
  }
  return items
}

/** The extent covering a byte offset within the file. */
export function extentForFileOffset(items: ExtentItem[], fileOffset: number): ExtentItem {
  const hit = items.find(e => fileOffset >= e.fileOffset && fileOffset < e.fileOffset + (e.length ?? 0))
  if (!hit)
    throw new SelfhealMapError(`file offset ${fileOffset} is in no extent of this file`)
  return hit
}

/**
 * btrfs scrub checks and reports in 64 KiB stripes (GT-3) — the kernel names
 * one of these in every scrub warning, for compressed extents and plain ones
 * alike. Verified live on kernel 7.0.14-12-pve: two corrupt blobs 16 KiB apart
 * inside one stripe were both reported at the stripe's start.
 */
export const BTRFS_STRIPE_BYTES = 65536

/** One `extent data backref` line of an EXTENT_ITEM. */
export interface ExtentDataBackref {
  /** The subvolume id holding the file. */
  root: number
  /** The file's inode number. */
  objectid: number
  /** The offset within the file where the extent starts. */
  offset: number
  /** How many references this file makes to the extent. */
  count: number
}

/**
 * One EXTENT_ITEM of the extent tree — an on-disk extent keyed by DEVICE
 * logical byte, the only btrfs index that answers "which extent owns this
 * on-disk byte". The EXTENT_DATA items of a file tree are keyed by file offset
 * instead, which is why a logical byte cannot be traced to its extent through
 * them alone.
 */
export interface ExtentTreeItem {
  /** btrfs logical bytenr of the extent's first on-disk sector. */
  logical: number
  /** On-disk length (the key's offset field — the compressed blob when compressed). */
  length: number
  /** The data backrefs: every (subvolume, inode, file offset) that owns a piece. */
  backrefs: ExtentDataBackref[]
}

/** `item N key (<logical> EXTENT_ITEM <length>)`. */
const EXTENT_TREE_ITEM_RE = /item \d+ key \((\d+) EXTENT_ITEM (\d+)\)/
/** `(178 0x…) extent data backref root <r> objectid <i> offset <o> count <c>`. */
const EXTENT_DATA_BACKREF_RE = /extent data backref root (\d+) objectid (\d+) offset (\d+) count (\d+)/

/**
 * Parse the EXTENT_ITEMs (with their data backrefs) out of an extent tree dump.
 *
 * Body lines attach only within their own item, as in every parser here: the
 * next `item N key (…)` closes the previous one, and a block group or a
 * metadata tree-block item (which share the extent tree) is skipped by the key
 * regex itself.
 */
export function parseExtentTreeItems(dump: string): ExtentTreeItem[] {
  const items: ExtentTreeItem[] = []
  let current: ExtentTreeItem | null = null
  for (const line of dump.split('\n')) {
    const key = EXTENT_TREE_ITEM_RE.exec(line)
    if (key) {
      current = { logical: Number(key[1]), length: Number(key[2]), backrefs: [] }
      items.push(current)
      continue
    }
    if (!current)
      continue
    const ref = EXTENT_DATA_BACKREF_RE.exec(line)
    if (ref)
      current.backrefs.push({ root: Number(ref[1]), objectid: Number(ref[2]), offset: Number(ref[3]), count: Number(ref[4]) })
  }
  return items
}

/**
 * The file's extents whose ON-DISK bytes intersect the 64 KiB stripe the
 * kernel named (selfheal.8).
 *
 * The route is the kernel's own: the extent tree at the named logical (two
 * bounded walks — the stripe may straddle a leaf boundary), whose EXTENT_ITEM
 * data backrefs carry the real FILE offset of every owning extent, then one
 * fs-tree walk per owner for its full EXTENT_DATA item. Backrefs are filtered
 * to the (subvolume, inode) the kernel printed — a blob shared with a snapshot
 * or another file contributes only this file's extents.
 *
 * An empty result means nothing of THIS file lives in the named stripe; a
 * thrown {@link SelfhealMapError} means the chain could not be followed at
 * all. Both are the caller's cue to fall back — never a reason to guess.
 */
export async function extentsForStripe(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  root: number,
  inode: number,
  logical: number,
): Promise<ExtentItem[]> {
  if (ctx.roots.extent === null)
    throw new SelfhealMapError('btrfs dump-tree -r named no extent tree root — a logical byte cannot be traced to its extent without it')
  const fsRoot = ctx.roots.bySubvolume.get(root)
  if (fsRoot === undefined)
    throw new SelfhealMapError(`btrfs names no tree root for subvolume ${root}`)

  // The stripe's first and last items: the leaf holding the stripe's start and
  // the leaf holding its end. Deduped, the two cover the stripe — items are
  // contiguous and ordered in device space.
  const stripeStart = Math.floor(logical / BTRFS_STRIPE_BYTES) * BTRFS_STRIPE_BYTES
  const stripeEnd = stripeStart + BTRFS_STRIPE_BYTES
  const seen = new Set<number>()
  const owners: { fileOffset: number }[] = []
  for (const target of [stripeStart, stripeEnd - 1]) {
    const leaf = await findLeaf(executor, ctx.srcDevice, ctx.roots.extent, extentItemKey(target))
    for (const item of parseExtentTreeItems(leaf)) {
      if (item.logical >= stripeEnd || item.logical + item.length <= stripeStart)
        continue
      for (const ref of item.backrefs) {
        if (ref.root !== root || ref.objectid !== inode || seen.has(ref.offset))
          continue
        seen.add(ref.offset)
        owners.push({ fileOffset: ref.offset })
      }
    }
  }

  // One fs-tree walk per owning file offset, reusing the extent resolver the
  // repair engine uses — the EXTENT_DATA item is the single source of truth
  // for the extent's file range and its compression.
  const extents: ExtentItem[] = []
  for (const owner of owners) {
    const leaf = await findLeaf(executor, ctx.srcDevice, fsRoot, extentDataKey(inode, owner.fileOffset))
    extents.push(extentForFileOffset(parseExtentItems(leaf, inode), owner.fileOffset))
  }
  return extents
}

/**
 * md byte → which member, and where on it.
 *
 * left-symmetric RAID5/6: P sits at `(n-1) - (stripe mod n)`, Q immediately
 * after it, and the data chunks follow Q (RAID6) or P (RAID5) in increasing
 * disk order, wrapping. `dataIndex` is the position among the data disks in
 * that order — md's RAID6 syndrome uses it as the exponent of the Q
 * coefficient, which is why it is carried and not recomputed later.
 *
 * RAID1 has no stripe: the md byte is at the same offset on every leg, past
 * that leg's own data offset.
 */
export function placeMdByte(mdByte: number, geo: MdGeometry): Omit<MemberLocation, 'logical' | 'lvByte' | 'startSector' | 'chunkLogical' | 'chunkDevice'> {
  if (geo.raid1) {
    const mirrors = geo.members.map((m, i) => (m ? i : -1)).filter(i => i >= 0)
    if (mirrors.length === 0)
      throw new SelfhealMapError('RAID1 array reports no present member')
    const first = mirrors[0]
    return {
      mdByte,
      memberIndex: first,
      memberDevice: geo.members[first] as string,
      memberOffset: geo.dataOffsets[first] + mdByte,
      stripe: null,
      parityIndex: null,
      qIndex: null,
      dataIndex: null,
      mirrors,
    }
  }

  if (geo.layout !== SUPPORTED_PARITY_LAYOUT) {
    throw new SelfhealMapError(
      `md layout '${geo.layout ?? 'unknown'}' is not supported — this engine maps ${SUPPORTED_PARITY_LAYOUT} only (the mdadm default, and what AHR creates). Refusing rather than guessing where the bytes are.`,
    )
  }
  if (geo.chunkBytes <= 0)
    throw new SelfhealMapError(`md reports chunk_size ${geo.chunkBytes} on ${geo.level}`)

  const n = geo.raidDisks
  const dataDisks = n - (geo.raid6 ? 2 : 1)
  const chunkIndex = Math.floor(mdByte / geo.chunkBytes)
  const dataIndex = chunkIndex % dataDisks
  const stripe = Math.floor(chunkIndex / dataDisks)
  const inChunk = mdByte % geo.chunkBytes
  const parityIndex = (n - 1) - (stripe % n)
  const qIndex = (parityIndex + 1) % n
  const anchor = geo.raid6 ? qIndex : parityIndex
  const memberIndex = (anchor + 1 + dataIndex) % n
  const device = geo.members[memberIndex]
  if (!device)
    throw new SelfhealMapError(`member role ${memberIndex} is missing from the array — repair refuses on a degraded array`)
  return {
    mdByte,
    memberIndex,
    memberDevice: device,
    memberOffset: geo.dataOffsets[memberIndex] + stripe * geo.chunkBytes + inChunk,
    stripe,
    parityIndex,
    qIndex: geo.raid6 ? qIndex : null,
    dataIndex,
    mirrors: [memberIndex],
  }
}

/** The data-disk roles of one stripe, in md's stripe order (index = Q exponent). */
export function stripeDataOrder(geo: MdGeometry, stripe: number): number[] {
  const n = geo.raidDisks
  const dataDisks = n - (geo.raid6 ? 2 : 1)
  const parityIndex = (n - 1) - (stripe % n)
  const anchor = geo.raid6 ? (parityIndex + 1) % n : parityIndex
  return Array.from({ length: dataDisks }, (_, d) => (anchor + 1 + d) % n)
}

// ---------------------------------------------------------------------------
//  Live reads
// ---------------------------------------------------------------------------

/**
 * md geometry, read LIVE.
 *
 * Roles come from `mdadm --detail --export` (`MD_DEVICE_<name>_ROLE` /
 * `_DEV` — KEY=VALUE, the structured form); everything else from sysfs, one
 * value per file. Each member's data offset is read from its OWN `rd<n>/offset`
 * rather than assumed uniform: `mdadm --grow --data-offset` can leave a member
 * with a different one, and a repair that assumed otherwise would write 4 KiB
 * of correct data into the wrong place.
 */
export async function readMdGeometry(executor: CommandExecutor, mdDevice: string): Promise<MdGeometry> {
  const kernel = await kernelName(executor, mdDevice)
  const sys = mdSysPath(kernel)

  const attributes: Record<string, string | null> = {}
  for (const key of ['level', 'raid_disks', 'chunk_size', 'layout'])
    attributes[key] = await readMdAttrOrNull(sys, key)

  const raidDisks = Number(attributes.raid_disks ?? '0')
  for (let i = 0; i < raidDisks; i++)
    attributes[`rd${i}/offset`] = await readMdAttrOrNull(sys, `rd${i}/offset`)

  const detail = await executor.exec(MDADM, ['--detail', '--export', mdDevice])
  if (detail.exitCode !== 0)
    throw new SelfhealMapError(`mdadm --detail --export ${mdDevice} failed: ${detail.stderr.trim()}`)

  return geometryFromAttributes(mdDevice, kernel, sys, attributes, parseMdDetailExport(detail.stdout, raidDisks))
}

/**
 * Role index → member device, from `mdadm --detail --export`.
 *
 * A role with no device is a HOLE (a failed or removed member), left null so
 * the caller can refuse rather than silently shifting every later role down by
 * one — which is what building the list from the present devices alone would do.
 */
export function parseMdDetailExport(text: string, raidDisks: number): (string | null)[] {
  const members: (string | null)[] = Array.from<string | null>({ length: raidDisks }).fill(null)
  const roles = new Map<string, number>()
  const devices = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const role = MD_DEVICE_ROLE_RE.exec(line)
    if (role)
      roles.set(role[1], Number(role[2]))
    const device = MD_DEVICE_DEV_RE.exec(line)
    if (device)
      devices.set(device[1], device[2])
  }
  for (const [name, role] of roles) {
    const device = devices.get(name)
    if (device && role < raidDisks)
      members[role] = device
  }
  return members
}

/**
 * Assemble the geometry from raw sysfs attribute values.
 *
 * Split out from the reads so the decoding — which level is which, what a
 * `layout` number means, which attributes a level simply does not have — can be
 * checked against captured sysfs from real RAID1, RAID5 and RAID6 arrays.
 */
export function geometryFromAttributes(
  device: string,
  kernel: string,
  sys: string,
  attributes: Record<string, string | null>,
  members: (string | null)[],
): MdGeometry {
  const level = attributes.level ?? ''
  const raid6 = level === 'raid6'
  const raid1 = level === 'raid1'
  if (!raid1 && level !== 'raid5' && !raid6)
    throw new SelfhealMapError(`md level '${level}' is not a self-heal band type (raid1, raid5, raid6)`)

  const raidDisks = Number(attributes.raid_disks ?? '0')
  if (!Number.isInteger(raidDisks) || raidDisks <= 0)
    throw new SelfhealMapError(`md reports raid_disks '${attributes.raid_disks}'`)

  const chunkBytes = Number(attributes.chunk_size ?? '0')
  // RAID1 reports layout 0 and means nothing by it — do not decode it as a
  // parity layout and then refuse the array for not being left-symmetric.
  const raw = attributes.layout
  const layout = raid1 || raw === null ? null : (MD_LAYOUT_NAMES[Number(raw)] ?? `layout ${raw}`)

  const dataOffsets: number[] = []
  for (let i = 0; i < raidDisks; i++) {
    const offset = attributes[`rd${i}/offset`]
    dataOffsets.push(offset === null || offset === undefined ? 0 : Number(offset) * 512)
  }

  return { device, kernel, sys, level, raid6, raid1, raidDisks, chunkBytes, layout, members, dataOffsets }
}

/** The btrfs device behind a mountpoint (the LV). */
export async function btrfsDeviceFor(executor: CommandExecutor, mountpoint: string): Promise<string> {
  const r = await executor.exec(FINDMNT, ['-n', '-o', 'SOURCE', '-T', mountpoint])
  if (r.exitCode !== 0 || !r.stdout.trim())
    throw new SelfhealMapError(`findmnt found no filesystem at ${mountpoint}`)
  // A subvolume mount prints `/dev/x[/@data]` — the device is the part before `[`.
  return r.stdout.trim().split('[')[0]
}

/**
 * Everything about the pool that is the same for every block of one run.
 *
 * Resolving the md array from the dm table's own `major:minor` — rather than a
 * second `dmsetup deps` call — keeps the device and the offset coming from ONE
 * reading of one table: a pool whose table changed between the two calls could
 * otherwise be mapped with one segment's offset onto another segment's array.
 */
export async function resolveContext(executor: CommandExecutor, mountpoint: string): Promise<SelfhealContext> {
  const srcDevice = await btrfsDeviceFor(executor, mountpoint)

  let segments: DmSegment[]
  let mdDevice: string
  const table = await executor.exec(DMSETUP, ['table', srcDevice])
  if (table.exitCode === 0 && table.stdout.trim()) {
    segments = parseDmTable(table.stdout)
    const majmin = `${segments[0].major}:${segments[0].minor}`
    mdDevice = `/dev/${await kernelName(executor, `/sys/dev/block/${majmin}`)}`
  }
  else {
    // btrfs straight on md (no LVM): the identity segment keeps one code path.
    segments = [{ startSector: 0, lengthSectors: Number.MAX_SAFE_INTEGER, major: 0, minor: 0, offsetSector: 0 }]
    mdDevice = srcDevice
  }

  const geometry = await readMdGeometry(executor, mdDevice)
  const roots = await readTreeRoots(executor, srcDevice)
  return { mountpoint, srcDevice, segments, geometry, roots, chunks: [], csums: [] }
}

/**
 * The chunk covering a logical byte, fetching ONE chunk-tree leaf if the cache
 * does not already hold it.
 *
 * Chunks partition the logical address space, so a cached chunk that covers the
 * byte IS the answer and no walk is needed — which is why a compressed blob's
 * sectors, or a whole stripe's worth of lookups, cost one leaf between them.
 */
export async function coveringChunk(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  logical: number,
  dataOnly = false,
): Promise<ChunkItem> {
  const cached = ctx.chunks.find(c => logical >= c.logical && logical < c.logical + c.length)
  if (!cached) {
    const leaf = await findLeaf(executor, ctx.srcDevice, ctx.roots.chunk, chunkItemKey(logical))
    mergeChunks(ctx, parseChunkItems(leaf))
  }
  return chunkForLogical(ctx.chunks, logical, dataOnly)
}

/** Add newly-read chunk items to the run's cache, without duplicating. */
function mergeChunks(ctx: SelfhealContext, items: ChunkItem[]): void {
  for (const item of items) {
    if (!ctx.chunks.some(c => c.logical === item.logical))
      ctx.chunks.push(item)
  }
}

/**
 * Place ONE btrfs logical byte all the way down to a member — the pure half,
 * given the chunk that covers it. Kept separate from the fetching so the whole
 * chain can be asserted against captured rig output with no executor at all.
 */
export function locateLogicalIn(
  logical: number,
  chunk: ChunkItem,
  segments: DmSegment[],
  geometry: MdGeometry,
): MemberLocation {
  const lvByte = logical - chunk.logical + chunk.deviceOffset
  const seg = segmentForLvByte(segments, lvByte)
  const mdByte = lvByte - seg.startSector * 512 + seg.offsetSector * 512
  const placed = placeMdByte(mdByte, geometry)
  return {
    ...placed,
    logical,
    lvByte,
    startSector: seg.offsetSector,
    chunkLogical: chunk.logical,
    chunkDevice: chunk.deviceOffset,
  }
}

/** Place ONE btrfs logical byte, fetching the covering DATA chunk as needed. */
export async function locateLogical(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  logical: number,
): Promise<MemberLocation> {
  const chunk = await coveringChunk(executor, ctx, logical, true)
  return locateLogicalIn(logical, chunk, ctx.segments, ctx.geometry)
}

/** The inode number of a path. */
async function inodeOf(executor: CommandExecutor, path: string): Promise<number> {
  const r = await executor.exec(STAT, ['-c', '%i', path])
  if (r.exitCode !== 0)
    throw new SelfhealMapError(`stat ${path}: ${r.stderr.trim()}`)
  return Number(r.stdout.trim())
}

/** The subvolume id holding a path — which fs tree the walk starts in. */
export async function subvolumeIdOf(executor: CommandExecutor, path: string): Promise<number> {
  const rootid = await executor.exec(BTRFS, ['inspect-internal', 'rootid', path])
  if (rootid.exitCode === 0 && INTEGER_RE.test(rootid.stdout.trim()))
    return Number(rootid.stdout.trim())
  // Older btrfs-progs: fall back to the subvolume the path sits in.
  const show = await executor.exec(BTRFS, ['subvolume', 'show', path])
  const m = SUBVOLUME_ID_RE.exec(show.stdout)
  if (!m)
    throw new SelfhealMapError(`cannot determine the subvolume id of ${path}`)
  return Number(m[1])
}

/**
 * The REPAIR UNIT for one file block of one extent.
 *
 * Uncompressed: the block itself — each 4 KiB block carries its own csum, so
 * the extent is not the unit. Compressed: the whole on-disk blob, because
 * btrfs stores one csum entry per on-disk sector of it and a single corrupt
 * sector takes out the entire (up to 128 KiB) logical extent.
 */
export function repairUnitFor(extent: ExtentItem, block: number): {
  compressed: boolean
  blobLogical: number
  blobSectors: number
  logicalByte: number
} {
  const diskByte = extent.diskByte ?? 0
  const fileOffset = block * BLOCK_BYTES
  const compressed = extent.compression !== 'none'
  const within = fileOffset - extent.fileOffset
  return {
    compressed,
    blobLogical: compressed ? diskByte : diskByte + within,
    blobSectors: compressed ? Math.ceil((extent.diskLength ?? BLOCK_BYTES) / BLOCK_BYTES) : 1,
    logicalByte: diskByte + within,
  }
}

/**
 * Resolve one 4 KiB file block into the REPAIR UNIT's on-disk sectors.
 *
 * The repair unit is the block itself for an uncompressed extent — each block
 * carries its own csum — and the WHOLE on-disk blob for a compressed one:
 * btrfs stores one csum entry per on-disk sector of the blob, and a single
 * corrupt sector takes out the entire (up to 128 KiB) logical extent, so there
 * is nothing smaller that can be checked or fixed.
 *
 * Every sector is placed INDEPENDENTLY through the full chain rather than
 * assumed contiguous on one member: a blob that straddles a chunk boundary has
 * its sectors on two different disks, and assuming otherwise would read the
 * wrong bytes and then "repair" from them.
 */
export async function resolveBlock(
  executor: CommandExecutor,
  ctx: SelfhealContext,
  file: string,
  block: number,
): Promise<ResolvedBlock> {
  const inode = await inodeOf(executor, file)
  const subvol = await subvolumeIdOf(executor, file)
  const fsRoot = ctx.roots.bySubvolume.get(subvol)
  if (fsRoot === undefined)
    throw new SelfhealMapError(`btrfs names no tree root for subvolume ${subvol} (holding ${file})`)

  const fileOffset = block * BLOCK_BYTES
  // ONE leaf: the descent takes the greatest key <= (inode, EXTENT_DATA,
  // fileOffset), which is the extent COVERING that offset, so the leaf it
  // lands in is the leaf that holds it.
  const leaf = await findLeaf(executor, ctx.srcDevice, fsRoot, extentDataKey(inode, fileOffset))
  const extents = parseExtentItems(leaf, inode)
  if (extents.length === 0)
    throw new SelfhealMapError(`no EXTENT_DATA items for ${file} (inode ${inode}) in subvolume ${subvol}`)

  const extent = extentForFileOffset(extents, fileOffset)
  if (extent.type === 'inline' || extent.diskByte === undefined || extent.diskLength === undefined)
    throw new SelfhealMapError(`block ${block} of ${file} is an inline extent — its bytes live in the metadata tree, not in a data chunk`)
  if (extent.diskByte === 0)
    throw new SelfhealMapError(`block ${block} of ${file} is a hole — there is nothing on disk to repair`)

  const { compressed, blobLogical, blobSectors, logicalByte } = repairUnitFor(extent, block)

  const sectors: MemberLocation[] = []
  for (let k = 0; k < blobSectors; k++)
    sectors.push(await locateLogical(executor, ctx, blobLogical + k * BLOCK_BYTES))

  return { file, block, extent, compressed, blobLogical, blobSectors, logicalByte, sectors }
}
