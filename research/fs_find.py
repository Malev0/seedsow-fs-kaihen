#!/usr/bin/env python3
"""Find instructions matching a mnemonic/op_str regex in fs.elf text."""
import os, sys, re
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fs.elf")
RAW = open(PATH, "rb").read()
TEXT_OFF, TEXT_VA, TEXT_SIZE = 0x1000, 0x292000000, 0x24e000
TEXT = RAW[TEXT_OFF:TEXT_OFF + TEXT_SIZE]
md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
md.skipdata = True

mnem = sys.argv[1]
opre = re.compile(sys.argv[2]) if len(sys.argv) > 2 else None
context = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0

hits = []
insns = list(md.disasm(TEXT, TEXT_VA))
for idx, ins in enumerate(insns):
    if ins.mnemonic != mnem: continue
    if opre and not opre.search(ins.op_str): continue
    hits.append(idx)
print(f"hits: {len(hits)}")
for idx in hits[:40]:
    start = max(0, idx - context)
    end = min(len(insns), idx + context + 1)
    print(f"--- hit at +0x{insns[idx].address - TEXT_VA:x} ---")
    for j in range(start, end):
        i = insns[j]
        mark = " <== " if j == idx else "     "
        print(f"{mark}+0x{i.address - TEXT_VA:06x}  {i.mnemonic:<8} {i.op_str}")
