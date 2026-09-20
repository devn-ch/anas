import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import {
  BTRFS_KEY_TYPES,
  BTRFS_OBJECTIDS,
  chooseChild,
  chunkItemKey,
  compareKeys,
  csumItemKey,
  extentDataKey,
  findLeaf,
  MAX_TREE_DEPTH,
  parseKeyText,
  parseTreeBlock,
  parseTreeRoots,
  readTreeRoots,
  SelfhealTreeError,
} from '../selfheal-btree.js'
import { findCsumEntry, parseCsumItems } from '../selfheal-csum.js'
import { chunkForLogical, extentForFileOffset, parseChunkItems, parseExtentItems } from '../selfheal-map.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, '../../fixtures/selfheal')

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf-8')
}

const DEVICE = '/dev/mapper/gtsh-data'
const ROOTS = fixture('dump-tree-roots.txt')

/** The walk's answers, recorded from the rig alongside the node dumps. */
interface WalkTarget {
  tree: string
  file?: string
  for?: string
  inode?: number
  block?: number
  key: (string | number)[]
  path: number[]
  logical?: number
  logical_byte?: number
  target_logical?: number
  chunk_logical?: number
  chunk_device?: number
  stored_csum?: string
}
interface WalkExpected {
  chunk_root: number
  csum_root: number
  fs_root: number
  subvolid: number
  big_inode: number
  small_inode: number
  inline: { file: string, inode: number, key: number[], path: number[] }
  targets: WalkTarget[]
  last_child: { key: (string | number)[], path: number[], expected_leaf: number, children_in_root: number }
}
const EXPECTED: WalkExpected = JSON.parse(fixture('tree-walk-expected.json'))

/** An executor that serves the captured `dump-tree -b` / `-r` outputs. */
function nodeServer(): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({
    command: '/usr/bin/btrfs',
    args: ['inspect-internal', 'dump-tree', '-r', DEVICE],
    result: { stdout: ROOTS, stderr: '', exitCode: 0 },
  })
  for (const bytenr of [22052864, 30670848, 30769152, 30834688, 31309824, 31834112, 32538624, 32620544]) {
    executor.addFixture({
      command: '/usr/bin/btrfs',
      args: ['inspect-internal', 'dump-tree', '-b', String(bytenr), DEVICE],
      result: { stdout: fixture(`node-${bytenr}.txt`), stderr: '', exitCode: 0 },
    })
  }
  return executor
}

/**
 * The key-directed b-tree walk (selfheal.5) — what makes the engine usable on a
 * real pool, where `dump-tree -t 7` would be tens of gigabytes through a 10 MB
 * buffer. Fixtures are every node along one real path per tree, captured from a
 * loop rig deliberately filled until the csum and fs trees went multi-level.
 */
describe('selfheal btree — keys', () => {
  it('turns btrfs\'s symbolic key text back into the numbers btrfs sorts by', () => {
    assert.deepEqual(parseKeyText('FIRST_CHUNK_TREE CHUNK_ITEM 13631488'), {
      objectid: 256n,
      type: BTRFS_KEY_TYPES.CHUNK_ITEM,
      offset: 13631488n,
    })
    assert.deepEqual(parseKeyText('257 EXTENT_DATA 81920000'), {
      objectid: 257n,
      type: BTRFS_KEY_TYPES.EXTENT_DATA,
      offset: 81920000n,
    })
  })

  it('carries a NEGATIVE objectid as the unsigned value btrfs sorts it as', () => {
    // EXTENT_CSUM is -10, which as a u64 sorts near the top — not below zero.
    assert.equal(parseKeyText('EXTENT_CSUM EXTENT_CSUM 0').objectid, (1n << 64n) - 10n)
    assert.equal(BTRFS_OBJECTIDS.EXTENT_CSUM, 18446744073709551606n)
    assert.equal(compareKeys(parseKeyText('EXTENT_CSUM EXTENT_CSUM 0'), parseKeyText('257 EXTENT_DATA 0')), 1)
  })

  it('REFUSES an objectid or type it cannot name rather than guessing its place', () => {
    assert.throws(() => parseKeyText('WAT CHUNK_ITEM 0'), SelfhealTreeError)
    assert.throws(() => parseKeyText('WAT CHUNK_ITEM 0'), /unknown btrfs objectid 'WAT'/)
    assert.throws(() => parseKeyText('256 NONSENSE 0'), /unknown btrfs key type 'NONSENSE'/)
  })

  it('accepts the UNKNOWN.<n> form print-tree uses for a type it has no name for', () => {
    assert.equal(parseKeyText('256 UNKNOWN.199 0').type, 199)
  })

  it('orders objectid, then type, then offset', () => {
    const k = (t: string) => parseKeyText(t)
    assert.equal(compareKeys(k('256 INODE_ITEM 0'), k('257 INODE_ITEM 0')), -1)
    assert.equal(compareKeys(k('257 EXTENT_DATA 0'), k('257 INODE_ITEM 0')), 1)
    assert.equal(compareKeys(k('257 EXTENT_DATA 4096'), k('257 EXTENT_DATA 8192')), -1)
    assert.equal(compareKeys(k('257 EXTENT_DATA 4096'), k('257 EXTENT_DATA 4096')), 0)
  })
})

