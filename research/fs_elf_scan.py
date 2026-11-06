#!/usr/bin/env python3
"""Scan the fsp-srv fs.elf dump: SVC census + the API-thread entry."""
import struct, sys, os
from collections import Counter
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fs.elf")
raw = open(PATH, "rb").read()

# Program headers: text 0x1000/0x24e000 @0x292000000, rodata, data
TEXT_OFF, TEXT_VA, TEXT_SIZE = 0x1000, 0x292000000, 0x24e000
text = raw[TEXT_OFF:TEXT_OFF + TEXT_SIZE]
md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)


def dis(va, count, base_va=TEXT_VA):
    off = va - base_va
    for ins in md.disasm(text[off:off + count * 4], va):
        print(f"0x{ins.address:x}  {ins.mnemonic:<8} {ins.op_str}")


def svc_census():
    c = Counter()
    for i in range(0, len(text) - 4, 4):
        w = struct.unpack_from("<I", text, i)[0]
        if (w & 0xFFE0001F) == 0xD4000001:
            c[(w >> 5) & 0xFFFF] += 1
    for imm, n in sorted(c.items()):
        print(f"svc #{imm:#04x}  {n}")


def bl_callers(target_off):
    out = []
    for i in range(0, len(text) - 4, 4):
        w = struct.unpack_from("<I", text, i)[0]
        if (w & 0xFC000000) == 0x94000000:
            imm = w & 0x03FFFFFF
            if imm & 0x02000000:
                imm -= 0x04000000
            if i + imm * 4 == target_off:
                out.append(i)
    return out


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "entry"
    if what == "svc":
        svc_census()
    elif what == "entry":
        dis(TEXT_VA + 0xACD4, 120)
    elif what == "callers":
        t = int(sys.argv[2], 0)
        for off in bl_callers(t):
            print(f"caller 0x{off:x}")
    elif what == "at":
        dis(TEXT_VA + int(sys.argv[2], 0), int(sys.argv[3]) if len(sys.argv) > 3 else 80)
