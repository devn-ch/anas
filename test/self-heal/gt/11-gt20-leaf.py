#!/usr/bin/env python3
"""11-gt20-leaf.py [corrupt|verify] — GT-20: find the csum tree's root leaf,
map its two DUP stripes to member offsets (mapping chain + an oracle scan for
the leaf-bytenr bytes), corrupt the LAST 4 KiB of the leaf on STRIPE 0's copy
(the header — bytenr + header csum — survives, so the rot is in the items and
the header-csum comparison in (e) stays meaningful), and verify the injection.
`verify` re-reads both copies and re-runs the header-csum comparison (used
after the scrub, to see whether scrub repaired stripe 0).
Records under /root/gtsh/out/gt20/."""
import hashlib
import json
import os
import re
import struct
import sys

sys.path.insert(0, '/root/gtsh/suite')
from common import (dm_start_sector, dump_tree, md_geometry,  # noqa: E402
                    predict, read_direct, run, write_direct, components)
from crc32c import crc32c  # noqa: E402
from oracle import scan_members  # noqa: E402

GT = '/root/gtsh'
OUT = os.environ.get('GT20_OUT') or f'{GT}/out/gt20'
SRC = '/dev/mapper/gtsh-data'
MDDEV = open(f'{GT}/state/mddev.txt').read().strip()
NODE = 65536  # read a full 64 KiB window; the fs nodesize is determined by (e)


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()[:16]


def chunk_dup_map(dump3: str, logical: int):
    """(logical_start, length, [stripe device offsets], type) of the chunk
    covering `logical` — all stripes recorded (a METADATA|DUP chunk has two)."""
    for item in dump3.split('\n\titem '):
        if 'CHUNK_ITEM' not in item:
            continue
        lo = int(re.search(r'CHUNK_ITEM (\d+)', item).group(1))
        ln = int(re.search(r'length (\d+)', item).group(1))
        offs = [int(o) for o in
                re.findall(r'stripe \d+ devid \d+ offset (\d+)', item)]
        if lo <= logical < lo + ln:
            typ = re.search(r'type (\S+)', item).group(1)
            return lo, ln, offs, typ
    raise RuntimeError(f'no chunk covers logical {logical}')


def header_csum_check(raw: bytes):
    """btrfs tree-block header: crc32c of bytes 32..nodesize, stored LE as a
    u32 in bytes 0..3 (the brief's formula). The nodesize is not known a
    priori — test 16K/32K/64K and report which (if any) matches."""
    stored = int.from_bytes(raw[0:4], 'little')
    for ns in (16384, 32768, 65536):
        if crc32c(raw[32:ns]) == stored:
            return ns, stored, True
    return None, stored, False


