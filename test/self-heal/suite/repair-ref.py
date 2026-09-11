#!/usr/bin/env python3
"""repair-ref.py — the REFERENCE REPAIR for the selfheal.2 suite.

Usage: repair-ref.py <mountpoint> <file> <block>

Implements the converged sequence exactly as the story lists it:

    pin              ro transient snapshot (pin-then-re-resolve)
    resolve          file block -> btrfs logical -> chunk hop -> dm -> md LBA
                     -> (member, offset) from md sysfs (never hardcoded)
    reverify         re-verify the crc32c AT THE COMPUTED MEMBER LOCATION
                     (uncompressed: the 4K block; compressed: every on-disk
                     sector of the extent's blob); content that still passes
                     the stored csum => "not corrupt here" => exit 4
    precheck         bounded md check over the stripe (GT-5 convention
                     sync_min=stripe*128, sync_max=(stripe+1)*128); GT-5 rule:
                     the check SUSPENDS at sync_max, end it with `idle`.
                     mismatch_cnt == 0 while the block is corrupt =>
                     parity agrees with the bad data => diagnosed-above-md
                     => exit 3
    rmw              save rmw_level, set 0 (reconstruct-write semantics)
    reconstruct      candidate = XOR of the same 4 KiB member offset on every
                     OTHER member. RAID5: all n-1 others. RAID6: P-only
                     reconstruction (XOR of every member except the bad data
                     member and except Q) — ONLY valid when the bad member is
                     a data member and P is intact; otherwise exit 2.
    arbitrate        crc32c(candidate) vs the STORED csum (csum tree read as
                     the drill did — this kernel's scrub dmesg omits csums);
                     mismatch => exit 2
    guard            read-back guard: the md block at the computed md offset
                     must equal the bytes seen on the member; else exit 2
    write            candidate written THROUGH md (reconstruct-write keeps the
                     parity group consistent), O_DIRECT + fsync
    postcheck        bounded check again; mismatch_cnt must be 0, else exit 2
    coldread         drop caches, read the block (compressed: the whole
                     extent region) through the pin snapshot; EIO => exit 2
    finally          restore rmw_level, sync_min=0, sync_max=max (ending any
                     suspended op first), destroy the snapshot

Exit codes: 0 repaired / 2 unrepairable / 3 diagnosed-above-md / 4
mapping-abort / 70 injected failure (REPAIR_FAIL_AT) / 1 internal error.

Env:
  REPAIR_FAIL_AT=<step>   raise an injected exception immediately BEFORE
                          <step> (steps: pin resolve reverify precheck rmw
                          reconstruct arbitrate guard write postcheck
                          coldread). The finally-block cleanup still runs —
                          case 4 of the suite asserts it.
  REPAIR_REPORT=<path>    write a JSON sidecar (mapping, pre/post mismatch,
                          steps done, outcome, reason) for the suite.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (BS, bounded_window_check, chunk_data_map, dm_start_sector,
                    drop_caches, dump_tree, extent_for_offset, file_extents,
                    find_btrfs_dev, md_geometry, predict, read_direct,
                    restore_sync_knobs, snapshot_read, write_direct)
from crc32c import crc32c

REPAIR_SNAP = ".anas-repair-snap"

STEPS = ["pin", "resolve", "reverify", "precheck", "rmw", "reconstruct",
         "arbitrate", "guard", "write", "postcheck", "coldread"]

EXIT_OK, EXIT_UNREPAIRABLE, EXIT_ABOVE_MD, EXIT_MAPPING_ABORT = 0, 2, 3, 4
EXIT_INJECTED, EXIT_INTERNAL = 70, 1


class RepairAbort(Exception):
    def __init__(self, code: int, reason: str):
        self.code, self.reason = code, reason
        super().__init__(reason)


class Injected(Exception):
    pass


class Repair:
    def __init__(self, mountpoint: str, path: str, block: int):
        self.mountpoint = mountpoint
        self.path = path
        self.block = block
        self.report = {"mountpoint": mountpoint, "file": path, "block": block,
                       "steps_done": [], "injected_at": None}
        self.snap = None
        self.geo = None
        self.fail_at = os.environ.get("REPAIR_FAIL_AT")

    # -- scaffolding

    def step(self, name: str) -> None:
        if self.fail_at == name:
            self.report["injected_at"] = name
            raise Injected(f"REPAIR_FAIL_AT={name}")
        self.report["steps_done"].append(name)

    def die(self, code: int, reason: str) -> None:
        raise RepairAbort(code, reason)

    # -- steps

    def do_pin(self) -> None:
        self.step("pin")
        parent = os.path.dirname(self.mountpoint.rstrip("/"))
        self.snap = os.path.join(parent, REPAIR_SNAP)
        if os.path.exists(self.snap):
            subprocess_run(["btrfs", "subvolume", "delete", self.snap])
        subprocess_run(["btrfs", "subvolume", "snapshot", "-r",
                        self.mountpoint, self.snap])

    def do_resolve(self) -> None:
        self.step("resolve")
        srcdev = find_btrfs_dev(self.mountpoint)
        self.srcdev = srcdev
        self.geo = md_geometry(self.mddev)
        dump3 = dump_tree(srcdev, 3)
        self.dump3 = dump3
        self.dump7 = dump_tree(srcdev, 7)
        exts = file_extents(srcdev, self.mountpoint, self.path)
        e = extent_for_offset(exts, self.block * BS)
        self.ext = e
        self.compressed = e["comp"] != "none"
        if self.compressed:
            # repair unit = the extent's on-disk (compressed) blob
            self.blob_logical = e["disk"]
            self.blob_sectors = (e["disknr"] + BS - 1) // BS
            self.target_logical = e["disk"]
            self.blob_md_byte = None          # set below
        else:
            # repair unit = the caller's single 4K block (each block carries
            # its own csum; the extent is not the unit for uncompressed data)
            self.blob_logical = e["disk"] + (self.block * BS - e["foff"])
            self.blob_sectors = 1
            self.target_logical = self.blob_logical
            self.blob_md_byte = None
        clog, cdev, _ = chunk_data_map(dump3, self.target_logical)
        self.chunk_logical, self.chunk_device = clog, cdev
        ss = dm_start_sector(srcdev)
        self.start_sector = ss
        self.md_byte = self.target_logical - clog + cdev + ss * 512
        self.blob_md_byte = self.md_byte
        p = predict(self.md_byte, self.geo)
        self.disk = p["disk"]
        self.moff = p["moff"]
        self.stripe = p["stripe"]
        self.parity_disk = p["parity_disk"]
        self.q_disk = p["q_disk"]
        if self.moff % BS:
            self.die(EXIT_INTERNAL, f"computed member offset {self.moff} not 4K aligned")
        self.report.update({"level": self.geo["level"], "n": self.geo["n"],
                            "compressed": self.compressed,
                            "blob_logical": self.blob_logical,
                            "blob_sectors": self.blob_sectors,
                            "logical_byte": self.target_logical,
                            "md_byte": self.blob_md_byte, "disk": self.disk,
                            "moff": self.moff, "stripe": self.stripe,
                            "parity_disk": self.parity_disk,
                            "q_disk": self.q_disk})

    def members(self) -> list[str]:
        from common import components
        return components(self.mddev)

    def stored_csum(self, logical: int) -> int:
        from common import csum_lookup
        return csum_lookup(self.srcdev, self.dump7, self.dump3, logical)

    def member_block(self, disk: int, sector: int) -> bytes:
        """4K O_DIRECT read at the blob sector's member offset."""
        off = self.moff + sector * BS
        return read_direct(self.members()[disk], off, BS)

    def do_reverify(self) -> None:
        self.step("reverify")
        if self.compressed:
            bad = []
            for k in range(self.blob_sectors):
                member_bytes = self.member_block(self.disk, k)
                logical = self.blob_logical + k * BS
                try:
                    stored = self.stored_csum(logical)
                except LookupError:
                    self.die(EXIT_UNREPAIRABLE,
                             f"no stored csum for logical {logical} (NOCOW/prealloc?)")
                if crc32c(member_bytes) != stored:
                    bad.append(k)
            self.report["bad_sectors"] = bad
            if not bad:
                self.die(EXIT_MAPPING_ABORT,
                         f"not corrupt here: every on-disk sector of the extent "
                         f"at (m{self.disk}, {self.moff}) passes its stored csum "
                         f"for {self.path} block {self.block}")
            if len(bad) > 1:
                self.die(EXIT_UNREPAIRABLE,
                         f"{len(bad)} bad on-disk sectors in one compressed "
                         f"extent ({bad}); single-sector repair only")
        else:
            logical = self.blob_logical
            try:
                stored = self.stored_csum(logical)
            except LookupError:
                self.die(EXIT_UNREPAIRABLE,
                         f"no stored csum for logical {logical} (NOCOW/prealloc?)")
            member_bytes = self.member_block(self.disk, 0)
            self.report["bad_sectors"] = [] if crc32c(member_bytes) == stored else [0]
            if crc32c(member_bytes) == stored:
                self.die(EXIT_MAPPING_ABORT,
                         f"not corrupt here: member content at (m{self.disk}, "
                         f"{self.moff}) passes the stored csum for {self.path} "
                         f"block {self.block}")
            bad = [0]
        self.bad_sector = bad[0]
        self.corrupt_member_bytes = self.member_block(self.disk, self.bad_sector)

    def do_precheck(self) -> None:
        self.step("precheck")
        mm = bounded_window_check(self.mddev, self.stripe)
        self.report["precheck_mismatch"] = mm
        if mm == 0:
            self.die(EXIT_ABOVE_MD,
                     f"pre-check: bounded md check over stripe {self.stripe} "
                     f"reports mismatch_cnt==0 while the member block fails "
                     f"its csum — parity agrees with the bad data; diagnosed "
                     f"above md")

    def do_rmw(self) -> None:
        self.step("rmw")
        m = f"/sys/block/{os.path.basename(os.path.realpath(self.mddev))}/md"
        self.rmw_path = f"{m}/rmw_level"
        self.rmw_saved = open(self.rmw_path).read().strip()
        self.report["rmw_saved"] = self.rmw_saved
        with open(self.rmw_path, "w") as fh:
            fh.write("0")

    def contributing_members(self) -> list[int]:
        n = self.geo["n"]
        if not self.geo["raid6"]:
            return [i for i in range(n) if i != self.disk]
        if self.disk == self.parity_disk:
            self.die(EXIT_UNREPAIRABLE,
                     "RAID6 P-member loss is not covered by the reference "
                     "repair (P-only XOR needs P); restore from backup")
        if self.disk == self.q_disk:
            self.die(EXIT_UNREPAIRABLE,
                     "RAID6 Q-member loss is not covered by the reference "
                     "repair (P-only XOR reconstructs data from P); restore "
                     "from backup")
        return [i for i in range(n) if i not in (self.disk, self.q_disk)]

    def do_reconstruct(self) -> None:
        self.step("reconstruct")
        cand = None
        for i in self.contributing_members():
            data = self.member_block(i, self.bad_sector)
            cand = data if cand is None else bytes(a ^ b for a, b in zip(cand, data))
        self.candidate = cand

    def do_arbitrate(self) -> None:
        self.step("arbitrate")
        val = crc32c(self.candidate)
        stored = self.stored_csum(self.blob_logical + self.bad_sector * BS)
        self.report["candidate_csum"] = f"0x{val:08x}"
        self.report["stored_csum"] = f"0x{stored:08x}"
        if val != stored:
            self.die(EXIT_UNREPAIRABLE,
                     f"candidate fails arbitration: crc32c=0x{val:08x} "
                     f"stored=0x{stored:08x}")

    def do_guard(self) -> None:
        self.step("guard")
        md_node = self.mddev
        boff = self.md_byte - self.md_byte % BS + self.bad_sector * BS
        md_bytes = read_direct(md_node, boff, BS)
        if md_bytes != self.corrupt_member_bytes:
            self.die(EXIT_UNREPAIRABLE,
                     "read-back guard failed: md block at the computed offset "
                     "does not match the member bytes seen at reverify")

    def do_write(self) -> None:
        self.step("write")
        boff = self.md_byte - self.md_byte % BS + self.bad_sector * BS
        write_direct(self.mddev, boff, self.candidate)   # O_DIRECT + fsync

    def do_postcheck(self) -> None:
        self.step("postcheck")
        mm = bounded_window_check(self.mddev, self.stripe)
        self.report["postcheck_mismatch"] = mm
        if mm != 0:
            self.die(EXIT_UNREPAIRABLE,
                     f"post-check: mismatch_cnt={mm} after repair")

    def do_coldread(self) -> None:
        self.step("coldread")
        drop_caches()
        rel = os.path.relpath(self.path, self.mountpoint)
        snap_file = os.path.join(self.snap, rel)
        if self.compressed:
            e = self.ext
            blocks = list(range(e["foff"] // BS,
                                (e["foff"] + e["nr"]) // BS))
        else:
            blocks = [self.block]
        r = snapshot_read(snap_file, blocks)
        if r["eio"]:
            self.die(EXIT_UNREPAIRABLE,
                     f"cold read via snapshot still EIOs blocks {r['eio']}")
        self.report["coldread_blocks"] = len(r["ok"])

    def cleanup(self) -> None:
        errs = []
        try:
            if getattr(self, "rmw_path", None) and getattr(self, "rmw_saved", None):
                with open(self.rmw_path, "w") as fh:
                    fh.write(self.rmw_saved)
        except OSError as e:
            errs.append(f"rmw restore: {e}")
        try:
            if getattr(self, "mddev", None):
                restore_sync_knobs(self.mddev)
        except OSError as e:
            errs.append(f"sync knobs: {e}")
        try:
            if self.snap and os.path.exists(self.snap):
                subprocess_run(["btrfs", "subvolume", "delete", self.snap])
        except Exception as e:  # noqa: BLE001
            errs.append(f"snapshot: {e}")
        self.report["cleanup_errors"] = errs

    def run(self) -> int:
        self.mddev = os.environ.get("REPAIR_MDDEV")
        if not self.mddev:
            # discover the md array under the mountpoint's btrfs device
            srcdev = find_btrfs_dev(self.mountpoint)
            self.mddev = resolve_mddev(srcdev)
        try:
            self.do_pin()
            self.do_resolve()
            self.do_reverify()
            self.do_precheck()
            self.do_rmw()
            self.do_reconstruct()
            self.do_arbitrate()
            self.do_guard()
            self.do_write()
            self.do_postcheck()
            self.do_coldread()
            self.report["outcome"] = "repaired"
            return EXIT_OK
        except Injected:
            self.report["outcome"] = "injected"
            return EXIT_INJECTED
        except RepairAbort as e:
            self.report["outcome"] = ("above-md" if e.code == EXIT_ABOVE_MD
                                      else "mapping-abort" if e.code == EXIT_MAPPING_ABORT
                                      else "unrepairable")
            self.report["reason"] = e.reason
            print(e.reason, file=sys.stderr)
            return e.code
        finally:
            self.cleanup()
            rep = os.environ.get("REPAIR_REPORT")
            if rep:
                with open(rep, "w") as fh:
                    json.dump(self.report, fh, indent=1)


def subprocess_run(cmd: list[str]) -> None:
    import subprocess
    r = subprocess.run(cmd, capture_output=True, text=True,
                       stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}: {r.stderr.strip()}")


def resolve_mddev(srcdev: str) -> str:
    """Follow dm -> md: dmsetup dependency -> /dev/mdX node."""
    import subprocess
    out = subprocess.run(["dmsetup", "deps", "-o", "blkdevname", srcdev],
                         capture_output=True, text=True).stdout
    import re
    m = re.search(r"\((\w+)\)", out)
    if not m:
        raise RuntimeError(f"cannot resolve md under {srcdev}: {out}")
    return f"/dev/{m.group(1)}"


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return EXIT_INTERNAL
    mountpoint, path, block = sys.argv[1], sys.argv[2], int(sys.argv[3])
    if not os.path.isabs(path):
        path = os.path.join(mountpoint, path)
    if os.path.commonpath([os.path.realpath(path),
                           os.path.realpath(mountpoint)]) != os.path.realpath(mountpoint):
        print(f"file {path} not under mountpoint {mountpoint}", file=sys.stderr)
        return EXIT_INTERNAL
    try:
        return Repair(mountpoint, path, block).run()
    except Exception as e:  # noqa: BLE001
        print(f"repair-ref internal error: {e!r}", file=sys.stderr)
        return EXIT_INTERNAL


if __name__ == "__main__":
    sys.exit(main())
