const {runPath, statePath} = require('../../shared/paths.cjs');
// Start clean OunceHEN through the mapped native bootstrap.
const fs = require('node:fs');
const path = require('node:path');
const frontend = require('./nro.cjs');
const thread = require('./sdk-thread.cjs');
const {check, live} = require('../app/session.cjs');
const {connect} = require('../tools/fs-memory.cjs');
const {exportHandle} = require('./export-handle.cjs');
const {code: sdkThread} = require('../app/worker.cjs');

// The bootstrap creates its migration-title launch on a worker thread with
// BootstrapInput.pthread_create, then waits for it with pthread_trywait while
// the module itself serves the mount. Where the game's pthread_t is
// ThreadType | 7 (Civ 7 does this; the tag is per-game), that wait never reports
// the exit, so the mount is never served and PM blocks -- the module stopped at
// BootstrapOperation_Launch on 2026-11-14 20:24 for exactly that reason.
//
// Masking a 3-bit tag is harmless for an untagged pointer, so the adapter is
// always installed rather than detected:
//   and x0, x0, #~7 ; ldr x16, 0x10 ; br x16 ; nop ; .quad TryWaitThread
// create/join stay the SDK's own functions: they are what produced the
// (possibly tagged) pthread_t in the first place.
const TryWaitAdapterWords = [0x927df000, 0x58000070, 0xd61f0200, 0xd503201f];

function tryWaitAdapter(tryWait) {
  const bytes = Buffer.alloc(24);
  TryWaitAdapterWords.forEach((word, index) => bytes.writeUInt32LE(word >>> 0, index * 4));
  bytes.writeBigUInt64LE(BigInt(tryWait), 16);
  return bytes;
}

