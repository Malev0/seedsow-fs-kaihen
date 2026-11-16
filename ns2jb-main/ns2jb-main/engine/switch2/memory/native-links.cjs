// These are address candidates from saved native reads, not verified pointers.
// A reused block is weaker evidence than a change confined to its free-list
// header. Seedsow keeps its cache link words at interior offsets, not only at
// the 0x4000-aligned block head, so scan every word and also accept a
// pointer-like word that is stable across the snapshots.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

// The FS allocator's free-list node is not always one word. A release can
// rewrite next/prev/key and still leave the rest of the block untouched; that
// is the same strong evidence as a one-word change, just with a larger header.
const HEADER_SIZES = [8, 0x10, 0x18, 0x20, 0x28];

async function findNativeLinks(snapshots, allowReusedBlockHeads = false) {
  const reads = [];
  for (const snapshot of snapshots) {
    const bytes = await fs.readFile(snapshot.outputFile);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), snapshot.outputSha256,
      'Saved native leak hash differs');
    reads.push({...snapshot, bytes});
  }
  const candidates = [];
  for (let index = 0; index < reads.length; index++) {
    const snapshot = reads[index], leaked = snapshot.bytes;
    const previous = reads[index - 1]?.bytes, next = reads[index + 1]?.bytes;
    for (let offset = 0x4000; offset + 8 <= leaked.length; offset += 8) {
      const value = leaked.readBigUInt64LE(offset);
      if (value < 0x100000000n || value >= (1n << 39n) || value % 0x4000n ||
          !(value & 0xffffffn)) continue;
      const blockEnd = Math.min(((offset & ~0x3fff) + 0x4000), leaked.length);
      const tail = leaked.subarray(offset + 8, blockEnd);
      const zeroTail = !leaked.subarray(offset + 8, Math.min(offset + 64, blockEnd)).some(byte => byte !== 0);
      const zeroAfter32 = !leaked.subarray(offset + 32, blockEnd).some(byte => byte !== 0);
      let changedHeader = 0;
      if (previous && previous.length >= offset + 8 && previous.readBigUInt64LE(offset) !== value) {
        for (const header of HEADER_SIZES) {
          if (offset + header > blockEnd || previous.length < blockEnd) continue;
          if (previous.subarray(offset + header, blockEnd).equals(leaked.subarray(offset + header, blockEnd))) {
            changedHeader = header;
            break;
          }
        }
      }
      const changedLink = changedHeader === 8;
      const reusedBlockHead = !!next && next.length >= offset + 8 &&
        next.readBigUInt64LE(offset) !== value &&
        !next.subarray(offset + 8, blockEnd).equals(tail);
      const stableLink = !!previous && previous.length >= offset + 8 &&
        previous.readBigUInt64LE(offset) === value;
      if (!zeroTail && !zeroAfter32 && !changedHeader && !(allowReusedBlockHeads && reusedBlockHead) && !stableLink) continue;
      candidates.push({offset, target: Number(value), zeroTail, zeroAfter32, changedLink, changedHeader,
        reusedBlockHead, stableLink, sourceFile: snapshot.outputFile, sourceSha256: snapshot.outputSha256,
        snapshot: snapshot.name || 'initial'});
    }
  }
  const strength = item => item.changedHeader ? 3 : item.zeroTail ? 2 : item.zeroAfter32 ? 1 : item.stableLink ? 0.5 : 0;
  return candidates.sort((a, b) => strength(b) - strength(a) || a.target - b.target);
}

module.exports = {findNativeLinks, HEADER_SIZES};