def copy_state(dev: str, moff: int, label: str, pre: bytes | None) -> dict:
    raw = read_direct(dev, moff, NODE)
    ns, stored, ok = header_csum_check(raw)
    calc = crc32c(raw[32:ns]) if ns else None
    calc_s = f'0x{calc:08x}' if calc is not None else 'n/a'
    ns_s = str(ns) if ns else '?'
    st = {'label': label, 'sha': sha(raw), 'changed_vs_pre': (
        raw != pre) if pre is not None else None,
        'stored_csum': f'0x{stored:08x}',
        'crc32c(32..nodesize)': calc_s,
        'nodesize_matched': ns, 'csum_ok': ok,
        'first32': raw[0:32].hex(), 'last16': raw[-16:].hex()}
    print(f"  {label} {dev}@{moff}: sha={st['sha']}"
          + (f" (changed vs pre: {st['changed_vs_pre']})" if pre is not None else ''))
    print(f"    stored(bytes 0..3)=0x{stored:08x} "
          f"crc32c(bytes 32..{ns_s})={calc_s} match={ok}")
    return st


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else 'corrupt'
    os.makedirs(OUT, exist_ok=True)
    if mode == 'check':
        # no re-identification: a transaction commit may have moved the csum
        # root, and the corrupted block's bytenr is what we must keep testing.
        # (Also must not re-write the *-pre.bin snapshots.)
        info = json.load(open(f'{OUT}/leaf.json'))
        dev0, moff0 = info['stripe0']['dev'], info['stripe0']['moff']
        dev1, moff1 = info['stripe1']['dev'], info['stripe1']['moff']
        pre0 = open(f'{OUT}/stripe0-pre.bin', 'rb').read()
        pre1 = open(f'{OUT}/stripe1-pre.bin', 'rb').read()
        print(f"=== GT-20 check: leaf {info['leaf']} copies at saved offsets ===")
        copy_state(dev0, moff0, 'stripe 0', pre0)
        copy_state(dev1, moff1, 'stripe 1', pre1)
        r0 = read_direct(dev0, moff0, NODE)
        r1 = read_direct(dev1, moff1, NODE)
        print(f"  copies_equal_now={r0 == r1}")
        return
    if mode != 'corrupt':
        raise SystemExit(f'unknown mode {mode} (want corrupt|check)')
    # -r: short root info for every tree — the csum root's bytenr comes from
    # its ROOT_ITEM line (the brief's "dump-tree -r" route).
    dr = run(['btrfs', 'inspect-internal', 'dump-tree', '-r', SRC]).stdout
    open(f'{OUT}/00-dump-tree-roots.txt', 'w').write(dr)
    mr = re.search(r'checksum tree key \(CSUM_TREE ROOT_ITEM \d+\) (\d+) level', dr)
    if not mr:
        raise RuntimeError(f'no checksum tree root in dump-tree -r:\n{dr[:600]}')
    leaf = int(mr.group(1))
    # FACT (btrfs-progs v6.14): the NUMERIC -t <n> is NOT the kernel tree
    # object id — -t 10 dumps the FREE SPACE tree and -t 7 the csum tree.
    # The string form -t csum works, and matches the -r bytenr.
    d10 = run(['btrfs', 'inspect-internal', 'dump-tree', '-t', 'csum',
               SRC]).stdout
    open(f'{OUT}/01-dump-tree-csum-tree.txt', 'w').write(d10)
    # the dump carries a prolog ("btrfs-progs vNNN" + a "checksum tree key"
    # line) before the root block — find the first tree-block line
    m = re.search(r'^(leaf|node) (\d+) ', d10, re.M)
    if not m:
        raise RuntimeError(f'dump-tree -t csum has no tree block:\n{d10[:400]}')
    first = d10[m.start():d10.find('\n', m.start())].strip()
    if m.group(1) != 'leaf':
        raise RuntimeError(f'csum tree root is a {m.group(1)} (multiple leaves) — '
                           f'fresh rig should give a single root leaf: {first}')
    if int(m.group(2)) != leaf:
        print(f"UNEXPECTED: -r bytenr {leaf} != first leaf line bytenr {m.group(2)}")
    leaf = int(m.group(2))
    d3 = dump_tree(SRC, 3)
    clog, clen, offs, typ = chunk_dup_map(d3, leaf)
    print(f"=== GT-20: csum tree root leaf ===")
    print(f"dump-tree -t csum first tree-block line: {first}")
    print(f"leaf bytenr = {leaf}")
    print(f"chunk: logical {clog}..{clog + clen - 1} type={typ} stripe offsets={offs}")
    if len(offs) != 2 or 'DUP' not in typ:
        print(f"UNEXPECTED: expected a METADATA|DUP chunk with two stripes, got {typ} {offs}")
    in_chunk = leaf - clog
    ss = dm_start_sector(SRC)
    geo = md_geometry(MDDEV)
    comps = components(MDDEV)
    p0 = predict(offs[0] + in_chunk + ss * 512, geo)
    p1 = predict(offs[1] + in_chunk + ss * 512, geo)
    dev0, dev1 = comps[p0['disk']], comps[p1['disk']]
    moff0, moff1 = p0['moff'], p1['moff']
    print(f"stripe 0 copy: LV {offs[0] + in_chunk} -> md {offs[0] + in_chunk + ss * 512} -> {dev0} moff {moff0}")
    print(f"stripe 1 copy: LV {offs[1] + in_chunk} -> md {offs[1] + in_chunk + ss * 512} -> {dev1} moff {moff1}")
    hits = scan_members(comps, struct.pack('<Q', leaf))
    print(f"oracle scan for leaf-bytenr bytes (LE u64 {leaf}): {hits}")
    raw0 = read_direct(dev0, moff0, NODE)
    raw1 = read_direct(dev1, moff1, NODE)
    print(f"pre-corruption: stripe0 sha={sha(raw0)} stripe1 sha={sha(raw1)} copies_equal={raw0 == raw1}")
    ns, stored, ok = header_csum_check(raw1)
    print(f"header csum identity on INTACT stripe 1 copy: nodesize={ns} stored=0x{stored:08x} match={ok}")
    info = {'leaf': leaf, 'clog': clog, 'clen': clen, 'type': typ, 'offs': offs,
            'in_chunk': in_chunk, 'ss': ss,
            'stripe0': {'dev': dev0, 'moff': moff0, 'lv': offs[0] + in_chunk, 'pre_sha': sha(raw0)},
            'stripe1': {'dev': dev1, 'moff': moff1, 'lv': offs[1] + in_chunk, 'pre_sha': sha(raw1)},
            'nodesize': ns}
    json.dump(info, open(f'{OUT}/leaf.json', 'w'), indent=1)
    open(f'{OUT}/stripe0-pre.bin', 'wb').write(raw0)
    open(f'{OUT}/stripe1-pre.bin', 'wb').write(raw1)

    junk = b'\xaa' * 4096
    off = moff0 + ns - 4096
    print(f"corrupting: last 4 KiB of the leaf (offsets {off}..{off + 4095}) on STRIPE 0 copy {dev0} — header (bytenr + csum field) survives")
    write_direct(dev0, off, junk)
    r0 = read_direct(dev0, moff0, NODE)
    r1 = read_direct(dev1, moff1, NODE)
    print("post-corruption:")
    copy_state(dev0, moff0, 'stripe 0 (corrupt)', raw0)
    copy_state(dev1, moff1, 'stripe 1 (intact)', raw1)
    tail = r0[ns - 16:ns]
    print(f"  stripe 0 leaf-last-16B (window offset {ns-16}): {tail.hex()} (junk was 0xaa*4096)")
    assert sha(r0) != sha(raw0), "corruption did not land"
    assert r1 == raw1, "stripe 1 changed — injection hit the wrong copy"
    print("corruption verified: stripe 0 changed, stripe 1 untouched")


if __name__ == '__main__':
    main()
