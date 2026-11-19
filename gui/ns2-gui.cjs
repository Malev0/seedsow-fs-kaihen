#!/usr/bin/env node
// Small manual controller for the Seedsow run.
//
//   Start         -> launch/<platform> setup (stop-all, shim, mounts, bridge)
//                    then `node pipeline.cjs --hen` and tools/hen.cjs
//   Attempt failed -> stop the run, kill the bridge, mark the boot dead
//   Stop          -> stop the running child tree
//
// A failed run does the "Attempt failed" cleanup automatically.
//
// API (also usable from tools): GET /api/state, GET /api/log, POST /api/start,
// POST /api/failed, POST /api/stop, GET /api/events (SSE).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const {spawn} = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const KAIHEN = path.join(ROOT, 'kaihen');
const SWITCH2 = path.join(ROOT, 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2');
const PIPELINE = path.join(SWITCH2, 'pipeline.cjs');
// The run directory is opened once per Start; until then the readers fall back
// to the engine tree so an old status/pipeline file can still be shown.
const {prepareRun, loadEnv} = require(path.join(TOOLS, 'env.cjs'));
const SELF_UPDATE = require(path.join(TOOLS, 'self-update.cjs'));
const KAIHEN_RELEASE = require(path.join(TOOLS, 'kaihen-release.cjs'));
const VERSION = SELF_UPDATE.readVersion(ROOT).version;
let RUN = null;
const runRoot = () => RUN || SWITCH2;
// Show the newest run on startup; Start opens a fresh one (prepareRun() reads
// NS2_RUN_DIR, which only runPipeline() sets).
try { RUN = fs.readFileSync(path.join(ROOT, 'runs', 'latest.txt'), 'utf8').trim() || null; } catch { RUN = null; }
const PORT = Number(process.env.NS2_GUI_PORT || 31338);

function consoleHost() {
  if (process.env.NS2_CONSOLE) return process.env.NS2_CONSOLE.trim();
  try {
    const first = fs.readFileSync(path.join(TOOLS, 'console-host.txt'), 'utf8').split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch {}
  return '192.168.1.50';
}
let CONSOLE = consoleHost();

const state = {
  phase: 'idle',
  message: 'Start Seedsow, press Y, then press Start.',
  consoleUp: null,
  stage: '',
  stages: [],
  report: null,
  pipeline: null,
  progress: null,
  startedAt: null,
  finishedAt: null,
  seq: 0,
  lines: [],
};

// Ordered pipeline plan (pipeline.cjs); used to turn "N stages done" into a
// percentage for the RO and process lanes. Stage 2 gets its percentage from the
// probe report itself.
const STAGE3_PLAN = [
  'retained/find-metadata', 'ro/install-retained', 'FS layout', 'Owned FS root',
  'Owned FS notifier', 'ro/test-sm', 'ro/copy-loader-root', 'ro/prepare-workers',
  'RO payload and current console policy', 'ro/bind-sessions', 'ro/prepare-event',
  'ro/test-gate', 'ro/launch', 'Start RO payload', 'RO instruction challenges',
  'Restore Loader session',
];
const STAGE4_PLAN = [
  'Connect to the RO frontend', 'RO instruction challenges', 'HEN bootstrap',
];

function laneProgress(plan, done) {
  let index = -1;
  plan.forEach((name, i) => { if (done.has(name)) index = i; });
  const steps = Math.max(0, index + 1);
  return {steps, total: plan.length, percent: Math.round((steps / plan.length) * 100)};
}

const APP_RESTART_HINT =
  'Relaunch Seedsow Lullaby (the app), press Y, then press Start again.';
const CONSOLE_RESTART_HINT =
  'If the console is frozen or the app will not relaunch, hold the power button for 15 seconds, then power it back on.';
const SD_CARD_HINT =
  'Ensure you have a compatible SD card inserted. Both express and non-express work. ' +
  'If you do not have the exFAT update, then your SD card must be formatted to FAT32.';

function failureHints(stage, error, beforeStage3 = false) {
  const text = String(error || '');
  const hints = [];
  if (/Missing kaihen/i.test(text))
    hints.push('The local kaiHEN release is incomplete. Press Update kaiHEN (Auto-Download), then retry.');
  const stage3or4 = STAGE3_PLAN.includes(stage) || STAGE4_PLAN.includes(stage) ||
    stage === 'kaiHEN';
  if (stage3or4 ||
      /SD filesystem open failed|SD|sdcard|card|exFAT|FAT32|package|exefs|staging|kaiHEN|HEN/i.test(text))
    hints.push(SD_CARD_HINT);
  if (!beforeStage3) hints.push(CONSOLE_RESTART_HINT);
  // The app-restart line is deliberately last: it is the next action for every
  // failed attempt, even after a console power cycle.
  hints.push(APP_RESTART_HINT);
  return hints;
}

function computeProgress() {
  const pipeline = readPipeline();
  const report = readReport();
  const rows = pipeline?.stages || [];
  const failed = rows.find(s => s.status === 'failed');
  const done = new Set(rows.filter(s => s.status === 'complete').map(s => s.name));
  const stage3Started = STAGE3_PLAN.some(name => done.has(name));
  const stage4Started = STAGE4_PLAN.some(name => done.has(name)) ||
    done.has('Restore Loader session');
  const stage2Progress = () => {
    const p = report?.progress;
    return {stage: 2, percent: p ? p.percent : 0,
      label: p ? p.label : 'starting the probe',
      detail: p && p.profile ? p.profile : ''};
  };

  if (failed) {
    const name = failed.name || '';
    const stage = stage4Started ||
      ['Connect to the RO frontend', 'RO instruction challenges', 'HEN bootstrap'].includes(name) ? 4
      : STAGE3_PLAN.includes(name) ? 3
      : name === 'app/map' ? 1 : 2;
    const lane = stage === 4 ? laneProgress(STAGE4_PLAN, done)
      : stage === 3 ? laneProgress(STAGE3_PLAN, done)
      : stage === 2 ? {percent: report?.progress?.percent || 0} : {percent: 0};
    return {stage, percent: lane.percent, label: 'failed: ' + (name || 'stage ' + stage),
      detail: failed.error || ''};
  }

  if (!done.has('app/map')) {
    return {stage: 1, percent: 0, label: 'mapping the application', detail: ''};
  }
  // Check the later stages before the stage-2 report. The acquisition report's
  // memoryReady flag can still be false while the pipeline is already staging
  // HEN, which used to leave the bar at "Stage 2 98%".
  if (stage4Started) {
    if (readStatusText().startsWith('[4/4]')) {
      return {stage: 4, percent: 100, label: 'kaiHEN Startup Complete', detail: ''};
    }
    const lane = laneProgress(STAGE4_PLAN, done);
    return {stage: 4, percent: lane.percent, label: `${lane.steps}/${lane.total} HEN steps`, detail: ''};
  }
  if (stage3Started) {
    const lane = laneProgress(STAGE3_PLAN, done);
    return {stage: 3, percent: lane.percent, label: `${lane.steps}/${lane.total} RO steps`, detail: ''};
  }
  if (!(report && report.memoryReady)) return stage2Progress();
  return {stage: 3, percent: 0, label: `0/${STAGE3_PLAN.length} RO steps`, detail: ''};
}
const clients = new Set();
let child = null;
// Set while the pipeline is holding the FS endpoint after stage 4. The pipeline
// child stays alive on its IPC channel until the GUI sends {type:'release'};
// the GUI sends it automatically once HEN has started (or failed).
let pipelineHeld = false;

function releasePipeline(reason, ok = false) {
  if (!pipelineHeld) return false;
  if (!child || child.connected === false) return false;
  // `ok` tells the pipeline whether tools/hen.cjs actually started HEN, so a
  // failed start cannot be published as 4/4 "kaiHEN Startup Complete".
  try { child.send({type: 'release', ok}); } catch { return false; }
  pipelineHeld = false;
  addLine(`[gui] release sent (${reason}); retiring the FS endpoint ...`);
  return true;
}

// An update must not touch the tree while the pipeline, the bridge setup or the
// held FS endpoint still has a child running.
function runActive() {
  return state.phase === 'setup' || state.phase === 'running' ||
    state.phase === 'restarting' || pipelineHeld || Boolean(child);
}

function publicState() {
  return {
    phase: state.phase, message: state.message, consoleUp: state.consoleUp,
    stage: state.stage, stages: state.stages, report: state.report,
    pipeline: state.pipeline, progress: state.progress,
    startedAt: state.startedAt, finishedAt: state.finishedAt,
    console: CONSOLE, version: VERSION, logSeq: state.seq,
  };
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch {} }
}

function setState(patch) {
  Object.assign(state, patch);
  broadcast('state', publicState());
}

function addLine(text) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    const entry = {seq: ++state.seq, t: new Date().toISOString(), text: line};
    try { process.stdout.write(`${entry.t} ${line}\n`); } catch {}
    state.lines.push(entry);
    if (state.lines.length > 4000) state.lines.splice(0, state.lines.length - 4000);
    broadcast('line', entry);
  }
}

