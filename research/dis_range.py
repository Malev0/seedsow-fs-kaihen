#!/usr/bin/env python3
"""Disassemble a range of the Seedsow SDK text with capstone."""
import os, struct, sys
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "research",
                    "Seedsow Lullaby Demo [010042D022AEA000][v0][BASE]", "Program #0", "0")
TEXT = open(os.path.join(BASE, "sdk.text"), "rb").read()

def dis(start, length, label=""):
    md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
    if label: print(f"--- {label} ---")
    for ins in md.disasm(TEXT[start:start + length], start):
        print(f"0x{ins.address:06x}  {ins.mnemonic:<8} {ins.op_str}")

if __name__ == "__main__":
    start = int(sys.argv[1], 0)
    length = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x100
    dis(start, length)
