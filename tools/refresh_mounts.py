import glob
import json
import os
import re
import urllib.request
from pathlib import Path


def console_host():
    host = os.environ.get('NS2_CONSOLE')
    if host:
        return host.strip()
    try:
        text = Path(__file__).with_name('console-host.txt').read_text(encoding='utf-8')
        first = text.splitlines()[0].strip()
        if first:
            return first
    except OSError:
        pass
    return '192.168.1.50'


URL = f'http://{console_host()}:8080/eval'
ROOT = Path(__file__).resolve().parent.parent
ACCESSOR = str(ROOT / 'console' / 'n2h_accessor.lua')


def post(path):
    data = open(path, 'rb').read()
    req = urllib.request.Request(URL, data=data, method='POST')
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode('utf-8', 'replace')


out = post(ACCESSOR)
print(out)
# Keep the full walk: it lists every mount name, so a donor backing other than
# the app's live save (e.g. tmp/game/empty) can be chosen later.
try:
    (ROOT / 'tools' / 'mounts.log').write_text(out, encoding='utf-8')
except OSError:
    pass
sdk = re.search(r'sdk=(0x[0-9a-fA-F]+)', out)
if not sdk:
    raise SystemExit('could not parse sdk')
# The accessor prints one `mount ...` line per mount (save, tmp, game, ...).
# Keep every mount that resolved a service: donor-prepare can then clone a
# backing other than the app's live save (NS2_DONOR_MOUNT=tmp).
mounts = []
pattern = re.compile(
    r'^mount name=(\S+) accessor=(0x[0-9a-fA-F]+) impl=(0x[0-9a-fA-F]+) '
    r'service=(0x[0-9a-fA-F]+) vtable=(0x[0-9a-fA-F]+) '
    r'manager=(0x[0-9a-fA-F]+) objectId=(\d+) borrowed=(\d+)\r?$', re.M)
for match in pattern.finditer(out):
    mounts.append({
        'name': match.group(1),
        'accessor': int(match.group(2), 16),
        'implementation': int(match.group(3), 16),
        'service': int(match.group(4), 16),
        'serviceVtable': int(match.group(5), 16),
    })
if not mounts:
    # Older accessor output: only the save mount was resolved.
    entry = re.search(r'accessor=(0x[0-9a-fA-F]+).*?impl=(0x[0-9a-fA-F]+)', out)
    service = re.search(r'^impl=0x[0-9a-fA-F]+ service=(0x[0-9a-fA-F]+)', out, re.M)
    vtable = re.search(r'service vtable=(0x[0-9a-fA-F]+)', out)
    if not (entry and service and vtable):
        raise SystemExit('could not parse accessor/service/vtable')
    mounts = [{
        'name': 'save',
        'accessor': int(entry.group(1), 16),
        'implementation': int(entry.group(2), 16),
        'service': int(service.group(1), 16),
        'serviceVtable': int(vtable.group(1), 16),
    }]
data = {
    'session': 'seedsow',
    'sdk': int(sdk.group(1), 16),
    'mounts': mounts,
}
paths = glob.glob(str(ROOT / '**' / 'engine' / 'switch2' / 'app' / 'mounts.json'), recursive=True)
if not paths:
    raise SystemExit('mounts.json not found')
json.dump(data, open(paths[0], 'w'), indent=2)
print('wrote', paths[0])
print(json.dumps(data, indent=2))
