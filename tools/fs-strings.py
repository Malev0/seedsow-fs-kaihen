import re
raw = open('fs.elf', 'rb').read()
for m in re.finditer(rb'[ -~]{6,}', raw):
    s = m.group().decode('ascii')
    if any(k in s.lower() for k in ('assert', 'abort', 'invalid', 'failed', 'fail', 'domain', 'close', 'object', 'save', 'filesystem', 'file system', 'session', 'refcount', 'reference')):
        print('%08x  %s' % (m.start(), s))
