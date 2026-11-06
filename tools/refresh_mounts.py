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
sdk = re.search(r'sdk=(0x[0-9a-fA-F]+)', out)
entry = re.search(r'accessor=(0x[0-9a-fA-F]+).*?impl=(0x[0-9a-fA-F]+)', out)
service = re.search(r'^impl=0x[0-9a-fA-F]+ service=(0x[0-9a-fA-F]+)', out, re.M)
vtable = re.search(r'service vtable=(0x[0-9a-fA-F]+)', out)
if not (entry and service and vtable and sdk):
    raise SystemExit('could not parse sdk/accessor/service/vtable')
data = {
    'session': 'seedsow',
    'sdk': int(sdk.group(1), 16),
    'mounts': [{
        'name': 'save',
        'accessor': int(entry.group(1), 16),
        'implementation': int(entry.group(2), 16),
        'service': int(service.group(1), 16),
        'serviceVtable': int(vtable.group(1), 16),
    }],
}
paths = glob.glob(str(ROOT / '**' / 'engine' / 'switch2' / 'app' / 'mounts.json'), recursive=True)
if not paths:
    raise SystemExit('mounts.json not found')
json.dump(data, open(paths[0], 'w'), indent=2)
print('wrote', paths[0])
print(json.dumps(data, indent=2))
