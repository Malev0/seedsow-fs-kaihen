#!/usr/bin/env python3
"""Read qwords from the Seedsow sdk segments by virtual address.

Segment layout inferred from the NSO segment sizes: text, ro, data.
"""
import os, struct, sys

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "research",
                    "Seedsow Lullaby Demo [010042D022AEA000][v0][BASE]", "Program #0", "0")
TEXT = open(os.path.join(BASE, "sdk.text"), "rb").read()
RO = open(os.path.join(BASE, "sdk.ro"), "rb").read()
DATA = open(os.path.join(BASE, "sdk.data"), "rb").read()

RO_BASE = len(TEXT)
DATA_BASE = RO_BASE + len(RO)

def read(addr, n):
    if addr < RO_BASE:
        return TEXT[addr:addr + n]
    if addr < DATA_BASE:
        return RO[addr - RO_BASE:addr - RO_BASE + n]
    return DATA[addr - DATA_BASE:addr - DATA_BASE + n]

def qwords(addr, n):
    b = read(addr, n)
    return [struct.unpack_from('<Q', b, i)[0] for i in range(0, len(b), 8)]

if __name__ == '__main__':
    addr = int(sys.argv[1], 0)
    n = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x40
    print(f"text=0x{RO_BASE:x} ro=0x{RO_BASE:x}..0x{DATA_BASE:x} data=0x{DATA_BASE:x}..0x{DATA_BASE+len(DATA):x}")
    for i, v in enumerate(qwords(addr, n)):
        print(f"0x{addr + i * 8:08x}: 0x{v:016x}")
