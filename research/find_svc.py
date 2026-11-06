#!/usr/bin/env python3
"""List every SVC instruction in the Seedsow SDK text (imm + offset + next insn)."""
import os
import struct

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "Seedsow Lullaby Demo [010042D022AEA000][v0][BASE]", "Program #0", "0")
text = open(os.path.join(BASE, "sdk.text"), "rb").read()
hits = {}
for i in range(0, len(text) - 8, 4):
    word = struct.unpack_from("<I", text, i)[0]
    if (word & 0xFFE0001F) == 0xD4000001:
        imm = (word >> 5) & 0xFFFF
        nxt = struct.unpack_from("<I", text, i + 4)[0]
        hits.setdefault(imm, []).append((i, nxt))
for imm in sorted(hits):
    rows = hits[imm]
    ret = sum(1 for _, n in rows if n == 0xD65F03C0)
    print(f"svc #{imm:#04x}: {len(rows)} site(s), {ret} followed by ret, first {hex(rows[0][0])}")
