import sys
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM
from capstone.arm64 import ARM64_OP_REG, ARM64_OP_MEM
raw = open(r'FW dump Switch2 JPN/0400000000000037/main.decompressed.bin', 'rb').read()
TXT = 0x2827c
text = raw[:TXT]
md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
md.detail = True
insns = {}
for i in range(0, len(text) - 4, 4):
    for ins in md.disasm(text[i:i+4], i):
        insns[i] = ins
        break
offs = sorted(insns)

def reg(ins, n):
    ops = ins.operands
    return ins.reg_name(ops[n].reg) if n < len(ops) and ops[n].type == ARM64_OP_REG else None

def mem(ins, n):
    ops = ins.operands
    return ops[n].mem if n < len(ops) and ops[n].type == ARM64_OP_MEM else None

def func_start(off):
    for k in range(off, max(0, off - 0x600), -4):
        if k in insns and insns[k].mnemonic in ('pacibsp', 'paciasp'):
            return k
    return None

# function contains loads/stores at the domain entry fields and a 0x30 stride
cands = {}
for off in offs:
    ins = insns[off]
    for n in (1, 2):
        m = mem(ins, n)
        if m is None:
            continue
        if m.disp in (0x18, 0x20, 0x28):
            B = reg(ins, n)
            if not B:
                continue
            st = func_start(off)
            if st is not None:
                cands.setdefault(st, set()).add((B, m.disp))

matches = []
for st, fields in cands.items():
    for B in set(b for b, _ in fields):
        disps = set(d for b, d in fields if b == B)
        if {0x18, 0x20, 0x28} <= disps:
            matches.append((st, B))

print('domain-field functions', len(matches))
seen = set()
for st, B in matches[:20]:
    if st in seen:
        continue
    seen.add(st)
    print('=== func 0x%x base %s' % (st, B))
    for k in range(st, min(st + 0x120, len(text) - 4), 4):
        if k in insns:
            x = insns[k]
            print('  0x%x  %-8s %s' % (x.address, x.mnemonic, x.op_str))
    print()
