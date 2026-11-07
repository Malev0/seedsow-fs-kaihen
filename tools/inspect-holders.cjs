const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const layout = JSON.parse(fs.readFileSync(path.join(root, 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2', 'ro', 'seedsow-layout.json'), 'utf8'));
const bytes = fs.readFileSync(layout.range.outputFile);
const base = layout.range.address;
function show(name, address, length = 0x88) {
  const off = address - base;
  if (off < 0 || off + length > bytes.length) { console.log(name, 'OUT'); return; }
  const b = bytes.subarray(off, off + length);
  console.log(`\n${name} 0x${address.toString(16)}`);
  for (let i = 0; i < b.length; i += 8)
    console.log(`  +0x${i.toString(16).padStart(2, '0')} 0x${b.readBigUInt64LE(i).toString(16).padStart(16, '0')}`);
  console.log(`  u32 +0x30=${b.readUInt32LE(0x30)} +0x40=${b.readUInt32LE(0x40)} +0x44=${b.readUInt32LE(0x44)} +0x48=${b.readUInt32LE(0x48)} byte+0x70=${b[0x70]}`);
}
// A linked session holder from waiter[3] and waiter[5], and the two idle objects.
show('chain holder waiter3 0x5ab18dc2d8', 0x5ab18dc2d8);
show('chain holder waiter5 0x5ab18da050', 0x5ab18da050);
show('idle object row-0x88', 0x5ab18dc360);
show('idle object row', 0x5ab18dc3e8);
show('chain holder waiter5 0x5ab18d9fc8', 0x5ab18d9fc8);
show('chain holder waiter5 0x5ab18d9f40', 0x5ab18d9f40);
