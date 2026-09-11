import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { parseTreeRoots } from '../selfheal-btree.js'
import {
  chunkForLogical,
  extentForFileOffset,
  extentsForStripe,
  geometryFromAttributes,
  locateLogicalIn,
  logicalToLvByte,
  parseChunkItems,
  parseDmTable,
  parseExtentItems,
  parseExtentTreeItems,
  parseMdDetailExport,
  placeMdByte,
  repairUnitFor,
  segmentForLvByte,
  SelfhealMapError,
  stripeDataOrder,
} from '../selfheal-map.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, '../../fixtures/selfheal')

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf-8')
}

/** `key=value` sysfs capture (see fixtures/selfheal/PROVENANCE.md) → a map. */
function sysfsAttributes(name: string): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const line of fixture(name).split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0)
      continue
    const value = line.slice(eq + 1)
    out[line.slice(0, eq)] = value === '<absent>' ? null : value
  }
  return out
}

const CHUNK_TREE = fixture('dump-tree-chunk.txt')
const SUBVOL_TREE = fixture('dump-tree-subvol.txt')
const DM_TABLE = fixture('dmsetup-table-lv.txt')

/** What the selfheal.2 Python mapper resolved on the same rig — the answers. */
interface ExpectedMapping {
  file: string
  block: number
  compressed: boolean
  logical_byte: number
  target_logical: number
  blob_logical: number
  blob_sectors: number
  chunk_logical: number
  chunk_device: number
  start_sector: number
  lv_byte: number
  md_byte: number
  disk: number
  moff: number
  stripe: number
  parity_disk: number
  q_disk: number
  stored_csum: string
}
const EXPECTED: ExpectedMapping[] = JSON.parse(fixture('expected-mapping.json'))

const RAID5 = geometryFromAttributes(
  '/dev/md127',
  'md127',
  '/sys/block/md127/md',
  sysfsAttributes('md-sysfs-raid5.txt'),
  parseMdDetailExport(fixture('mdadm-detail-export-raid5.txt'), 6),
)
const RAID6 = geometryFromAttributes(
  '/dev/md127',
  'md127',
  '/sys/block/md127/md',
  sysfsAttributes('md-sysfs-raid6.txt'),
  parseMdDetailExport(fixture('mdadm-detail-export-raid6.txt'), 7),
)
const RAID1 = geometryFromAttributes(
  '/dev/md126',
  'md126',
  '/sys/block/md126/md',
  sysfsAttributes('md-sysfs-raid1.txt'),
  parseMdDetailExport(fixture('mdadm-detail-export-raid1.txt'), 2),
)

const SEGMENTS = parseDmTable(DM_TABLE)
const CHUNKS = parseChunkItems(CHUNK_TREE)

/**
 * THE mapping helper (selfheal.5), against output captured verbatim from a
 * live loop rig. The reference answers come from the selfheal.2 suite's own
 * Python mapper, which was written independently — an agreement between the
 * two is worth more than either agreeing with itself.
 */
describe('selfheal mapping — md geometry', () => {
  it('reads level, chunk, layout and per-member data offsets from sysfs values', () => {
    assert.equal(RAID5.level, 'raid5')
    assert.equal(RAID5.raidDisks, 6)
    assert.equal(RAID5.chunkBytes, 65536)
    assert.equal(RAID5.layout, 'left-symmetric')
    assert.equal(RAID5.raid6, false)
    assert.deepEqual(RAID5.dataOffsets, [1048576, 1048576, 1048576, 1048576, 1048576, 1048576])
  })

  it('maps roles to devices from mdadm --detail --export, in role order', () => {
    assert.deepEqual(RAID5.members, [
      '/dev/loop0',
      '/dev/loop1',
      '/dev/loop2',
      '/dev/loop3',
      '/dev/loop4',
      '/dev/loop5',
    ])
    assert.equal(RAID6.members.length, 7)
    assert.equal(RAID6.raid6, true)
  })

  it('leaves a missing role NULL rather than shifting the later roles down', () => {
    const text = fixture('mdadm-detail-export-raid5.txt')
      .split('\n')
      .filter(l => !l.includes('dev_loop2'))
      .join('\n')
    const members = parseMdDetailExport(text, 6)
    assert.equal(members[2], null)
    assert.equal(members[3], '/dev/loop3')
  })

  it('treats RAID1 as having no layout and no chunk — both are absent, not zero-meaning', () => {
    assert.equal(RAID1.level, 'raid1')
    assert.equal(RAID1.raid1, true)
    assert.equal(RAID1.layout, null)
    assert.equal(RAID1.chunkBytes, 0)
    assert.deepEqual(RAID1.dataOffsets, [1048576, 1048576])
  })

  it('refuses a level that is not an AHR band type', () => {
    assert.throws(
      () => geometryFromAttributes('/dev/md0', 'md0', '/s', { level: 'raid10', raid_disks: '4' }, []),
      /not a self-heal band type/,
    )
  })
})

