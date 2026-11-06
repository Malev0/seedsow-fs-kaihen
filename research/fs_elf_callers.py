#!/usr/bin/env python3
"""Find callers of each FS syscall veneer and show the call sites."""
import struct, sys, os
from collections import Counter
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fs.elf")
raw = open(PATH, "rb").read()
TEXT_OFF, TEXT_VA, TEXT_SIZE = 0x1000, 0x292000000, 0x24e000
text = raw[TEXT_OFF:TEXT_OFF + TEXT_SIZE]
md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)


def svcs():
    out = []
    for i in range(0, len(text) - 4, 4):
        w = struct.unpack_from("<I", text, i)[0]
        if (w & 0xFFE0001F) == 0xD4000001:
            out.append((i, (w >> 5) & 0xFFFF))
    return out


def bl_map():
    out = {}
    for i in range(0, len(text) - 4, 4):
        w = struct.unpack_from("<I", text, i)[0]
        if (w & 0xFC000000) == 0x94000000:
            imm = w & 0x03FFFFFF
            if imm & 0x02000000:
                imm -= 0x04000000
            out.setdefault(i + imm * 4, []).append(i)
    return out


def dis(off, n=16, indent="   "):
    for ins in md.disasm(text[off:off + n * 4], TEXT_VA + off):
        print(f"{indent}0x{ins.address:x}  {ins.mnemonic:<8} {ins.op_str}")


if __name__ == "__main__":
    calls = bl_map()
    if len(sys.argv) > 1 and sys.argv[1] == "callers":
        for off, imm in svcs():
            prev = struct.unpack_from("<I", text, off - 4)[0]
            # str x0/x1, [sp, #-0x10]! prologue before the svc
            start = off - 4 if prev in (0xF81F0FE0, 0xF81F0FE1) else off
            c = calls.get(start, [])
            if c:
                print(f"svc #{imm:#04x} entry 0x{start:x}: {len(c)} caller(s) {[hex(x) for x in c[:10]]}")
        sys.exit(0)
    if len(sys.argv) > 2 and sys.argv[1] == "callers-of":
        t = int(sys.argv[2], 0)
        for c in calls.get(t, []):
            print(f"=== caller 0x{c:x}")
            dis(c - 0x30, 32)
        sys.exit(0)
    if len(sys.argv) > 2 and sys.argv[1] == "at":
        dis(int(sys.argv[2], 0), int(sys.argv[3]) if len(sys.argv) > 3 else 40)
