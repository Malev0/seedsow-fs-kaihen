const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2', 'retained');
const report = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2', 'ro', 'seedsow-layout.json'), 'utf8'));
const capture = report.range;
const bytes = fs.readFileSync(capture.outputFile);
console.log('capture', capture.address.toString(16), capture.length, bytes.length);
const row = 389525914600; // ownDomain row from bound-sessions
const holder = row - 0x88;
function show(name, address, length) {
  const off = address - capture.address;
  if (off < 0 || off + length > bytes.length) { console.log(name, 'OUT OF RANGE'); return; }
  const b = bytes.subarray(off, off + length);
  console.log(`\n${name} 0x${address.toString(16)} (file +0x${off.toString(16)})`);
  for (let i = 0; i < b.length; i += 8) {
    const q = b.readBigUInt64LE(i);
    const p = q < (1n << 40n) && q > 0x10000n ? ' -> 0x' + q.toString(16) : '';
    console.log(`  +0x${i.toString(16).padStart(2, '0')} 0x${q.toString(16).padStart(16, '0')}${p}`);
  }
  return b;
}
const h = show('holder', holder, 0x88);
const r = show('session row', row, 0x88);
console.log('\nholder +0x30 u32 =', h.readUInt32LE(0x30), '0x' + h.readUInt32LE(0x30).toString(16));
console.log('holder +0x38 u64 =', h.readBigUInt64LE(0x38).toString());
console.log('holder +0x70 byte =', h[0x70]);
console.log('holder +0x28 u64 = 0x' + h.readBigUInt64LE(0x28).toString(16));
console.log('row +0x28 u64    = 0x' + r.readBigUInt64LE(0x28).toString(16));
console.log('row +0x30 u32    =', r.readUInt32LE(0x30), '0x' + r.readUInt32LE(0x30).toString(16));
console.log('row +0x48 u32    =', r.readUInt32LE(0x48));