// Ask the acquisition supervisor to retire through the socket recorded in
// current-acquisition.json. Best effort: a console that has already stopped
// answering must not turn a completed HEN start into a failure.
async function retireEndpoint() {
  try {
    const current = JSON.parse(fs.readFileSync(statePath('current-acquisition.json'), 'utf8'));
    const reply = await require('../tools/endpoint.cjs')
      .request(current.socketPath, {command: 'retire'}, 30000, 3000);
    // The endpoint answers `retiring` *before* it runs its cleanup, and that
    // cleanup (close 42 handles, free the allocation, remove the scratch) needs
    // the console. Returning here and letting the caller detach the console RPC
    // loop killed exactly that cleanup in switch-tNBR5
    // ("console RPC listener is not running: connect timeout", cleanedUp false,
    // 42 handles still open) - a half-retired endpoint, which is what hangs the
    // app at close. Wait for cleanedUp in the report.
    const deadline = Date.now() + Math.max(0, Number(process.env.NS2_HEN_RETIRE_CLEANUP_MS || 60000));
    let report = null;
    while (Date.now() < deadline) {
      try { report = JSON.parse(fs.readFileSync(current.report, 'utf8')); } catch {}
      if (report?.cleanedUp || report?.cleanupError) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return {reply, at: new Date().toISOString(), cleanedUp: Boolean(report?.cleanedUp),
      // NS2_RETIRE_LEAK leaves the teardown undone on purpose, so cleanedUp is
      // false by construction; the caller must not read that as a failure.
      cleanupSkipped: Boolean(report?.cleanupSkipped),
      cleanupError: report?.cleanupError ? String(report.cleanupError).split('\n')[0] : null};
  } catch (error) {
    return {error: error.message};
  }
}

function makeBootstrapImage(text) {
  check(text.length <= 0xff80, 'Native bootstrap exceeds text segment');
  const image = Buffer.alloc(0x12000);
  // Real NROs carry this 0x10-byte prefix before the NRO0 header; the stock
  // ldr:ro rejects an image with a zeroed prefix (0x1216).
  image.writeUInt32LE(0x14000020, 0x00);
  image.writeUInt32LE(0xf0, 0x04);
  image.write('HOMEBREW', 0x08);
  image.write('NRO0', 0x10);
  image.writeUInt32LE(image.length, 0x18);
  image.writeUInt32LE(0x10000, 0x24);
  image.writeUInt32LE(0x10000, 0x28);
  image.writeUInt32LE(0x1000, 0x2c);
  image.writeUInt32LE(0x11000, 0x30);
  image.writeUInt32LE(0x1000, 0x34);
  image.writeUInt32LE(0x1000, 0x38);
  text.copy(image, 0x80);
  return image;
}

async function main(imagePath, bootstrapPath, gameMainPath, programs = []) {
  let text = fs.readFileSync(bootstrapPath);
  // Append the try-wait adapter right after the bootstrap text (16-byte aligned)
  // and point the bootstrap's pthread_trywait slot at it below.
  const adapterOffset = (text.length + 15) & ~15;
  text = Buffer.concat([text, Buffer.alloc(adapterOffset - text.length),
    tryWaitAdapter(live.sdk + sdkThread.tryWait.offset)]);
  check(text.length <= 0xff80, 'Bootstrap plus adapter exceeds the text segment');
  const memory = await connect();
  const read = suffix => JSON.parse(fs.readFileSync(runPath('switch2', 'ro', live.session + suffix)));
  const bound = read('-bound-sessions.json');
  const root = read('-loader-root-copy.json');
  const layout = read('-layout.json');
  const event = read('-gate-event.json');
  const row = bound.rows.find(item => item.domain === root.targetDomain);
  const state = await memory.request({command: 'root-native-info'});
  check(state.worker?.joined && state.donor?.ready && row, 'Current setup is not idle');
  const shell = state.services.find(item => item.name === 'pm:shell');
  const monitor = state.services.find(item => item.name === 'pm:dmnt');
  check(shell && monitor, 'Required PM sessions are missing');
  check(state.notifiers.length === 1, 'Owned FS notifier is missing');
  check(state.apiWorkers?.length === 7, 'kaiHEN needs the seven retained FS workers');
  const exported = await exportHandle(memory, row.receive, 'Native launch Loader readiness');
  const fsProcess = await exportHandle(memory, 0xffff8001, 'Native RO reader FS process');
  const current = JSON.parse(fs.readFileSync(statePath('current-acquisition.json')));
  const report = JSON.parse(fs.readFileSync(current.report));
  const channel = report.retainedMemory;
  const args = Buffer.alloc(432);
  args.writeUInt32LE(report.retained.candidateHandle, 0);
  args.writeBigInt64LE(BigInt(channel.dataOffset), 8);
  args.writeBigInt64LE(BigInt(channel.dataEntryOffset + 0x20), 16);
  const gate = [row.address, Number(Buffer.from(row.raw, 'hex').readBigUInt64LE()),
    row.domain, row.metadata, row.request, ...bound.waiters];
  gate.forEach((value, index) => args.writeBigUInt64LE(BigInt(value), 24 + index * 8));
  // Pass the real FS API-worker KThread copies (exported by prepare-workers and
  // proven with GetThreadId). kaiHEN's gate cancels these threads with
  // svcCancelSynchronization, which is what retires an injected selection. A
  // boot whose export failed passes the owned FS notifier event instead: a 0
  // handle is rejected by HIPC COPY, while cancelling an event always fails,
  // which selects kaiHEN's notifier-wake fallback.
  state.apiWorkers.forEach((worker, index) =>
    args.writeUInt32LE(worker.handle || event.write, 120 + index * 4));
  [row.receive, row.wait, event.sourceHandle, exported.handle, event.read, event.write]
    .forEach((value, index) => args.writeUInt32LE(value, 148 + index * 4));
  const donor = read('-filesystem-types.json').rows.find(item => item.name === 'donor');
  const mount = [layout.table, root.targetDomain, (root.targetEntry - layout.table) / 0x30 + 1,
    donor.entry, donor.object, donor.metadata, donor.vptr, 0x040000000000003an];
  mount.forEach((value, index) => args.writeBigUInt64LE(BigInt(value), 176 + index * 8));
  args.writeUInt32LE(shell.handle, 240);
  args.writeBigUInt64LE(0x040000000000003an, 248);
  // 0x14 = kaiHEN's launch flags. Two diagnostic bits are masked off before the
  // flags reach pmshellLaunchProgram: NS2_SKIP_GAME_ARM=1 skips all of the
  // arming, =start keeps the config/handles but skips henStartGameArm.
  const skipArm = String(process.env.NS2_SKIP_GAME_ARM || '0');
  const armBits = skipArm === '1' ? 0x80000000 : skipArm === 'start' ? 0x40000000 : 0;
  args.writeUInt32LE((0x14 | armBits) >>> 0, 256);
  args.writeUInt8(3, 260);
  args.writeUInt32LE(monitor.handle, 244);
  // pthread_create / pthread_join are the SDK's own (they take the tagged
  // handle); pthread_trywait points at the adapter, which needs the mapped
  // entry address and so is written in execute().
  args.writeBigUInt64LE(BigInt(live.sdk + sdkThread.create.offset), 264);
  args.writeBigUInt64LE(BigInt(live.sdk + sdkThread.join.offset), 280);
  args.writeUInt32LE(shell.sm, 288);
  const acquisition = JSON.parse(fs.readFileSync(memory.reportFile));
  const fsRoot = acquisition.ownedRoot.clones[0];
  const packagePath = '@Sdcard:/kaihen/bin/hen/exefs.nsp';
  args.writeUInt32LE(fsRoot, 296);
  args.write(packagePath, 300, 'utf8');
  args.writeUInt32LE(fsProcess.handle, 396);
  args.writeUInt32LE(state.notifiers[0], 400);
  args.writeUInt32LE(root.copy.handle, 404);
  // Stage through the retained endpoint so the host does not need a second
  // FS session. kaiHEN's compiled bootstrap/HEN hardcode the /kaihen paths.
  const stage = (target, source) => memory.request({command: 'root-native-file-stage',
    root: fsRoot, target, source});
  let joined = false;
  try {
    let stagedMenu = null;
    if (process.env.HBMENU_NRO) {
      console.log('Staging hbmenu.nro');
      stagedMenu = await stage('/hbmenu.nro', process.env.HBMENU_NRO);
    }
    console.log('Staging game loader');
    const stagedGame = await stage('/kaihen/bin/game/main', gameMainPath);
    const stagedPrograms = [];
    for (const program of programs) {
      console.log(`Staging ${program.target}`);
      stagedPrograms.push(await stage(program.target, program.source));
    }
    console.log('Staging HEN');
    const staged = await stage('/kaihen/bin/hen/main', imagePath);
    const image = makeBootstrapImage(text);
    // On failure the catch below reopens both packages through the host, which
    // separates "our request is wrong" from "the written package is wrong".
    // Two phases when the bootstrap has to ask for the package mount. Phase 1
    // writes /kaihen/bin/hen/exefs.nsp and stops with StartupPackageDeferred;
    // the host then opens that package (this console rejects the bootstrap's own
    // FS cmd 10, the host's framing is proven) and phase 2 runs with the row.
    const DEFERRED = 0x0A5A;
    // Mode 0 (default): the bootstrap writes and opens the package itself.
    // Mode 1: the host builds, stages and opens it and hands the bootstrap the
    // mount row; that needs the host-row bootstrap at commit 55a6f57.
    const packageMode = String(process.env.NS2_HEN_HOST_PACKAGE ?? '0');
    if (packageMode === '1') {
      const row = await memory.request({command: 'root-native-file-package-row',
        root: fsRoot, kind: 'hen', build: true, loader: root.copy.handle,
        image: imagePath, title: '0x040000000000003a'});
      check(row.entry > 0 && row.object > 0 && row.metadata > 0 && row.vptr > 0,
        'HEN package row is incomplete');
      args.writeBigUInt64LE(BigInt(row.entry), 200);
      args.writeBigUInt64LE(BigInt(row.object), 208);
      args.writeBigUInt64LE(BigInt(row.metadata), 216);
      args.writeBigUInt64LE(BigInt(row.vptr), 224);
      console.log(JSON.stringify({stage: 'hen-package-mount', entry: row.entry,
        object: row.object, files: row.files.map(item => item.name)}));
    } else {
      // 'stage': the host builds and stages the package but supplies no row, so
      // the bootstrap still writes and opens it itself (upstream's flow; the
      // module's write replaces the host's staged copy). '0': the host does no
      // package work at all.
      if (packageMode === 'stage') {
        const staged = await memory.request({command: 'root-native-file-package-row',
          root: fsRoot, kind: 'hen', build: true, open: false, loader: root.copy.handle,
          image: imagePath, title: '0x040000000000003a'});
        console.log(JSON.stringify({stage: 'hen-package-staged',
          path: staged.staged && staged.staged.path, size: staged.built && staged.built.size}));
      }
      args.writeBigUInt64LE(0n, 200);
      args.writeBigUInt64LE(0n, 208);
      args.writeBigUInt64LE(0n, 216);
      args.writeBigUInt64LE(0n, 224);
      if (packageMode !== 'stage')
        console.log(JSON.stringify({stage: 'hen-package-host-disabled'}));
    }
    let launched = null;
    for (let phase = 1; launched === null; phase++) {
      const suffix = phase === 1 ? '' : '-mount';
      try {
      launched = await frontend.main({
      label: 'hen-startup' + suffix,
      filename: 'hen-startup' + suffix + '.json',
      image,
      // HEN owns the console from here. Do not unload, query or clean up: each
      // of those is an SDK call on the game's onEnterFrame thread, and one that
      // does not return freezes the frame loop (no HOME, no sleep).
      keepMapped: process.env.NS2_HEN_KEEP_MAPPED !== '0',
      async execute(session, entry, record, save) {
        args.writeUInt32LE(record.handle, 292);
        // entry is the mapped NRO text base, so entry + adapterOffset is where
        // the try-wait adapter now lives.
        args.writeBigUInt64LE(BigInt(entry + adapterOffset), 272);
        record.tryWaitAdapter = entry + adapterOffset;
        record.skipGameArm = skipArm;
        record.flags = (0x14 | armBits) >>> 0;
        record.staged = staged;
        record.stagedGame = stagedGame;
        record.stagedPrograms = stagedPrograms;
        record.stagedMenu = stagedMenu;
        record.package = '@Sdcard:/kaihen/bin/hen/exefs.nsp';
        const result = await thread.execute(session, entry, record, save, {
          // The module parks the Loader and drives the FS itself, so the host
          // must not read app memory while it does. A working gate finishes in
          // tens of seconds, so wait 10 s, then poll with a 20 s read timeout
          // until 120 s.
          waitMs: 120000,
          // A read that is still queued when the module finishes is served
          // then, but when the module wedges (pendingThread: wait) every read
          // sits behind it for the whole timeout. 20 s keeps a wedged start to
          // about a minute instead of three, and a healthy launch publishes its
          // first operation within a second.
          // The bootstrap publishes `BootstrapOperation` into the args tail
          // (BootstrapArgs.output, +408; `startup.hpp` asserts the layout) and
          // finalises it with the result. 10 = Complete. Poll that instead of
          // TryWaitThread, which blocks while the module is inside an IPC send
          // on this build.
          progress: session => ({address: session.base + 0x6010, offset: 408,
            initialWaitMs: 10000, pollMs: 1000, retryMs: 2000, readTimeoutMs: 20000,
            terminal: (operation, result) => operation === 10 || result !== 0}),
          async prepare(session, address) {
            record.argumentsAddress = address;
            await save();
            await session.write(address, args);
          },
          async verify(session, address, record) {
            joined = true;
            const out = await session.readOwned(address + 408, 24);
            record.operation = out.readUInt32LE(0);
            record.result = out.readUInt32LE(4);
            record.pid = out.readBigUInt64LE(8).toString();
            record.gateRestoreResult = out.readUInt32LE(16);
            record.channelRestoreResult = out.readUInt32LE(20);
            // Bootstrap can transfer a receipt-pending Loader restore to
            // OunceHEN after publishing the original wait and signalling
            // the park event. HEN then owns the eventual acknowledgement.
            record.gateRestorePending = record.operation === 10 &&
              record.gateRestoreResult === 0xea01;
            record.deferred = record.result === DEFERRED;
            await save();
            if (record.deferred) return;
            // A poisoned cache entry left installed when the app terminates is
            // what hangs "closing software" (acquire.cjs retire(): it hangs the
            // app and the console UI), but retiring at Complete is too early:
            // HEN reads the retained alias once on the first turn of its loop
            // (GameArm::openPackage -> RetainedMemory::begin), so restoring the
            // entry before that read removes the state HEN is about to use.
            //   NS2_HEN_RETIRE=0        never (leave it to the GUI's Release)
            //   NS2_HEN_RETIRE=1|now    at Complete
            //   NS2_HEN_RETIRE=delayed  NS2_HEN_RETIRE_MS (default 8000) after
            //                           Complete, i.e. after HEN's first turn
            const retireMode = String(process.env.NS2_HEN_RETIRE ?? '0');
            if (record.operation === 10 && !record.result && retireMode !== '0') {
              if (retireMode === 'delayed') {
                record.retireDelayMs = Math.max(0,
                  Math.floor(Number(process.env.NS2_HEN_RETIRE_MS) || 8000));
                await save();
                await new Promise(resolve => setTimeout(resolve, record.retireDelayMs));
              }
              record.retire = await retireEndpoint();
              await save();
            }
            check(!record.result &&
              (!record.gateRestoreResult || record.gateRestorePending) &&
              !record.channelRestoreResult &&
              record.operation === 10,
              `Startup operation ${record.operation} failed: 0x${record.result.toString(16)}`);

          },
        });
        return result;
      },
      });
      } catch (error) {
      const probe = {at: new Date().toISOString(), startError: error.message};
      for (const kind of ['hen', 'ro']) {
        try {
          const opened = await memory.request({command: 'root-native-package-open',
            root: fsRoot, kind});
          probe[kind] = {result: opened.result, canonicalResult: opened.canonicalResult,
            root: opened.root, files: (opened.entries || []).map(item =>
              ({name: item.name, size: item.size, sha256: item.sha256}))};
        } catch (probeError) { probe[kind] = {error: probeError.message}; }
      }
      // The GUI runs this tool outside the pipeline, so its output only reaches
      // the GUI log; write the probe into the run as well.
      const probeFile = runPath('switch2', 'ro', 'hen-package-probe.json');
      try { fs.writeFileSync(probeFile, JSON.stringify(probe, null, 2) + '\n'); }
      catch (writeError) { probe.writeError = writeError.message; }
      console.error('package-open probe ' + probeFile + ' ' + JSON.stringify(probe));
      throw error;
      }
      // The row is supplied above, so the bootstrap never defers in practice;
      // the deferred branch stays for a console where the host cannot open the
      // package and the module has to write it and ask again.
      const first = JSON.parse(fs.readFileSync(launched.file));
      if (first.result !== DEFERRED) break;
      if (phase >= 2) throw Error('The bootstrap asked for the package mount twice');
      launched = null;
    }
    const record = JSON.parse(fs.readFileSync(launched.file));
    return {pid: record.pid, file: launched.file};
  } finally {
    // Every request runs on the game's onEnterFrame thread, so once the module
    // reported success the run makes none at all -- these closes included. The
    // app is closed by hand right after, which releases them anyway.
    // After a retire the endpoint has already closed everything and its pipe is
    // gone, so these can only fail; never turn a completed start into a failure
    // over them (switch-jJeti: operation 10, retire cleanedUp true, then a
    // connect ENOENT from here was reported as "kaiHEN startup failed").
    if (joined && process.env.NS2_HEN_KEEP_MAPPED === '0') {
      await memory.request({command: 'root-native-close-handle', handle: exported.handle}).catch(() => {});
      await memory.request({command: 'root-native-close-handle', handle: fsProcess.handle}).catch(() => {});
    }
  }
}
module.exports = {main};
