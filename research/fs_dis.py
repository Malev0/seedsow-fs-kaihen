#!/usr/bin/env python3
"""Disassemble the fs.elf text by text offset (or VA)."""
import os, sys
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fs.elf")
RAW = open(PATH, "rb").read()
TEXT_OFF, TEXT_VA, TEXT_SIZE = 0x1000, 0x292000000, 0x24e000
TEXT = RAW[TEXT_OFF:TEXT_OFF + TEXT_SIZE]
md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)

def dis(off, count, label=""):
    if label: print(f"--- {label} ---")
    for ins in md.disasm(TEXT[off:off + count * 4], TEXT_VA + off):
        print(f"0x{ins.address:09x} (+0x{ins.address - TEXT_VA:06x})  {ins.mnemonic:<8} {ins.op_str}")

if __name__ == '__main__':
    arg = sys.argv[1]
    off = int(arg, 0)
    if off >= TEXT_VA:
        off -= TEXT_VA
    count = int(sys.argv[2], 0) if len(sys.argv) > 2 else 40
    dis(off, count)
