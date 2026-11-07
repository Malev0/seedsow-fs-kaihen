const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2', 'ro');
for (const f of fs.readdirSync(dir)) {
  if (!f.startsWith('seedsow-gate-test-')) continue;
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  let j;
  try { j = JSON.parse(t); } catch { continue; }
  if (j.selectionsAfterStep) {
    console.log(f, 'row=' + j.row.address.toString(16), 'sel=' + JSON.stringify(j.selectionsAfterStep),
      'stop=' + j.stopped, 'wakeMode=' + j.wakeMode, 'mode=' + (j.stepMode || ''));
  }
}
