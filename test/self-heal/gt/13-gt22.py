#!/usr/bin/env python3
"""13-gt22.py — byte-level helper for GT-22 (fail-one-leg scrub on a RAID1 band).

Subcommands (run on the node; paths come from /root/gtsh/state):
  scan        raw oracle scan of both legs for the f1 marker (block 300);
              prints JSON {hits, boff, data_offset, md_byte}, rc=1 unless one
              hit per leg at the SAME block offset; persists gt22-locate.json
  rot <leg>   write 4 KiB of fresh junk at the block on leg <leg> behind md
              (direct to the member device); junk kept at keep/gt22-junk.bin
  writemd     write the kept-original block THROUGH /dev/md/gtsh1 (O_DIRECT, at
              md_byte) — with one leg removed this lands on the surviving leg
  blk <leg>   sha256 + MATCH/BAD of leg <leg>'s block vs keep/f1.blk300
  coldread    COLD snapshot read of f1 block 300 through btrfs: EIO/MATCH + sha
Every subcommand after `scan` reads the block offset from gt22-locate.json —
once a leg is rotted its signature is gone, so re-scanning would lie.
All member I/O is O_DIRECT; nothing here prompts (mdadm-free).
"""
import hashlib
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, "/root/gtsh")
from common import BS, make_snap, read_direct, remove_snap, snapshot_read, write_direct  # noqa: E402
from oracle import scan_members  # noqa: E402

GT = "/root/gtsh"
STATE = f"{GT}/state"
KEEP = f"{GT}/keep"
MOUNT = open(f"{STATE}/workdir.txt").read().strip()
MEMBERS = open(f"{STATE}/members.txt").read().split()
MDDEV = open(f"{STATE}/mddev.txt").read().strip()
SIG = "ANASGT-F1-MARKER-0123456789abcdef".encode()  # 01-markers.py's verbatim literal (33 bytes)
BLOCK = 300
JUNK = f"{KEEP}/gt22-junk.bin"
ORIG = f"{KEEP}/f1.blk300"
LOC = f"{STATE}/gt22-locate.json"


def data_offset() -> int:
    """Data Offset (bytes) from mdadm --examine of member 0 (metadata 1.2)."""
    r = subprocess.run(["mdadm", "--examine", MEMBERS[0]], capture_output=True,
                       text=True, stdin=subprocess.DEVNULL)
    m = re.search(r"Data Offset\s*:\s*(\d+) sectors", r.stdout)
    if not m:
        sys.exit(f"no Data Offset in examine output:\n{r.stdout[:600]}")
    return int(m.group(1)) * 512


def located() -> dict:
    return json.load(open(LOC))


def orig_block() -> bytes:
    return open(ORIG, "rb").read()


def main() -> None:
    cmd = sys.argv[1]
    if cmd == "scan":
        doff = data_offset()
        hits = scan_members(MEMBERS, SIG)
        blocks = sorted({o - o % BS for _, o in hits})
        if len(hits) != len(MEMBERS) or len(blocks) != 1:
            sys.exit(f"UNEXPECTED scan: hits={hits} blocks={blocks}")
        boff = blocks[0]
        j = {"hits": [[d, o] for d, o in hits], "boff": boff,
             "data_offset": doff, "md_byte": boff - doff,
             "members": MEMBERS, "mddev": MDDEV}
        json.dump(j, open(LOC, "w"), indent=1)
        print(json.dumps(j))
        return
    loc = located()
    boff = loc["boff"]
    if cmd == "rot":
        leg = int(sys.argv[2])
        junk = os.urandom(BS)
        open(JUNK, "wb").write(junk)
        write_direct(MEMBERS[leg], boff, junk)
        print(f"rot leg m{leg} ({MEMBERS[leg]}) at {boff}: "
              f"junk sha={hashlib.sha256(junk).hexdigest()[:16]}")
        return
    if cmd == "writemd":
        # through md at md_byte; with one leg removed it lands on the survivor
        write_direct(loc["mddev"], loc["md_byte"], orig_block())
        print(f"wrote original block through {loc['mddev']} at "
              f"md_byte={loc['md_byte']} (data_offset={loc['data_offset']})")
        return
    if cmd == "blk":
        leg = int(sys.argv[2])
        got = read_direct(MEMBERS[leg], boff, BS)
        want = orig_block()
        print(f"m{leg} ({MEMBERS[leg]}) blk300: "
              f"{'MATCH' if got == want else 'BAD'} "
              f"sha={hashlib.sha256(got).hexdigest()[:16]}")
        return
    if cmd == "coldread":
        snap = make_snap(MOUNT, ".gt22-snap")
        try:
            subprocess.run(["sync"]).returncode
            with open("/proc/sys/vm/drop_caches", "w") as fh:
                fh.write("3\n")
            r = snapshot_read(os.path.join(snap, "f1.bin"), [BLOCK])
            got = r["data"].get(BLOCK)
            if BLOCK in r["eio"]:
                print("coldread: EIO")
                return
            want = orig_block()
            print(f"coldread: MATCH={got == want} "
                  f"sha={hashlib.sha256(got).hexdigest()[:16]} "
                  f"(orig sha={hashlib.sha256(want).hexdigest()[:16]})")
        finally:
            remove_snap(MOUNT, ".gt22-snap")
        return
    sys.exit(f"unknown subcommand {cmd}")


if __name__ == "__main__":
    main()