describe('selfheal mapping — dm table', () => {
  it('parses the linear segment the btrfs LV sits on', () => {
    assert.deepEqual(parseDmTable(DM_TABLE), [
      { startSector: 0, lengthSectors: 2031616, major: 9, minor: 127, offsetSector: 2560 },
    ])
  })

  it('parses the name-prefixed form `dmsetup table` prints without a device', () => {
    assert.deepEqual(parseDmTable(fixture('dmsetup-table-all.txt')), parseDmTable(DM_TABLE))
  })

  it('REFUSES a non-linear target instead of mapping through it', () => {
    assert.throws(
      () => parseDmTable('0 2031616 mirror core 2 1024 nosync 2 9:127 0 9:128 0\n'),
      /is not linear/,
    )
  })

  it('picks the segment covering an LV byte (a multi-band pool is a concat)', () => {
    const segments = [
      { startSector: 0, lengthSectors: 2048, major: 9, minor: 1, offsetSector: 2560 },
      { startSector: 2048, lengthSectors: 2048, major: 9, minor: 2, offsetSector: 4096 },
    ]
    assert.equal(segmentForLvByte(segments, 0).minor, 1)
    assert.equal(segmentForLvByte(segments, 2048 * 512).minor, 2)
    assert.throws(() => segmentForLvByte(segments, 4096 * 512), /no dm linear segment/)
  })
})

describe('selfheal mapping — chunk tree (GT-2)', () => {
  const chunks = parseChunkItems(CHUNK_TREE)

  it('reads every chunk with its own device delta', () => {
    const data = chunks.filter(c => /\bDATA\b/.test(c.type))
    assert.equal(data.length, 2)
    assert.deepEqual(data[0], { logical: 13631488, length: 8388608, deviceOffset: 13631488, type: 'DATA|single' })
    assert.deepEqual(data[1], { logical: 82378752, length: 117440512, deviceOffset: 142737408, type: 'DATA|single' })
  })

  it('selects the chunk COVERING the byte — the second one has delta 60,358,656', () => {
    assert.equal(logicalToLvByte(chunks, 14860288, true).lvByte, 14860288)
    assert.equal(logicalToLvByte(chunks, 82378752, true).lvByte, 142737408)
    assert.equal(82378752 - 142737408, -60358656)
  })

  it('finds metadata chunks too — the csum leaf hop needs them', () => {
    const metadata = chunkForLogical(chunks, 30867456)
    assert.equal(metadata.type, 'METADATA|DUP')
    assert.equal(metadata.deviceOffset, 38797312)
  })

  it('refuses a logical byte no DATA chunk covers', () => {
    assert.throws(() => chunkForLogical(chunks, 1, true), /no DATA chunk covers/)
  })
})

describe('selfheal mapping — extent items', () => {
  it('reads the uncompressed extent of f1.bin (inode 257)', () => {
    const extents = parseExtentItems(SUBVOL_TREE, 257)
    assert.equal(extents.length, 1)
    assert.deepEqual(extents[0], {
      fileOffset: 0,
      diskByte: 13631488,
      diskLength: 8388608,
      length: 8388608,
      ram: 8388608,
      compression: 'none',
      type: 'regular',
    })
  })

  it('reads f3.bin as 32 zstd extents, each a single 4 KiB on-disk block', () => {
    const extents = parseExtentItems(SUBVOL_TREE, 258)
    assert.equal(extents.length, 32)
    assert.ok(extents.every(e => e.compression === 'zstd' && e.diskLength === 4096 && e.ram === 131072))
    assert.equal(extents[0].diskByte, 82378752)
    assert.equal(extents[9].fileOffset, 9 * 131072)
    assert.equal(extents[9].diskByte, 82378752 + 9 * 4096)
  })

  it('never lets one inode inherit the next inode\'s extents', () => {
    assert.equal(parseExtentItems(SUBVOL_TREE, 999).length, 0)
  })

  it('the repair unit is the block when uncompressed and the whole blob when not', () => {
    const plain = parseExtentItems(SUBVOL_TREE, 257)[0]
    assert.deepEqual(repairUnitFor(plain, 300), {
      compressed: false,
      blobLogical: 13631488 + 300 * 4096,
      blobSectors: 1,
      logicalByte: 13631488 + 300 * 4096,
    })
    const zstd = extentForFileOffset(parseExtentItems(SUBVOL_TREE, 258), 300 * 4096)
    const unit = repairUnitFor(zstd, 300)
    assert.equal(unit.compressed, true)
    assert.equal(unit.blobLogical, 82415616)
    assert.equal(unit.blobSectors, 1)
  })
})

