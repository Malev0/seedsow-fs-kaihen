#!/usr/bin/env node
// Parse a worker-side TCP dump (the raw FS table window) against the launch
// proof that produced it.
//
//   node tools/parse-dump.cjs [dump.bin] [launch.json]
//
// With no arguments it uses the newest dump-<timestamp>.bin in the repository
// root and the newest ro/seedsow-launch-<timestamp>.json. Each 0x30-byte row is
// printed with the entry id, address, domain, object and metadata; the row whose
// metadata matches the donor is marked `"match": true`.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const switch2 = path.join(root, 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2');

function latest(directory, pattern) {
  const files = fs.readdirSync(directory).filter(name => pattern.test(name))
    .map(name => ({name, at: fs.statSync(path.join(directory, name)).mtimeMs}))
    .sort((a, b) => b.at - a.at);
  if (!files.length) throw Error(`No file matching ${pattern} in ${directory}`);
  return path.join(directory, files[0].name);
}

const dumpFile = process.argv[2] || latest(root, /^dump-\d+\.bin$/);
const launchFile = process.argv[3] || latest(path.join(switch2, 'ro'), /^seedsow-launch-\d+\.json$/);
const proof = JSON.parse(fs.readFileSync(launchFile, 'utf8'));
const watch = proof.watch || {};
const firstFree = Number(watch.firstFree);
const windowAddress = Number(watch.windowAddress);
const donorMetadata = Number(proof.donor?.metadata);
const bytes = fs.readFileSync(dumpFile);

console.log(JSON.stringify({dump: path.relative(root, dumpFile),
  launch: path.relative(root, launchFile), bytes: bytes.length,
  windowAddress, firstFree, donorMetadata}));

let matches = 0;
for (let offset = 0; offset + 0x30 <= bytes.length; offset += 0x30) {
  const domain = Number(bytes.readBigUInt64LE(offset + 0x18));
  if (!domain) continue;
  const metadata = Number(bytes.readBigUInt64LE(offset + 0x28));
  const row = {id: firstFree + offset / 0x30, address: windowAddress + offset,
    domain, object: Number(bytes.readBigUInt64LE(offset + 0x20)), metadata,
    match: metadata === donorMetadata};
  if (row.match) matches++;
  console.log(JSON.stringify(row));
}
console.log(JSON.stringify({matches}));
