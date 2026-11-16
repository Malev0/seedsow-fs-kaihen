// Recompute the NSO segment hashes and the manifest after a binary patch.
//
// The payload is a hand-built, *uncompressed* NSO0. Its header sets the
// TextHash/RoHash/DataHash flags (bits 3..5), so any edit of .text/.rodata/.data
// must also rewrite the matching SHA-256 at 0xA0/0xC0/0xE0. Patching `main` to
// `b .` without doing that leaves a stale TextHash (the 2026-11-08 idle-payload
// control did exactly this).
//
// Usage: node refresh-hashes.cjs [payload/main]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const file = process.argv[2] || path.join(__dirname, 'main');
const manifestFile = path.join(__dirname, 'manifest.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest();
const u32 = (b, o) => b.readUInt32LE(o);

const bytes = fs.readFileSync(file);
if (bytes.toString('ascii', 0, 4) !== 'NSO0') throw Error('Not an NSO0 image: ' + file);
const flags = u32(bytes, 0x0c);
if (flags & 0x07) throw Error('Compressed NSO segments are not supported by this tool');

const segments = [
  {name: 'text', offset: u32(bytes, 0x10), size: u32(bytes, 0x18), hash: 0xa0, flag: 1 << 3},
  {name: 'rodata', offset: u32(bytes, 0x20), size: u32(bytes, 0x28), hash: 0xc0, flag: 1 << 4},
  {name: 'data', offset: u32(bytes, 0x30), size: u32(bytes, 0x38), hash: 0xe0, flag: 1 << 5}
];
const result = {};
for (const segment of segments) {
  if (!(flags & segment.flag)) continue;
  if (!segment.size || segment.offset + segment.size > bytes.length)
    throw Error('Invalid ' + segment.name + ' segment bounds');
  const digest = hash(bytes.subarray(segment.offset, segment.offset + segment.size));
  const previous = bytes.subarray(segment.hash, segment.hash + 0x20);
  digest.copy(bytes, segment.hash);
  result[segment.name] = {offset: segment.offset, size: segment.size,
    before: previous.toString('hex'), after: digest.toString('hex'),
    changed: !previous.equals(digest)};
}
fs.writeFileSync(file, bytes);

const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.payloadBytes = bytes.length;
manifest.payloadSha256 = hash(bytes).toString('hex');
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

console.log(JSON.stringify({file, bytes: bytes.length, flags: '0x' + flags.toString(16),
  segments: result, payloadSha256: manifest.payloadSha256}, null, 2));