describe('selfheal mapping — md placement', () => {
  it('places a RAID5 md byte on the left-symmetric data disk of its stripe', () => {
    const placed = placeMdByte(16171008, RAID5)
    assert.equal(placed.memberIndex, 0)
    assert.equal(placed.memberOffset, 4308992)
    assert.equal(placed.stripe, 49)
    assert.equal(placed.parityIndex, 4)
    assert.equal(placed.qIndex, null)
  })

  it('places a RAID6 md byte past Q, and names both parity members', () => {
    const placed = placeMdByte(16171008, RAID6)
    assert.equal(placed.stripe, 49)
    assert.equal(placed.parityIndex, 6)
    assert.equal(placed.qIndex, 0)
    assert.equal(placed.dataIndex, 1)
    assert.equal(placed.memberIndex, 2)
  })

  it('orders a RAID6 stripe\'s data disks the way md numbers its Q coefficients', () => {
    assert.deepEqual(stripeDataOrder(RAID6, 49), [1, 2, 3, 4, 5])
    assert.deepEqual(stripeDataOrder(RAID6, 58), [6, 0, 1, 2, 3])
    assert.deepEqual(stripeDataOrder(RAID5, 49), [5, 0, 1, 2, 3])
  })

  it('puts a RAID1 block at the same offset on every leg, with no stripe', () => {
    const placed = placeMdByte(65536, RAID1)
    assert.equal(placed.memberOffset, 1048576 + 65536)
    assert.equal(placed.stripe, null)
    assert.equal(placed.parityIndex, null)
    assert.deepEqual(placed.mirrors, [0, 1])
  })

  it('REFUSES a layout it does not map rather than guessing', () => {
    const asymmetric = { ...RAID5, layout: 'left-asymmetric' }
    assert.throws(() => placeMdByte(16171008, asymmetric), SelfhealMapError)
    assert.throws(() => placeMdByte(16171008, asymmetric), /left-symmetric only/)
  })

  it('REFUSES to place a block on a member the array does not have', () => {
    const degraded = { ...RAID5, members: [null, ...RAID5.members.slice(1)] }
    assert.throws(() => placeMdByte(16171008, degraded), /missing from the array/)
  })
})

describe('selfheal mapping — the whole chain', () => {
  for (const expected of EXPECTED) {
    it(`resolves ${expected.file} block ${expected.block} exactly as the suite's own mapper does`, () => {
      const chunk = chunkForLogical(CHUNKS, expected.target_logical, true)
      const located = locateLogicalIn(expected.target_logical, chunk, SEGMENTS, RAID5)
      assert.equal(located.chunkLogical, expected.chunk_logical)
      assert.equal(located.chunkDevice, expected.chunk_device)
      assert.equal(located.lvByte, expected.lv_byte)
      assert.equal(located.startSector, expected.start_sector)
      assert.equal(located.mdByte, expected.md_byte)
      assert.equal(located.memberIndex, expected.disk)
      assert.equal(located.memberOffset, expected.moff)
      assert.equal(located.stripe, expected.stripe)
      assert.equal(located.parityIndex, expected.parity_disk)
    })
  }

  it('derives the block\'s repair unit and its logical byte from the tree, not from filefrag', () => {
    for (const expected of EXPECTED) {
      const inode = expected.file === 'f1.bin' ? 257 : 258
      const extent = extentForFileOffset(parseExtentItems(SUBVOL_TREE, inode), expected.block * 4096)
      const unit = repairUnitFor(extent, expected.block)
      assert.equal(unit.compressed, expected.compressed)
      // `target_logical` is the suite's name for the start of the repair unit:
      // the block itself when uncompressed, the compressed blob when not.
      assert.equal(unit.blobLogical, expected.target_logical, `${expected.file} ${expected.block}`)
      assert.equal(unit.logicalByte, expected.logical_byte)
    }
  })
})

