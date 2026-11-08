import sys
from capstone import *
raw = open('fs.elf', 'rb').read()
md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
start = int(sys.argv[1], 16)
end = int(sys.argv[2], 16)
base = 0x292000000
for ins in md.disasm(raw[start:end], base + start - 0x1000):
    print('%08x  %-8s %s' % (ins.address, ins.mnemonic, ins.op_str))
