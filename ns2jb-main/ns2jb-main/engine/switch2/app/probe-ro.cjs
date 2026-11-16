// Challenge the native RO payload from the application's own space.
// The stock RO's ro:dmnt entry in the system space outlives its process, so the
// FS-side probe keeps resolving the dead stock port. The payload also registers
// ro:1 in the application space (space 2), which the game process may reach.
const fs = require('node:fs/promises');
const path = require('node:path');
const {artifactDir} = require('../../shared/paths.cjs');
const OUT = artifactDir(__dirname);
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

async function challenge(session, handle, nonce, pid) {
  const reply = await session.ipc('RO app instruction challenge', handle, 0x524f0001, nonce);
  const data = reply.data;
  check(!reply.result && data.length >= 48 &&
    data.readBigUInt64LE() === 0x4558454f5232534en &&
    data.readBigUInt64LE(8) === (nonce.readBigUInt64LE() ^ 0x9d7c3a51e6b2048fn) &&
    data.readBigUInt64LE(16) === BigInt(pid), 'The app-space payload response differs');
  return data;
}

async function main(pid) {
  check(typeof pid === 'string' && /^\d+$/.test(pid), 'Expected the accepted RO process ID');
  const session = new Session('ro-app-probe-' + Date.now(), 0x10000);
  const proof = {session: live.session, pid, name: 'ro:1', started: new Date().toISOString(),
    challenges: [], services: [], raw: [], attempts: [], verified: false};
  const file = path.join(OUT, 'ro-app-probe-' + Date.now() + '.json');
  const save = () => fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  await save();
  try {
    await session.initialize();
    for (const name of ['ro:1', 'ldr:ro', 'ro:dmnt'])
      proof.services.push(await probeService(session, name));
    await save();
    // The SDK getService wrapper enforces the NPDM access list (the game is
    // denied ro:1/ro:dmnt). The raw cmd 0x11 on the game's own SM client
    // bypasses that check and resolves the payload's application-space (space
    // 2) registrations. ro:1 is the payload's free space-2 name.
    for (const name of ['ro:1', 'ro:dmnt', 'ldr:ro']) {
      try { proof.raw.push(await session.rawGetService(name)); }
      catch (error) { proof.raw.push({name, error: error.message}); }
      await save();
    }
    const candidates = [
      ...proof.raw.filter(row => row.service && !row.result && !row.transport),
      ...proof.services.filter(row => row.handle && !row.result),
    ];
    for (const candidate of candidates) {
      const handle = candidate.service || candidate.handle, name = candidate.name;
      try {
        proof.challenges = [];
        let previousTick = 0n;
        for (let i = 0; i < 2; i++) {
          const nonce = crypto.randomBytes(8);
          const row = {nonce: nonce.toString('hex')};
          proof.challenges.push(row); await save();
          const data = await challenge(session, handle, nonce, pid);
          row.threadId = data.readBigUInt64LE(24).toString();
          row.tick = data.readBigUInt64LE(32).toString();
          row.registration = data.subarray(40, 48).toString('hex');
          check(BigInt(row.tick) > previousTick, 'The app-space native tick did not advance');
          previousTick = BigInt(row.tick);
          row.verified = true; await save();
        }
        proof.name = name; proof.handle = handle; proof.verified = true;
        proof.completed = new Date().toISOString(); await save();
        await session.close(handle);
        return {file, verified: true, pid, challenges: proof.challenges.length,
          completed: proof.completed, service: name, app: true,
          services: proof.services, raw: proof.raw};
      } catch (error) {
        proof.attempts.push({name, handle, error: error.message}); await save();
      }
    }
    check(false, 'The game cannot reach an RO service (see services/raw)');
  } catch (error) {
    proof.error = error.stack; await save();
    error.proofFile = file;
    error.services = proof.services;
    error.raw = proof.raw;
    throw error;
  } finally {
    if (await session.ready()) await session.cleanup();
  }
}
module.exports = {main};