function readStatusText() {
  try {
    // status.txt is "<line> <ISO timestamp>"; the stage chip wants the line.
    return fs.readFileSync(path.join(runRoot(), 'status.txt'), 'utf8').trim()
      .replace(/\s+\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, '');
  } catch { return ''; }
}
function readStatus() {
  const text = readStatusText();
  if (text && text !== state.stage) setState({stage: text});
}

function readPipeline() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(runRoot(), 'pipeline.json'), 'utf8'));
    return {
      stages: (p.stages || []).map(s => ({name: s.name, status: s.status,
        error: s.error ? String(s.error).split('\n')[0] : null})),
    };
  } catch { return null; }
}

function readReport() {
  try {
    const dir = path.join(runRoot(), RUN ? 'switch2/memory' : 'memory');
    const files = fs.readdirSync(dir).filter(f => /^reserved-gap-\d+\.json$/.test(f)).sort();
    if (!files.length) return null;
    const file = files[files.length - 1];
    const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const link = r.linkSelection || {};
    return {
      file,
      memoryReady: !!(r.memoryControl && r.memoryControl.ready),
      strong: link.strong ?? null, weak: link.weak ?? null, stable: link.stable ?? null,
      cleanedUp: r.cleanedUp ?? null,
      elapsed_s: r.metrics ? Math.round(r.metrics.elapsedMs / 1000) : null,
      error: r.error ? String(r.error).split('\n')[0] : null,
      progress: r.progress ?? null,
      active: r.active?.profile ?? null,
      waves: Array.isArray(r.cases) ? r.cases.length : null,
      timings: r.timings ?? null,
    };
  } catch { return null; }
}

// ---- Controller bridge -----------------------------------------------------
// tools/controller.cjs owns the HTTP contract (press/release/tap/sequence/
// status) and the connection file, so any controller implementation works.
const controller = require(path.join(TOOLS, 'controller.cjs'));
const CONTROLLER_BUTTONS = controller.BUTTONS;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// A user stop is not a failed attempt. This is the state it leaves behind.
function markStopped() {
  setState({phase: 'finished', message: 'Stopped.', finishedAt: Date.now()});
}

async function controllerTap(buttons, down = 0.12, up = 0.16) {
  return (await controller.tap(buttons, down, up)) || {};
}

// A bridge may answer {confirmed:false} when it queued the press but could not
// prove the controller executed it.
function controllerProblems(label, reply) {
  if (reply.errors && reply.errors.length) {
    addLine(`[ctl] ${label} rejected: ${reply.errors.join('; ')}`);
    return true;
  }
  if (reply.confirmed === false) {
    addLine(`[ctl] ${label}: the controller did not confirm the press`);
    return true;
  }
  return false;
}

