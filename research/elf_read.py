#!/usr/bin/env python3
"""Minimal ELF64 reader for fs.elf: sections + symbols + string tables."""
import struct, sys

class ELF:
    def __init__(self, path):
        self.data = open(path, 'rb').read()
        d = self.data
        assert d[:4] == b'\x7fELF' and d[4] == 2 and d[5] == 1
        (self.e_type, self.e_machine, self.e_version, self.e_entry, self.e_phoff,
         self.e_shoff, self.e_flags, self.e_ehsize, self.e_phentsize, self.e_phnum,
         self.e_shentsize, self.e_shnum, self.e_shstrndx) = struct.unpack_from('<HHIQQQIHHHHHH', d, 16)
        self.sections = []
        for i in range(self.e_shnum):
            off = self.e_shoff + i * self.e_shentsize
            (name, typ, flags, addr, offset, size, link, info, addralign, entsize) = \
                struct.unpack_from('<IIQQQQIIQQ', d, off)
            self.sections.append(dict(index=i, name_off=name, type=typ, flags=flags, addr=addr,
                                      offset=offset, size=size, link=link, info=info,
                                      addralign=addralign, entsize=entsize))
        shstr = self.sections[self.e_shstrndx]
        self.shstr = d[shstr['offset']:shstr['offset'] + shstr['size']]
        for s in self.sections:
            s['name'] = self._cstr(self.shstr, s['name_off'])
        self.symbols = []
        for s in self.sections:
            if s['type'] not in (2, 11):  # SYMTAB, DYNSYM
                continue
            strtab = self.sections[s['link']]
            strings = d[strtab['offset']:strtab['offset'] + strtab['size']]
            n = s['size'] // s['entsize'] if s['entsize'] else 0
            for j in range(n):
                off = s['offset'] + j * s['entsize']
                st_name, st_info, st_other, st_shndx, st_value, st_size = \
                    struct.unpack_from('<IBBHQQ', d, off)
                self.symbols.append(dict(name=self._cstr(strings, st_name), info=st_info,
                                         shndx=st_shndx, value=st_value, size=st_size,
                                         table=s['name']))

    @staticmethod
    def _cstr(buf, off):
        end = buf.find(b'\0', off)
        if end < 0: end = len(buf)
        return buf[off:end].decode('utf-8', 'replace')

    def section(self, name):
        for s in self.sections:
            if s['name'] == name:
                return s
        return None

    def vaddr_to_offset(self, addr):
        for s in self.sections:
            if s['type'] != 8 and s['addr'] <= addr < s['addr'] + s['size']:
                return s['offset'] + (addr - s['addr'])
        return None

if __name__ == '__main__':
    e = ELF(sys.argv[1] if len(sys.argv) > 1 else 'fs.elf')
    print(f"type={e.e_type} machine={e.e_machine} entry=0x{e.e_entry:x} sections={e.e_shnum} symbols={len(e.symbols)}")
    for s in e.sections:
        print(f"  [{s['index']:2}] {s['name']:<20} type={s['type']:<2} addr=0x{s['addr']:08x} off=0x{s['offset']:08x} size=0x{s['size']:x} entsize={s['entsize']}")
