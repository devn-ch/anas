import type { AhrPool, SelfhealStepName } from '@anas/shared'
import type {
  CommandExecutor,
  ExecResult,
  ExecStreamResult,
  PipelineResult,
} from '../../executor/types.js'
import type { SelfhealRepairOptions } from '../selfheal-repair.js'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SelfhealOutcome } from '@anas/shared'
import { withTopLevelMount } from '../ahr-snapshots.js'
import { crc32c, NODE_BYTES } from '../selfheal-csum.js'
import { chunkForLogical, geometryFromAttributes, locateLogicalIn, memberOffsetOn, parseChunkItems, parseDmTable, parseMdDetailExport, selfhealBand } from '../selfheal-map.js'
import {
  boundedWindowCheck,
  ForeignSyncOpError,
  gfInv,
  gfMul,
  gfPow2,
  reconstructFromQ,
  reconstructionPlan,
  repairBlock,
  restoreSyncKnobs,
  SELFHEAL_SNAPSHOT_PREFIX,
  SelfhealRunError,
} from '../selfheal-repair.js'
import { forgetIssuedChecks, hasIssuedCheck, markCheckIssued } from '../selfheal-syncop.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, '../../fixtures/selfheal')

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf-8')
}

const BS = 4096
/** f1.bin block 300, verbatim off its member disk, and the csum btrfs stored. */
const HEALTHY = Buffer.from(fixture('member-block-f1-300.b64').trim(), 'base64')
const STORED = Number(fixture('member-block-f1-300.csum').trim())
/** Where the chain puts that block on the captured rig (see selfheal-map.test.ts). */
const MEMBER_OFFSET = 4308992
const MD_BYTE = 16171008
/** The csum tree leaf of the captured rig — what a sealed fake leaf claims to be. */
const CSUM_LEAF = 30834688
const TARGET_ROLE = 0
const STRIPE = 49
const MEMBERS = ['/dev/loop0', '/dev/loop1', '/dev/loop2', '/dev/loop3', '/dev/loop4', '/dev/loop5']

/**
 * The captured rig's trees are each a single leaf, so its tree ROOTS are those
 * leaves. Reading the bytenrs out of the fixtures themselves keeps the fake
 * honest — nothing here is a number typed twice.
 */
function leafBytenr(name: string): number {
  const m = /^leaf (\d+) items/m.exec(fixture(name))
  if (!m)
    throw new Error(`${name} has no leaf header`)
  return Number(m[1])
}
const TREE_LEAVES: Record<number, string> = {
  [leafBytenr('dump-tree-chunk.txt')]: 'dump-tree-chunk.txt',
  [leafBytenr('dump-tree-csum.txt')]: 'dump-tree-csum.txt',
  [leafBytenr('dump-tree-subvol.txt')]: 'dump-tree-subvol.txt',
}
const TREE_ROOTS = [
  'btrfs-progs v6.14',
  'root tree: 1 level 0',
  `chunk tree: ${leafBytenr('dump-tree-chunk.txt')} level 0`,
  `checksum tree key (CSUM_TREE ROOT_ITEM 0) ${leafBytenr('dump-tree-csum.txt')} level 0`,
  `file tree key (256 ROOT_ITEM 0) ${leafBytenr('dump-tree-subvol.txt')} level 0`,
  '',
].join('\n')

/**
 * Make a synthetic 16 KiB btrfs node vouch for itself, the way the filesystem
 * does: its own bytenr at header offset 48, and the crc32c of bytes
 * 32…nodesize in the low four bytes of the csum field, little-endian.
 *
 * D3: the engine now verifies the csum leaf it reads raw off the LV, so a fake
 * that hands back a bare `Buffer.alloc` with a checksum written into it is
 * correctly refused. Sealing it is what a real leaf already is — proved
 * against the captured `split-csum-leaf.b64` in selfheal-csum.test.ts.
 */
function sealNode(node: Buffer, bytenr: number): Buffer {
  node.writeBigUInt64LE(BigInt(bytenr), 48)
  node.writeUInt32LE(crc32c(node.subarray(32, NODE_BYTES)), 0)
  return node
}

/** Deterministic filler for the sibling members — content is irrelevant, XOR is not. */
function filler(seed: number): Buffer {
  const out = Buffer.alloc(BS)
  let x = seed * 2654435761 % 4294967291
  for (let i = 0; i < BS; i++) {
    x = (x * 1103515245 + 12345) % 2147483648
    out[i] = x & 0xFF
  }
  return out
}

/** The last argv element — where mount/umount/snapshot put their destination. */
function lastArg(args: string[]): string {
  return args.at(-1) ?? ''
}

function xor(...buffers: Buffer[]): Buffer {
  const out = Buffer.alloc(BS)
  for (const b of buffers) {
    for (let i = 0; i < BS; i++)
      out[i] ^= b[i]
  }
  return out
}

/**
 * A fake node: real md sysfs knob FILES in a temp tree (so the engine's
 * save/restore is exercised for real), plus an executor that serves the rig's
 * captured command output and a six-member array held in memory.
 *
 * The array is seeded so that the XOR of the five other members at the target
 * offset IS the healthy block — which is what a real RAID5 stripe means and
 * what the reconstruction has to rediscover.
 */
class FakeNode implements CommandExecutor {
  readonly root: string
  readonly mountpoint: string
  readonly file: string
  readonly sys: string
  readonly members = new Map<string, Buffer>()
  readonly calls: { command: string, args: string[] }[] = []
  readonly deleted: string[] = []
  mdBlock: Buffer
  /** Set when the engine writes through md — the model's "the stripe is fixed now". */
  wroteThroughMd: Buffer | null = null
  /** dmsetup's global table, so a pvmove can be staged. */
  dmTableAll = fixture('dmsetup-table-all.txt')
  /** The LV's own table — overridden to stage a multi-band pool. */
  dmTableLv = fixture('dmsetup-table-lv.txt')
  /** §12: paths findmnt should report as mounted (the top-level-mount gate). */
  readonly mounted = new Set<string>()
  /** §12: what `btrfs subvolume list` reports. */
  subvolList = ''
  /** §12: `btrfs inspect-internal subvolid-resolve` answer for the file. */
  subvolResolve = '@data'
  /** Every top-level mount taken and released, in order. */
  readonly mountLog: string[] = []
  /** Snapshots created, by their full destination path. */
  readonly created: string[] = []
  /** What `mismatch_cnt` reads before anything is written. */
  precheckMismatch = '8'

