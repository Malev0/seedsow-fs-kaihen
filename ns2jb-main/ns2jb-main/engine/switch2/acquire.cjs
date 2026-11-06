const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { a } = require('../shared/rpc.cjs');
const { request } = require('./tools/endpoint.cjs');
const { verifyProof } = require('./memory/verify-proof.cjs');
const { save, read } = require('./ro/runtime.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// The acquisition owns native allocations until retire() completes.
async function start() {
  // This is flaky right now, so run 3x for now. NS2_ACQUIRE_ATTEMPTS=1 lets a
  // caller retry only after checking that the console was left clean, because a
  // probe that retains resources (placementUncertain) must not be re-run on the
  // same boot.
  const MAX_ATTEMPTS = Number(process.env.NS2_ACQUIRE_ATTEMPTS || 3);
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; ++attempt) {
    const logFile = path.join(__dirname, 'acquisition.log');

    try {
      await fs.promises.unlink(logFile);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const log = fs.createWriteStream(logFile, { flags: 'wx', mode: 0o600 });
    await new Promise((resolve, reject) => { log.once('open', resolve); log.once('error', reject); });
    const probeFile = process.env.NS2_PROBE || path.join(__dirname, 'memory/probe-reserved-gap.cjs');
    const child = spawn(process.execPath, [probeFile],
      { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    let reportFile, exited, spawnError;
    child.once('error', error => { spawnError = error; });
    const done = new Promise(resolve => child.once('close', (code, signal) => {
      exited = { code, signal }; log.end(); resolve(exited);
    }));
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      let row;
      try { row = JSON.parse(line); } catch { return; }
      if (row.stage === 'connected') reportFile = row.file;
    });
    const abandon = async () => {
      if (!exited) child.kill('SIGKILL');
      await done;
    };
    try {
      const deadline = Date.now() + Number(process.env.NS2_ACQUIRE_TIMEOUT_MS || 45 * 60 * 1000);
      let report, recorded = false;
      for (; ;) {
        if (reportFile) {
          // The probe rewrites this file atomically; a transient Windows share
          // violation while it renames must not abort the acquisition.
          try {report = await read(reportFile);}
          catch (error) {
            if (!['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
          }
          if (!recorded) {
            // Keep the scratch owner discoverable even if acquisition later fails.
            await save(path.join(__dirname, 'current-acquisition.json'), { session: a.session, report: reportFile });
            recorded = true;
          }
        }
        if (report?.memoryControl?.ready) break;
        if (exited || spawnError || Date.now() >= deadline)
          throw Error('FS acquisition did not complete. Inspect ' + logFile + '; restart the console before another launch.');
        await delay(500);
      }
      if (report.session !== a.session || report.error || report.cleanupError)
        throw Error('FS acquisition has an error or belongs to another session');
      const proof = await verifyProof(reportFile, a.session);
      const supervisorReport = path.join(__dirname, 'acquisition-supervisor.json');
      await save(supervisorReport, { stage: 'memory-ready', attempts: [{ report: reportFile }] });
      const current = {
        session: a.session, report: reportFile, supervisorReport,
        socketPath: report.memoryControl.socketPath, proof, finished: new Date().toISOString()
      };
      await save(path.join(__dirname, 'current-acquisition.json'), current);
      return {
        ...current, abandon,
        async retire() {
          const latest = await read(reportFile);
          const retained = latest.retainedMemory;
          if (!latest.memoryControl?.ready || latest.placementUncertain || retained?.pending ||
            latest.memoryControl.pending || latest.retained.threads.length ||
            retained?.promoted && (!retained.ready || !retained.canonical || !retained.zeroCountVerified))
            throw Error('The retained endpoint cannot be retired from its current state');
          const state = latest.nativeRo;
          if (state?.worker && !state.worker.joined) throw Error('A native worker is still pending');
          // A failed stage-3 read can leave the endpoint busy for a while; a
          // retire that gives up after 3 s leaves the poisoned cache entry
          // installed, which is what makes the app (and the console UI) hang.
          const result = await request(current.socketPath, { command: 'retire' }, 120000, 120000);
          if (!result.retired && !result.retiring) throw Error('The retained endpoint did not retire');
          const deadline = Date.now() + 60000;
          while (!exited && Date.now() < deadline) await delay(100);
          if (!exited) throw Error('FS cleanup timed out; inspect ' + reportFile);
          const final = await read(reportFile);
          if (exited.code !== 0 || !final.cleanedUp || final.cleanupError)
            throw Error('FS resources did not clean up completely; inspect ' + reportFile);
          return { cleanedUp: true, report: reportFile };
        },
      };
    } catch (error) { await abandon(); lastError = error; }
    if (attempt < MAX_ATTEMPTS - 1) await delay(1000);
  }
  throw lastError;
}

module.exports = { start };
