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

async function activate(launchFile, memoryOverride = null) {
  // Post-start /main redirect: the watcher and activation must share one Memory
  // client. Two clients race the retained endpoint while the resumed Loader is
  // emitting its real open requests, and the gate steps interleave badly.
  const memory = memoryOverride || await connect(), launch = await read(launchFile);
  // restoreSkipped means the stale close was left queued and the Loader session
  // parked on purpose (serving or restoring it faults the console). The launch
  // itself is valid: the Loader read the main image on its other FS session.
  check(launch.report === memory.reportFile && launch.session === memory.info.session &&
    launch.imageAccepted && (launch.restored || launch.restoreSkipped) &&
    (launch.flags === 0 || launch.flags === 0x10) &&
    /^\d+$/.test(launch.pid), 'The current boot has no accepted, stopped RO image');
  const state = await memory.request({command: 'root-native-info'});
  check(state.worker?.joined, 'The launch worker has not joined');
  const sm = await read(local(memory.info.session, '-sm-proof.json'));
  check(sm.report === memory.reportFile && !sm.program.result, 'The original RO identity is stale');
  const smOriginalPid = Buffer.from(sm.program.hex, 'hex').readBigUInt64LE().toString();
  // NS2_LAUNCH_KILL_ORIGINAL terminates the stock RO before the replacement
  // starts; a second instance of the same system program is what faults the
  // console after the start. The launch proof records that termination, so the
  // stock RO is already gone here: skip the identity and termination steps
  // that assume it is still alive.
  const preTerminated = Boolean(launch.originalTermination && launch.originalPid);
  const originalPid = preTerminated ? String(launch.originalPid) : smOriginalPid;
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
  const identities = preTerminated ? [['identity', proof.pid]]
    : [['identity', proof.pid], ['original', originalPid]];
  for (const [name, pid] of identities) {
    proof[name] = await ipc(monitor, 7, pid); await save(file, proof);
    check(!proof[name].result && Buffer.from(proof[name].hex, 'hex').readBigUInt64LE() === 0x0400000000000037n,
      'PM did not identify ' + name + ' as native RO');
  }
  if (preTerminated) {
    proof.originalPreTerminated = {pid: originalPid, launch: launch.originalTermination};
    // The stock RO is already gone; a nonzero GetProgramId is the expected proof.
    proof.originalGone = await ipc(monitor, 7, originalPid); await save(file, proof);
  }
  // The 2026-11-08 05:05 control proved the duplicate-`ro` case: with the stock
  // RO terminated *before* the replacement starts, the console survived
  // (`result:0`, pid 211); every run that starts the replacement while the
  // stock is alive faults right after the start, idle image included, so the
  // payload is exonerated. `NS2_STOCK_TERMINATE=pre` does that kill here.
  const mode = process.env.NS2_STOCK_TERMINATE || 'pre';
  check(['dmnt', 'shell', 'skip', 'pre'].includes(mode), 'Unsupported NS2_STOCK_TERMINATE');
  if (!preTerminated && mode === 'pre') {
    proof.pending = 'terminate original before start'; await save(file, proof);
    proof.preTermination = await ipc(shell, 1, originalPid);
    await save(file, proof);
    check(!proof.preTermination.result, 'The original RO process did not release its services');
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
      // pm:dmnt StartProcess blocks until the Loader finishes and has crashed
      // the console when called synchronously (04:19). Run it in a worker; with
      // NS2_DUMP_HOST set, use pm-start-dump so the PM reply is shipped to the
      // PC before the console can fault.
      const net = require('node:net');
      const dumpHost = process.env.NS2_DUMP_HOST || '';
      const dumpPort = Number(process.env.NS2_DUMP_PORT || 39401);
      let dumpEnabled = process.env.NS2_PM_START_DUMP !== '0' && !!dumpHost;
      const ipv4 = host => host.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
      let dumpServer = null, dumpData = null;
      if (dumpEnabled) {
        try {
          await new Promise((resolve, reject) => {
            dumpServer = net.createServer(socket => {
              const parts = [];
              socket.on('data', chunk => {
                parts.push(chunk);
                const bytes = Buffer.concat(parts);
                if (!dumpData && bytes.length >= 0x100) dumpData = bytes.subarray(0, 0x100).toString('hex');
              });
              socket.on('error', () => {});
            });
            dumpServer.once('error', reject);
            dumpServer.listen(dumpPort, '0.0.0.0', resolve);
          });
        } catch (error) {
          // A listener already on 39401 must not abort the start. Fall back to
          // the plain pm-start worker (values/settle) and record why.
          proof.startDumpError = error.message;
          if (dumpServer) { try { dumpServer.close(); } catch {} }
          dumpServer = null;
          dumpEnabled = false;
          await save(file, proof);
        }
      }
      proof.startWorker = await memory.request({command: 'root-native-worker-prepare',
        kind: dumpEnabled ? 'pm-start-dump' : 'pm-start',
        handle: monitor, pid: Number(proof.pid), port: dumpPort, pcAddress: ipv4(dumpHost)});
      await save(file, proof);
      await memory.request({command: 'root-native-worker-release'});
      const startDeadline = Date.now() + 180000;
      let values = null;
      while (Date.now() < startDeadline && !dumpData) {
        try { values = await memory.request({command: 'root-native-worker-values'}); }
        catch (error) {
          proof.startValuesError = error.message;
          // A crashed console leaves the endpoint busy; keep the dump if the
          // PM reply already reached the listener.
          if (dumpData) break;
          throw error;
        }
        if (values.values.every(value => value !== values.sentinel)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (dumpServer) dumpServer.close();
      let settled;
      // The dump is the authoritative result when the console faulted; do not
      // block another 60 s on worker-settle first.
      if (!dumpData) {
        try {
          settled = await memory.request({command: 'root-native-worker-settle'});
          proof.startSettled = settled;
        } catch (error) { proof.startSettleError = error.message; }
      }
      if (dumpData) {
        proof.start = {dumpHex: dumpData, note: 'pm-start-dump reply captured before the console fault'};
        // The `pre` order keeps the console alive, so finish the worker too:
        // pm-start-dump also sends a pm:dmnt id 7 query reply (second result
        // cell). Wait for both cells, then settle so handoff sees
        // `worker.joined`. If the console did fault, the poll times out and the
        // proof keeps the dump.
        const settleDeadline = Date.now() + Number(process.env.NS2_START_SETTLE_MS ?? 10000);
        try {
          let cells = null;
          while (Date.now() < settleDeadline) {
            cells = await memory.request({command: 'root-native-worker-values'});
            if (cells.values.every(value => value !== cells.sentinel)) break;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          check(cells && cells.values.every(value => value !== cells.sentinel),
            'The start worker did not store every result');
          proof.startSettled = await memory.request({command: 'root-native-worker-settle'});
        } catch (error) {
          proof.startSettleError = error.message;
        }
      } else if (settled) {
        proof.start = settled.responses?.[0] || settled;
        proof.startValues = settled.values;
        // Keep the pm:dmnt reply and the raw response page before validating:
        // a failed start used to throw here and discard the only evidence (the
        // 17:25 post-start run lost the result code this way).
        proof.startResponseFile = path.join(directory,
          path.basename(memory.reportFile, '.json') + '-ro-start-response.json');
        await save(proof.startResponseFile, {session: memory.info.session,
          report: memory.reportFile, captured: new Date().toISOString(),
          worker: proof.startWorker, settled});
        await save(file, proof);
        if (proof.start.result) {
          try { proof.exceptions = await memory.request({command: 'root-native-pm-exceptions'}); }
          catch (error) { proof.exceptionsError = error.message; }
          proof.finished = new Date().toISOString();
          await save(file, proof);
        }
        check(!proof.start.result, 'The accepted RO process did not start (pm:dmnt result 0x' +
          Number(proof.start.result ?? proof.start.canonicalResult ?? 0).toString(16) + '; see ' +
          proof.startResponseFile + ')');
      } else {
        proof.finished = new Date().toISOString();
        await save(file, proof);
        throw Error('The accepted RO process did not start (no dump or worker result)');
      }
      await save(file, proof);
    }
  }
  // A replacement that faults on its own before the termination call is the
  // other candidate for the post-start crash. pm:dmnt id 0 returns the
  // process-exception list (ro/control.cjs `pm-exceptions`); if the new pid is
  // in it, the frontend crashed, not the termination. Settle first so the
  // Loader has finished and the frontend has run its init/registration.
  // NS2_EXCEPTION_CHECK=0 skips the query (the `pre` control run keeps the
  // sequence down to kill -> start -> handoff).
  if (process.env.NS2_EXCEPTION_CHECK !== '0') {
    const exceptionSettleMs = Math.max(0, Number(process.env.NS2_EXCEPTION_SETTLE_MS ?? 1500));
    if (exceptionSettleMs) await new Promise(resolve => setTimeout(resolve, exceptionSettleMs));
    try {
      proof.exceptions = await memory.request({command: 'root-native-pm-exceptions'});
      proof.replacementCrashed = (proof.exceptions.pids || []).includes(String(proof.pid));
    } catch (error) {
      proof.exceptionsError = error.message;
    }
    await save(file, proof);
  }
  if (preTerminated || mode === 'pre') {
    proof.termination = preTerminated
      ? {preTerminated: true, pid: originalPid, launch: launch.originalTermination}
      : {preTerminated: true, pid: originalPid, mode, call: proof.preTermination};
    await save(file, proof);
  } else {
    // The stock RO is a system process. The dev runtime terminates it through
    // pm:shell id 1, but that call has crashed at this point on every run
    // (01:10/01:24/01:34/01:45). pm:dmnt id 2 is a guess at a debug-monitor
    // TerminateProcess; the kit only proves dmnt 1 = start and 7 = program id,
    // and 02:35 crashed at the same point, so id 2 is probably not a terminate
    // (Switch 1 dmnt id 2 is HookToCreateApplicationProcess). NS2_STOCK_TERMINATE
    // selects the path; `skip` leaves the stock alive and `pre` kills it before
    // the start (the 2026-11-08 05:05 proven order).
    proof.terminationMode = mode;
    proof.pending = 'terminate identified original (' + mode + ')';
    await save(file, proof);
    if (mode === 'skip') proof.termination = {skipped: true, pid: originalPid, mode};
    else if (mode === 'shell') proof.termination = await ipc(shell, 1, originalPid);
    else proof.termination = await ipc(monitor, 2, originalPid);
    await save(file, proof);
    check(proof.termination.skipped || !proof.termination.result,
      'The original RO process did not release its services');
  }
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
  // A launch that skipped restore leaves the session parked on our notifier
  // with the stale close still queued. The receive handle, parent and state are
  // unchanged; only +0x30 differs, so treat that as the expected parked state.
  const parked = b.readUInt32LE(0x30) !== row.receive;
  check(ptr(b) === ptr(Buffer.from(row.raw, 'hex')) && ptr(b, 0x70) === row.domain &&
    ptr(b, 0x78) === row.metadata && ptr(b, 0x60) === row.request &&
    (parked || b.readUInt32LE(0x30) === row.receive) &&
    b.readUInt32LE(0x48) === row.receive &&
    b.readUInt32LE(0x40) === 1 && bound.waiters.includes(ptr(b, 0x28)),
  'Loader session changed or is not parked');
  const state = await memory.request({command: 'root-native-info'});
  check(state.worker?.joined, 'A native proof worker remains active');
  const result = {session, report: memory.reportFile, at: new Date().toISOString(),
    fsReady: memory.info.ready, corruptionCount: memory.info.corruptionCount, parked,
    loader: {address: row.address, wait: b.readUInt32LE(0x30), receive: row.receive, state: 1},
    workerJoined: true};
  const file = local(session, '-handoff.json'); await save(file, result);
  return {file, ...result};
}

module.exports = {directory, acquisitionFile, executionFile, read, save, hash, local, activate, handoff, probe};
