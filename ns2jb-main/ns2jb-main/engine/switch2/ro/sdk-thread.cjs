// Run a mapped NRO entry on an SDK-created thread, then join before unloading.
const {live, check} = require('../app/session.cjs');
const {code} = require('../app/worker.cjs');

async function execute(session, entry, record, save, config = {}) {
  for (const name of ['create', 'join', 'tryWait', 'tryWaitImplementation']) {
    await session.verifyCode(code[name], name);
  }
  const slots = session.base + 0x6000;
  const returnSlot = slots + 8;
  const statusSlot = slots + 16;
  await session.write(slots, Buffer.alloc(48));
  if (config.prepare) await config.prepare(session, statusSlot);
  record.pendingThread = 'create';
  await save();
  session.threads.add('creating');
  record.createResult = await session.rpc.call4(live.sdk + code.create.offset,
    slots, 0, entry, statusSlot);
  check(!record.createResult, 'pthread_create failed: ' + record.createResult);
  // Progress mode never needs the thread pointer: it is only used by
  // TryWaitThread/pthread_join, and reading it right after create races a module
  // that is already deep in FS work (2026-11-14 19:31: the 8-byte read blocked
  // for 120 s while the bootstrap parked the Loader). Read it only for the
  // try-wait path below.
  const progressMode = Boolean(config.progress);
  let thread = null;
  if (!progressMode) thread = Number((await session.readOwned(slots, 8)).readBigUInt64LE());
  session.threads.delete('creating');
  if (thread !== null) session.threads.add(thread);
  record.thread = thread;
  record.pendingThread = 'wait';
  await save();

  const deadline = Date.now() + (config.waitMs ?? 15000);
  // Progress mode: poll the module's own result block instead of calling
  // TryWaitThread. On this build TryWaitThread blocks while the target thread
  // is inside an IPC send (and again in pthread_exit), which strands the host
  // RPC -- and the app's HTTP listener -- for as long as the mapped module
  // runs. The module publishes its current operation into that block as it
  // goes, so polling it both reports progress and leaves the last reached step
  // on disk if the app disappears.
  const progress = typeof config.progress === 'function' ? config.progress(session) : config.progress || null;
  if (progress) {
    // `address` is the arguments block; `offset` is the output struct inside it
    // (BootstrapArgs.output at +408). Reading the wrong field is how a previous
    // run recorded the retained candidate handle as the operation.
    const block = progress.address + (progress.offset || 0);
    let lastOperation = -1, lastResult = null, terminal = false, samples = 0, readErrors = 0;
    // The module parks the Loader and drives the FS itself, which can hold the
    // app's RPC for seconds. Give it a head start and treat a failed read as
    // "still busy" rather than fatal: a read that is already queued is served
    // when the app unblocks, so retrying costs nothing.
    const initialWait = Math.max(0, Number(progress.initialWaitMs ?? 0));
    if (initialWait) await new Promise(resolve => setTimeout(resolve, initialWait));
    while (Date.now() < deadline) {
      let out;
      try {
        out = await session.readOwned(block, 24, Number(progress.readTimeoutMs ?? 45000));
      } catch (error) {
        readErrors++;
        record.progressReadErrors = readErrors;
        record.progressError = error.message;
        await save();
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, progress.retryMs ?? 1000));
        continue;
      }
      samples++;
      const operation = out.readUInt32LE(0), result = out.readInt32LE(4);
      if (operation !== lastOperation || result !== lastResult) {
        lastOperation = operation;
        lastResult = result;
        record.lastOperation = operation;
        record.lastResult = result;
        record.operationSamples = samples;
        await save();
      }
      if (progress.terminal(operation, result)) { terminal = true; break; }
      await new Promise(resolve => setTimeout(resolve, progress.pollMs ?? 250));
    }
    record.operationSamples = samples;
    await save();
    check(terminal, 'Mapped module did not reach a terminal operation (last 0x' +
      (lastOperation >>> 0).toString(16) + ', ' + readErrors + ' read errors' +
      (readErrors ? '; reads timed out, so the console RPC is blocked behind the module. ' +
        'If HOME still answers, the console is alive: restart the app from the GUI' : '') + ')');
    // Do not join: pthread_join blocks in pthread_exit here, and the module has
    // already published its final result. Give its last few instructions time
    // to retire before the caller unmaps the image.
    await new Promise(resolve => setTimeout(resolve, progress.settleMs ?? 500));
    if (thread !== null) session.threads.delete(thread);
    record.joined = true;
    record.threadLeftRunning = true;
    delete record.pendingThread;
    await save();
    if (config.verify) {
      await config.verify(session, progress.address, record);
      await save();
    }
    // A caller that recognises a deliberate stop (record.deferred) treats it as
    // a clean return so the module is unmapped normally.
    return record.deferred ? 0 : record.lastResult >>> 0;
  }

  let finished = false;
  while (Date.now() < deadline) {
    const state = await session.rpc.call3(live.sdk + code.tryWait.offset, thread, 0, 0);
    check(state === 0 || state === 1, 'Unexpected SDK thread state: ' + state);
    if (state === 1) {
      finished = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  check(finished, 'Thread has not exited; retain its mapped image and backing');
  record.pendingThread = 'join';
  await save();
  record.joinResult = await session.rpc.call3(live.sdk + code.join.offset, thread, returnSlot, 0);
  check(!record.joinResult, 'pthread_join failed: ' + record.joinResult);
  session.threads.delete(thread);
  record.joined = true;
  const returned = Number((await session.readOwned(returnSlot, 8)).readBigUInt64LE());
  delete record.pendingThread;
  await save();
  if (config.verify) {
    await config.verify(session, statusSlot, record);
    await save();
  }
  return returned;
}

module.exports = {execute};
