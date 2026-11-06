#!/usr/bin/env python3
"""Find BL callers of the SDK SVC veneers and disassemble around them.

The SDK module (research/.../sdk.text) is the same nnSdk build the FS sysmodule
links, so the wait/cancel field offsets here match the FS-side objects we poke
(selected +0x10, epoch +0x18 in the waiter entries).
"""
import os, struct, sys
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "Seedsow Lullaby Demo [010042D022AEA000][v0][BASE]", "Program #0", "0")
TEXT = open(os.path.join(BASE, "sdk.text"), "rb").read()

# veneer addresses found by the SVC scan (imm -> file offset of the svc insn)
VENEER = {0x18: 0x168bf8, 0x19: 0x168c0c, 0x21: 0x168c4c, 0x43: 0x168db0, 0x44: 0x168dc8}
# the veneer entry is where callers branch; the svc sits inside it
ENTRY = {imm: off - 4 * 2 for imm, off in VENEER.items()}


def bl_targets(text):
    out = {}
    for i in range(0, len(text) - 4, 4):
        w = struct.unpack_from("<I", text, i)[0]
        if (w & 0xFC000000) == 0x94000000:
            imm = w & 0x03FFFFFF
            if imm & 0x02000000:
                imm -= 0x04000000
            out.setdefault(i + imm * 4, []).append(i)
    return out


def dis(start, end, label=""):
    md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
    print(f"--- {label} 0x{start:x}..0x{end:x} ---")
    for ins in md.disasm(TEXT[max(0, start):end], start):
        mark = "  <== svc" if ins.mnemonic == "svc" else ""
        print(f"0x{ins.address:06x}  {ins.mnemonic:<8} {ins.op_str}{mark}")


def main():
    targets = bl_targets(TEXT)
    for imm, entry in sorted(ENTRY.items()):
        callers = targets.get(entry, [])
        print(f"\n=== svc #{imm:#04x} veneer 0x{entry:x}: {len(callers)} caller(s) ===")
        for at in callers[:6]:
            dis(at, at + 0x120, f"caller @0x{at:x}")
        if len(callers) > 6:
            print(f"  ... {len(callers) - 6} more")


if __name__ == "__main__":
    main()
