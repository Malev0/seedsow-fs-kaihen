#!/usr/bin/env python3
"""Disassemble the Seedsow SDK SVC veneer region and label known SVCs."""
import os
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "Seedsow Lullaby Demo [010042D022AEA000][v0][BASE]", "Program #0", "0")
text = open(os.path.join(BASE, "sdk.text"), "rb").read()
start, end = 0x168a80, 0x168e60
md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
for ins in md.disasm(text[start:end], start):
    print(f"0x{ins.address:06x}  {ins.mnemonic:<8} {ins.op_str}")
