const fs = require('node:fs/promises');
const path = require('node:path');
const {a} = require('../shared/rpc.cjs');
const transport = require('../shared/rpc.cjs');
const {run} = require('../shared/stages.cjs');
const {openRun, runDirectory, runPath} = require('../shared/paths.cjs');
const {connect} = require('./tools/fs-memory.cjs');
const runtime = require('./ro/runtime.cjs');
const postStart = require('./ro/post-start-open.cjs');
const {read, save, local, hash} = runtime;
const check = (ok, message) => {if (!ok) throw Error(message);};

async function main() {
  // A direct `node pipeline.cjs` run still gets its own runs/switch-XXXXX.
  if (!runDirectory()) openRun();
  const flags = process.argv.slice(2);
  check(flags.length <= 2 && flags.every(flag => ['--hen', '--probe'].includes(flag)) &&
    new Set(flags).size === flags.length, 'Usage: pipeline.cjs [--hen] [--probe]');
  // HEN mode: launch/activate the kaiHEN RO replacement, restore the Loader
  // session, and prove the app's ldr:ro frontend (ready.cjs). The GUI then runs
  // tools/hen.cjs, which maps kaiHEN's bootstrap into FS. It stops before the
  // stage-4 FS probe, which the HEN path does not need.
  const henMode = flags.includes('--hen') || process.env.NS2_HEN === '1';
  // Probe mode: same launch, but run the ro:dmnt instruction challenge against
  // the compiled RO image.
  const probeMode = flags.includes('--probe') || process.env.NS2_RO_PROBE === '1';
  const donorHen = henMode || probeMode;
  check(!(probeMode && henMode), '--probe cannot be combined with --hen');
  const file = runPath('pipeline.json');
  const record = {session: a.session, started: new Date().toISOString(), stages: []};
  await fs.writeFile(file, JSON.stringify(record) + '\n', {flag: 'wx', mode: 0o600});
  // Stage banner on the console screen. The bridge's `say` command runs a
  // `print` in the game, which the launcher draws in its overlay, so the person
  // in front of the console sees where the run is. Best effort and fire and
  // forget: the screen is a nicety and must never block or fail a stage.
  function announce(text) {
    transport.request({command: 'say', text, timeoutMs: 2000}).catch(() => {});
  }

  async function stage(name, action) {
    console.log(name);
    const row = {name, started: new Date().toISOString(), status: 'running'};
    record.stages.push(row); await save(file, record);
    try {
      row.result = await action(); row.status = 'complete';
      await stopAfter(name);
      return row.result;
    } catch (error) {row.status = 'failed'; row.error = error.stack; throw error;}
    finally {row.finished = new Date().toISOString(); await save(file, record);}
  }

  // Close-path bisect: stop after the named stage, restore the cache entry, stop
  // the console RPC loop and exit cleanly so the app can be closed by hand.
  // NS2_HEN_SKIP=1 keeps tools/hen.cjs from running afterwards.
  let stoppedAfter = false;
  async function stopAfter(name) {
    const wanted = process.env.NS2_STOP_AFTER_STAGE;
    if (!wanted || stoppedAfter || !name.includes(wanted)) return false;
    stoppedAfter = true;
    record.result = {stoppedAfter: name, at: new Date().toISOString()};
    let retired = null;
    if (acquisition) {
      try { retired = await acquisition.retire(); }
      catch (error) { retired = {error: error.message}; }
    }
    let detached = null;
    try { detached = await transport.request({command: 'rpc-shutdown', timeoutMs: 8000}); }
    catch (error) { detached = {error: error.message}; }
    Object.assign(record.result, {retired, detached});
    await save(file, record);
    console.log(JSON.stringify(record.result));
    console.log('[ns2jb] stopped after "' + name + '"; close Seedsow now');
    process.exit(0);
  }
  // Live progress: status.txt always holds the current stage, and every stage
  // line is printed with its 1-4 number (watch with: Get-Content status.txt -Wait).
  const statusFile = runPath('status.txt');
  let step = 0, announcedStep = 0;
  async function status(label) {
    const line = `[${step}/4] ${label}`;
    console.log(line);
    // One banner per main stage on the console screen, not one per sub-stage:
    // the 19 pipeline stages are grouped into these four.
    if (step !== announcedStep) {
      announcedStep = step;
      announce(`[ns2jb] stage ${step}: ${label}`);
    }
    try {await fs.writeFile(statusFile, line + ' ' + new Date().toISOString() + '\n', {mode: 0o600});}
    catch { /* status is best effort */ }
    return line;
  }
  const script = (folder, name, args = [], timeout) =>
    stage(folder + '/' + name, async () => {
      await status(folder + '/' + name);
      return run(path.join(__dirname, folder), name, args, timeout);
    });
  // Post-start /main redirect. The Loader's real open is emitted only while
  // pm:dmnt resumes the suspended replacement, so the watcher has to park the
  // Loader session before activation and share activation's Memory client (two
  // clients race the retained endpoint and interleave the gate steps).
  async function armPostStartWatcher(memory) {
    const roDir = runPath('switch2', 'ro');
    const stamp = Date.now();
    const proofFile = path.join(roDir, a.session + '-post-start-main-' + stamp + '.json');
    const logFile = path.join(roDir, 'post-start-open-watch-' + stamp + '.log');
    await fs.writeFile(logFile, '');
    const controller = new AbortController();
    let armed = false, resolveArmed, rejectArmed;
    const armedPromise = new Promise((resolve, reject) => {
      resolveArmed = resolve; rejectArmed = reject;
    });
    let approveSwap, cancelSwap, swapApprovalReason = 'pending';
    const swapApproval = new Promise(resolve => {
      approveSwap = () => {
        if (swapApprovalReason !== 'pending') return;
        swapApprovalReason = 'activation-accepted';
        resolve(true);
      };
      cancelSwap = () => {
        if (swapApprovalReason !== 'pending') return;
        swapApprovalReason = 'activation-cancelled';
        resolve(false);
      };
    });
    // Activation must be accepted before the Loader wrapper is redirected, but
    // waiting forever deadlocks when the start worker is itself blocked on the
    // redirect. Bound the barrier.
    const beforeSwap = async () => {
      const maxWaitMs = Math.max(1000,
        Number(process.env.NS2_POST_START_SWAP_MAX_WAIT_MS || 10000));
      let timer;
      const bounded = new Promise(resolve => {
        timer = setTimeout(() => {
          if (swapApprovalReason === 'pending') swapApprovalReason = 'bounded-stabilization-window';
          resolve({approved: true, reason: swapApprovalReason});
        }, maxWaitMs);
        timer.unref?.();
      });
      const approval = await Promise.race([
        swapApproval.then(approved => ({approved, reason: swapApprovalReason})),
        bounded
      ]);
      if (timer) clearTimeout(timer);
      return approval;
    };
    const appendLog = entry => fs.appendFile(logFile, JSON.stringify(entry) + '\n').catch(() => {});
    const done = (async () => {
      try {
        const result = await postStart.watch(memory, {watchMode: true, file: proofFile,
          signal: controller.signal, beforeSwap,
          onArmed: () => { armed = true; resolveArmed(); }});
        await appendLog({stage: 'post-start-watch-complete', at: new Date().toISOString(),
          swapped: result.swapped, restored: result.restored});
        return {code: 0, result};
      } catch (error) {
        if (!armed) rejectArmed(error);
        await appendLog({stage: 'post-start-watch-error', at: new Date().toISOString(),
          error: error.stack || error.message});
        return {code: 1, error: error.stack || error.message};
      }
    })();
    done.catch(() => {});
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('Post-start watcher did not arm before activation')), 15000);
      timer.unref?.();
    });
    try {
      await Promise.race([armedPromise, timeout]);
      return {done, controller, proofFile, logFile, approveSwap, cancelSwap};
    } catch (error) {
      controller.abort();
      await done;
      const text = await fs.readFile(logFile, 'utf8').catch(() => '');
      throw Error('Post-start watcher did not arm before activation: ' +
        (text.trim().slice(-2000) || error.message));
    }
  }
  async function stopPostStartWatcher(watcher) {
    if (!watcher) return;
    watcher.cancelSwap?.();
    watcher.controller.abort();
    await watcher.done.catch(() => {});
  }
  async function finishPostStartWatcher(watcher) {
    const result = await watcher.done;
    let proof = null;
    try { proof = JSON.parse(await fs.readFile(watcher.proofFile, 'utf8')); } catch { /* kept in result */ }
    if (result.code !== 0 || !proof?.swapped || proof.restored !== true) {
      const text = await fs.readFile(watcher.logFile, 'utf8').catch(() => '');
      throw Error('Post-start watcher failed (code=' + result.code + '): ' +
        (proof?.error || result.error || text.trim().slice(-2000) || 'no diagnostic detail'));
    }
    return {file: watcher.proofFile, log: watcher.logFile, ...proof};
  }
  let acquisition;
  try {
    step = 1; await status('Checking the console');
    await script('app', 'map');
    // await script('app', 'inspect-mounts'); // Seedsow exposes save/game/empty; SmileBASIC list rejects it
    // Cleanup is optional and can wedge the serialized /eval queue; let the probe's own
    // free-space check decide, then clean afterward if needed.
    // await stage('Remove exploit scratch from prior launches', () => require('./cleanup-scratch.cjs').main());
    // app/qualify verifies the SmileBASIC thread-scheduling/affinity code paths;
    // Seedsow skips affinity and validates the worker chain with the smoke tests
    // instead. Set NS2_QUALIFY=1 to force it.
    if (a.session === 'seedsow' && process.env.NS2_QUALIFY !== '1') {
      await status('app/qualify skipped for Seedsow (NS2_QUALIFY=1 to force)');
    } else {
      const app = await script('app', 'qualify');
      check(app.verified && app.cleanedUp, 'Application worker qualification failed');
    }
    step = 2; await status('Acquiring FS memory (probe)');
    await stage('FS read, write and restoration', async () => {
      acquisition = await require('./acquire.cjs').start();
      return {report: acquisition.report, proof: acquisition.proof};
    });
    // Bisect switch: closing the app after a successful acquisition freezes the
    // console with kaiHEN never started (switch-QXAs7 with NS2_HEN=0), so the
    // state the acquisition installs cannot be destroyed. Stop here to test
    // whether that state alone is the problem or whether the swapped-in RO
    // replacement is: nothing after this point has touched the Loader yet.
    if (process.env.NS2_STOP_AFTER_ACQUIRE) {
      const stopMode = process.env.NS2_STOP_AFTER_ACQUIRE;
      record.result = {acquired: true, report: acquisition.report,
        stopped: 'after acquisition (NS2_STOP_AFTER_ACQUIRE=' + stopMode + ')'};
      // 2 = also retire first. That restores the poisoned cache entry (with
      // NS2_RETIRE_LEAK=1 it leaves the handles and the allocation alone), so a
      // freeze here is the entry or its restoration, while a clean run means the
      // entry is fine and the handles/notifier/allocation are what cannot be
      // destroyed. retire() throws when the cleanup was skipped, which is
      // expected in this mode; the restore has already happened by then.
      if (stopMode === '2') {
        try { record.retired = await acquisition.retire(); }
        catch (error) { record.retireError = error.message; }
      }
      await save(file, record);
      // Stop the console RPC loop *before* anything asks the app to close: the
      // serve chunk runs on the app's frame thread, and once HOME/close is
      // pressed the app is suspended and cannot answer any more.
      let detached = null;
      try {
        detached = await transport.request({command: 'rpc-shutdown', timeoutMs: 8000});
      } catch (error) { detached = {error: error.message}; }
      record.detached = detached;
      await save(file, record);
      console.log(JSON.stringify({detached}));
      console.log('[ns2jb] stopped after acquisition; close Seedsow now');
      return;
    }
    step = 3; await status('Starting the native helper (retained/RO)');
    const captured = await read(acquisition.report);
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (!captured.retainedMemory?.captures?.some(c => c.length === 0x4d8000))
      await script('retained', 'find-metadata', [acquisition.supervisorReport]);
    await script('ro', 'install-retained');
    await stage('FS layout', () => require('./ro/layout.cjs').main());
    await stage('Owned FS root', () => require('./ro/objects.cjs').main('root'));
    await stage('Owned FS notifier', () => require('./ro/objects.cjs').main('notifier'));
    const layout = await read(local(a.session, '-layout.json'));
    await script('ro', 'test-sm', [String(layout.sdk + 0x12a0)]);
    await script('ro', 'copy-loader-root', [String(layout.target.entry)]);
    await script('ro', 'prepare-workers');
    // NS2_FS_PROBE=1 reads the FS module image (read-only, no gate). With
    // NS2_FS_PROBE_ONLY=1 the pipeline stops here instead of hitting the gate.
    if (process.env.NS2_FS_PROBE === '1') {
      await script('ro', 'probe-fs-image', [], 600000);
      if (process.env.NS2_FS_PROBE_ONLY === '1')
        throw Error('FS image probe complete; stopping before the gate');
    }
    const donor = await stage('RO payload and current console policy', async () => {
      const memory = await connect();
      // Fast local endpoint check before the FS IPC calls. If this times out,
      // the retained endpoint (not the FS) is gone and the app needs a relaunch.
      const endpoint = await memory.request({command: 'root-native-info'});
      check(endpoint.session === a.session, 'The retained endpoint session changed');
      const loader = await read(local(a.session, '-loader-root-copy.json'));
      const code = await memory.request({command: 'root-native-code-open', handle: loader.copy.handle, title: '0x0400000000000037'});
      check(!code.result, 'Native RO CodeFS did not open');
      for (const name of ['main.npdm'])
        await memory.request({command: 'root-native-file-capture', handle: code.handle, name});
      const result = await memory.request({command: 'root-native-donor-prepare', hen: donorHen});
      check(result.ready && result.mount === 'package' && result.kind === 'ro' &&
        Array.isArray(result.files) && result.files.length >= 2 &&
        result.files.every(item => item.sha256), 'The kaiHEN RO package did not verify');
      // runtime.activate needs the PM monitor; ro/test-sm only opens pm:shell.
      // Open it after the package work so a package failure cannot be confused
      // with an SM failure. Do not unregister anything here.
      const sm = await read(local(a.session, '-sm-proof.json'));
      result.monitor = await memory.request({command: 'root-native-sm-service',
        handle: sm.export.handle, name: 'pm:dmnt'});
      check(!result.monitor.result && !result.monitor.transport,
        'PM monitor did not open: ' + JSON.stringify(result.monitor));
      return result;
    });
    await script('ro', 'bind-sessions');
    if (process.env.NS2_CODE_SWAP === '1') {
      // Fix A: make the mount handler's content source the donor before the
      // Loader mounts, so the mount reply is already kaiHEN's package.
      record.codeSwap = await stage('Pre-mount code filesystem redirect', async () => {
        const memory = await connect();
        return memory.request({command: 'root-native-file-code-swap'});
      });
    }
    if (process.env.NS2_FS_SWAP === '1') {
      record.fsSwap = await stage('Pre-mount filesystem redirect', async () => {
        const memory = await connect();
        return memory.request({command: 'root-native-file-fs-swap'});
      });
    }
    // NS2_MAIN_SWAP is captured after prepare-event, just below, so the
    // read-only storage recon hold sees only the donor package and the stock
    // code FS (no extra live /main object).
    await script('ro', 'prepare-event');
    // Read-only FS storage recon state: the package donor and stock code FS are
    // both live and the launch/HEN staging has not disturbed them. Hold here
    // with NS2_HOLD_TYPES=1; no mode field so the GUI's normal held/release
    // path is used.
    if (process.env.NS2_HOLD_TYPES === '1') {
      const hold = {session: a.session, report: acquisition.report,
        socketPath: acquisition.socketPath, started: new Date().toISOString()};
      await save(runPath('types-hold.json'), hold);
      record.hold = {mode: 'types', state: 'ready', ...hold};
      await save(file, record);
      process.send({type: 'held-ready', session: a.session});
      const reason = await require('./hold.cjs').waitForRelease();
      record.hold = {...record.hold, state: 'releasing', reason,
        released: new Date().toISOString()};
      await save(file, record);
      const cleanup = await stage('Release FS resources', () => acquisition.retire());
      record.result = {hold: record.hold, cleanup, started: record.started,
        completed: new Date().toISOString()};
      return;
    }
    // Capture the donor /main impl and wrapper vptr for the post-start redirect.
    // Capture mode opens only the kaiHEN package /main: opening the stock CodeFS
    // /main here stalls the launch (23:57 run, mounts 0).
    if (process.env.NS2_MAIN_SWAP === '1') {
      record.mainSwap = await stage('Pre-mount /main redirect', async () => {
        const memory = await connect();
        return memory.request({command: 'root-native-file-main-swap'});
      });
    }
    // The ported launch.cjs/gate.cjs performs the real park/step/restore:
    // parkSession() drains any request left by the pre-launch stages, rebuilds
    // the wait array, and the launch loop serves every Loader request with
    // step() to the proven second mount. The old ro/test-gate diagnostic is
    // skipped (NS2_SKIP_TEST_GATE=1).
    const gate = process.env.NS2_SKIP_TEST_GATE === '1'
      ? {verified: true, restored: true, skipped: true}
      : await script('ro', 'test-gate');
    check(gate.verified && gate.restored, 'The native request gate did not qualify');
    const launch = await script('ro', 'launch', [], 300000);
    // The wait-only/watch diagnostic deliberately leaves the app on the error
    // screen; its product is the TCP capture, not a started payload. Stop here
    // instead of reporting a fake "PM did not accept the payload" failure.
    if (process.env.NS2_LAUNCH_WAIT_ONLY === '1' || process.env.NS2_LAUNCH_WATCH === '1') {
      console.log(JSON.stringify({stage: 'wait-only-complete', file: launch.file,
        watch: launch.watch, waitOnly: launch.waitOnly}));
      return;
    }
    // A stale close (the read frees its own domain entry) is left queued and
    // the session parked instead of being served, because serving it faults the
    // console. The Loader's main-image read runs on its other FS session, so the
    // launch is still valid: 03:16 returned result 0 and pid 208 this way.
    check(launch.imageAccepted && launch.pid && (launch.restored || launch.restoreSkipped),
      'PM did not accept the payload');
    // Diagnostic runs (the idle-payload control) must stop before activate:
    // activate kills the original RO, which would confound the next run.
    if (process.env.NS2_STOP_AFTER_LAUNCH === '1') {
      console.log(JSON.stringify({stage: 'stop-after-launch', file: launch.file,
        pid: launch.pid, settled: launch.settled, completion: launch.completion}));
      // The diagnostic deliberately leaves the console alive, but the
      // acquisition child and the bridge socket keep this process in the event
      // loop. The GUI waits for the pipeline exit, so it showed "running"
      // forever after the 04:26 control. Save the finished record and exit;
      // the probe child keeps the retained endpoint available for host probes.
      record.finished = new Date().toISOString();
      await save(file, record);
      process.exit(0);
    }
    // Arm the post-start watcher before resuming the replacement. NS2_OPEN_SWAP=0
    // disables the proven-inert pre-activation open swap in ro/launch.cjs;
    // NS2_POST_START_OPEN=0 disables this watcher instead.
    // A staged SD exefs package is opened by the Loader's own ScopedCodeMount
    // before the base code, so the post-start entry watcher has nothing to do
    // (and would fail its "no swappable mount" check).
    const exefsRedirect = Boolean(donor?.package?.redirect);
    let postStartWatcher = null, postStartMemory = null;
    if (!exefsRedirect && process.env.NS2_POST_START_OPEN !== '0' &&
        process.env.NS2_MAIN_SWAP === '1') {
      postStartMemory = await connect();
      postStartWatcher = await armPostStartWatcher(postStartMemory);
      record.postStartWatcher = {file: postStartWatcher.proofFile,
        log: postStartWatcher.logFile, mode: 'shared-rpc'};
      await save(file, record);
    }
    let activation;
    try {
      activation = await stage('Start RO payload',
        () => runtime.activate(launch.file, postStartMemory));
      if (postStartWatcher) {
        // Activation must be accepted before the Loader-owned /main wrapper is
        // redirected. The watcher has already observed and parked the wrapper;
        // releasing this barrier performs the verified pointer swap.
        postStartWatcher.approveSwap?.();
        record.postStartMainSwap = await stage('Post-start /main redirect', async () => {
          const result = await finishPostStartWatcher(postStartWatcher);
          check(result?.swapped && result?.restored,
            'Post-start /main redirect did not verify the Loader-owned wrapper');
          return result;
        });
        postStartWatcher = null;
      }
    } catch (error) {
      await stopPostStartWatcher(postStartWatcher);
      postStartWatcher = null;
      throw error;
    }
    if (henMode || probeMode) {
      const handoff = await stage('Restore Loader session', () => runtime.handoff());
      const step = henMode
        ? await stage('Connect to the RO frontend', () => require('./ro/ready.cjs').main())
        : await stage('RO instruction challenges', () => runtime.probe(activation.pid));
      const mode = henMode ? 'hen' : 'ro-probe';
      const result = {session: a.session, pid: activation.pid, launch: launch.file,
        handoff: handoff.file, [henMode ? 'ready' : 'probe']: step,
        verified: true, restored: true};
      await save(runPath(henMode ? 'ro-frontend-current.json' : 'ro-probe-current.json'), result);
      record[mode] = result;
      await save(file, record);
      if (typeof process.send === 'function') {
        process.send({type: 'held-ready', session: a.session, mode,
          socketPath: acquisition.socketPath});
        const reason = await require('./hold.cjs').waitForRelease();
        record.hold = {mode, state: 'releasing', reason,
          released: new Date().toISOString()};
        await save(file, record);
      }
      // The GUI releases the hold only after tools/hen.cjs has returned, so
      // reaching this point means HEN startup is complete. Publish it as the
      // fourth main stage so the top bar shows 4/4.
      if (henMode) {
        step = 4;
        await status('kaiHEN Startup Complete');
      }
      // After HEN starts, the retained endpoint is promoted and HEN owns its
      // state; retirement from here is not possible and is not a run failure.
      // Closing the app performs the teardown. Keep the stage complete so the
      // GUI does not report a failed attempt.
      const cleanup = await stage('Release FS resources', async () => {
        try {
          return await acquisition.retire();
        } catch (error) {
          if (!/The retained endpoint cannot be retired from its current state/.test(error.message))
            throw error;
          // The endpoint is already gone/retired by the HEN start. Release the
          // acquisition child so the pipeline exits, and report a skipped
          // retirement instead of a failed stage.
          await acquisition.abandon();
          return {retireSkipped: error.message};
        }
      });
      record.result = {[mode]: result, cleanup, started: record.started,
        completed: new Date().toISOString()};
      return;
    }
    const proof = await stage('RO instruction challenges', () => runtime.probe(activation.pid));
    const handoff = await stage('Restore Loader session', () => runtime.handoff());
    const payload = donor.files.find(item => item.name === 'main');
    if (process.env.NS2_DONOR_MAIN !== 'real') {
      const kaihenDir = process.env.KAIHEN_DIR || path.join(__dirname, '../../../../../kaihen');
      check(payload.sha256 === hash(await fs.readFile(path.join(kaihenDir, 'ro', 'main'))),
        'Payload changed during launch');
    }
    await save(runtime.executionFile, {verified: true, session: a.session, report: acquisition.report,
      pid: proof.pid, programId: '0400000000000037', payloadSha256: payload.sha256,
      service: proof.service, proof: proof.file, launch: launch.file, identity: activation.file, handoff: handoff.file});
    step = 4; await status('Running the FS demo');
    await script('process', 'bind-notifier');
    const mapping = await script('process', 'qualify');
    check(mapping.verified && mapping.cleanup?.finished, 'Native process mapping did not qualify and clean up');
    const execution = await stage('FS instruction challenges', () => require('./process/fs-execute.cjs').main());
    check(execution.verified && execution.restored, 'FS execution or restoration did not verify');
    const donorCleanup = await stage('Remove RO donor files', async () => {
      const memory = await connect();
      const donor = await memory.request({command: 'root-native-donor-cleanup'});
      check(donor.cleanedUp, 'Donor files did not clean up');
      return donor;
    });
    const cleanup = await stage('Release FS resources', async () =>
      ({...await acquisition.retire(), donor: donorCleanup}));
    const result = {...execution, cleanup, started: record.started, completed: new Date().toISOString()};
    await save(runPath('fs-execution-current.json'), result);
    record.verified = true; record.result = result;
  } catch (error) {
    record.error = error.stack;
    if (acquisition) {
      try {
        const latest = await read(acquisition.report);
        // Before promotion, the acquisition still owns its original restoration
        // path. Later failures may have native state that needs a console reboot.
        if (!latest.nativeRo && !latest.retainedMemory?.promoted) {
          try {
            record.failureCleanup = await acquisition.retire();
          } catch (first) {
            // A failed stage-3 read may still be in flight at the endpoint. One
            // delayed retry is worth it: a successful retire drops the poisoned
            // cache entry and keeps the app closable (no hard reboot).
            record.cleanupRetry = first.message;
            await new Promise(resolve => setTimeout(resolve, 5000));
            record.failureCleanup = await acquisition.retire();
          }
        } else await acquisition.abandon();
      } catch (cleanupError) {
        record.cleanupError = cleanupError.stack;
        await acquisition.abandon();
      }
    }
    throw error;
  } finally {record.finished = new Date().toISOString(); await save(file, record);}
}

module.exports = {main};
if (require.main === module) main().catch(error => {console.error(error.stack); process.exitCode = 1;});
