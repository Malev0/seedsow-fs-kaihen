// Two fresh challenges, attributed to the server by the kernel's PID descriptor.
const fs = require('node:fs/promises');
const path = require('node:path');
const {artifactDir} = require('../../shared/paths.cjs');
const OUT = artifactDir(__dirname);
const crypto = require('node:crypto');
const {connect} = require("../tools/fs-memory.cjs");
const check = (ok, message) => { if (!ok) throw Error(message); };

async function main(pid) {
  check(typeof pid === 'string' && /^\d+$/.test(pid), 'Expected the accepted RO process ID');
  const name = 'ro:dmnt';
  const memory = await connect();
  const state = await memory.request({command: 'root-native-info'});
  const proof = {session: memory.info.session, report: memory.reportFile, pid, name,
    started: new Date().toISOString(), challenges: [], verified: false};
  const file = path.join(OUT, memory.info.session + '-execution-proof-' + Date.now() + '.json');
  const save = () => fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  await save();
  async function worker(request, areaOffset) {
    await memory.request({command: 'root-native-worker-prepare', ...request, areaOffset});
    await memory.request({command: 'root-native-worker-release'});
    const until = Date.now() + 4000;
    for (;;) {
      // TryWaitThread blocks inside pthread_exit on this build, so derive
      // completion from the stored result cells and settle instead of joining.
      // A settled thread keeps its stack, so each probe worker gets its own
      // area (0x180000 / 0x1E0000; test-gate uses 0x60000, launch 0x100000 and
      // 0x2A0000; area 0 stays free for the stage-4 join workers).
      const values = await memory.request({command: 'root-native-worker-values'});
      if (values.values.every(value => value !== values.sentinel))
        return memory.request({command: 'root-native-worker-settle'});
      check(Date.now() < until, 'Proof worker remains pending; preserved without issuing another synchronous IPC');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const monitor = state.services.find(s => s.name === 'pm:dmnt')?.handle;
  const smClient = state.services.find(s => s.name === 'pm:shell')?.sm;
  const liveness = async () => {
    if (!monitor) return {error: 'The owned PM monitor is missing'};
    const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(pid));
    return memory.request({command: 'root-native-ipc', handle: monitor, id: 7, hex: bytes.toString('hex')});
  };
  try {
    let handle = smClient;
    check(handle, 'The borrowed FS SM client is missing');
    proof.aliveBefore = await liveness(); await save();
    // If the app-side duplicate SM handle is closed but the FS's own client is
    // alive, re-export the FS source handle and use the fresh duplicate.
    try {
      const smProof = JSON.parse(await fs.readFile(
        path.join(OUT, memory.info.session + '-sm-proof.json')));
      proof.smSourceHandle = smProof.sourceHandle;
      const canary = async value => {
        const reply = await memory.request({command: 'root-native-sm-service', handle: value, name: 'pm:shell'});
        for (const moved of reply.moves || [])
          await memory.request({command: 'root-native-close-handle', handle: moved});
        return reply;
      };
      const before = await canary(handle);
      proof.canaryBefore = {transport: before.transport, result: before.result};
      if (before.transport === 0xf601 || before.result) {
        const fresh = await require('./export-handle.cjs').exportHandle(memory, smProof.sourceHandle,
          'stage-4 SM re-export');
        proof.smReexport = {handle: fresh.handle, proof: fresh.proof};
        handle = fresh.handle;
        const after = await canary(handle);
        proof.canaryFresh = {transport: after.transport, result: after.result};
      }
      await save();
    } catch (failure) { proof.smCanaryError = failure.message; await save(); }
    // Fresh space-1 names: the stock RO never registered these, so the SM has
    // no dead tombstone and its first match is the payload's live port. The FS
    // raw GetService (cmd 0x11) does not enforce its NPDM list, and all of these
    // are in that list anyway. One worker area per name: the GetService and the
    // two challenges run in a single chain, so the session handle is read
    // straight out of the GetService reply (no cross-worker handle).
    const candidates = require('./fresh-names.cjs');
    const areas = [0x240000, 0x1E0000, 0x180000, 0x120000, 0x0C0000];
    const attempts = [];
    for (const [index, candidateName] of candidates.entries()) {
      const nonce1 = crypto.randomBytes(8), nonce2 = crypto.randomBytes(8);
      const row = await worker({kind: 'ro-raw-probe', handle, name: candidateName,
        hex: nonce1.toString('hex'), hex2: nonce2.toString('hex')}, areas[index]);
      const attempt = {name: candidateName, lookup: row.responses[0], challenges: [
        {nonce: nonce1.toString('hex'), reply: row.responses[1]},
        {nonce: nonce2.toString('hex'), reply: row.responses[2]},
      ]};
      attempts.push(attempt); proof.attempts = attempts; await save();
      const lookup = attempt.lookup;
      if (!lookup || lookup.transport || lookup.result || !lookup.handle) continue;
      let previousTick = 0n, verified = true;
      for (const challenge of attempt.challenges) {
        const reply = challenge.reply;
        if (!reply || reply.transport || reply.result ||
          (reply.kernelPid !== null && reply.kernelPid !== pid)) { verified = false; break; }
        const nonce = Buffer.from(challenge.nonce, 'hex');
        const data = Buffer.from(reply.data, 'hex');
        if (!(data.length >= 48 && data.readBigUInt64LE() === 0x4558454f5232534en &&
          data.readBigUInt64LE(8) === (nonce.readBigUInt64LE() ^ 0x9d7c3a51e6b2048fn) &&
          data.readBigUInt64LE(16) === BigInt(pid))) { verified = false; break; }
        challenge.threadId = data.readBigUInt64LE(24).toString();
        challenge.tick = data.readBigUInt64LE(32).toString();
        challenge.registration = data.subarray(40, 48).toString('hex');
        if (BigInt(challenge.tick) <= previousTick) { verified = false; break; }
        previousTick = BigInt(challenge.tick);
        challenge.verified = true; await save();
      }
      if (verified && attempt.challenges.every(challenge => challenge.verified)) {
        proof.name = candidateName; proof.handle = lookup.handle;
        proof.challenges = attempt.challenges; proof.verified = true;
        break;
      }
      await memory.request({command: 'root-native-close-handle', handle: lookup.handle});
      await save();
    }
    check(proof.verified, 'No RO service returned the native challenge');
    proof.completed = new Date().toISOString();
    await save();
    if (proof.handle)
      proof.closed = await memory.request({command: 'root-native-close-handle', handle: proof.handle});
    await save();
    return {file, verified: true, pid, challenges: proof.challenges.length, completed: proof.completed,
      service: proof.name};
  } catch (error) {
    try { proof.aliveAfter = await liveness(); } catch (failure) { proof.livenessError = failure.message; }
    if (smClient) {
      try {
        proof.lookupAfter = await memory.request({command: 'root-native-sm-service', handle: smClient, name});
      } catch (failure) { proof.lookupAfterError = failure.message; }
    }
    proof.error = error.stack; await save();
    // The FS-side ro:dmnt is the stock's dead system-space port. The payload
    // also registers ro:1 in the application space; challenge that from the
    // game process, which is the only client that can see space 2.
    try {
      const app = await require('../app/probe-ro.cjs').main(pid);
      proof.app = app;
      proof.verified = true; proof.completed = app.completed; proof.name = app.service;
      await save();
      return {file, verified: true, pid, challenges: app.challenges, completed: app.completed,
        service: app.service, app: true};
    } catch (appError) {
      proof.appError = appError.stack; proof.appServices = appError.services; await save();
    }
    error.proofFile = file;
    throw error;
  }
}
module.exports = {main};
