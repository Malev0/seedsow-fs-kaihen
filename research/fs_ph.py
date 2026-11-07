import struct
d=open('fs.elf','rb').read()
e_phoff=struct.unpack_from('<Q',d,0x20)[0]
e_phentsize=struct.unpack_from('<H',d,0x36)[0]
e_phnum=struct.unpack_from('<H',d,0x38)[0]
print('phoff',hex(e_phoff),'entsize',e_phentsize,'num',e_phnum)
for i in range(e_phnum):
    off=e_phoff+i*e_phentsize
    p_type,p_flags,p_offset,p_vaddr,p_paddr,p_filesz,p_memsz,p_align=struct.unpack_from('<IIQQQQQQ',d,off)
    print(i,'type',p_type,'flags',p_flags,'off',hex(p_offset),'vaddr',hex(p_vaddr),'filesz',hex(p_filesz),'memsz',hex(p_memsz),'align',hex(p_align))