// Restart Game: same cleanup as "Attempt failed", then the controller
// sequence HOME x2 (1 s apart, to dismiss the SD-card notice), X, A, A(xN), Y.
// The second A block is 2 presses by default and 1 when the caller asks for it.
async function restartGame(aPresses, yDelayMs) {
  if (state.phase === 'restarting') return {ok: false, error: 'a restart is already in progress'};
  const presses = Number(aPresses) === 1 ? 1 : 2;
  const yDelay = Math.min(60000, Math.max(0, Number(yDelayMs ?? 3000)));
  setState({phase: 'restarting', message: 'Restarting: stopping the run, then sending controller input ...'});
  addLine(`[ctl] restart-game: second A block = ${presses} press(es); Y delay = ${yDelay} ms`);
  try {
    await stopEverything('restart-game: stopped the run and the bridge');
    killTree();
    if (stopping) {
      addLine('[ctl] restart stopped');
      markStopped();
      return {ok: false, stopped: true};
    }
    const status = await controller.status();
    addLine(`[ctl] bridge ok (${status.controller || 'unknown'})`);
    const sequence = [
      {button: 'HOME', wait: 1000, label: 'HOME (1/2)'},
      {button: 'HOME', wait: 1000, label: 'HOME (2/2)'},
      {button: 'X', wait: 1000, label: 'X'},
      {button: 'A', wait: 1000, label: 'A'},
      ...Array.from({length: presses}, (_, index) => ({button: 'A',
        wait: index === presses - 1 ? yDelay : 180, label: `A (${index + 1}/${presses})`})),
      {button: 'Y', wait: 0, label: 'Y'},
    ];
    for (const step of sequence) {
      if (stopping) break;
      const reply = await controllerTap(step.button, 0.15, 0.2);
      addLine(`[ctl] ${step.label}`);
      controllerProblems(step.label, reply);
      if (step.wait) await sleep(step.wait);
    }
    if (stopping) {
      addLine('[ctl] restart stopped');
      markStopped();
      return {ok: false, stopped: true};
    }
    addLine('[ctl] sequence sent; waiting for the console HTTP server');
    setState({message: 'Sequence sent. Waiting for the console ...'});
    const deadline = Date.now() + 90000;
    let up = false;
    while (Date.now() < deadline) {
      if (stopping) break;
      up = await probeConsole();
      if (up) break;
      await sleep(2000);
    }
    if (stopping) {
      addLine('[ctl] restart stopped');
      markStopped();
      return {ok: false, stopped: true};
    }
    if (up) {
      addLine('[ctl] console is up');
      bootFresh = true;
      setState({phase: 'idle', consoleUp: true, message: 'Console restarted - press Start to set up this boot.'});
    } else {
      addLine('[ctl] console did not answer within 90 s');
      setState({phase: 'failed', consoleUp: false, message: 'Controller sequence sent, but the console HTTP server is still down - check the screen.'});
    }
    return {ok: true, consoleUp: up};
  } catch (error) {
    if (stopping) {
      addLine('[ctl] restart stopped');
      markStopped();
      return {ok: false, stopped: true};
    }
    addLine(`[ctl] restart-game failed: ${error.message}`);
    setState({phase: 'failed', message: `Restart failed: ${error.message}`});
    return {ok: false, error: error.message};
  }
}

// Run a controller sequence. The bridge times the holds and gaps itself; the
// host only waits between steps when the bridge has no /sequence call.
async function runSequence(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 64)
    throw Error('a sequence needs 1..64 steps');
  for (const step of steps) controller.BUTTONS.has(String(step.buttons ?? step.button).toUpperCase());
  try {
    const reply = await controller.sequence(steps);
    for (const step of steps)
      addLine(`[ctl] ${[].concat(step.buttons ?? step.button).join('+')}`);
    if (reply.confirmed === false) addLine('[ctl] sequence: not confirmed by the controller');
    const total = steps.reduce((sum, step) => sum + Math.max(0, Number(step.wait) || 0), 0);
    if (total) await sleep(total);
    return;
  } catch (error) {
    if (!/HTTP 404|not found/i.test(error.message)) throw error;
  }
  // Fallback for a bridge without /sequence: tap each step here.
  for (const step of steps) {
    const buttons = [].concat(step.buttons ?? step.button);
    const hold = Math.min(5, Math.max(0.04, Number(step.hold ?? step.down) || 0.15));
    const wait = Math.min(60000, Math.max(0, Number(step.wait) || 0));
    const reply = await controllerTap(buttons, hold, 0.16);
    addLine(`[ctl] ${buttons.join('+')} (${Math.round(hold * 1000)} ms)`);
    controllerProblems(buttons.join('+'), reply);
    if (wait) await sleep(wait);
  }
}

function readBody(req, limit = 8192) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      if (size >= limit) return;
      chunks.push(chunk);
      size += chunk.length;
    });
    req.on('end', () => resolve(Buffer.concat(chunks).subarray(0, limit).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

// The browser uploads a picked folder as relative paths. Reject anything that
// would leave <repo>/kaihen (absolute paths, drive letters, "." or "..").
function kaihenTarget(relative) {
  const clean = String(relative || '').replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) ||
      clean.split('/').some(part => !part || part === '.' || part === '..'))
    throw Error('invalid kaiHEN file path');
  const target = path.resolve(KAIHEN, clean);
  if (!target.startsWith(KAIHEN + path.sep)) throw Error('kaiHEN file path escapes the folder');
  return target;
}

function probeConsole() {
  // A real request, not a connect-and-drop. http.lua's pump_accept treats any
  // accept error other than EAGAIN as fatal ("[!] httpd: accept N -> ...;
  // server stopped" at common/http.lua:329) and never restarts, so a connection
  // that is reset while queued kills the launcher's HTTP server for the rest of
  // the boot - including the setup that uploads the shim. A completed GET is
  // closed gracefully by the server instead.
  CONSOLE = consoleHost();
  return new Promise(resolve => {
    const req = http.get({host: CONSOLE, port: 8080, path: '/', timeout: 2500}, res => {
      res.resume();
      res.on('end', () => resolve(true));
      res.on('error', () => resolve(true));
    });
    const done = ok => { try { req.destroy(); } catch {} resolve(ok); };
    req.on('timeout', () => done(false));
    req.on('error', () => done(false));
  });
}

