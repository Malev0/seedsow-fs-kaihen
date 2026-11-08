// Challenge the native RO payload from the application's own space.
// The stock RO's ro:dmnt entry in the system space outlives its process, so the
// FS-side probe keeps resolving the dead stock port. The payload also registers
// ro:1 in the application space (space 2), which the game process can reach.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {Session, live, check} = require('./session.cjs');

async function main(pid) {
  check(typeof pid === 'string' && /^\d+$/.test(pid), 'Expected the accepted RO process ID');
  const session = new Session('ro-app-probe-' + Date.now(), 0x10000);
  const proof = {session: live.session, pid, name: 'ro:1', started: new Date().toISOString(),
    challenges: [], verified: false};
  const file = path.join(__dirname, 'ro-app-probe-' + Date.now() + '.json');
  const save = () => fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  await save();
  try {
    await session.initialize();
    const handle = await session.openService('ro:1');
    proof.handle = handle; await save();
    let previousTick = 0n;
    for (let i = 0; i < 2; i++) {
      const nonce = crypto.randomBytes(8);
      const row = {nonce: nonce.toString('hex')};
      proof.challenges.push(row); await save();
      const reply = await session.ipc('RO app instruction challenge', handle, 0x524f0001, nonce);
      const data = reply.data;
      check(!reply.result && data.length >= 48 &&
        data.readBigUInt64LE() === 0x4558454f5232534en &&
        data.readBigUInt64LE(8) === (nonce.readBigUInt64LE() ^ 0x9d7c3a51e6b2048fn) &&
        data.readBigUInt64LE(16) === BigInt(pid), 'The app-space payload response differs');
      row.threadId = data.readBigUInt64LE(24).toString();
      row.tick = data.readBigUInt64LE(32).toString();
      row.registration = data.subarray(40, 48).toString('hex');
      check(BigInt(row.tick) > previousTick, 'The app-space native tick did not advance');
      previousTick = BigInt(row.tick);
      row.verified = true; await save();
    }
    proof.verified = true;
    proof.completed = new Date().toISOString();
    await save();
    await session.close(handle);
    return {file, verified: true, pid, challenges: proof.challenges.length,
      completed: proof.completed, service: 'ro:1', app: true};
  } catch (error) {
    proof.error = error.stack; await save();
    error.proofFile = file;
    throw error;
  } finally {
    if (await session.ready()) await session.cleanup();
  }
}
module.exports = {main};
