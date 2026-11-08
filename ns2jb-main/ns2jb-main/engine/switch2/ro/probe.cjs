// Two fresh challenges, attributed to the server by the kernel's PID descriptor.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {connect} = require("../tools/fs-memory.cjs");
const {smCanary} = require("./canary.cjs");
const {exportHandle} = require("./export-handle.cjs");
const check = (ok, message) => { if (!ok) throw Error(message); };

async function main(pid) {
  check(typeof pid === 'string' && /^\d+$/.test(pid), 'Expected the accepted RO process ID');
  const name = 'ro:dmnt';
  const memory = await connect();
  const state = await memory.request({command: 'root-native-info'});
  const proof = {session: memory.info.session, report: memory.reportFile, pid, name,
    started: new Date().toISOString(), challenges: [], verified: false};
  const file = path.join(__dirname, memory.info.session + '-execution-proof-' + Date.now() + '.json');
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
  let handle = smClient;
  try {
    check(smClient, 'The borrowed FS SM client is missing');
    proof.aliveBefore = await liveness(); await save();
    // The FS SM client object at sdk+0x12a0 is the authoritative liveness
    // check: only the FS owns it, so a changed header means the FS is gone or
    // re-initialized. The app's duplicate handle can die on its own.
    const smProof = JSON.parse(await fs.readFile(
      path.join(__dirname, memory.info.session + '-sm-proof.json')));
    proof.smSourceHandle = smProof.sourceHandle;
    proof.smAddress = smProof.address;
    try {
      const header = await memory.read(smProof.address - 8, 24);
      proof.fsSm = {
        self: await memory.pointer(smProof.address - 8) === smProof.address,
        tag: header.readUInt32LE(4),
        handle: header.readUInt32LE(8),
        zero: header.readUInt32LE(12) === 0,
        guard: header.readUInt16LE(16) === 0x101,
        sourceMatches: header.readUInt32LE(8) === smProof.sourceHandle,
      };
    } catch (failure) { proof.fsSmError = failure.message; }
    await save();
    proof.canaryBefore = await smCanary(memory, smClient, 'probe-before');
    handle = smClient;
    if (!proof.canaryBefore.ok) {
      // The app's duplicate may be closed while the FS's own handle is not:
      // duplicate the FS handle again through the notifier and re-test it.
      try {
        const fresh = await exportHandle(memory, smProof.sourceHandle, 'stage-4 SM re-export');
        proof.smReexport = {handle: fresh.handle, proof: fresh.proof};
        await save();
        proof.canaryFresh = await smCanary(memory, fresh.handle, 'probe-fresh');
        if (proof.canaryFresh.ok) handle = fresh.handle;
      } catch (failure) { proof.smReexportError = failure.message; }
      await save();
    }
    // The stock's ro:dmnt registration survives its process, so try the
    // payload's app-space ro:1 first (it is free and the FS may still resolve
    // it), then ro:dmnt. Each candidate gets its own lookup/challenge worker
    // areas; a settled thread must not be reused.
    const candidates = [
      {name: 'ro:1', space: 2, lookupArea: 0x240000, challengeArea: 0x1E0000},
      {name, lookupArea: 0x180000, challengeArea: 0xC0000},
    ];
    // The worker areas are all in use, so the space marshalling form is chosen
    // per boot: NS2_SM_LAYOUT=space-first uses space at 8 / name at 12 (the
    // RegisterService/UnregisterService form), otherwise name at 8 / space at 16.
    const layout = process.env.NS2_SM_LAYOUT === 'space-first' ? 'space-first' : undefined;
    const attempts = [];
    for (const candidate of candidates) {
      const lookupRow = await worker({kind: 'sm-get', handle, name: candidate.name,
        space: candidate.space, layout}, candidate.lookupArea);
      const attempt = {name: candidate.name, lookup: lookupRow, challenges: []};
      attempts.push(attempt); proof.attempts = attempts; await save();
      const lookup = lookupRow.responses[0];
      if (lookup.transport || lookup.result || !lookup.handle) continue;
      let previousTick = 0n, verified = true;
      for (let i = 0; i < 2; i++) {
        const nonce = crypto.randomBytes(8);
        const row = {nonce: nonce.toString('hex')};
        attempt.challenges.push(row); await save();
        row.reply = await worker({kind: 'ro-probe', handle: lookup.handle, hex: row.nonce}, candidate.challengeArea);
        await save();
        const reply = row.reply.responses[0];
        if (reply.transport || reply.result || reply.kernelPid !== pid) { verified = false; break; }
        const data = Buffer.from(reply.data, 'hex');
        if (!(data.length >= 48 && data.readBigUInt64LE() === 0x4558454f5232534en &&
          data.readBigUInt64LE(8) === (nonce.readBigUInt64LE() ^ 0x9d7c3a51e6b2048fn) &&
          data.readBigUInt64LE(16) === BigInt(pid))) { verified = false; break; }
        row.threadId = data.readBigUInt64LE(24).toString();
        row.tick = data.readBigUInt64LE(32).toString();
        row.registration = data.subarray(40, 48).toString('hex');
        if (BigInt(row.tick) <= previousTick) { verified = false; break; }
        previousTick = BigInt(row.tick);
        row.verified = true; await save();
      }
      if (verified && attempt.challenges.length === 2) {
        proof.name = candidate.name; proof.handle = lookup.handle;
        proof.challenges = attempt.challenges; proof.verified = true;
        break;
      }
      await memory.request({command: 'root-native-close-handle', handle: lookup.handle});
      await save();
    }
    check(proof.verified, 'No RO service returned the native challenge');
    proof.completed = new Date().toISOString();
    await save();
    proof.closed = await memory.request({command: 'root-native-close-handle', handle: proof.handle});
    await save();
    return {file, verified: true, pid, challenges: proof.challenges.length, completed: proof.completed,
      service: proof.name};
  } catch (error) {
    try { proof.aliveAfter = await liveness(); } catch (failure) { proof.livenessError = failure.message; }
    if (handle) {
      try {
        proof.lookupAfter = await memory.request({command: 'root-native-sm-service', handle, name});
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