// A completed GET is safe: http.lua's pump_accept treats a connect-and-drop as
// fatal ("[!] httpd: accept ...; server stopped"), so probeConsole() always
// sends a real request and drains the reply. Poll it every 5 s so the HTTP
// indicator follows a relaunch; the pipeline still notices a dead console
// during a run.
let probingConsole = false;
let lastConsoleProbe = 0;
async function poller() {
  // A single probe when the controller starts, so the indicator is not blank.
  if (state.consoleUp === null) setState({consoleUp: await probeConsole()});
  for (;;) {
    if (!probingConsole && state.phase !== 'restarting' &&
        Date.now() - lastConsoleProbe >= 5000) {
      probingConsole = true;
      lastConsoleProbe = Date.now();
      probeConsole().then(up => {
        if (up !== state.consoleUp) setState({consoleUp: up});
      }).catch(() => {}).finally(() => { probingConsole = false; });
    }
    if (state.phase === 'running' || state.phase === 'setup') {
      readStatus();
      const report = readReport(), pipeline = readPipeline(), progress = computeProgress();
      const before = JSON.stringify([state.report, state.pipeline, state.progress]);
      const after = JSON.stringify([report, pipeline, progress]);
      if (before !== after) setState({report, pipeline, progress});
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

function runStream(file, args, {cwd, env, prefix, timeoutMs, ipc, onMessage}) {
  return new Promise(resolve => {
    addLine(`${prefix}$ ${path.basename(file)} ${args.join(' ')}`);
    const options = {cwd: cwd || ROOT, env: env || process.env, windowsHide: true};
    // The held-RPC pipeline needs an IPC channel to report `held-ready` and to
    // receive `{type:'release'}` when the user retires the endpoint.
    if (ipc) options.stdio = ['ignore', 'pipe', 'pipe', 'ipc'];
    const p = spawn(file, args, options);
    child = p;
    if (ipc && typeof onMessage === 'function') p.on('message', message => onMessage(message, p));
    let settled = false;
    let timer = null;
    const finish = code => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child = null;
      // Grandchildren (e.g. the bridge started by the setup script) inherit our pipes,
      // so `close` can never fire. Resolve on `exit` and drop the streams.
      try { p.stdout && p.stdout.destroy(); } catch {}
      try { p.stderr && p.stderr.destroy(); } catch {}
      resolve(code);
    };
    const onData = d => addLine(String(d).split(/\r?\n/).filter(Boolean).map(l => prefix + l).join('\n'));
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', err => { addLine(`${prefix}spawn error: ${err.message}`); finish(-1); });
    p.on('exit', code => setTimeout(() => finish(code === null ? -1 : code), 300));
    if (timeoutMs) {
      timer = setTimeout(() => {
        addLine(`${prefix}timed out after ${Math.round(timeoutMs / 1000)} s; stopping it`);
        killTree();
        finish(-1);
      }, timeoutMs);
    }
  });
}

function killTree() {
  const p = child;
  if (!p) return;
  child = null;
  try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], {windowsHide: true}); } catch {}
}

async function stopEverything(reason) {
  killTree();
  addLine(`[gui] ${reason}`);
  await new Promise(resolve => {
    const p = spawn('node', [path.join(TOOLS, 'rpc-tool.cjs'), 'stop-all'], {cwd: ROOT, windowsHide: true});
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 15000);
    p.on('close', () => { clearTimeout(timer); resolve(); });
    p.on('error', () => { clearTimeout(timer); resolve(); });
  });
}

