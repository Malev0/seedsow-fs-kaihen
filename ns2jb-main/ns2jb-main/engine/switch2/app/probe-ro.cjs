// Challenge the native RO payload from the application's own space.
// The stock RO's ro:dmnt entry in the system space outlives its process, so the
// FS-side probe keeps resolving the dead stock port. The payload also registers
// ro:1 in the application space (space 2), which the game process may reach.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {Session, live, check} = require('./session.cjs');

// Raw GetService so the proof records the SM result code even when the game's
// NPDM denies the name (NotAllowed) instead of the payload not registering it
// (NotRegistered).
async function probeService(session, name) {
  const values = session.base + 0x1000;
  const bytes = Buffer.alloc(32); bytes.write(name, 8);
  await session.write(values, bytes);
  const result = await session.call('getService', values, values + 8, name.length);
  const handle = result ? null : (await session.readOwned(values, 4)).readUInt32LE();
  if (handle) session.handles.add(handle);
  return {name, result, handle};
}

async function main(pid) {
  check(typeof pid === 'string' && /^\d+$/.test(pid), 'Expected the accepted RO process ID');
  const session = new Session('ro-app-probe-' + Date.now(), 0x10000);
  const proof = {session: live.session, pid, name: 'ro:1', started: new Date().toISOString(),
    challenges: [], services: [], verified: false};
  const file = path.join(__dirname, 'ro-app-probe-' + Date.now() + '.json');
  const save = () => fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  await save();
  try {
    await session.initialize();
    for (const name of ['ro:1', 'ldr:ro', 'ro:dmnt'])
      proof.services.push(await probeService(session, name));
    await save();
    const service = proof.services.find(item => !item.result && item.handle && item.name === 'ro:1');
    check(service, 'The game cannot resolve the payload\'s ro:1 (see services)');
    const handle = service.handle;
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
      completed: proof.completed, service: 'ro:1', app: true, services: proof.services};
  } catch (error) {
    proof.error = error.stack; await save();
    error.proofFile = file;
    error.services = proof.services;
    throw error;
  } finally {
    if (await session.ready()) await session.cleanup();
  }
}
module.exports = {main};
