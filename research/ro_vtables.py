import struct
b = open(r'FW dump Switch2 JPN/0400000000000037/main.decompressed.bin', 'rb').read()
TXT, RO, DAT = 0x2827c, 0x8eb8, 0x2058
text = b[:TXT]
rodata = b[TXT:TXT + RO]
data = b[TXT + RO:TXT + RO + DAT]
RO_VA, DATA_VA = 0x29000, 0x32000

def ro_off(va): return va - RO_VA
def data_off(va): return va - DATA_VA

# Find interesting mangled type names in rodata.
names = []
i = 0
while i < len(rodata):
    if 32 <= rodata[i] < 127:
        j = i
        while j < len(rodata) and 32 <= rodata[j] < 127:
            j += 1
        s = rodata[i:j].decode('latin1')
        if ('CmifDomainServerObject' in s or 'HipcServerSessionManagerWithDomain' in s
                or 'HipcServerSessionManager' in s or 'DomainBase' in s):
            names.append((RO_VA + i, s))
        i = j
    else:
        i += 1

print('candidate type names', len(names))
for va, s in names:
    print('  0x%x %s' % (va, s))

# For each name string, find a data pointer to it (the typeinfo name field).
print('\n--- typeinfo / vtable ---')
for va, s in names:
    hits = []
    for o in range(0, len(data) - 8, 8):
        v = struct.unpack_from('<Q', data, o)[0]
        if v == va:
            hits.append(DATA_VA + o)
    for h in hits:
        # typeinfo = h - 8; its vtable ptr at typeinfo+0, name at typeinfo+8
        typeinfo = h - 8
        vt_hits = []
        for o in range(0, len(data) - 8, 8):
            v = struct.unpack_from('<Q', data, o)[0]
            if v == typeinfo:
                vt_hits.append(DATA_VA + o)
        print('name 0x%x -> typeinfo 0x%x, vtable refs %s' % (va, typeinfo, [hex(x) for x in vt_hits]))
        for vt in vt_hits:
            vtable = vt + 8
            entries = []
            for k in range(24):
                o = data_off(vtable) + k * 8
                if o + 8 > len(data):
                    break
                v = struct.unpack_from('<Q', data, o)[0]
                entries.append(v)
            print('   vtable 0x%x entries:' % vtable, ' '.join('0x%x' % e for e in entries))