/**
 * selfheal.8 — tracing a DEVICE logical byte back to the extent that owns it.
 * Everything below is fed the verbatim capture of a live rig with a compressed
 * file whose second extent's blob was corrupted and scrubbed (see
 * fixtures/selfheal/PROVENANCE.md, "Compressed-extent attribution fixtures").
 */
describe('selfheal mapping — the extent tree (selfheal.8)', () => {
  const EXTENT_TREE = fixture('dump-tree-extent.txt')

  it('parses the EXTENT_ITEMs with their data backrefs, and nothing else', () => {
    const items = parseExtentTreeItems(EXTENT_TREE)
    // 16 data extents of the rig's one file; the BLOCK_GROUP_ITEM and the
    // metadata TREE_BLOCK items sharing the tree create no item.
    assert.equal(items.length, 16)
    assert.deepEqual(items[1], {
      logical: 13635584,
      length: 4096,
      backrefs: [{ root: 256, objectid: 257, offset: 131072, count: 1 }],
    })
    assert.ok(items.every(i => i.backrefs.length === 1))
    // The backref offset is the extent's REAL file offset — the number the
    // kernel's scrub warning does not carry for a compressed extent.
    assert.deepEqual(items.map(i => i.backrefs[0].offset), Array.from({ length: 16 }, (_, k) => k * 131072))
  })

  /** The captured rig's mapping context — trees only; the md half is unused here. */
  function compressedRigContext(): Parameters<typeof extentsForStripe>[1] {
    const roots = parseTreeRoots(fixture('dump-tree-roots-compressed.txt'))
    return {
      mountpoint: '/mnt/sh8',
      srcDevice: '/dev/loop0',
      segments: [],
      geometry: {} as never,
      roots,
      chunks: [],
      csums: [],
    }
  }

  function treeExecutor(): MockExecutor {
    const executor = new MockExecutor()
    const roots = parseTreeRoots(fixture('dump-tree-roots-compressed.txt'))
    executor.addFixture({
      command: '/usr/bin/btrfs',
      args: ['inspect-internal', 'dump-tree', '-b', String(roots.extent), '/dev/loop0'],
      result: { stdout: EXTENT_TREE, stderr: '', exitCode: 0 },
    })
    executor.addFixture({
      command: '/usr/bin/btrfs',
      args: ['inspect-internal', 'dump-tree', '-b', String(roots.bySubvolume.get(256)), '/dev/loop0'],
      result: { stdout: fixture('dump-tree-subvol-compressed.txt'), stderr: '', exitCode: 0 },
    })
    return executor
  }

  it('resolves the extents owning the named stripe, with their real file ranges', async () => {
    const executor = treeExecutor()
    const extents = await extentsForStripe(executor, compressedRigContext(), 256, 257, 13631488)
    // All 16 of the file's zstd blobs live inside that one 64 KiB stripe.
    assert.equal(extents.length, 16)
    assert.ok(extents.every(e => e.compression === 'zstd' && e.length === 131072 && e.diskLength === 4096))
    assert.deepEqual(extents.map(e => e.fileOffset), Array.from({ length: 16 }, (_, k) => k * 131072))
    // The extent whose blob sits 4 KiB into the stripe — the corrupt one in
    // the capture — resolves to file bytes 131072..262143, NOT to what the
    // kernel's `offset 0` would have pointed at.
    const corrupt = extentForFileOffset(extents, 131072)
    assert.equal(corrupt.diskByte, 13635584)
    // Two walks for the extent tree (stripe start and stripe end land in the
    // same leaf) plus one per owning file offset.
    assert.equal(executor.calls.length, 2 + 16)
  })

  it('names no extent where this file owns none — and refuses a foreign subvolume', async () => {
    const executor = treeExecutor()
    const ctx = compressedRigContext()
    assert.deepEqual(
      await extentsForStripe(executor, ctx, 256, 257, 97533952),
      [],
      'the metadata region at the top of the address space is nobody\'s data extent',
    )
    await assert.rejects(
      extentsForStripe(executor, ctx, 999, 257, 13631488),
      SelfhealMapError,
    )
  })
})