describe('selfheal btree — nodes and roots', () => {
  it('parses an internal node and its child pointers', () => {
    const node = parseTreeBlock(fixture('node-30670848.txt'))
    assert.equal(node.leaf, false)
    assert.equal(node.level, 1)
    assert.equal(node.bytenr, 30670848)
    assert.equal(node.children.length, EXPECTED.last_child.children_in_root)
    assert.equal(node.children[0].block, 30736384)
  })

  it('parses a leaf and keeps its text for the item parsers', () => {
    const leaf = parseTreeBlock(fixture('node-30834688.txt'))
    assert.equal(leaf.leaf, true)
    assert.deepEqual(leaf.children, [])
    assert.ok(parseCsumItems(leaf.text).length > 0)
  })

  it('reads every tree root from one bounded `dump-tree -r`', async () => {
    const executor = nodeServer()
    const roots = await readTreeRoots(executor, DEVICE)
    assert.equal(roots.chunk, EXPECTED.chunk_root)
    assert.equal(roots.csum, EXPECTED.csum_root)
    assert.equal(roots.bySubvolume.get(EXPECTED.subvolid), EXPECTED.fs_root)
    assert.equal(roots.bySubvolume.get(5), 30605312, 'FS_TREE is subvolume 5')
    assert.equal(executor.calls.length, 1)
  })

  // selfheal.8 — the extent tree root rides along. The selfheal.5 walk never
  // needed it; a logical byte can only be traced to its extent through it.
  it('reads the extent tree root from the compressed-rig capture (selfheal.8)', () => {
    const roots = parseTreeRoots(fixture('dump-tree-roots-compressed.txt'))
    assert.equal(roots.chunk, 22036480)
    assert.equal(roots.csum, 30441472)
    assert.equal(roots.extent, 30457856)
    assert.equal(roots.bySubvolume.get(256), 30539776)
  })

  it('the selfheal.2 rig capture names its extent tree too — always present on a real fs', () => {
    const roots = parseTreeRoots(fixture('dump-tree-roots.txt'))
    assert.equal(roots.extent, 32505856)
  })

  it('refuses a filesystem whose roots it cannot find', () => {
    assert.throws(() => parseTreeRoots('btrfs-progs v6.14\n'), /named no chunk tree root/)
    assert.throws(
      () => parseTreeRoots('chunk tree: 1 level 0\n'),
      /named no checksum tree root/,
    )
  })

  it('takes the child with the GREATEST key ≤ the target', () => {
    const node = parseTreeBlock(fixture('node-30670848.txt'))
    // Exactly on a separator key.
    assert.equal(chooseChild(node, csumItemKey(82378752)), 31014912)
    // Between two separators — the earlier child owns the range.
    assert.equal(chooseChild(node, csumItemKey(82378752 + 4096)), 31014912)
    // Before everything in the subtree: the leftmost child, so the caller's own
    // "nothing covers this" check reports it rather than a throw mid-descent.
    assert.equal(chooseChild(node, csumItemKey(0)), node.children[0].block)
  })
})

