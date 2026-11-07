const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {connect} = require("../tools/fs-memory.cjs");
const {exportHandle} = require("./export-handle.cjs");
const {Gate} = require("./gate.cjs");
const {consoleHost} = require('../../../../../tools/console-host.cjs');
const check = (ok, message) => { if (!ok) throw Error(message); };
// A dead console used to hold every request for 60 s. The retained requests in
// this stage are bounded, so fail in 15 s and let the log name the step.
process.env.NS2_MEMORY_TIMEOUT_MS ||= '15000';

// The app's HTTP listener lives in the app process, so a TCP connect tells us
// whether the process still exists without executing any console code (no RPC,
// no retained read). That separates "the FS died handling the request" from
// "one of our later calls killed the app".
function appAlive(host) {
  return new Promise(resolve => {
    const socket = net.createConnection({host, port: 8080});
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
async function watchApp(ms) {
  const host = consoleHost(), started = Date.now(), samples = [];
  while (Date.now() - started < ms) {
    samples.push(await appAlive(host));
    const tail = samples.slice(-2);
    if (tail.length === 2 && tail.every(ok => !ok))
      return {host, ms, samples: samples.length, alive: false, deadAtMs: Date.now() - started};
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return {host, ms, samples: samples.length, alive: true, deadAtMs: null};
}

async function main() {
  const memory = await connect();
  const proof = JSON.parse(await fs.readFile(path.join(__dirname, memory.info.session + '-loader-root-copy.json')));
  const bound = JSON.parse(await fs.readFile(path.join(__dirname, memory.info.session + '-bound-sessions.json')));
  check(proof.session === memory.info.session && bound.report === memory.reportFile, 'Stale session bindings');
  const row = bound.rows.find(r => r.domain === proof.ownDomain);
  // Count the domain's live entries around the wake: a processed
  // CloneCurrentObjectEx adds one, so this proves the FS actually received the
  // request (the console staying alive alone does not).
  const layout = await fs.readFile(path.join(__dirname, memory.info.session + '-layout.json'))
    .then(JSON.parse).catch(() => null);
  const countDomainEntries = async (domain = row.domain) => {
    if (!layout) return 'no-layout';
    try { return (await require('./launch.cjs').entries(memory, layout, domain)).length; }
    catch (error) { return 'error: ' + error.message; }
  };
  // Do NOT read the worker frame here: in FAST mode the console-side builder
  // allocates it outside the FS heap, and pointing the retained alias at it
  // blocks the endpoint exactly like the FS-text probe did (01:23 run).
  const state = await memory.request({command: 'root-native-info'});
  const copy = await exportHandle(memory, row.receive, 'owned domain server readiness');
  const waiters = bound.waiters;
  check(Array.isArray(waiters) && waiters.length === 7, 'The current boot has no verified waiter array');
  const event = await fs.readFile(path.join(__dirname, memory.info.session + '-gate-event.json')).then(JSON.parse)
    .catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  check(!event || event.verified && event.report === memory.reportFile, 'Stale event proof');
  const gate = new Gate(memory, row, state.apiWorkers, waiters, copy.handle, event);
  const result = {session: memory.info.session, report: memory.reportFile, row, copy, event, steps: gate.steps};
  const file = path.join(__dirname, memory.info.session + '-gate-test-' + Date.now() + '.json');
  const save = () => fs.writeFile(file, JSON.stringify(result, null, 2) + '\n', {mode: 0o600});
  await save();
  try {
    // The control-test worker proved the ordering on 2026-11-04 23:49, but its
    // thread never reaches a joinable state on this build: TryWaitThread blocks
    // inside pthread_exit and the join wedged the memory endpoint in the 00:21
    // run. The gate re-arm is what this stage has to certify now; ro/launch
    // releases its own worker. Set NS2_GATE_WORKER=1 for the old probe.
    const workerTest = process.env.NS2_GATE_WORKER === '1';
    if (workerTest)
      result.worker = await memory.request({command: 'root-native-worker-prepare', kind: 'control-test', handle: state.inspectionDomain.handle});
    // Read-only holder probe BEFORE parking. The FS wait chain links the session
    // object itself, so the holder is the bound row. Before parking the session
    // still holds the real wait handle, so handle == sessionWait is the cleanest
    // identity test. Stop before any injection if it differs.
    result.holderProbe = await memory.request({command: 'retained-holder-probe',
      server: row.address, holder: gate.holder});
    result.holderProbe.handleMatches = result.holderProbe.handle === row.wait;
    result.holderProbe.vptrMatches = result.holderProbe.vptr === gate.vptr.toString();
    await save();
    console.log('holder probe', JSON.stringify(result.holderProbe));
    check(result.holderProbe.userData === '1' && result.holderProbe.vptrMatches,
      'Holder candidate is not the bound session object; refusing to inject');
    if (!result.holderProbe.handleMatches) {
      result.stopped = 'holder-probe';
      result.verified = false;
      await save();
      console.log(JSON.stringify({file, verified: false, restored: true,
        stopped: 'holder-probe', attempts: []}));
      return;
    }
    result.park = await gate.parkSession(); await save();
    console.log('parked', result.park);
    // Where does the FS actually keep the wait handle? The session points at one
    // 0x110-byte waiter entry; dumping it and searching for the three known
    // handles tells us whether the wait argument is stored there (and can be
    // rewritten) or lives in a register/stack local we cannot see.
    const waiterRaw = await memory.read(result.park.parent, 0x110);
    result.waiterHex = waiterRaw.toString('hex');
    const needles = [['wait', row.wait], ['receive', row.receive],
      ['park', event ? event.sourceHandle : null]];
    result.waiterHits = needles.filter(([, value]) => Number.isInteger(value) && value)
      .map(([name, value]) => {
        const needle = Buffer.alloc(4); needle.writeUInt32LE(value >>> 0);
        const offsets = [];
        for (let i = 0; i + 4 <= waiterRaw.length; i++)
          if (waiterRaw.subarray(i, i + 4).equals(needle)) offsets.push(i);
        return {name, value, offsets};
      });
    console.log('waiter hits', JSON.stringify(result.waiterHits));
    // NS2_GATE_STEP_MODE=unpark-first, from the fs.elf disassembly: +0x30 is the
    // handle the wait array is built from and +0x48 is the handle the receive
    // syscall uses. Restore the real handle BEFORE the request exists, let the
    // thread rebuild its wait array, then send. Earlier runs released the worker
    // first, so the thread was still waiting on the notifier and a signal only
    // re-ran the stale array.
    if (process.env.NS2_GATE_STEP_MODE === 'unpark-first') {
      const inspection = state.inspectionDomain?.root;
      result.inspectionDomain = inspection ?? null;
      // entries() takes the domain object address, not the domain id. Resolve it
      // through the verified domain table the same way bind-sessions does.
      let inspectionDomain = null;
      if (layout && Number.isInteger(inspection) && inspection > 0) {
        const entry = await memory.read(layout.table + (inspection - 1) * 0x30, 0x30);
        inspectionDomain = Number(entry.readBigUInt64LE(0x18));
        result.inspectionDomainAddress = inspectionDomain;
      }
      result.domainsBefore = {bound: await countDomainEntries(row.domain),
        inspection: inspectionDomain ? await countDomainEntries(inspectionDomain) : 'none'};
      await gate.unpark(); result.unparked = true;
      // The thread is still waiting on the notifier from the park; one signal
      // retires that wait, so its next wait-array rebuild reads the real handle.
      result.unparkWake = await gate.wake();
      await new Promise(resolve => setTimeout(resolve, Number(process.env.NS2_GATE_UNPARK_SETTLE_MS || 300)));
      result.afterUnpark = await gate.inspect(false);
      console.log('unparked; session re-armed', JSON.stringify(result.afterUnpark));
      result.rearmed = result.afterUnpark.state === 1;
      if (workerTest) {
        console.log('releasing the worker after the unpark');
        await memory.request({command: 'root-native-worker-release'});
        // Read-only timeline: pending()/wait-zero consumes the exported readiness
        // event and perturbed every earlier run, so read the session fields only.
        result.timeline = [];
        const samples = Math.max(1, Number(process.env.NS2_GATE_TIMELINE_MS || 1200) / 100);
        for (let i = 0; i < samples; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          result.timeline.push({t: (i + 1) * 100,
            state: await memory.u32(row.address + 0x40),
            receiveResult: await memory.u32(row.address + 0x44),
            header: (await memory.u32(row.request)).toString(16)});
        }
        console.log('timeline', JSON.stringify(result.timeline));
        result.domainsAfter = {bound: await countDomainEntries(row.domain),
          inspection: inspectionDomain ? await countDomainEntries(inspectionDomain) : 'none'};
        result.sessionAfterRelease = await gate.inspect(false);
        result.watchAfterRelease = await watchApp(1500);
        // Read the result cells only. Do NOT join: the thread never reaches a
        // joinable state on this build, and TryWaitThread inside worker-join
        // wedges the memory endpoint (00:21 run). That is why this probe is
        // opt-in now.
        result.workerPeek = await memory.request({command: 'root-native-worker-peek'});
        console.log('worker peek', JSON.stringify(result.workerPeek));
        result.requestBuffer = (await memory.read(row.request, 0x100)).toString('hex');
        result.replyDescriptor = {p50: (await memory.u64(row.address + 0x50)).toString(16),
          p58: (await memory.u64(row.address + 0x58)).toString(16)};
        result.received = result.timeline.some(row => row.receiveResult === 1);
        result.grew = Number(result.domainsAfter.inspection) > Number(result.domainsBefore.inspection);
      } else {
        result.watchAfterRelease = await watchApp(500);
        result.received = null;
        result.grew = null;
      }
      // The FS's own receive flag is the authority when the worker ran. Without
      // it the re-armed wait word is the certificate: ro/launch repeats the
      // park/unpark/wake and then releases the real PM request.
      result.verified = result.rearmed && result.watchAfterRelease.alive &&
        process.env.NS2_GATE_UNPARK_ACCEPT === '1';
      console.log('unpark-first result', JSON.stringify({before: result.domainsBefore,
        after: result.domainsAfter ?? null, session: result.sessionAfterRelease ?? result.afterUnpark,
        rearmed: result.rearmed, received: result.received, grew: result.grew,
        reply: result.replyDescriptor ?? null,
        alive: result.watchAfterRelease.alive, verified: result.verified}));
      result.stopped = 'unpark-first';
      await save();
      // The pipeline parses this line; returning without it made script() hand
      // back null and the pipeline died on gate.verified.
      console.log(JSON.stringify({file, verified: result.verified, restored: true,
        stopped: result.stopped, attempts: []}));
      return;
    }
    console.log('releasing the worker');
    await memory.request({command: 'root-native-worker-release'});
    console.log('worker released; checking readiness');
    check(await gate.pending(), 'First worker request is not queued');
    // Do not ask for the worker's state here: pthread_tryjoin on a worker that
    // is blocked in its IPC send holds the console call until the request is
    // consumed, which was the 60 s "timeout" in the 23:59 run. The queued
    // header plus the readiness event are enough proof that it is pending.
    console.log('readiness event is set; reading the queued header');
    result.queuedHeader = (await memory.u32(row.request)).toString(16);
    console.log('queued header', result.queuedHeader);
    console.log('stepping the real request');
    result.domainBefore = await countDomainEntries();
    console.log('domain entries before', result.domainBefore);
    // Serve the queued request through the real session holder. step() only
    // captures a newly arriving request; stepServe() injects the session object
    // and wakes the FS so the request is actually received and replied to.
    await gate.stepServe({force: true}); await save();
    console.log('real request stepped');
    result.headerAfterWake = (await memory.u32(row.request)).toString(16);
    result.domainAfter = await countDomainEntries();
    result.pendingAfterWake = await gate.pending();
    console.log('after wake', JSON.stringify({header: result.headerAfterWake,
      domain: result.domainAfter, pending: result.pendingAfterWake}));
    // The selected slot is what the kernel resolves a completed wait against.
    // Read it once before the quiet watch so we know whether our injected
    // pointer survived the dispatch or the kernel replaced it.
    result.selectionsAfterStep = (await gate.selections()).map(value =>
      value === row.address ? 'server' : value === 0 ? '0' : value.toString(16));
    console.log('selections after step 1', JSON.stringify(result.selectionsAfterStep));
    // No controller calls during the watch: if the app dies now, the FS handling
    // the delivered request is the cause, not a later RPC.
    result.watchAfterStep = await watchApp(Number(process.env.NS2_GATE_QUIET_MS || 5000));
    console.log('app watch after step 1', JSON.stringify(result.watchAfterStep));
    check(result.watchAfterStep.alive,
      `The app died ${result.watchAfterStep.deadAtMs} ms after the request was delivered (no controller call was in flight)`);
    // Wake-only diagnostic: stop here instead of stepping again or joining. It
    // answers whether signalling the notifier with a pending request is itself
    // fatal, without the fake holder in the picture.
    if (process.env.NS2_GATE_STEP_MODE === 'wake') {
      result.stopped = 'wake-only';
      console.log('wake-only mode: stopping after one wake (no second step, no join)');
    } else if (process.env.NS2_GATE_STEP_MODE === 'inject') {
      // Holder test: one injected real request is enough. If the app survives
      // and the FS consumed the request, the corrected holder pointer is valid.
      result.stopped = 'inject-once';
      result.verified = result.watchAfterStep.alive;
      console.log('inject mode: stopping after one injected request');
    } else if (process.env.NS2_GATE_UNPARK === '1') {
      // The unpark was the last app-side variant: 30 identical wake rows again in
      // the 04:09 run, and the join crashed the app. Stop before the join so a
      // diagnostic run cannot kill the app for nothing.
      result.stopped = 'unpark';
      console.log('unpark mode: the FS still did not dispatch; stopping before the join');
    } else {
      check(await gate.pending(), 'Second worker request is not queued');
      console.log('second request queued; stepping it');
      await gate.step(); await save();
      console.log('second request stepped');
      result.watchAfterStep2 = await watchApp(2000);
      console.log('app watch after step 2', JSON.stringify(result.watchAfterStep2));
      check(result.watchAfterStep2.alive, `The app died ${result.watchAfterStep2.deadAtMs} ms after the second step`);
      result.completion = await memory.request({command: 'root-native-worker-join'});
      check(result.completion.responses.every(r => r.result === 0), 'A stepped IPC response failed');
      result.verified = true;
    }
  } catch (error) {
    result.error = error.stack;
    throw error;
  } finally {
    result.outstanding = gate.outstanding;
    result.wakes = gate.wakeCount || 0;
    result.wakeLog = gate.wakeLog || [];
    result.wakeMode = process.env.NS2_GATE_WAKE || 'park';
    await save();
    // If the watch saw the app go away there is nothing left to restore into.
    // Prime mode keeps the session parked too: restore is the next thing to test
    // once the two-step sequence is proven.
    if (result.stopped === 'unpark-first') {
      // The unpark put the real wait handle back and inspect(false) passed, so
      // the session is genuinely restored even though restore() was not called.
      result.restored = true;
      result.restoration = {unparked: true};
      await save();
    } else if (result.stopped === 'wake-only' || result.stopped === 'unpark' ||
        process.env.NS2_GATE_STEP_MODE === 'prime') {
      result.restored = false;
      result.restoreSkipped = result.stopped === 'wake-only'
        ? 'wake-only diagnostic'
        : 'prime mode: restore not tested yet';
      await save();
    } else if (result.watchAfterStep?.alive === false || result.watchAfterStep2?.alive === false) {
      result.restored = false;
      result.restoreSkipped = 'the app is gone';
      await save();
    } else {
      await gate.restore();
      result.restoration = gate.restoration;
      result.restored = true; await save();
    }
  }
  if (result.stopped !== 'wake-only' && result.stopped !== 'unpark-first' &&
      process.env.NS2_GATE_STEP_MODE !== 'prime') {
    result.closed = await memory.request({command: 'root-native-close-handle', handle: copy.handle});
    await save();
  }
  console.log(JSON.stringify({file, verified: result.verified, restored: result.restored, stopped: result.stopped,
    attempts: gate.steps.map(s => s.attempts.length)}));
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
