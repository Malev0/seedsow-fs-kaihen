// Start only the accepted RO image, then verify its native replies and cleanup.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {connect, encodeU64} = require("../tools/fs-memory.cjs");
const {directory, check, ptr, validate} = require("./layout.cjs");
const {main: probe} = require("./probe.cjs");
const acquisitionFile = path.join(__dirname, '../current-acquisition.json');
const executionFile = path.join(directory, 'current-execution.json');
// Reports are replaced atomically by their writer; on Windows a concurrent
// reader can briefly hit a share violation, so retry the open.
async function read(file) {
  for (let attempt = 0; ; attempt++) {
    try {return JSON.parse(await fs.readFile(file, 'utf8'));}
    catch (error) {
      // The probe truncates and rewrites its report, so a concurrent read can
      // observe an empty file (SyntaxError has no code). From remote-lua-sw2's
      // vendored copy: treat that as transient like a share violation.
      if (!(['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || error instanceof SyntaxError) ||
          attempt >= 40) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function save(file, value) {
  const temporary = file + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  // acquire.cjs polls reports while this process replaces them; Windows can
  // briefly hold the destination and fail the rename with a share violation.
  for (let attempt = 0; ; attempt++) {
    try {await fs.rename(temporary, file); return;}
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 40) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
const local = (session, suffix) => path.join(directory, session + suffix);

async function activate(launchFile) {
  const memory = await connect(), launch = await read(launchFile);
  check(launch.report === memory.reportFile && launch.session === memory.info.session &&
    launch.imageAccepted && launch.restored && (launch.flags === 0 || launch.flags === 0x10) &&
    /^\d+$/.test(launch.pid), 'The current boot has no accepted, stopped RO image');
  const state = await memory.request({command: 'root-native-info'});
  check(state.worker?.joined, 'The launch worker has not joined');
  const sm = await read(local(memory.info.session, '-sm-proof.json'));
  check(sm.report === memory.reportFile && !sm.program.result, 'The original RO identity is stale');
  const originalPid = Buffer.from(sm.program.hex, 'hex').readBigUInt64LE().toString();
  check(BigInt(originalPid) > 1n && BigInt(launch.pid) > 1n && originalPid !== launch.pid,
    'The original and replacement RO PIDs must be distinct');
  const shell = state.services.find(s => s.name === 'pm:shell')?.handle;
  const monitor = state.services.find(s => s.name === 'pm:dmnt')?.handle;
  check(shell && monitor, 'The owned PM sessions are missing');
  const proof = {session: memory.info.session, report: memory.reportFile, launch: launchFile,
    pid: launch.pid, originalPid, started: new Date().toISOString()};
  const file = local(memory.info.session, '-activation.json');
  const ipc = (handle, id, pid) => memory.request({command: 'root-native-ipc', handle, id,
    hex: encodeU64(BigInt(pid)).toString('hex')});
  await save(file, proof);
  for (const [name, pid] of [['identity', proof.pid], ['original', originalPid]]) {
    proof[name] = await ipc(monitor, 7, pid); await save(file, proof);
    check(!proof[name].result && Buffer.from(proof[name].hex, 'hex').readBigUInt64LE() === 0x0400000000000037n,
      'PM did not identify ' + name + ' as native RO');
  }
  // flags 0 launches normally: PM already started the process during the
  // launch, so calling pm:dmnt id 1 again is unnecessary (and dangerous on a
  // manipulated FS). Only the suspended launch needs the explicit start.
  if (launch.flags === 0x10) {
    // ro/launch now triggers the start inside the serve-gate window so the
    // mount can be observed and swapped. Reuse that start instead of calling
    // pm:dmnt id 1 a second time.
    if (launch.start && !launch.start.result) {
      proof.start = launch.start; proof.startReused = true; await save(file, proof);
    } else {
      proof.pending = 'start replacement'; await save(file, proof);
      proof.start = await ipc(monitor, 1, proof.pid); await save(file, proof);
      check(!proof.start.result, 'The accepted RO process did not start');
    }
  }
  proof.pending = 'terminate identified original'; await save(file, proof);
  proof.termination = await ipc(shell, 1, originalPid); await save(file, proof);
  check(!proof.termination.result, 'The original RO process did not release its services');
  delete proof.pending;
  proof.finished = new Date().toISOString(); await save(file, proof);
  return {file, pid: proof.pid, originalPid};
}

async function handoff() {
  const memory = await connect(), session = memory.info.session;
  const layout = await read(local(session, '-layout.json'));
  await validate(memory, layout);
  const bound = await read(local(session, '-bound-sessions.json'));
  check(bound.report === memory.reportFile, 'Session binding belongs to another boot');
  const row = bound.rows.find(r => r.domain === layout.target.domain);
  check(row, 'The Loader session is missing');
  const b = await memory.read(row.address, 0x88);
  check(ptr(b) === ptr(Buffer.from(row.raw, 'hex')) && ptr(b, 0x70) === row.domain &&
    ptr(b, 0x78) === row.metadata && ptr(b, 0x60) === row.request &&
    b.readUInt32LE(0x30) === row.receive && b.readUInt32LE(0x48) === row.receive &&
    b.readUInt32LE(0x40) === 1 && bound.waiters.includes(ptr(b, 0x28)),
  'Loader has not returned to its original idle receive session');
  const state = await memory.request({command: 'root-native-info'});
  check(state.worker?.joined, 'A native proof worker remains active');
  const result = {session, report: memory.reportFile, at: new Date().toISOString(),
    fsReady: memory.info.ready, corruptionCount: memory.info.corruptionCount,
    loader: {address: row.address, wait: row.receive, receive: row.receive, state: 1}, workerJoined: true};
  const file = local(session, '-handoff.json'); await save(file, result);
  return {file, ...result};
}

module.exports = {directory, acquisitionFile, executionFile, read, save, hash, local, activate, handoff, probe};
