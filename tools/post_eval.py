import os
import sys
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


path = sys.argv[1]
data = open(path, 'rb').read()
req = urllib.request.Request(f'http://{console_host()}:8080/eval', data=data, method='POST')
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        print(r.read().decode('utf-8', 'replace'))
except Exception as e:
    print('POST ERROR:', e)
    sys.exit(1)