// The setup script is per platform; both do the same steps.
const SETUP_SCRIPT = process.platform === 'win32'
  ? {command: 'powershell',
    args: ['-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'launch', 'windows', 'setup.ps1')]}
  : {command: 'bash', args: [path.join(ROOT, 'launch', 'unix', 'setup.sh')]};

async function setupBoot() {
  setState({phase: 'setup', message: 'Setting up the boot: stop-all, shim, mounts, bridge ...'});
  const code = await runStream(SETUP_SCRIPT.command, SETUP_SCRIPT.args,
    {prefix: '[setup] ', timeoutMs: 10 * 60 * 1000});
  if (code !== 0) return 'console setup failed (see log)';

  const ping = await new Promise(resolve => {
    let out = '';
    const p = spawn('node', [path.join(TOOLS, 'rpc-tool.cjs'), 'ping'], {cwd: ROOT, windowsHide: true});
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', () => resolve(out));
    p.on('error', () => resolve(''));
  });
  if (!/pong/.test(ping)) return 'bridge ping failed';
  addLine('[gui] bridge: pong');

  try {
    const conn = JSON.parse(fs.readFileSync(path.join(ROOT, 'ns2jb-main', 'ns2jb-main', 'engine', 'connection.json'), 'utf8'));
    const mounts = JSON.parse(fs.readFileSync(path.join(SWITCH2, 'app', 'mounts.json'), 'utf8'));
    if (mounts.sdk !== conn.addresses.sdk) {
      return `mounts sdk mismatch (${mounts.sdk} != ${conn.addresses.sdk})`;
    }
    addLine(`[gui] mounts sdk ${mounts.sdk} matches`);
  } catch (err) {
    return `mounts check failed: ${err.message}`;
  }

  // Do not open a second save mount here. `save-list --clean` perturbs the FS
  // heap immediately before the probe and can stop the positive canary
  // overwrite (docs/FINDINGS.md 3.5: "Opening a storage before the wave
  // perturbs the FS heap and can stop the overwrite from changing the canary
  // at all"). The probe removes leftover NS2_GAP_* trees itself with the save
  // clone it already owns, so this extra cleanup is redundant as well as
  // harmful. Run `node tools/save-list.cjs --clean` by hand only if a boot
  // fails with insufficient save space.
  addLine('[gui] save cleanup skipped (the probe removes NS2_GAP_* itself)');
  return null;
}

// Pipeline overrides for the next Start, read from <repo>/env.txt and then
// <repo>/env.local.txt (see tools/env.cjs). The same files feed ns2-run.cjs, so
// a boot can be A/B tested with either entry point.
function extraEnv() {
  return loadEnv();
}

// Alias-bucket rotation: each Start/Auto attempt uses the next 16 KiB-aligned
// file offset. A boot with only stableLink candidates is usually the wrong
// cache bucket; retrying another window can expose changedLink/changedHeader
// candidates without a code change.
//
// The offset is copied through the FS path normalizer, which validates UTF-8.
// 0x28000 steps put 0x80 in the offset's byte1 (e.g. 0x1428000), and the
// planner's fatal TextDecoder then throws "The encoded data was not valid for
// encoding utf-8". Keep every byte of the offset below 0x80; 0x50000 steps
// keep byte1 at 0 while still changing the cache bucket by 20 entries.
let aliasOffsetCursor = 0;
function applyAliasOffset(extra) {
  const raw = extra.NS2_ALIAS_OFFSETS;
  if (!raw) return;
  const offsets = String(raw).split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isSafeInteger(value) && value >= 0 && value % 0x4000 === 0 &&
      [0, 8, 16, 24].every(shift => ((value >>> shift) & 0xff) < 0x80));
  if (!offsets.length) return;
  const offset = offsets[aliasOffsetCursor++ % offsets.length];
  extra.NS2_ALIAS_OFFSET = '0x' + offset.toString(16);
}

// One acquisition per boot: Start is refused until the app is relaunched.
let bootFresh = true;

async function runPipeline() {
  setState({phase: 'running', message: 'Pipeline running ...', pipeline: null, report: null});
  // One directory per run: every log, capture and proof the pipeline writes is
  // routed there by engine/shared/paths.cjs (NS2_RUN_DIR is inherited).
  const prepared = prepareRun();
  RUN = prepared.dir;
  addLine(`[gui] run directory: ${RUN}`);
  try { fs.rmSync(path.join(RUN, 'pipeline.json'), {force: true}); } catch {}
  const extra = prepared.env;
  applyAliasOffset(extra);
  const env = {...process.env, NS2_FAST: '1', NS2_WAVE_SETTLE_MS: '1000',
    NS2_PROBE: path.join(SWITCH2, 'memory', 'probe-reserved-gap-seedsow.cjs'),
    NS2_ACQUIRE_TIMEOUT_MS: '2700000', NS2_ACQUIRE_ATTEMPTS: '1', ...extra};
  if (Object.keys(extra).length) addLine('[gui] env overrides: ' +
    Object.entries(extra).filter(([key]) => key !== 'NS2_RUN_DIR')
      .map(([key, value]) => `${key}=${value}`).join(' '));
  // Start kaiHEN's bootstrap after the pipeline has launched the RO
  // replacement and holds the retained endpoint. tools/hen.cjs maps
  // bootstrap.bin into FS; the bootstrap then starts HEN through the Loader.
  let henDetail = null;
  async function runTool(script, args = []) {
    addLine(`[hen] $ node ${script} ${args.join(' ')}`.trim());
    return new Promise(resolve => {
      // Same environment the pipeline gets, including env.txt/env.local.txt:
      // tools/hen.cjs reads NS2_KAIHEN_* / NS2_SKIP_GAME_ARM style switches from
      // there, and passing only process.env silently ignored them.
      const p = spawn('node', [path.join(TOOLS, script), ...args],
        {cwd: ROOT, windowsHide: true, env: {...env, ...(RUN ? {NS2_RUN_DIR: RUN} : {})}});
      const onData = d => {
        const lines = String(d).split(/\r?\n/).filter(Boolean);
        if (lines.length) henDetail = lines[lines.length - 1];
        if (lines.length) addLine(lines.map(l => '[hen] ' + l).join('\n'));
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      p.on('error', error => { addLine(`[hen] spawn error: ${error.message}`); resolve(-1); });
      p.on('close', code => resolve(code === null ? -1 : code));
    });
  }
  // The pipeline always runs the HEN path. The research holds are not exposed
  // by this controller; if one arrives anyway, release it immediately.
  let henOutcome = null, henOk = null;
  const code = await runStream('node',
    ['pipeline.cjs', '--hen'], {
    cwd: SWITCH2, env, prefix: '[run] ', ipc: true,
    onMessage: message => {
      if (message?.type !== 'held-ready') return;
      pipelineHeld = true;
      if (message.mode !== 'hen') {
        addLine(`[gui] ${message.mode || 'research'} hold released automatically.`);
        releasePipeline((message.mode || 'research') + ' hold', false);
        return;
      }
      setState({phase: 'running', message: 'RO replacement held. Starting kaiHEN ...',
        pipeline: readPipeline(), report: readReport(),
        progress: computeProgress() || state.progress});
      addLine(`[gui] RO replacement held (session ${message.session}).`);
      runTool('hen.cjs').then(henCode => {
        henOk = henCode === 0;
        henOutcome = henOk
          ? 'kaiHEN is running. Quit Seedsow, then hold R while launching a native game.'
          : 'kaiHEN startup failed: ' + (henDetail || 'see the log.');
        addLine(henOk ? '[gui] kaiHEN started. Press HOME, quit Seedsow, then hold R on a native game.'
          : '[gui] kaiHEN startup failed.');
        releasePipeline(henOk ? 'kaiHEN started' : 'kaiHEN startup failed', henOk);
      }).catch(error => {
        henOk = false;
        henOutcome = 'kaiHEN startup error: ' + error.message;
        addLine('[gui] HEN startup error: ' + error.message);
        releasePipeline('HEN startup error', false);
      });
    }
  });
  pipelineHeld = false;
  if (stopping) {
    setState({phase: 'finished', message: 'Stopped.', pipeline: readPipeline(),
      report: readReport(), progress: computeProgress() || state.progress, finishedAt: Date.now()});
    return {failed: false, stopped: true};
  }

  const pipeline = readPipeline();
  const report = readReport();
  const bad = pipeline && pipeline.stages.filter(s => s.status === 'failed').pop();
  const stage = bad ? bad.name : (henOk === false ? 'kaiHEN' : null);
  const failed = code !== 0 || Boolean(bad) || henOk === false;
  // Retrying only makes sense for the boot lottery. Once stage 3 starts, the FS
  // state is native and the app usually cannot be relaunched cleanly.
  const beforeStage3 = Boolean(bad
    ? ['app/map', 'FS read, write and restoration'].includes(bad.name)
    : henOk !== false);
  let message;
  if (henOutcome) {
    message = henOutcome;
  } else if (report && report.memoryReady && !bad) {
    message = 'Pipeline finished.';
  } else if (report && /No changedLink candidate/.test(report.error || '')) {
    message = 'Boot rejected (no usable address plan).';
  } else if (bad) {
    message = `Failed at ${bad.name}: ${bad.error || 'see the log.'}`;
  } else {
    message = `Pipeline exited with code ${code}.`;
  }
  const hints = failed ? failureHints(stage,
    bad?.error || henDetail || henOutcome || report?.error || '', beforeStage3) : [];
  if (failed) message = [message, ...hints].join('\n');
  setState({phase: 'finished', message, pipeline, report,
    // A confirmed HEN start is the end of stage 4 even if status.txt was not
    // written; keep the bar and the stage chip consistent at 4/4.
    progress: henOk === true
      ? {stage: 4, percent: 100, label: 'kaiHEN Startup Complete', detail: ''}
      : (computeProgress() || state.progress),
    ...(failed ? {stage: '[failed] ' + (stage || 'run')}
      : henOk === true ? {stage: '[4/4] kaiHEN Startup Complete'} : {}),
    finishedAt: Date.now()});
  if (report) {
    addLine(`[gui] probe: ${report.file} memoryReady=${report.memoryReady} strong=${report.strong} weak=${report.weak} stable=${report.stable} cleanedUp=${report.cleanedUp} ${report.error ? 'error=' + report.error : ''}`);
    if (/Insufficient save space/i.test(report.error || ''))
      addLine('[gui] save is full; run "node tools/save-list.cjs --clean" once, then power-cycle and Start.');
  }
  if (failed) {
    const cleanup = pipeline && pipeline.failureCleanup ? 'retained state retired'
      : pipeline && pipeline.cleanupError ? 'cleanup failed: ' + String(pipeline.cleanupError).split('\n')[0]
      : 'no cleanup recorded';
    addLine(`[gui] failure cleanup: ${cleanup}`);
    addLine(`[gui] failed at ${stage || 'setup'}; boot is used up.`);
    for (const hint of hints) addLine('[gui] ' + hint);
  } else {
    bootFresh = false;
  }
  return {failed, beforeStage3, stage};
}

let busy = false;
let autoRunning = false;
// Set by the Stop button. A stop is not a failed attempt: it must not run the
// attempt-failed cleanup, retry, or report a stage. It also aborts a controller
// restart while it is waiting for the console.
let stopping = false;

// A failed attempt always runs the "Attempt failed" cleanup: stop the run and
// the bridge, and mark this boot used up, so the next Start cannot reuse a
// dirtied FS heap. Automatic runs then relaunch the app themselves.
async function markAttemptFailed(reason, beforeStage3 = false, stage = null, error = '') {
  const hints = failureHints(stage, error || reason, beforeStage3);
  const message = [reason, ...hints].join('\n');
  setState({phase: 'failed', message: `${reason} Stopping the run ...`, finishedAt: Date.now()});
  await stopEverything('attempt failed; boot marked dead');
  killTree();
  pipelineHeld = false;
  bootFresh = true;
  setState({phase: 'failed', message, finishedAt: Date.now()});
  for (const hint of hints) addLine('[gui] ' + hint);
}

// Auto mode: the stage-2 acquisition is a per-boot lottery, so when a run fails
// before 3/4 relaunch the app and try another boot. Never auto-retries a stage-3
// failure: the FS is in native state there and needs a power-cycle.
async function autoRun(options = {}) {
  if (autoRunning) return {ok: false, error: 'an auto run is already active'};
  const total = Math.min(20, Math.max(1, Number(options.attempts) || 1));
  const aPresses = Number(options.aPresses) === 1 ? 1 : 2;
  const yDelayMs = Math.min(60000, Math.max(0, Number(options.yDelayMs ?? 3000)));
  autoRunning = true;
  stopping = false;
  let badBoots = 0;
  try {
    for (let attempt = 1; attempt <= total; attempt++) {
      if (total > 1) addLine(`[auto] attempt ${attempt}/${total}`);
      const result = await startRun({keepLog: attempt > 1});
      if (stopping || result.stopped) return result;
      if (!result.ok) {
        await markAttemptFailed(result.error ? `Setup failed: ${result.error}.` : 'Setup failed.', true);
        return result;
      }
      if (!result.failed) return result;           // success
      if (!result.beforeStage3) {
        addLine(`[auto] failed at ${result.stage || 'stage 3+'}; not restarting automatically (stage 3+ needs a console restart)`);
        await markAttemptFailed(`Failed at ${result.stage || 'stage 3+'}.`, false, result.stage,
          state.report?.error || result.stage || '');
        return result;
      }
      // The acquisition needs a changedLink cache candidate; boots without one
      // are refused on purpose (stable-only plans wedge the FS). Retries only
      // help because relaunching the app re-perturbs the FS cache.
      const reason = (state.report && state.report.error) || '';
      if (/No changedLink candidate/i.test(reason)) {
        badBoots++;
        addLine(`[auto] no changedLink candidate on this boot (${badBoots} in a row) - relaunching`);
        if (badBoots >= 3) {
          addLine('[auto] three bad boots in a row: a console restart changes the FS cache layout more than an app relaunch');
          badBoots = 0;
        }
      } else {
        badBoots = 0;
      }
      if (attempt >= total) {
        addLine('[auto] out of attempts');
        await markAttemptFailed(total > 1 ? 'Out of attempts.' : 'Attempt failed.', true);
        return result;
      }
      addLine(`[auto] failed at ${result.stage}; restarting the app for another boot`);
      const restarted = await restartGame(aPresses, yDelayMs);
      if (stopping || restarted.stopped) return result;
      if (!restarted.consoleUp) {
        addLine('[auto] restart did not bring the console back; stopping');
        await markAttemptFailed('Restart did not bring the console back.', false);
        return result;
      }
      await sleep(1500);
    }
    return {ok: true};
  } finally {
    autoRunning = false;
  }
}

async function startRun(options = {}) {
  if (busy || state.phase === 'setup' || state.phase === 'running') {
    return {ok: false, error: 'a run is already active'};
  }
  // One acquisition per boot: a second probe on the same process runs against a
  // dirtied FS heap and is the usual way a boot turns into a hard reboot.
  if (!bootFresh) {
    return {ok: false, error: 'This boot was already used. Relaunch Seedsow, then press "Attempt failed" (or Restart Game) before Start.'};
  }
  busy = true;
  try {
    // The line sequence is never reset: the browser filters on `seq > lastSeq`,
    // and a reset made it drop every line of the new run whenever a late line
    // from the previous run landed between the click and this point.
    if (!options.keepLog) { state.lines.length = 0; }
    state.startedAt = Date.now(); state.finishedAt = null;
    state.stages = []; state.report = null; state.pipeline = null; state.progress = null;
    // Each Start opens a fresh run directory, so status.txt cannot be stale;
    // only the UI stage chip needs clearing.
    setState({stage: ''});
    addLine(`[gui] console ${CONSOLE}`);
    const extra = extraEnv();
    const up = await probeConsole();
    setState({consoleUp: up});
    if (stopping) return {ok: false, stopped: true};
    if (!up) {
      setState({phase: 'idle', message: 'Console HTTP is down - start Seedsow and press Y, then press Start.'});
      addLine('[gui] console 8080 is not reachable');
      return {ok: false, error: 'console not reachable'};
    }
    const problem = await setupBoot();
    if (stopping) return {ok: false, stopped: true};
    if (problem) {
      const tail = state.lines.slice(-20).map(l => l.text).join('\n');
      const wedged = /never answered|not reachable/i.test(tail);
      const message = wedged
        ? '/eval is not answering. If Seedsow is running, its HTTP handler is wedged - close the game, start it again, press Y, then Start.'
        : `Setup failed: ${problem}`;
      setState({phase: 'finished', message, finishedAt: Date.now()});
      return {ok: false, error: problem};
    }
    bootFresh = false;
    const outcome = await runPipeline();
    return {ok: true, ...outcome};
  } finally {
    busy = false;
  }
}

const PAGE = path.join(__dirname, 'ns2-gui.html');

const server = http.createServer(async (req, res) => {  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, {'content-type': type, 'cache-control': 'no-store'});
    res.end(body);
  };
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/console-host') {
      return send(200, JSON.stringify({host: consoleHost(),
        override: process.env.NS2_CONSOLE || null,
        file: path.join(TOOLS, 'console-host.txt')}));
    }
    if (req.method === 'POST' && url.pathname === '/api/console-host') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
      const host = String(body.host || '').trim();
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host)) {
        return send(400, JSON.stringify({error: 'that is not a valid IPv4 address or host name'}));
      }
      try {
        require(path.join(TOOLS, 'console-host.cjs')).writeConsoleHost(host);
        CONSOLE = host;
        const up = await probeConsole();
        setState({consoleUp: up});
        addLine(`[gui] console address set to ${host} (${up ? 'HTTP is up' : 'HTTP is not answering'})`);
        return send(200, JSON.stringify({ok: true, host, consoleUp: up,
          note: process.env.NS2_CONSOLE
            ? 'NS2_CONSOLE is set in the environment, so it still overrides this value.'
            : 'Press Start to restart the bridge on this address.'}));
      } catch (error) {
        return send(500, JSON.stringify({error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/kaihen/upload') {
      let body = {};
      try {
        body = JSON.parse((await readBody(req, 32 * 1024 * 1024)) || '{}');
      } catch (error) {
        return send(400, JSON.stringify({ok: false, error: 'invalid upload body'}));
      }
      try {
        const target = kaihenTarget(body.path);
        const bytes = Buffer.from(String(body.data || ''), 'base64');
        if (!bytes.length) throw Error('empty file');
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, bytes);
        return send(200, JSON.stringify({ok: true,
          path: path.relative(KAIHEN, target).split(path.sep).join('/'), size: bytes.length}));
      } catch (error) {
        addLine(`[gui] kaiHEN upload failed: ${error.message}`);
        return send(400, JSON.stringify({ok: false, error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/kaihen/validate') {
      try {
        const {checkDir, required} = require(path.join(TOOLS, 'update-kaihen.cjs'));
        checkDir(KAIHEN);
        const files = required.filter(rel => fs.statSync(path.join(KAIHEN, rel), {throwIfNoEntry: false})?.isFile());
        addLine(`[gui] kaiHEN updated: ${files.join(', ')}`);
        return send(200, JSON.stringify({ok: true, dir: KAIHEN, files}));
      } catch (error) {
        addLine(`[gui] kaiHEN update incomplete: ${error.message}`);
        return send(400, JSON.stringify({ok: false, error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/console-only-upload') {
      if (runActive())
        return send(409, JSON.stringify({ok: false,
          error: 'A run is active; stop it before uploading the console-only save.'}));
      addLine('[gui] console-only upload: press Y at the Seedsow launcher first.');
      try {
        const code = await runStream('node', [path.join(ROOT, 'console-only', 'upload.cjs')],
          {cwd: ROOT, env: {...process.env, NS2_CONSOLE: CONSOLE}, prefix: '[console] '});
        return send(code === 0 ? 200 : 500, JSON.stringify({ok: code === 0, code}));
      } catch (error) {
        addLine(`[gui] console-only upload failed: ${error.message}`);
        return send(500, JSON.stringify({ok: false, error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/prepare-sd') {
      if (runActive())
        return send(409, JSON.stringify({ok: false,
          error: 'A run is active; stop it before preparing the SD card.'}));
      addLine('[gui] Prepare SD: choose the SD card root in the folder dialog ...');
      try {
        const code = await runStream('node', [path.join(TOOLS, 'prepare-sd.cjs')],
          {cwd: ROOT, env: {...process.env}, prefix: '[sd] '});
        return send(code === 0 ? 200 : 500, JSON.stringify({ok: code === 0, code}));
      } catch (error) {
        addLine(`[gui] Prepare SD failed: ${error.message}`);
        return send(500, JSON.stringify({ok: false, error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/kaihen/latest') {
      if (runActive())
        return send(409, JSON.stringify({ok: false,
          error: 'A run is active; stop it before updating kaiHEN.'}));
      addLine('[gui] kaiHEN: checking the latest release ...');
      try {
        const result = await KAIHEN_RELEASE.updateFromLatest();
        addLine(`[gui] kaiHEN ${result.tag}: ${result.count} file(s) copied into kaihen/`);
        return send(200, JSON.stringify({ok: true, ...result}));
      } catch (error) {
        addLine(`[gui] kaiHEN auto-update failed: ${error.message}`);
        return send(500, JSON.stringify({ok: false, error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/update/check') {
      try {
        const result = await SELF_UPDATE.check({root: ROOT});
        addLine(result.update
          ? `[gui] update available: ${result.label} (local V${result.local.version})`
          : `[gui] up to date (V${result.local.version})`);
        return send(200, JSON.stringify({ok: true, ...result}));
      } catch (error) {
        addLine(`[gui] update check failed: ${error.message}`);
        return send(500, JSON.stringify({ok: false, error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/update/apply') {
      if (runActive())
        return send(409, JSON.stringify({ok: false,
          error: 'A run is active; stop it before updating.'}));
      addLine('[gui] update: downloading the new repository ...');
      let prepared;
      try {
        prepared = await SELF_UPDATE.prepare({root: ROOT});
      } catch (error) {
        addLine(`[gui] update download failed: ${error.message}`);
        return send(500, JSON.stringify({ok: false, error: error.message}));
      }
      const localVersion = SELF_UPDATE.readVersion(ROOT).version;
      if (Number(prepared.version) <= Number(localVersion)) {
        SELF_UPDATE.cleanup(prepared);
        addLine(`[gui] update: already up to date (V${localVersion})`);
        return send(409, JSON.stringify({ok: false,
          error: `already up to date (V${localVersion})`}));
      }
      addLine(`[gui] update V${prepared.version} downloaded; stopping the GUI ...`);
      try {
        await stopEverything('update: stopping the bridge before the GUI exits');
      } catch (error) {
        addLine(`[gui] update: bridge stop failed (continuing): ${error.message}`);
      }
      const helperArgs = [path.join(TOOLS, 'self-update.cjs'),
        '--apply', prepared.dir,
        '--temp', prepared.temp,
        '--version', prepared.version,
        '--commit', prepared.commit || '',
        '--wait-pid', String(process.pid),
        '--restart'];
      let helper;
      try {
        helper = spawn(process.execPath, helperArgs, {cwd: ROOT, env: process.env,
          detached: true, stdio: 'ignore', windowsHide: true});
        helper.unref();
      } catch (error) {
        addLine(`[gui] update helper failed to start: ${error.message}`);
        return send(500, JSON.stringify({ok: false, error: error.message}));
      }
      if (!helper.pid) {
        addLine('[gui] update helper did not start');
        return send(500, JSON.stringify({ok: false, error: 'the update helper did not start'}));
      }
      addLine(`[gui] update helper pid ${helper.pid}; the GUI will restart after the copy`);
      send(200, JSON.stringify({ok: true, version: prepared.version}));
      setTimeout(() => { try { server.close(); } catch {} process.exit(0); }, 700);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(200, JSON.stringify({...publicState(), logSeq: state.seq}));
    }
    if (req.method === 'GET' && url.pathname === '/api/log') {
      const since = Number(url.searchParams.get('since') || 0);
      return send(200, JSON.stringify({seq: state.seq, lines: state.lines.filter(l => l.seq > since)}));
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache',
        connection: 'keep-alive'});
      res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
      for (const l of state.lines.slice(-400)) res.write(`event: line\ndata: ${JSON.stringify(l)}\n\n`);
      clients.add(res);
      const keep = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(keep); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
      if (busy || autoRunning) return send(409, JSON.stringify({ok: false, error: 'a run is already active'}));
      const options = {attempts: body.attempts, aPresses: body.aPresses, yDelayMs: body.yDelayMs};
      // Run in the background; the page follows the run over /api/events.
      autoRun(options).catch(error => addLine(`[auto] stopped: ${error.message}`));
      return send(200, JSON.stringify({ok: true, started: true,
        attempts: Math.min(10, Math.max(1, Number(options.attempts) || 1))}));
    }
    if (req.method === 'GET' && url.pathname === '/api/controller-status') {
      // Pass the bridge's own answer through: any controller may add fields.
      try {
        const reply = await controller.status();
        return send(200, JSON.stringify({ok: true, ...reply}));
      } catch (error) {
        return send(200, JSON.stringify({ok: false, error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/controller-tap') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
      const raw = Array.isArray(body.buttons) ? body.buttons : [body.button];
      const buttons = raw.map(value => String(value || '').toUpperCase()).filter(Boolean);
      if (!buttons.length || buttons.length > 8) {
        return send(400, JSON.stringify({error: 'send one to eight buttons'}));
      }
      const unknown = buttons.find(button => !CONTROLLER_BUTTONS.has(button));
      if (unknown) return send(400, JSON.stringify({error: `unknown button ${unknown}`}));
      const down = Math.min(5, Math.max(0.05, Number(body.down) || 0.12));
      const up = Math.min(5, Math.max(0.08, Number(body.up) || 0.16));
      const label = buttons.join('+');
      try {
        const reply = await controllerTap(buttons, down, up);
        addLine(`[ctl] tap ${label} (${Math.round(down * 1000)} ms)`);
        controllerProblems(label, reply);
        return send(200, JSON.stringify({ok: true, buttons, confirmed: reply.confirmed,
          errors: reply.errors || []}));
      } catch (error) {
        addLine(`[ctl] tap ${label} failed: ${error.message}`);
        return send(502, JSON.stringify({error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/controller-stop') {
      try {
        await controller.stop();
        addLine('[ctl] stop: queue dropped, all buttons released');
        return send(200, JSON.stringify({ok: true}));
      } catch (error) {
        addLine(`[ctl] stop failed: ${error.message}`);
        return send(502, JSON.stringify({error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/restart-game') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
      const aPresses = Number(body.aPresses) === 1 ? 1 : 2;
      const yDelayMs = Math.min(60000, Math.max(0, Number(body.yDelayMs ?? 3000)));
      restartGame(aPresses, yDelayMs);
      return send(200, JSON.stringify({ok: true, aPresses, yDelayMs}));
    }
    if (req.method === 'POST' && url.pathname === '/api/failed') {
      const bad = state.pipeline?.stages?.find(s => s.status === 'failed');
      await markAttemptFailed('Attempt failed.', false, bad?.name || null,
        bad?.error || state.report?.error || '');
      return send(200, JSON.stringify({ok: true}));
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      stopping = true;
      if (pipelineHeld && releasePipeline('stop', false)) {
        // Retire the held endpoint cleanly instead of killing the pipeline; the
        // pipeline exits after acquisition.retire() completes.
        setState({phase: 'running', message: 'Releasing the held endpoint ...'});
      } else {
        killTree();
        markStopped();
      }
      return send(200, JSON.stringify({ok: true}));
    }
    if (req.method === 'POST' && url.pathname === '/api/controller-sequence') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
      try {
        await runSequence(body.steps);
        return send(200, JSON.stringify({ok: true}));
      } catch (error) {
        addLine('[ctl] sequence failed: ' + error.message);
        return send(400, JSON.stringify({error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/quit') {
      if (state.phase === 'setup' || state.phase === 'running' || state.phase === 'restarting')
        return send(409, JSON.stringify({error: 'A run is active; stop it first.'}));
      if (pipelineHeld)
        return send(409, JSON.stringify({error: 'The FS endpoint is still being released; wait for the run to finish.'}));
      addLine('[gui] stop requested; stopping the GUI');
      send(200, JSON.stringify({ok: true}));
      setTimeout(() => process.exit(0), 250);
      return;
    }
    return send(404, JSON.stringify({error: 'not found'}));
  } catch (err) {
    return send(500, JSON.stringify({error: err.message}));
  }
});

// Dumps and save pulls can take minutes; do not time the request out.
server.requestTimeout = 0;
server.listen(PORT, '127.0.0.1', () => {
  addLine(`[gui] listening on http://127.0.0.1:${PORT} (console ${CONSOLE})`);
  poller().catch(() => {});
});
server.on('error', err => {
  console.error(`cannot listen on 127.0.0.1:${PORT}: ${err.message}`);
  process.exit(1);
});