  constructor(options?: { corrupt?: boolean }) {
    this.root = mkdtempSync(join(tmpdir(), 'anas-selfheal-'))
    this.mountpoint = join(this.root, 'mnt')
    this.file = join(this.mountpoint, 'f1.bin')
    this.sys = join(this.root, 'sys/block/md127/md')
    mkdirSync(this.mountpoint, { recursive: true })
    mkdirSync(this.sys, { recursive: true })
    mkdirSync(join(this.root, 'proc/sys/vm'), { recursive: true })
    writeFileSync(join(this.root, 'proc/sys/vm/drop_caches'), '0')

    for (const line of fixture('md-sysfs-raid5.txt').split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0 || line.slice(eq + 1) === '<absent>')
        continue
      const key = line.slice(0, eq)
      const path = join(this.sys, key)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${line.slice(eq + 1)}\n`)
    }
    writeFileSync(join(this.sys, 'mismatch_cnt'), `${this.precheckMismatch}\n`)
    writeFileSync(join(this.sys, 'sync_completed'), '999999 / 407552\n')
    // A SECOND band, so a multi-band pool can be staged: a different array with
    // a different chunk size and a different data offset (captured rig).
    const band2 = join(this.root, 'sys/block/md126/md')
    mkdirSync(band2, { recursive: true })
    for (const line of fixture('twoband-md-sysfs-band2.txt').split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0 || line.slice(eq + 1) === '<absent>')
        continue
      const path = join(band2, line.slice(0, eq))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${line.slice(eq + 1)}\n`)
    }
    writeFileSync(join(band2, 'sync_completed'), '999999 / 405504\n')

    const siblings = [1, 2, 3, 5].map(i => filler(i))
    this.members.set(MEMBERS[1], siblings[0])
    this.members.set(MEMBERS[2], siblings[1])
    this.members.set(MEMBERS[3], siblings[2])
    this.members.set(MEMBERS[5], siblings[3])
    // P = XOR of every data member of the stripe (data order 5,0,1,2,3).
    this.members.set(MEMBERS[4], xor(HEALTHY, ...siblings))
    const corrupt = options?.corrupt !== false
    const junk = Buffer.alloc(BS, 0xAB)
    this.members.set(MEMBERS[0], corrupt ? junk : HEALTHY)
    this.mdBlock = this.members.get(MEMBERS[0]) as Buffer
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }

  knob(key: string): string {
    return readFileSync(join(this.sys, key), 'utf-8').trim()
  }

  setKnob(key: string, value: string): void {
    writeFileSync(join(this.sys, key), `${value}\n`)
  }

  async exec(command: string, args: string[]): Promise<ExecResult> {
    this.calls.push({ command, args })
    const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

    if (command === '/usr/bin/readlink') {
      const target = args[1]
      if (target.includes('9:127'))
        return ok('/sys/devices/virtual/block/md127\n')
      if (target.includes('9:126'))
        return ok('/sys/devices/virtual/block/md126\n')
      return ok(`${target}\n`)
    }
    if (command === '/usr/bin/findmnt') {
      if (args[0] === '--mountpoint') {
        return this.mounted.has(args[1])
          ? ok(`${args[1]}\n`)
          : { stdout: '', stderr: '', exitCode: 1 }
      }
      return ok('/dev/mapper/gtsh-data\n')
    }
    if (command === '/usr/bin/mount') {
      this.mounted.add(lastArg(args))
      this.mountLog.push(`mount ${args.join(' ')}`)
      return ok('')
    }
    if (command === '/usr/bin/umount') {
      this.mounted.delete(lastArg(args))
      this.mountLog.push(`umount ${lastArg(args)}`)
      return ok('')
    }
    if (command === '/usr/sbin/dmsetup')
      return ok(args.length > 1 ? this.dmTableLv : this.dmTableAll)
    if (command === '/usr/sbin/mdadm') {
      return ok(lastArg(args) === '/dev/md126'
        ? fixture('twoband-mdadm-detail-export-band2.txt')
        : fixture('mdadm-detail-export-raid5.txt'))
    }
    if (command === '/usr/bin/stat')
      return ok('257\n')
    if (command === '/usr/bin/sync')
      return ok('')
    if (command === '/usr/bin/btrfs') {
      if (args[1] === 'dump-tree') {
        if (args[2] === '-r')
          return ok(TREE_ROOTS)
        const leaf = TREE_LEAVES[Number(args[3])]
        if (args[2] === '-b' && leaf)
          return ok(fixture(leaf))
        return { stdout: '', stderr: `no such block ${args[3]}`, exitCode: 1 }
      }
      if (args[1] === 'rootid')
        return ok('256\n')
      if (args[1] === 'subvolid-resolve')
        return ok(`${this.subvolResolve}\n`)
      if (args[0] === 'subvolume' && args[1] === 'list')
        return ok(this.subvolList)
      if (args[0] === 'subvolume' && args[1] === 'delete') {
        this.deleted.push(args[2])
        return ok('')
      }
      if (args[0] === 'subvolume' && args[1] === 'snapshot') {
        this.created.push(lastArg(args))
        return ok('')
      }
    }
    if (command === '/usr/bin/dd') {
      const source = args.find(a => a.startsWith('if='))?.slice(3) ?? ''
      const target = args.find(a => a.startsWith('of='))?.slice(3) ?? ''
      if (target !== '' && target !== '/dev/null') {
        // The one write the engine makes: through md, reconstruct-write.
        this.wroteThroughMd = readFileSync(source)
        this.mdBlock = this.wroteThroughMd
        this.members.set(MEMBERS[TARGET_ROLE], this.wroteThroughMd)
        this.setKnob('mismatch_cnt', '0')
      }
      return ok('')
    }
    return { stdout: '', stderr: `unexpected ${command}`, exitCode: 127 }
  }

  async pipeline(cmd1: string, args1: string[], cmd2: string, args2: string[]): Promise<PipelineResult> {
    this.calls.push({ command: cmd1, args: args1 })
    const device = args1.find(a => a.startsWith('if='))?.slice(3) ?? ''
    const skip = Number(args1.find(a => a.startsWith('skip='))?.slice(5) ?? '0')
    const count = Number(args1.find(a => a.startsWith('count='))?.slice(6) ?? '1')
    const offset = skip * BS
    let bytes: Buffer

    if (device === '/dev/mapper/gtsh-data') {
      // The csum leaf: every 4-byte slot carries the stored csum, so the read
      // proves the HOP, not the entry arithmetic (that is selfheal-csum.test).
      // Sealed as a real node so it passes the engine's own check (D3).
      bytes = Buffer.alloc(count * BS)
      for (let i = 0; i + 4 <= bytes.length; i += 4)
        bytes.writeUInt32LE(STORED, i)
      sealNode(bytes.subarray(0, NODE_BYTES), CSUM_LEAF)
    }
    else if (device === '/dev/md127') {
      assert.equal(offset, MD_BYTE, 'the engine read md somewhere the mapping did not point')
      bytes = this.mdBlock
    }
    else {
      assert.equal(offset, MEMBER_OFFSET, `member read at ${offset}, not the mapped offset`)
      bytes = this.members.get(device) ?? Buffer.alloc(BS)
    }
    void cmd2
    void args2
    return { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: bytes.toString('base64') }
  }

  async execToStream(): Promise<ExecStreamResult> {
    throw new Error('not used')
  }
}

/**
 * A fake RAID1 BAND, with the two legs at DIFFERENT data offsets.
 *
 * md does not require a mirror's legs to share `rd<n>/offset` (`--grow
 * --data-offset` alone can end that), and a leg read at another leg's offset is
 * 4 KiB of some other block — which passes no checksum and, on the write side,
 * would be a repair aimed at the wrong place. The legs here are deliberately
 * skewed so every mirror read has to use the leg's OWN offset to find anything.
 *
 * Reads are served from an (offset → bytes) map per device, so a read at the
 * wrong offset returns zeros rather than quietly succeeding.
 */
class FakeMirror implements CommandExecutor {
  readonly root: string
  readonly mountpoint: string
  readonly file: string
  readonly sys: string
  readonly legs = new Map<string, Map<number, Buffer>>()
  readonly calls: { command: string, args: string[] }[] = []
  readonly memberReads: { device: string, offset: number }[] = []
  readonly deleted: string[] = []
  /** What md itself serves at the mapped md byte — `read_balance` picks a leg. */
  mdBytes: Buffer
  wroteThroughMd: Buffer | null = null

  /** Leg role → its data offset in bytes. */
  static readonly OFFSETS = [1048576, 4194304]
  static readonly LEGS = ['/dev/loop0', '/dev/loop1']

