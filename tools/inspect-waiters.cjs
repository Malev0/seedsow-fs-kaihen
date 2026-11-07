const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const layout = JSON.parse(fs.readFileSync(path.join(root, 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2', 'ro', 'seedsow-layout.json'), 'utf8'));
const bytes = fs.readFileSync(layout.range.outputFile);
const base = layout.range.address;
const q = (addr) => bytes.readBigUInt64LE(addr - base);
const u32 = (addr) => bytes.readUInt32LE(addr - base);
const inRange = (addr) => addr >= base && addr < base + bytes.length;

console.log('manager 0x' + layout.manager.toString(16), 'range 0x' + base.toString(16), bytes.length);
for (let i = 0; i < layout.waiters.length; i++) {
  const w = layout.waiters[i];
  console.log(`\nwaiter[${i}] 0x${w.toString(16)}`);
  console.log('  +0x00', '0x' + q(w).toString(16));
  console.log('  +0x08 head', '0x' + q(w + 8).toString(16), inRange(Number(q(w + 8))) ? 'in range' : 'OUT');
  console.log('  +0x10 cache', '0x' + q(w + 0x10).toString(16));
  console.log('  +0x18 stamp', '0x' + q(w + 0x18).toString(16));
  console.log('  +0x20 mutex', '0x' + q(w + 0x20).toString(16));
  // Follow the list at +0x08; node is at holder+8, next at node+0x10.
  const head = Number(q(w + 8));
  let node = head, seen = new Set(), n = 0;
  const chain = [];
  while (node && node !== w && !seen.has(node) && n < 12) {
    seen.add(node); n++;
    if (!inRange(node)) { chain.push('0x' + node.toString(16) + ' OUT'); break; }
    const holder = node - 8;
    chain.push({node: '0x' + node.toString(16), holder: '0x' + holder.toString(16),
      vptr: '0x' + q(holder).toString(16), h30: '0x' + u32(holder + 0x30).toString(16),
      h38: q(holder + 0x38).toString(), next: '0x' + q(node + 8).toString(16)});
    node = Number(q(node + 8));
  }
  console.log('  chain', JSON.stringify(chain, null, 0));
}