describe('selfheal btree — descending to the leaf', () => {
  for (const target of EXPECTED.targets) {
    const label = target.file ?? target.for ?? 'the chunk tree'
    it(`reaches the ${target.tree} leaf for ${label} in ${target.path.length} bounded reads`, async () => {
      const executor = nodeServer()
      const root = target.tree === 'fs'
        ? EXPECTED.fs_root
        : target.tree === 'csum' ? EXPECTED.csum_root : EXPECTED.chunk_root
      const key = target.tree === 'fs'
        ? extentDataKey(Number(target.key[0]), Number(target.key[2]))
        : target.tree === 'csum' ? csumItemKey(Number(target.key[2])) : chunkItemKey(Number(target.key[2]))

      const leaf = await findLeaf(executor, DEVICE, root, key)
      assert.equal(parseTreeBlock(leaf).bytenr, target.path.at(-1))
      // One exec per level — the whole point of the exercise.
      assert.equal(executor.calls.length, target.path.length)
    })
  }

  it('finds the covering CHUNK_ITEM in the leaf it reached', async () => {
    const executor = nodeServer()
    for (const target of EXPECTED.targets.filter(t => t.tree === 'chunk')) {
      const leaf = await findLeaf(executor, DEVICE, EXPECTED.chunk_root, chunkItemKey(target.logical as number))
      const chunk = chunkForLogical(parseChunkItems(leaf), target.logical as number, true)
      assert.equal(chunk.logical, target.chunk_logical)
      assert.equal(chunk.deviceOffset, target.chunk_device)
    }
  })

  it('finds the covering EXTENT_CSUM entry in the leaf it reached', async () => {
    const executor = nodeServer()
    for (const target of EXPECTED.targets.filter(t => t.tree === 'csum')) {
      const leaf = await findLeaf(executor, DEVICE, EXPECTED.csum_root, csumItemKey(target.logical as number))
      const entry = findCsumEntry(parseCsumItems(leaf), target.logical as number)
      assert.ok(entry, `no csum entry for ${target.logical}`)
      assert.ok(entry.item.start <= (target.logical as number))
    }
  })

  it('finds the covering EXTENT_DATA item in the leaf it reached', async () => {
    const executor = nodeServer()
    for (const target of EXPECTED.targets.filter(t => t.tree === 'fs')) {
      const offset = Number(target.key[2])
      const leaf = await findLeaf(executor, DEVICE, EXPECTED.fs_root, extentDataKey(target.inode as number, offset))
      const extent = extentForFileOffset(parseExtentItems(leaf, target.inode as number), offset)
      assert.equal(extent.diskByte !== undefined, true)
      assert.equal((extent.diskByte as number) + (offset - extent.fileOffset), target.logical_byte)
    }
  })

  /**
   * The "largest key ≤ target" selection is only exercised at the END of a node
   * when the target sorts past every separator — pick the wrong branch and a
   * lookup at the tail of the tree silently answers from the wrong subtree.
   */
  it('descends into the LAST child when the target sorts past every separator', async () => {
    const executor = nodeServer()
    const key = csumItemKey(Number(EXPECTED.last_child.key[2]))
    const leaf = await findLeaf(executor, DEVICE, EXPECTED.csum_root, key)
    assert.equal(parseTreeBlock(leaf).bytenr, EXPECTED.last_child.expected_leaf)
    const root = parseTreeBlock(fixture(`node-${EXPECTED.csum_root}.txt`))
    assert.equal(root.children.at(-1)?.block, EXPECTED.last_child.expected_leaf)
  })

  it('reaches the inline extent of a tiny file — which the engine then refuses', async () => {
    const executor = nodeServer()
    const inode = EXPECTED.inline.inode
    const leaf = await findLeaf(executor, DEVICE, EXPECTED.fs_root, extentDataKey(inode, 0))
    assert.equal(parseTreeBlock(leaf).bytenr, EXPECTED.inline.path.at(-1))
    const extent = extentForFileOffset(parseExtentItems(leaf, inode), 0)
    assert.equal(extent.type, 'inline')
    assert.equal(extent.diskByte, undefined, 'an inline extent has no on-disk bytes to repair')
  })

  it('refuses to loop, and refuses a tree deeper than any btrfs tree is', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: '/usr/bin/btrfs',
      result: {
        stdout: 'node 100 level 1 items 1\n\tkey (256 INODE_ITEM 0) block 100 gen 1\n',
        stderr: '',
        exitCode: 0,
      },
    })
    await assert.rejects(
      findLeaf(executor, DEVICE, 100, extentDataKey(257, 0)),
      /revisited block 100/,
    )
    assert.ok(MAX_TREE_DEPTH >= 8)
  })
})