  constructor(options?: { corruptLeg?: number, mdServes?: 'good' | 'bad' | 'neither' }) {
    this.root = mkdtempSync(join(tmpdir(), 'anas-selfheal-r1-'))
    this.mountpoint = join(this.root, 'mnt')
    this.file = join(this.mountpoint, 'f1.bin')
    this.sys = join(this.root, 'sys/block/md126/md')
    mkdirSync(this.mountpoint, { recursive: true })
    mkdirSync(this.sys, { recursive: true })
    mkdirSync(join(this.root, 'proc/sys/vm'), { recursive: true })
    writeFileSync(join(this.root, 'proc/sys/vm/drop_caches'), '0')

    for (const line of fixture('md-sysfs-raid1.txt').split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0 || line.slice(eq + 1) === '<absent>')
        continue
      const path = join(this.sys, line.slice(0, eq))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${line.slice(eq + 1)}\n`)
    }
    // The skew: leg 1 four megabytes in, leg 0 one.
    writeFileSync(join(this.sys, 'rd0/offset'), `${FakeMirror.OFFSETS[0] / 512}\n`)
    writeFileSync(join(this.sys, 'rd1/offset'), `${FakeMirror.OFFSETS[1] / 512}\n`)
    writeFileSync(join(this.sys, 'mismatch_cnt'), '8\n')
    writeFileSync(join(this.sys, 'sync_completed'), '999999 / 129024\n')

    const junk = Buffer.alloc(BS, 0xAB)
    const bad = options?.corruptLeg ?? 0
    for (const [role, device] of FakeMirror.LEGS.entries()) {
      const content = role === bad ? junk : HEALTHY
      this.legs.set(device, new Map([[FakeMirror.OFFSETS[role] + MD_BYTE, content]]))
    }
    this.mdBytes = options?.mdServes === 'bad'
      ? junk
      : options?.mdServes === 'neither'
        ? Buffer.alloc(BS, 0x5A)
        : HEALTHY // the default: md served the HEALTHY leg, as it may
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }

  knob(key: string): string {
    return readFileSync(join(this.sys, key), 'utf-8').trim()
  }

  async exec(command: string, args: string[]): Promise<ExecResult> {
    this.calls.push({ command, args })
    const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
    if (command === '/usr/bin/readlink') {
      return ok(args[1].includes('9:126') ? '/sys/devices/virtual/block/md126\n' : `${args[1]}\n`)
    }
    if (command === '/usr/bin/findmnt') {
      return args[0] === '--mountpoint' ? { stdout: '', stderr: '', exitCode: 1 } : ok('/dev/mapper/gtsh-data\n')
    }
    if (command === '/usr/sbin/dmsetup')
      return ok(args.length > 1 ? '0 2031616 linear 9:126 2560\n' : 'gtsh-data: 0 2031616 linear 9:126 2560\n')
    if (command === '/usr/sbin/mdadm')
      return ok(fixture('mdadm-detail-export-raid1.txt'))
    if (command === '/usr/bin/stat')
      return ok('257\n')
    if (command === '/usr/bin/sync')
      return ok('')
    if (command === '/usr/bin/btrfs') {
      if (args[1] === 'dump-tree') {
        if (args[2] === '-r')
          return ok(TREE_ROOTS)
        const leaf = TREE_LEAVES[Number(args[3])]
        if (args[2] === '-b' && leaf)
          return ok(fixture(leaf))
        return { stdout: '', stderr: `no such block ${args[3]}`, exitCode: 1 }
      }
      if (args[1] === 'rootid')
        return ok('256\n')
      if (args[0] === 'subvolume' && args[1] === 'delete') {
        this.deleted.push(args[2])
        return ok('')
      }
      if (args[0] === 'subvolume' && args[1] === 'snapshot')
        return ok('')
    }
    if (command === '/usr/bin/dd') {
      const target = args.find(a => a.startsWith('of='))?.slice(3) ?? ''
      const source = args.find(a => a.startsWith('if='))?.slice(3) ?? ''
      if (target !== '' && target !== '/dev/null') {
        this.wroteThroughMd = readFileSync(source)
        this.mdBytes = this.wroteThroughMd
        for (const [role, device] of FakeMirror.LEGS.entries())
          this.legs.get(device)?.set(FakeMirror.OFFSETS[role] + MD_BYTE, this.wroteThroughMd)
        writeFileSync(join(this.sys, 'mismatch_cnt'), '0\n')
      }
      return ok('')
    }
    return { stdout: '', stderr: `unexpected ${command}`, exitCode: 127 }
  }

  async pipeline(cmd1: string, args1: string[], cmd2: string, args2: string[]): Promise<PipelineResult> {
    this.calls.push({ command: cmd1, args: args1 })
    void cmd2
    void args2
    const device = args1.find(a => a.startsWith('if='))?.slice(3) ?? ''
    const count = Number(args1.find(a => a.startsWith('count='))?.slice(6) ?? '1')
    const offset = Number(args1.find(a => a.startsWith('skip='))?.slice(5) ?? '0') * BS
    let bytes: Buffer
    if (device === '/dev/mapper/gtsh-data') {
      bytes = Buffer.alloc(count * BS)
      for (let i = 0; i + 4 <= bytes.length; i += 4)
        bytes.writeUInt32LE(STORED, i)
      sealNode(bytes.subarray(0, NODE_BYTES), CSUM_LEAF)
    }
    else if (device === '/dev/md126') {
      assert.equal(offset, MD_BYTE, 'the engine read md somewhere the mapping did not point')
      bytes = this.mdBytes
    }
    else {
      this.memberReads.push({ device, offset })
      bytes = this.legs.get(device)?.get(offset) ?? Buffer.alloc(BS)
    }
    return { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: bytes.toString('base64') }
  }

  async execToStream(): Promise<ExecStreamResult> {
    throw new Error('not used')
  }
}

const OPTIONS = { checkTimeoutSeconds: 5, evictSpan: 1, settleMs: 0 }

let node: FakeNode

function useNode(build: () => FakeNode): void {
  beforeEach(() => {
    // The sync-op ownership log lives for the life of the process (D2). Each
    // case starts with nothing issued, exactly as a fresh daemon would.
    forgetIssuedChecks()
    node = build()
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = node.root
    process.env.ANAS_SELFHEAL_RUNTIME_DIR = join(node.root, 'run')
  })
  afterEach(() => {
    delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
    delete process.env.ANAS_SELFHEAL_RUNTIME_DIR
    node.cleanup()
  })
}

/** The captured rig's own geometry, pointed at the current fake node's sysfs. */
function raid5Geometry() {
  const attributes: Record<string, string | null> = {}
  for (const line of fixture('md-sysfs-raid5.txt').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0)
      attributes[line.slice(0, eq)] = line.slice(eq + 1) === '<absent>' ? null : line.slice(eq + 1)
  }
  return geometryFromAttributes('/dev/md127', 'md127', node.sys, attributes, parseMdDetailExport(fixture('mdadm-detail-export-raid5.txt'), 6))
}

/** Every knob the engine may touch, back the way md shipped it. */
function assertKnobsRestored(): void {
  assert.equal(node.knob('rmw_level'), '1', 'rmw_level')
  assert.equal(node.knob('sync_min'), '0', 'sync_min')
  assert.equal(node.knob('sync_max'), 'max', 'sync_max')
  assert.equal(node.knob('stripe_cache_size'), '256', 'stripe_cache_size')
}

/**
 * The converged sequence (selfheal.5) against a fake md whose knobs are real
 * files. The loop-device suite proves it on a real array; these prove the
 * decisions — which verdict, what is written, and that NOTHING is left behind
 * on any path out.
 */
describe('selfheal repair — reconstruction arithmetic', () => {
  it('reconstructs a RAID5 block as the XOR of the other members', () => {
    const siblings = [1, 2, 3, 5].map(i => filler(i))
    const parity = xor(HEALTHY, ...siblings)
    assert.ok(xor(parity, ...siblings).equals(HEALTHY))
    assert.equal(crc32c(xor(parity, ...siblings)), STORED)
  })

  it('multiplies and inverts in md\'s GF(2^8) (poly 0x11d, generator 2)', () => {
    assert.equal(gfMul(0, 0x57), 0)
    assert.equal(gfMul(1, 0x57), 0x57)
    // Vectors for RAID6's polynomial 0x11D — NOT AES's 0x11B, whose table
    // would answer 0xC1 here and be wrong for every syndrome md ever wrote.
    assert.equal(gfMul(0x57, 0x83), 0x31)
    assert.equal(gfMul(0x02, 0x80), 0x1D)
    assert.equal(gfMul(0x8D, 0x37), 0xCC)
    assert.equal(gfPow2(0), 1)
    assert.equal(gfPow2(1), 2)
    assert.equal(gfPow2(8), 0x1D)
    for (let a = 1; a < 256; a++)
      assert.equal(gfMul(a, gfInv(a)), 1, `inverse of ${a}`)
  })

  /**
   * The Q-syndrome path — the only reconstruction that never touches P, and so
   * the only one that survives a stripe whose P member is also damaged. The
   * CONVENTION (coefficient g^d over the data disks in md's stripe order) was
   * verified live against a 7-member RAID6 loop rig: the computed P and Q
   * matched the array's own P and Q members byte for byte on three stripes.
   */
  it('solves the Q syndrome for the one missing data block', () => {
    const data = [0, 1, 2, 3, 4].map(i => filler(i + 10))
    const q = Buffer.alloc(BS)
    for (let d = 0; d < data.length; d++) {
      const coefficient = gfPow2(d)
      for (let i = 0; i < BS; i++)
        q[i] ^= gfMul(coefficient, data[d][i])
    }
    for (let missing = 0; missing < data.length; missing++) {
      const survivors = data.map((b, d) => (d === missing ? null : b))
      assert.ok(reconstructFromQ(survivors, q, missing).equals(data[missing]), `missing ${missing}`)
    }
  })
})

describe('selfheal repair — a corrupt block on a RAID5 member', () => {
  useNode(() => new FakeNode())

  it('reconstructs it, arbitrates against the stored csum and writes it back', async () => {
    const outcome = await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)

    assert.equal(outcome.outcome, 'repaired', outcome.reason)
    assert.ok(node.wroteThroughMd?.equals(HEALTHY), 'the healthy block was written through md')
    assert.equal(outcome.diagnostics?.reconstruction, 'xor')
    assert.equal(outcome.diagnostics?.candidateCsum, outcome.diagnostics?.storedCsum)
    assert.equal(outcome.diagnostics?.precheckMismatch, 8)
    assert.equal(outcome.diagnostics?.postcheckMismatch, 0)
    assert.deepEqual(outcome.diagnostics?.cleanupErrors, [])
  })

  it('runs the steps in the converged order, and says what each one found', async () => {
    const outcome = await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    assert.deepEqual(outcome.steps.map(s => s.name), [
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
    assert.ok(outcome.steps.every(s => s.ok))
  })

  it('reports the mapping it used, all the way down the chain', async () => {
    const outcome = await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    const map = outcome.diagnostics?.mapping
    assert.equal(map?.memberIndex, TARGET_ROLE)
    assert.equal(map?.memberDevice, MEMBERS[TARGET_ROLE])
    assert.equal(map?.memberOffset, MEMBER_OFFSET)
    assert.equal(map?.mdByte, MD_BYTE)
    assert.equal(map?.stripe, STRIPE)
    assert.equal(map?.parityIndex, 4)
    assert.equal(map?.qIndex, null)
    assert.equal(map?.compressed, false)
    assert.equal(outcome.member, MEMBERS[TARGET_ROLE])
    assert.equal(outcome.array, '/dev/md127')
  })

  it('restores every knob and destroys its transient snapshot', async () => {
    await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    assertKnobsRestored()
    assert.equal(node.deleted.length, 1)
    assert.ok(node.deleted[0].includes(SELFHEAL_SNAPSHOT_PREFIX))
  })

  it('sets rmw_level to 0 BEFORE the write — the GT-7 poison is the default', async () => {
    let levelAtWrite: string | null = null
    await repairBlock(
      node,
      { mountpoint: node.mountpoint, file: node.file, block: 300 },
      { ...OPTIONS, beforeStep: (name) => {
        if (name === 'write')
          levelAtWrite = node.knob('rmw_level')
      } },
    )
    assert.equal(levelAtWrite, '0')
    assert.equal(node.knob('rmw_level'), '1')
  })

  it('produces an outcome the shared schema accepts', async () => {
    const outcome = await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    const parsed = SelfhealOutcome.parse(outcome)
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(outcome)))
    assert.throws(() => SelfhealOutcome.parse({ ...outcome, outcome: 'fixed' }))
  })
})

/**
 * R1 — a multi-band pool. The LV is a linear concatenation of one md array per
 * band (AHR-DESIGN §2.6), and the block under repair is in the SECOND band.
 * Before the fix the whole run took its geometry from the FIRST segment: the
 * block was placed with the wrong array's chunk size and member list, and read,
 * guarded and WRITTEN on the wrong disks.
 */
describe('selfheal repair — a block in the second band of the pool', () => {
  useNode(() => {
    const built = new FakeNode()
    // Band 1 is a 2048-sector sliver on ANOTHER array (md126, 512 K chunk,
    // 2 MiB data offset); band 2 is the rig's own array, and the segment's
    // offset keeps every captured number (md byte, member offset) unchanged.
    built.dmTableLv = '0 2048 linear 9:126 0\n2048 2029568 linear 9:127 4608\n'
    built.dmTableAll = `gtsh-data: ${built.dmTableLv.split('\n')[0]}\n`
    return built
  })

  it('resolves, reads and writes through the BAND\'s own array', async () => {
    const outcome = await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)

    assert.equal(outcome.outcome, 'repaired', outcome.reason)
    assert.equal(outcome.array, '/dev/md127', 'the band the block is on')
    assert.equal(outcome.diagnostics?.mapping?.memberDevice, MEMBERS[TARGET_ROLE])
    assert.equal(outcome.diagnostics?.mapping?.mdByte, MD_BYTE)
    assert.equal(outcome.diagnostics?.mapping?.chunkBytes, 65536, 'band 2\'s chunk, not band 1\'s 512 K')
    assert.ok(node.wroteThroughMd?.equals(HEALTHY))
  })

  it('reads and writes NO block device but band 2\'s array and its members', async () => {
    await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    const onBand1 = node.calls.filter(c => c.command === '/usr/bin/dd' && c.args.some(a => a.includes('/dev/md126')))
    assert.deepEqual(onBand1, [], 'band 1\'s array was read or written')
    // Its knobs are read (the gates check every band) but never turned: the
    // engine's one rmw_level write goes to the band under repair.
    assert.equal(readFileSync(join(node.root, 'sys/block/md126/md/rmw_level'), 'utf-8').trim(), '1')
    assert.equal(node.knob('rmw_level'), '1')
  })

  // The refusal now comes from the GATES, by name: a band's geometry failure is
  // carried on the band rather than thrown out of `resolveContext` (F6 — one
  // unreadable band must not void a whole scrub's attribution), and the repair
  // gate is what turns it back into a refusal for the pool as a whole.
  it('REFUSES a pool whose segment is not on an md array at all', async () => {
    node.dmTableLv = '0 2031616 linear 9:200 2560\n'
    const outcome = await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    assert.equal(outcome.outcome, 'unrepairable')
    assert.match(outcome.reason, /^refused: .*is not an md array/)
    assert.equal(node.wroteThroughMd, null)
    assert.deepEqual(outcome.steps.map(s => s.name), ['gates'], 'nothing past the gates ran')
  })
})

/**
 * A compressed blob whose on-disk sectors sit on TWO bands (second-pass F5).
 *
 * R1 gave every sector its own band, but the repair kept using
 * `sectors[0].geometry` for the knob save/restore and for the outcome's
 * `array`, while the write, the bounded checks and `rmw_level=0` went to
 * `target.geometry`. On a blob that straddles a band boundary those are
 * DIFFERENT arrays: band 2 was left at `rmw_level=0` for good and band 1 got a
 * restore it never needed. `reverify` had the same split — it read every
 * sector's `raid1`/`members` out of the first sector's geometry.
 *
 * The filesystem is a live capture (PROVENANCE.md, "Multi-sector compressed
 * blob"): `blob.bin`, one zstd extent of 128 KiB compressed to 45,056 on-disk
 * bytes — ELEVEN 4 KiB sectors, contiguous from logical 13,631,488 in a DATA
 * chunk whose device delta is 0. The dm table below puts the first eight of
 * them on band 1 and the last three on band 2, and the corrupt one is sector 9.
 */
describe('selfheal repair — a compressed blob straddling two bands', () => {
  const BLOB_LOGICAL = 13631488
  const BLOB_SECTORS = 11
  /** The blob's first sector on band 2 — the dm segment boundary, in LV bytes. */
  const BAND_BOUNDARY = BLOB_LOGICAL + 8 * BS
  /** The sector that is rotten: on band 2, and NOT the blob's first. */
  const BAD_SECTOR = 9
  const BAND2_MEMBERS = ['/dev/loop3', '/dev/loop4', '/dev/loop5']
  /** Band 1 is a MIRROR band — AHR builds one whenever a band has two disks. */
  const BAND1_MEMBERS = ['/dev/loop0', '/dev/loop1']

  const DM_TABLE_TWO_BAND = `0 ${BAND_BOUNDARY / 512} linear 9:127 2048\n`
    + `${BAND_BOUNDARY / 512} 1000000 linear 9:126 4096\n`

  /** The blob's tree blocks, by bytenr, as `dump-tree -b` printed them. */
  const BLOB_BLOCKS: Record<number, string> = {
    22036480: 'blob-dump-tree-chunk.txt',
    30425088: 'blob-dump-tree-csum.txt',
    30556160: 'blob-dump-tree-subvol.txt',
  }
  /** The csum item the capture holds: 11 entries from the blob's first sector. */
  const CSUM_LEAF_LOGICAL = 30425088
  const CSUM_ITEM_OFFSET = 16239
  /** The METADATA|DUP chunk the csum leaf lives in (stripe 0 is the copy read). */
  const CSUM_CHUNK_LOGICAL = 30408704
  const CSUM_CHUNK_DEVICE = 38797312
  const LEAF_HEADER = 101

  class FakeBlobNode implements CommandExecutor {
    readonly root: string
    readonly mountpoint: string
    readonly file: string
    readonly calls: { command: string, args: string[] }[] = []
    /** The blob's true sector contents; index 9 is what the repair must restore. */
    readonly sectors: Buffer[] = []
    /** Where each sector physically is, from the engine's own pure placement. */
    readonly locations: ReturnType<typeof locateLogicalIn>[] = []
    /** `<device>@<offset>` → the 4 KiB it holds. */
    readonly disk = new Map<string, Buffer>()
    wroteTo: { device: string, offset: number } | null = null
    wroteBytes: Buffer | null = null

    constructor() {
      this.root = mkdtempSync(join(tmpdir(), 'anas-selfheal-blob-'))
      this.mountpoint = join(this.root, 'mnt')
      this.file = join(this.mountpoint, 'blob.bin')
      mkdirSync(this.mountpoint, { recursive: true })
      mkdirSync(join(this.root, 'proc/sys/vm'), { recursive: true })
      writeFileSync(join(this.root, 'proc/sys/vm/drop_caches'), '0')
      this.writeSysfs('md127', 'md-sysfs-raid1.txt', '999999 / 129024\n')
      this.writeSysfs('md126', 'twoband-md-sysfs-band2.txt', '999999 / 405504\n')
      // The precheck must see rot on the band under repair.
      writeFileSync(join(this.root, 'sys/block/md126/md/mismatch_cnt'), '8\n')

      const bands = [
        selfhealBand(parseDmTable(DM_TABLE_TWO_BAND)[0], this.geometry('md127', 'mdadm-detail-export-raid1.txt', 'md-sysfs-raid1.txt')),
        selfhealBand(parseDmTable(DM_TABLE_TWO_BAND)[1], this.geometry('md126', 'twoband-mdadm-detail-export-band2.txt', 'twoband-md-sysfs-band2.txt')),
      ]
      const chunk = chunkForLogical(parseChunkItems(fixture('blob-dump-tree-chunk.txt')), BLOB_LOGICAL, true)
      for (let k = 0; k < BLOB_SECTORS; k++) {
        this.sectors.push(filler(100 + k))
        this.locations.push(locateLogicalIn(BLOB_LOGICAL + k * BS, chunk, bands))
      }
      // Every sector where it lives — the bad one replaced by junk. A mirror
      // band carries the same bytes on EVERY leg, each at its own data offset.
      for (let k = 0; k < BLOB_SECTORS; k++) {
        const where = this.locations[k]
        const content = k === BAD_SECTOR ? Buffer.alloc(BS, 0xAB) : this.sectors[k]
        for (const leg of where.mirrors)
          this.disk.set(`${where.geometry.members[leg]}@${memberOffsetOn(where.geometry, where, leg)}`, content)
        this.disk.set(`${where.geometry.device}@${where.mdByte}`, content)
      }
      // Band 2's other two members of the bad sector's stripe, seeded so their
      // XOR IS the sector that has to come back.
      const target = this.locations[BAD_SECTOR]
      const others = BAND2_MEMBERS.map((_, role) => role).filter(role => role !== target.memberIndex)
      const first = filler(7)
      const rows = [first, xor(first, this.sectors[BAD_SECTOR])]
      for (const [i, role] of others.entries())
        this.disk.set(`${BAND2_MEMBERS[role]}@${memberOffsetOn(target.geometry, target, role)}`, rows[i])
    }

    private writeSysfs(kernel: string, capture: string, syncCompleted: string): void {
      const sys = join(this.root, `sys/block/${kernel}/md`)
      mkdirSync(sys, { recursive: true })
      for (const line of fixture(capture).split('\n')) {
        const eq = line.indexOf('=')
        if (eq <= 0 || line.slice(eq + 1) === '<absent>')
          continue
        const path = join(sys, line.slice(0, eq))
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, `${line.slice(eq + 1)}\n`)
      }
      writeFileSync(join(sys, 'sync_completed'), syncCompleted)
    }

    /** The geometry the engine itself will read — built from the same captures. */
    private geometry(kernel: string, exportFixture: string, sysfsFixture: string) {
      const attributes: Record<string, string | null> = {}
      for (const line of fixture(sysfsFixture).split('\n')) {
        const eq = line.indexOf('=')
        if (eq > 0)
          attributes[line.slice(0, eq)] = line.slice(eq + 1) === '<absent>' ? null : line.slice(eq + 1)
      }
      const members = parseMdDetailExport(fixture(exportFixture), Number(attributes.raid_disks))
      return geometryFromAttributes(`/dev/${kernel}`, kernel, `/sys/block/${kernel}/md`, attributes, members)
    }

    cleanup(): void {
      rmSync(this.root, { recursive: true, force: true })
    }

    knob(kernel: string, key: string): string {
      return readFileSync(join(this.root, `sys/block/${kernel}/md`, key), 'utf-8').trim()
    }

    async exec(command: string, args: string[]): Promise<ExecResult> {
      this.calls.push({ command, args })
      const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
      if (command === '/usr/bin/readlink') {
        const target = args[1]
        if (target.includes('9:127'))
          return ok('/sys/devices/virtual/block/md127\n')
        if (target.includes('9:126'))
          return ok('/sys/devices/virtual/block/md126\n')
        return ok(`${target}\n`)
      }
      if (command === '/usr/bin/findmnt') {
        return args[0] === '--mountpoint'
          ? { stdout: '', stderr: '', exitCode: 1 }
          : ok('/dev/mapper/gtsh-data\n')
      }
      if (command === '/usr/sbin/dmsetup')
        return ok(args.length > 1 ? DM_TABLE_TWO_BAND : `gtsh-data: ${DM_TABLE_TWO_BAND.split('\n')[0]}\n`)
      if (command === '/usr/sbin/mdadm') {
        return ok(args.at(-1) === '/dev/md126'
          ? fixture('twoband-mdadm-detail-export-band2.txt')
          : fixture('mdadm-detail-export-raid1.txt'))
      }
      if (command === '/usr/bin/stat')
        return ok('257\n')
      if (command === '/usr/bin/sync')
        return ok('')
      if (command === '/usr/bin/btrfs') {
        if (args[1] === 'dump-tree') {
          if (args[2] === '-r')
            return ok(fixture('blob-dump-tree-roots.txt'))
          const block = BLOB_BLOCKS[Number(args[3])]
          if (block)
            return ok(fixture(block))
          return { stdout: '', stderr: `no such block ${args[3]}`, exitCode: 1 }
        }
        if (args[1] === 'rootid')
          return ok('256\n')
        if (args[1] === 'subvolid-resolve')
          return ok('@data\n')
        if (args[0] === 'subvolume' && args[1] === 'list')
          return ok('')
        if (args[0] === 'subvolume')
          return ok('')
      }
      if (command === '/usr/bin/dd') {
        const source = args.find(a => a.startsWith('if='))?.slice(3) ?? ''
        const target = args.find(a => a.startsWith('of='))?.slice(3) ?? ''
        if (target !== '' && target !== '/dev/null') {
          const offset = Number(args.find(a => a.startsWith('seek='))?.slice(5) ?? '0') * BS
          this.wroteTo = { device: target, offset }
          this.wroteBytes = readFileSync(source)
          this.disk.set(`${target}@${offset}`, this.wroteBytes)
          const where = this.locations[BAD_SECTOR]
          this.disk.set(`${where.memberDevice}@${where.memberOffset}`, this.wroteBytes)
          writeFileSync(join(this.root, 'sys/block/md126/md/mismatch_cnt'), '0\n')
        }
        return ok('')
      }
      return { stdout: '', stderr: `unexpected ${command}`, exitCode: 127 }
    }

    async pipeline(cmd1: string, args1: string[], _cmd2: string, _args2: string[]): Promise<PipelineResult> {
      this.calls.push({ command: cmd1, args: args1 })
      const device = args1.find(a => a.startsWith('if='))?.slice(3) ?? ''
      const skip = Number(args1.find(a => a.startsWith('skip='))?.slice(5) ?? '0')
      const count = Number(args1.find(a => a.startsWith('count='))?.slice(6) ?? '1')
      let bytes: Buffer
      if (device === '/dev/mapper/gtsh-data') {
        // The csum leaf, off the LV: each of the item's 11 entries is the
        // crc32c of the sector it belongs to, at the offset the REAL item
        // header in the capture puts it.
        bytes = Buffer.alloc(count * BS)
        const leafLv = CSUM_LEAF_LOGICAL - CSUM_CHUNK_LOGICAL + CSUM_CHUNK_DEVICE
        assert.equal(skip * BS, leafLv, 'the csum leaf was read somewhere the chunk hop did not point')
        for (let k = 0; k < BLOB_SECTORS; k++)
          bytes.writeUInt32LE(crc32c(this.sectors[k]), LEAF_HEADER + CSUM_ITEM_OFFSET + k * 4)
        sealNode(bytes.subarray(0, NODE_BYTES), CSUM_LEAF_LOGICAL)
      }
      else {
        bytes = this.disk.get(`${device}@${skip * BS}`) ?? Buffer.alloc(BS)
      }
      return { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: bytes.toString('base64') }
    }

    async execToStream(): Promise<ExecStreamResult> {
      throw new Error('not used')
    }
  }

  let blob: FakeBlobNode

  beforeEach(() => {
    forgetIssuedChecks()
    blob = new FakeBlobNode()
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = blob.root
    process.env.ANAS_SELFHEAL_RUNTIME_DIR = join(blob.root, 'run')
  })
  afterEach(() => {
    delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
    delete process.env.ANAS_SELFHEAL_RUNTIME_DIR
    blob.cleanup()
  })

  it('the capture really does straddle: sector 0 on band 1, the bad one on band 2', () => {
    assert.equal(blob.locations[0].geometry.device, '/dev/md127')
    assert.equal(blob.locations[BAD_SECTOR].geometry.device, '/dev/md126')
  })

  it('repairs it on the TARGET\'s band, and names that band in the outcome', async () => {
    const outcome = await repairBlock(blob, { mountpoint: blob.mountpoint, file: blob.file, block: 0 }, OPTIONS)

    assert.equal(outcome.outcome, 'repaired', outcome.reason)
    assert.equal(outcome.array, '/dev/md126', 'the outcome names the band that was worked on, not sector 0\'s')
    assert.ok(BAND2_MEMBERS.includes(outcome.member ?? ''), `member ${outcome.member} is not a band-2 disk`)
    assert.ok(blob.wroteBytes?.equals(blob.sectors[BAD_SECTOR]), 'the sector that came back is the one btrfs checksummed')
    assert.equal(blob.wroteTo?.device, '/dev/md126')
    assert.equal(blob.wroteTo?.offset, blob.locations[BAD_SECTOR].mdByte)
  })

  it('restores rmw_level on the band it turned it down on — and leaves the other band alone', async () => {
    const outcome = await repairBlock(blob, { mountpoint: blob.mountpoint, file: blob.file, block: 0 }, OPTIONS)
    assert.equal(outcome.outcome, 'repaired', outcome.reason)
    assert.deepEqual(outcome.diagnostics?.cleanupErrors, [])
    // Band 2 is the one that was turned down to 0 for the write; it must be
    // back at 1. Pre-fix the restore was written to band 1 and band 2 kept 0.
    assert.equal(blob.knob('md126', 'rmw_level'), '1', 'band 2 rmw_level')
    assert.equal(blob.knob('md126', 'sync_min'), '0')
    assert.equal(blob.knob('md126', 'sync_max'), 'max')
    assert.equal(blob.knob('md126', 'stripe_cache_size'), '256')
    // Band 1 was never turned at all — a mirror band has no `rmw_level` for
    // anything to write to, which is exactly what the pre-fix restore did.
    assert.equal(existsSync(join(blob.root, 'sys/block/md127/md/rmw_level')), false, 'nothing was written to band 1\'s rmw_level')
    assert.equal(blob.knob('md127', 'sync_min'), '0')
    assert.equal(blob.knob('md127', 'sync_max'), 'max')
  })

  it('re-verifies every sector through ITS OWN band\'s members', async () => {
    await repairBlock(blob, { mountpoint: blob.mountpoint, file: blob.file, block: 0 }, OPTIONS)
    const reads = blob.calls
      .filter(c => c.command === '/usr/bin/dd' && c.args.some(a => a.startsWith('if=/dev/loop')))
      .map(c => c.args.find(a => a.startsWith('if='))!.slice(3))
    // Sectors 0..7 live on band 1's disks and 8..10 on band 2's; both sets were
    // read, each at its own array's offsets (a zero-filled miss would fail the
    // csum and abort the run long before the repair above).
    assert.ok(reads.some(d => BAND1_MEMBERS.includes(d)), 'band 1 members were read')
    assert.ok(reads.some(d => BAND2_MEMBERS.includes(d)), 'band 2 members were read')
  })
})

describe('selfheal repair — the verdicts that write nothing', () => {
  useNode(() => new FakeNode())

  it('ABORTS when the bytes at the computed location still pass their csum', async () => {
    node.members.set(MEMBERS[TARGET_ROLE], HEALTHY)
    node.mdBlock = HEALTHY
    const outcome = await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    assert.equal(outcome.outcome, 'mapping-abort')
    assert.match(outcome.reason, /not corrupt here/)
    assert.equal(node.wroteThroughMd, null)
    assertKnobsRestored()
    assert.equal(node.deleted.length, 1)
  })

  it('diagnoses ABOVE MD when parity agrees with the bad data', async () => {
    node.setKnob('mismatch_cnt', '0')
    const outcome = await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    assert.equal(outcome.outcome, 'above-md')
    assert.match(outcome.reason, /implicates something other than the disks/)
    assert.equal(node.wroteThroughMd, null)
    assertKnobsRestored()
  })

  it('is UNREPAIRABLE when no reconstruction matches the stored csum', async () => {
    node.members.set(MEMBERS[4], Buffer.alloc(BS, 0x5A)) // a second damaged block
    const outcome = await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    assert.equal(outcome.outcome, 'unrepairable')
    assert.match(outcome.reason, /more than one block of this stripe is damaged/)
    assert.equal(node.wroteThroughMd, null)
    assertKnobsRestored()
  })

  it('REFUSES while the array is degraded', async () => {
    node.setKnob('degraded', '1')
    const outcome = await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    assert.equal(outcome.outcome, 'unrepairable')
    assert.match(outcome.reason, /^refused: .*is degraded/)
    assert.equal(node.wroteThroughMd, null)
    assert.equal(node.deleted.length, 0, 'nothing was pinned')
  })

  it('REFUSES while md is busy, reshaping, or the array is not writable', async () => {
    for (const [key, value, pattern] of [
      ['sync_action', 'resync', /is busy \(sync_action=resync\)/],
      ['sync_action', 'reshape', /is busy \(sync_action=reshape\)/],
      ['reshape_position', '4096', /mid-reshape/],
      ['array_state', 'read-auto', /read-auto/],
    ] as [string, string, RegExp][]) {
      const fresh = new FakeNode()
      process.env.ANAS_SELFHEAL_KERNEL_ROOT = fresh.root
      fresh.setKnob(key, value)
      const outcome = await repairBlock(fresh, { mountpoint: fresh.mountpoint, file: fresh.file, block: 300 }, OPTIONS)
      assert.equal(outcome.outcome, 'unrepairable', `${key}=${value}`)
      assert.match(outcome.reason, pattern)
      fresh.cleanup()
    }
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = node.root
  })

  it('REFUSES while a pvmove is moving the extents under the pool', async () => {
    node.dmTableAll = `pvmove0: 0 2031616 mirror core 2 1024 nosync 2 9:127 0 9:128 0\n${node.dmTableAll}`
    const outcome = await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    assert.equal(outcome.outcome, 'unrepairable')
    assert.match(outcome.reason, /^refused: a pvmove is in flight \(pvmove0\)/)
    assert.equal(node.wroteThroughMd, null)
  })
})

/**
 * D2 (design review 2026-09-14) — NEVER interrupt an md operation we did not
 * start.
 *
 * `echo idle > sync_action` does not mean "cancel my check". It means "stop
 * whatever you are doing", and what md is very often doing is REBUILDING ONTO
 * A SPARE after a member failed. Three paths wrote it on sight — the bounded
 * check's poll loop, the knob restore, and the scrub's band cancel — so a disk
 * failing mid-repair had its rebuild aborted by the repair that was trying to
 * help. The periodic scrub did it on every pass.
 *
 * A repair that is already mid-sequence when this happens must also write
 * NOTHING: the gates proved the array healthy at step 1, and everything since
 * has taken real time.
 */
describe('selfheal repair — md takes an operation of its own mid-repair', () => {
  useNode(() => new FakeNode())

  it('writes NOTHING when a recovery starts between the precheck and the write', async () => {
    const outcome = await repairBlock(
      node,
      { mountpoint: node.mountpoint, file: node.file, block: 300 },
      { ...OPTIONS, beforeStep: (name) => {
        if (name !== 'write')
          return
        // A member failed after the precheck: md is rebuilding onto a spare,
        // and it has bounded its own sync window to do it.
        node.setKnob('degraded', '1')
        node.setKnob('sync_action', 'recover')
        node.setKnob('sync_min', '6272')
        node.setKnob('sync_max', '6400')
      } },
    )

    assert.equal(outcome.outcome, 'unrepairable', outcome.reason)
    assert.match(outcome.reason, /^array state changed mid-repair: /)
    assert.match(outcome.reason, /is now degraded \(1 member missing\)/)
    assert.match(outcome.reason, /nothing written$/)
    assert.equal(node.wroteThroughMd, null, 'the reconstructed block was NOT written through md')
    // The knobs md set for its own rebuild are exactly as md left them.
    assert.equal(node.knob('sync_action'), 'recover', 'no idle was written over md\'s recovery')
    assert.equal(node.knob('sync_min'), '6272', 'the recovery\'s own window was not widened')
    assert.equal(node.knob('sync_max'), '6400')
    // And the run says what it left behind rather than swallowing it.
    assert.ok(
      outcome.diagnostics?.cleanupErrors.some(e => e.includes('md is running recover')),
      JSON.stringify(outcome.diagnostics?.cleanupErrors),
    )
    // rmw_level is still put back — it changes how md writes, never what it
    // is doing, so restoring it interrupts nothing.
    assert.equal(node.knob('rmw_level'), '1')
  })

  it('stops the bounded check itself rather than narrowing a recovery\'s window', async () => {
    node.setKnob('sync_action', 'recover')
    const geo = raid5Geometry()
    await assert.rejects(
      () => boundedWindowCheck(node, geo, 49, OPTIONS),
      (error: unknown) => {
        assert.ok(error instanceof ForeignSyncOpError)
        assert.match(error.message, /md is running recover on \/dev\/md127; not touched/)
        return true
      },
    )
    assert.equal(node.knob('sync_action'), 'recover')
    assert.equal(node.knob('sync_min'), '0', 'the window was not narrowed onto a running recovery')
    assert.equal(node.knob('sync_max'), 'max')
  })

  it('ends its OWN check with idle, exactly as before', async () => {
    const outcome = await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    assert.equal(outcome.outcome, 'repaired', outcome.reason)
    // The check the engine issued is over and the window is md's own again.
    assert.equal(node.knob('sync_action'), 'idle')
    assertKnobsRestored()
  })
})

describe('selfheal repair — restoreSyncKnobs, and the token it decides with (N3/N11)', () => {
  useNode(() => new FakeNode())

  it('a widen md BOUNCES keeps the token and writes no sync_min/sync_max (N11)', async () => {
    // This run owns a bounded check whose window is still narrow, and md
    // refuses the widen: EBUSY means the op has NOT reached the boundary, so
    // it is still running and still ours. The old code swallowed that, retired
    // the token anyway, and then wrote the window wide open UNDER the running
    // check — resuming it over the whole band.
    const geo = raid5Geometry()
    markCheckIssued('md127')
    node.setKnob('sync_action', 'check')
    node.setKnob('sync_min', '6272')
    node.setKnob('sync_max', '6400')
    chmodSync(join(node.sys, 'sync_max'), 0o444)
    let note: string | null
    try {
      note = await restoreSyncKnobs(geo)
    }
    finally {
      chmodSync(join(node.sys, 'sync_max'), 0o644)
    }

    assert.ok(note?.includes('could not be widened and ended'), String(note))
    assert.ok(note?.includes('the check is still this run\'s'), String(note))
    assert.equal(hasIssuedCheck('md127'), true, 'the check is still running, so it is still ours')
    assert.equal(node.knob('sync_min'), '6272', 'nothing was written under the running check')
    assert.equal(node.knob('sync_max'), '6400')
    assert.equal(node.knob('sync_action'), 'check')
  })

  it('records a sysfs write it could not make, instead of throwing out of cleanup (N11)', async () => {
    // `sync_min` is itself EBUSY on an array md is working on, and the pair was
    // written unconditionally — a raw throw out of a `finally`-driven cleanup.
    const geo = raid5Geometry()
    node.setKnob('sync_action', 'idle')
    node.setKnob('sync_min', '6272')
    chmodSync(join(node.sys, 'sync_min'), 0o444)
    let note: string | null
    try {
      note = await restoreSyncKnobs(geo)
    }
    finally {
      chmodSync(join(node.sys, 'sync_min'), 0o644)
    }
    assert.ok(note?.includes('sync_min not restored to 0'), String(note))
    assert.equal(node.knob('sync_max'), 'max', 'the half that CAN be written still goes in')
  })

  it('gives the token back on an idle array and on a foreign one (N3)', async () => {
    const geo = raid5Geometry()
    // Idle: whatever we issued has ended.
    markCheckIssued('md127')
    node.setKnob('sync_action', 'idle')
    assert.equal(await restoreSyncKnobs(geo), null)
    assert.equal(hasIssuedCheck('md127'), false)

    // Foreign: md took an operation of its own, so our check is gone with it —
    // and a token left behind would make md's NEXT check read as ours.
    markCheckIssued('md127')
    node.setKnob('sync_action', 'recover')
    const note = await restoreSyncKnobs(geo)
    assert.ok(note?.includes('md is running recover'), String(note))
    assert.equal(hasIssuedCheck('md127'), false)
  })

  it('a bounded check that never settles ends its own op and drops the token (N3)', async () => {
    // The op is still running when the timeout expires, and this call is
    // walking away from it: `restoreSyncKnobs` ends OUR op first (while the
    // token still proves it is ours), then the token goes — nothing after this
    // may treat a `check` on this array as this run's.
    const geo = raid5Geometry()
    node.setKnob('sync_action', 'idle')
    node.setKnob('sync_completed', '0 / 407552')
    await assert.rejects(
      () => boundedWindowCheck(node, geo, 49, { ...OPTIONS, checkTimeoutSeconds: 0.5 }),
      (error: unknown) => {
        assert.match((error as Error).message, /did not settle within 0\.5s/)
        return true
      },
    )
    assert.equal(hasIssuedCheck('md127'), false, 'the token never outlives the call that took it')
    assert.equal(node.knob('sync_action'), 'idle', 'our own check was ended, not abandoned armed')
    assert.equal(node.knob('sync_max'), 'max')
    assert.equal(node.knob('sync_min'), '0')
  })
})

/**
 * D7 — `reconstruct` reads the siblings BY DEVICE PATH, out of the
 * `mdadm --detail --export` snapshot the gates took. A member md has kicked
 * since then still has a path in that list, and reading it returns the disk's
 * own stale bytes rather than an error — so the XOR comes out wrong. On RAID5
 * that is a candidate that cannot be told from a good one except by
 * arbitration; the honest answer is that the array can no longer reconstruct.
 */
describe('selfheal repair — a member md kicked after the gates', () => {
  useNode(() => new FakeNode())

  it('REFUSES a RAID5 reconstruction once a sibling is gone', async () => {
    const outcome = await repairBlock(
      node,
      { mountpoint: node.mountpoint, file: node.file, block: 300 },
      { ...OPTIONS, beforeStep: (name) => {
        if (name !== 'reconstruct')
          return
        // md kicked loop3 and removed its rd3 the instant it did (GT: the
        // kernel drops the directory immediately).
        node.setKnob('degraded', '1')
        rmSync(join(node.sys, 'rd3'), { recursive: true, force: true })
      } },
    )
    assert.equal(outcome.outcome, 'unrepairable', outcome.reason)
    assert.match(outcome.reason, /md has kicked \/dev\/loop3 out of \/dev\/md127 since this repair started/)
    assert.match(outcome.reason, /a RAID5 reconstruction needs every other member/)
    assert.equal(node.wroteThroughMd, null)
    assertKnobsRestored()
  })

  /**
   * The plan itself, level by level. RAID6 survives exactly one kicked
   * sibling, and only through the syndrome that does not need it — which is
   * the whole reason the Q path exists (GT-15).
   */
  it('keeps the syndrome that does not need the kicked member, and only that one', () => {
    const raid6 = { raid1: false, raid6: true, device: '/dev/md127', members: ['/dev/a', '/dev/b', '/dev/c', '/dev/d', '/dev/e'] } as never
    const target = { memberIndex: 0, parityIndex: 3, qIndex: 4 } as never

    assert.deepEqual(
      reconstructionPlan(raid6, target, [], []),
      { refusal: null, pXor: true, qSyndrome: true, mirrors: [] },
      'a complete array builds both candidates',
    )
    assert.deepEqual(
      reconstructionPlan(raid6, target, [4], []),
      { refusal: null, pXor: true, qSyndrome: false, mirrors: [] },
      'Q gone: P-XOR only',
    )
    assert.deepEqual(
      reconstructionPlan(raid6, target, [3], []),
      { refusal: null, pXor: false, qSyndrome: true, mirrors: [] },
      'P gone: the Q solve, which never consults P',
    )
    // A kicked DATA member is a second unknown in the same stripe.
    assert.match(reconstructionPlan(raid6, target, [1], []).refusal as string, /second unknown data member/)
    assert.match(reconstructionPlan(raid6, target, [1, 3], []).refusal as string, /three unknowns and two syndromes/)
    // The block under repair is on member 0 — its own absence is not a second
    // failure, it is the thing being reconstructed.
    assert.equal(reconstructionPlan(raid6, target, [0], []).refusal, null)
  })

  it('drops a kicked mirror leg from the RAID1 candidates, and refuses when none is left', () => {
    const raid1 = { raid1: true, raid6: false, device: '/dev/md126', members: ['/dev/a', '/dev/b', '/dev/c'] } as never
    const target = { memberIndex: 0, parityIndex: null, qIndex: null } as never
    assert.deepEqual(reconstructionPlan(raid1, target, [2], [1, 2]).mirrors, [1], 'only the leg md still serves')
    assert.match(reconstructionPlan(raid1, target, [1], [1]).refusal as string, /no mirror leg left to copy/)
  })
})

/**
 * R3 — the eviction sweep's bound. `rd<n>/size` is in KIBIBYTES and is already
 * net of the data offset; reading it as sectors and subtracting the offset a
 * second time put the array's last stripe at roughly half its real one, so no
 * stripe in the upper half was ever swept — and a check over a stale cached
 * stripe reports `mismatch_cnt=0`, which the engine calls `above-md`.
 */
describe('selfheal repair — evicting the stripe cache near the end of the array', () => {
  useNode(() => new FakeNode())

  const geometry = raid5Geometry

  it('sweeps the stripes around a target near the END of the array', async () => {
    const geo = geometry()
    // 203776 KiB of data per member = 407552 sectors = 3184 stripes of 128.
    const start = node.calls.length
    await boundedWindowCheck(node, geo, 3180, { ...OPTIONS, evictSpan: 5 })
    const swept = node.calls
      .slice(start)
      .filter(c => c.command === '/usr/bin/dd' && c.args.includes('of=/dev/null'))
      .map(c => Number(c.args.find(a => a.startsWith('skip='))?.slice(5)) / 80)
    assert.deepEqual(swept, [3175, 3176, 3177, 3178, 3179, 3181, 3182, 3183])
  })

  it('stops at the last stripe rather than reading past the end of the array', async () => {
    const geo = geometry()
    const start = node.calls.length
    await boundedWindowCheck(node, geo, 3183, { ...OPTIONS, evictSpan: 5 })
    const swept = node.calls
      .slice(start)
      .filter(c => c.command === '/usr/bin/dd' && c.args.includes('of=/dev/null'))
      .map(c => Number(c.args.find(a => a.startsWith('skip='))?.slice(5)) / 80)
    assert.deepEqual(swept, [3178, 3179, 3180, 3181, 3182])
  })
})

/**
 * R4 + R5 — the mirror path. Both findings are invisible on a rig whose legs
 * share a data offset and whose md happens to serve the failing leg, which is
 * every rig the suite builds; they live or die here.
 */
describe('selfheal repair — a RAID1 band', () => {
  let mirror: FakeMirror

  function use(build: () => FakeMirror): void {
    beforeEach(() => {
      mirror = build()
      process.env.ANAS_SELFHEAL_KERNEL_ROOT = mirror.root
      process.env.ANAS_SELFHEAL_RUNTIME_DIR = join(mirror.root, 'run')
    })
    afterEach(() => {
      delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
      delete process.env.ANAS_SELFHEAL_RUNTIME_DIR
      mirror.cleanup()
    })
  }

  describe('with the legs at different data offsets', () => {
    use(() => new FakeMirror())

    it('reads every leg at ITS OWN offset and repairs from the good one', async () => {
      const outcome = await repairBlock(mirror, { mountpoint: mirror.mountpoint, file: mirror.file, block: 300 }, OPTIONS)

      assert.equal(outcome.outcome, 'repaired', outcome.reason)
      assert.equal(outcome.diagnostics?.reconstruction, 'mirror')
      assert.ok(mirror.wroteThroughMd?.equals(HEALTHY))
      // Leg 0 at 1 MiB + md byte, leg 1 at 4 MiB + md byte — never one offset
      // for both, which is what returned zeros before R4.
      const perLeg = new Map(mirror.memberReads.map(r => [r.device, new Set<number>()]))
      for (const read of mirror.memberReads)
        perLeg.get(read.device)?.add(read.offset)
      assert.deepEqual([...(perLeg.get(FakeMirror.LEGS[0]) ?? [])], [FakeMirror.OFFSETS[0] + MD_BYTE])
      assert.deepEqual([...(perLeg.get(FakeMirror.LEGS[1]) ?? [])], [FakeMirror.OFFSETS[1] + MD_BYTE])
    })

    it('reports the FAILING leg as the member, at that leg\'s own offset', async () => {
      const outcome = await repairBlock(mirror, { mountpoint: mirror.mountpoint, file: mirror.file, block: 300 }, OPTIONS)
      assert.equal(outcome.diagnostics?.mapping?.memberDevice, FakeMirror.LEGS[0])
      assert.equal(outcome.diagnostics?.mapping?.memberOffset, FakeMirror.OFFSETS[0] + MD_BYTE)
    })
  })

  describe('and the read-back guard', () => {
    // md's read_balance may serve EITHER leg. Both are legitimate, and the
    // repair must not depend on which one it got.
    use(() => new FakeMirror({ mdServes: 'good' }))

    it('passes when md served the HEALTHY leg (R5: not a failed mapping)', async () => {
      const outcome = await repairBlock(mirror, { mountpoint: mirror.mountpoint, file: mirror.file, block: 300 }, OPTIONS)
      assert.equal(outcome.outcome, 'repaired', outcome.reason)
      const guard = outcome.steps.find(s => s.name === 'guard')
      assert.match(guard?.detail ?? '', /md serves a mirror read from either leg/)
    })
  })

  describe('and the read-back guard when md serves the failing leg', () => {
    use(() => new FakeMirror({ mdServes: 'bad' }))

    it('passes too — either leg proves the md offset is this mirror\'s', async () => {
      const outcome = await repairBlock(mirror, { mountpoint: mirror.mountpoint, file: mirror.file, block: 300 }, OPTIONS)
      assert.equal(outcome.outcome, 'repaired', outcome.reason)
      assert.ok(mirror.wroteThroughMd?.equals(HEALTHY))
    })
  })

  describe('and the read-back guard when md matches NEITHER leg', () => {
    use(() => new FakeMirror({ mdServes: 'neither' }))

    it('REFUSES: the md offset is not where these member bytes live', async () => {
      const outcome = await repairBlock(mirror, { mountpoint: mirror.mountpoint, file: mirror.file, block: 300 }, OPTIONS)
      assert.equal(outcome.outcome, 'unrepairable')
      assert.match(outcome.reason, /matches NO leg of this mirror/)
      assert.equal(mirror.wroteThroughMd, null)
    })
  })
})

describe('selfheal repair — cleanup on every failure path', () => {
  useNode(() => new FakeNode())

  const STEPS: SelfhealStepName[] = [
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
  ]

  for (const step of STEPS) {
    it(`restores the knobs and destroys the snapshot when it fails before '${step}'`, async () => {
      await assert.rejects(
        repairBlock(
          node,
          { mountpoint: node.mountpoint, file: node.file, block: 300 },
          {
            ...OPTIONS,
            beforeStep: (name) => {
              if (name === step)
                throw new Error(`injected before ${step}`)
            },
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof SelfhealRunError)
          assert.match(error.message, new RegExp(`injected before ${step}`))
          assert.deepEqual(error.diagnostics.cleanupErrors, [])
          return true
        },
      )
      assertKnobsRestored()
      // Nothing is pinned until the pin step runs, and everything pinned after
      // it is destroyed — the two states the finally-block has to cover.
      assert.equal(node.deleted.length, step === 'gates' || step === 'pin' ? 0 : 1, 'snapshots left behind')
    })
  }

  it('sweeps a crashed earlier run\'s snapshot before taking its own', async () => {
    mkdirSync(join(node.mountpoint, `${SELFHEAL_SNAPSHOT_PREFIX}1700000000`))
    await repairBlock(node, { mountpoint: node.mountpoint, file: node.file, block: 300 }, OPTIONS)
    assert.ok(node.deleted.some(p => p.endsWith(`${SELFHEAL_SNAPSHOT_PREFIX}1700000000`)), 'stale sweep')
    assert.equal(node.deleted.length, 2)
  })

  it('refuses a file outside the mountpoint before doing anything at all', async () => {
    await assert.rejects(
      repairBlock(node, { mountpoint: node.mountpoint, file: '/etc/passwd', block: 0 }, OPTIONS),
      /is not under/,
    )
    assert.equal(node.calls.length, 0)
  })
})

/**
 * The §12 pin: an AHR pool that carries `@data` + `@snapshots` goes through the
 * SAME snapshot machinery as every other AHR snapshot — `createAhrSnapshot`,
 * `deleteAhrSnapshot`, `listAhrSnapshots`, and `withTopLevelMount` for the cold
 * read. The loop-device rigs the selfheal.2 suite runs on are flat
 * filesystems, so this branch has no suite coverage and lives or dies here.
 */
describe('selfheal repair — pinning a §12 pool', () => {
  useNode(() => new FakeNode())

  function pool(): AhrPool {
    return {
      name: 'tank',
      ahrType: 'hybrid',
      mountpoint: node.mountpoint,
      mounted: true,
      disks: [],
      arrays: [],
      vg: { name: 'tank', sizeBytes: 0, freeBytes: 0 },
      lv: { name: 'tank-vol', sizeBytes: 0 },
      capacity: { totalBytes: 0, usedBytes: 0, freeBytes: 0, usableBytes: 0, rawBytes: 0, parityBytes: 0 },
      state: 'healthy',
      subvolLayout: true,
      advisories: [],
    } as unknown as AhrPool
  }

  function options(): SelfhealRepairOptions {
    return { ...OPTIONS, ahrSnapshotOptions: { runtimeDir: join(node.root, 'run-ahr') } }
  }

  const topLevel = (): string => join(node.root, 'run-ahr', 'tank.toplevel')

  it('snapshots @data into @snapshots and cold-reads through the top-level mount', async () => {
    const outcome = await repairBlock(
      node,
      { mountpoint: node.mountpoint, file: node.file, block: 300, pool: pool() },
      options(),
    )
    assert.equal(outcome.outcome, 'repaired', outcome.reason)
    assert.equal(outcome.pool, 'tank')
    assert.equal(node.created.length, 1)
    assert.ok(
      node.created[0].startsWith(join(topLevel(), '@snapshots', SELFHEAL_SNAPSHOT_PREFIX)),
      `snapshot went to ${node.created[0]}`,
    )
    // The cold read reached the snapshot through @snapshots, not the mountpoint.
    const probe = node.calls.find(c =>
      c.command === '/usr/bin/dd' && c.args.some(a => a.includes('@snapshots')))
    assert.ok(probe, 'cold read went through @snapshots')
    assert.ok(probe.args.includes('iflag=direct'))
    // Nothing stays mounted: every mount is matched by its umount.
    assert.equal(node.mounted.size, 0, `still mounted: ${[...node.mounted].join(', ')}`)
    assert.deepEqual(outcome.diagnostics?.cleanupErrors, [])
  })

  it('destroys the snapshot through deleteAhrSnapshot, under its own mount', async () => {
    await repairBlock(
      node,
      { mountpoint: node.mountpoint, file: node.file, block: 300, pool: pool() },
      options(),
    )
    const deleted = node.deleted.filter(p => p.includes(SELFHEAL_SNAPSHOT_PREFIX))
    assert.equal(deleted.length, 1)
    assert.ok(deleted[0].startsWith(join(topLevel(), '@snapshots')), deleted[0])
    assert.equal(node.mounted.size, 0)
  })

  it('sweeps a crashed earlier run\'s @snapshots leftover, and nothing else', async () => {
    node.subvolList = [
      'ID 256 gen 9 top level 5 path @data',
      'ID 257 gen 9 top level 5 path @snapshots',
      `ID 258 gen 9 top level 257 path @snapshots/${SELFHEAL_SNAPSHOT_PREFIX}1700000000`,
      'ID 259 gen 9 top level 257 path @snapshots/nightly-2026-09-01',
      '',
    ].join('\n')
    await repairBlock(
      node,
      { mountpoint: node.mountpoint, file: node.file, block: 300, pool: pool() },
      options(),
    )
    assert.ok(
      node.deleted.some(p => p.endsWith(`${SELFHEAL_SNAPSHOT_PREFIX}1700000000`)),
      'the stale transient was swept',
    )
    assert.ok(
      !node.deleted.some(p => p.endsWith('nightly-2026-09-01')),
      'the operator\'s own snapshot was left alone',
    )
  })

  it('pins the NESTED subvolume a file lives in, not @data (a ro snapshot does not recurse)', async () => {
    node.subvolResolve = '@data/photos'
    mkdirSync(join(node.mountpoint, 'photos'), { recursive: true })
    const file = join(node.mountpoint, 'photos', 'f1.bin')
    await repairBlock(
      node,
      { mountpoint: node.mountpoint, file, block: 300, pool: pool() },
      options(),
    ).catch(() => {})
    const snapshot = node.calls.find(c =>
      c.command === '/usr/bin/btrfs' && c.args[0] === 'subvolume' && c.args[1] === 'snapshot')
    assert.ok(snapshot)
    assert.equal(snapshot.args[3], join(topLevel(), '@data', 'photos'))
    const probe = node.calls.find(c =>
      c.command === '/usr/bin/dd' && c.args.some(a => a.includes('@snapshots')))
    assert.ok(probe?.args.some(a => a.endsWith('f1.bin')), 'the file is at the snapshot root')
  })

  it('REFUSES when the pool\'s top-level mount is already held (a backup is in flight)', async () => {
    node.mounted.add(topLevel())
    const outcome = await repairBlock(
      node,
      { mountpoint: node.mountpoint, file: node.file, block: 300, pool: pool() },
      options(),
    )
    assert.equal(outcome.outcome, 'unrepairable')
    assert.match(outcome.reason, /^refused: the top-level mount for pool 'tank' is already held/)
    assert.equal(node.created.length, 0, 'nothing was pinned')
    assert.equal(node.wroteThroughMd, null)
  })

  it('falls back to an in-place snapshot for a FLAT pool — which the suite\'s rigs are', async () => {
    const flat = { ...pool(), subvolLayout: false }
    const outcome = await repairBlock(
      node,
      { mountpoint: node.mountpoint, file: node.file, block: 300, pool: flat },
      options(),
    )
    assert.equal(outcome.outcome, 'repaired', outcome.reason)
    assert.equal(node.created.length, 1)
    assert.ok(node.created[0].startsWith(join(node.mountpoint, SELFHEAL_SNAPSHOT_PREFIX)), node.created[0])
    assert.equal(node.mountLog.length, 0, 'a flat pool takes no top-level mount')
  })

  /**
   * S2 — the gate at step 1 refuses a pool whose top-level mount is already
   * held, but a backup can take it at any point AFTER that, and by the cold
   * read the block has already been WRITTEN. `withTopLevelMount` serialises on
   * that one path, so joining its queue means sitting on a live array with
   * `rmw_level=0` for as long as the backup runs — hours.
   *
   * The cold read is a confirmation, not a gate. Bounded wait, then an honest
   * `repaired` that says the confirmation did not run.
   */
  it('does not block behind a backup for the final cold read — it says the read was skipped', async () => {
    const held = pool()
    const snapshotOptions = { runtimeDir: join(node.root, 'run-ahr') }
    // A holder that arrives AFTER the gates and keeps the mount — a backup run.
    // It lets go on a timer: the engine's own `finally` destroys its pin
    // through the same mount, and THAT must still happen (a snapshot left
    // behind pins an extent for ever), so the destroy waits for the backup by
    // design. Only the cold READ — a confirmation, after the write — gives up.
    let holding: Promise<unknown> | null = null
    const backup = new Promise<void>(resolve => setTimeout(resolve, 1500))

    const outcome = await repairBlock(
      node,
      { mountpoint: node.mountpoint, file: node.file, block: 300, pool: held },
      {
        ...OPTIONS,
        ahrSnapshotOptions: snapshotOptions,
        coldReadWaitMs: 30,
        beforeStep: (name) => {
          if (name === 'write')
            holding = withTopLevelMount(node, held, () => backup, snapshotOptions)
        },
      },
    )

    assert.equal(outcome.outcome, 'repaired', outcome.reason)
    assert.match(outcome.reason, /post-check passed; cold read skipped: top-level mount busy/)
    assert.ok(node.wroteThroughMd?.equals(HEALTHY), 'the block WAS written — the read is the part that was skipped')
    const coldread = outcome.steps.find(s => s.name === 'coldread')
    assert.match(coldread?.detail ?? '', /^skipped: top-level mount busy/)
    assert.equal(coldread?.ok, true, 'a skipped confirmation is not a failed step')
    await holding
  })
})
