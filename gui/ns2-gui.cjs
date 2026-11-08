#!/usr/bin/env node
// Small manual controller for the Seedsow run.
//
//   Start                  -> resume.ps1 (stop-all, shim upload/reload, mounts, bridge)
//                             then `node pipeline.cjs --dump-firmware`
//   App crashed/relaunched -> stop the run, kill the bridge, mark the boot dead
//   Stop                   -> stop the running child tree
//   Clean save             -> node save-list.cjs --clean
//
// API (also usable from tools): GET /api/state, GET /api/log, POST /api/start,
// POST /api/crashed, POST /api/stop, POST /api/clean, GET /api/events (SSE).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const {spawn} = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const SWITCH2 = path.join(ROOT, 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2');
const PIPELINE = path.join(SWITCH2, 'pipeline.cjs');
const STATUS = path.join(SWITCH2, 'status.txt');
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
  'process/bind-notifier', 'process/qualify', 'FS instruction challenges',
  'Enumerate and capture installed system code', 'Remove RO donor files', 'Release FS resources',
];

function laneProgress(plan, done) {
  let index = -1;
  plan.forEach((name, i) => { if (done.has(name)) index = i; });
  const steps = Math.max(0, index + 1);
  return {steps, total: plan.length, percent: Math.round((steps / plan.length) * 100)};
}

function computeProgress() {
  const pipeline = readPipeline();
  const report = readReport();
  const rows = pipeline?.stages || [];
  if (rows.some(s => s.status === 'failed')) return null;
  const done = new Set(rows.filter(s => s.status === 'complete').map(s => s.name));

  if (!done.has('app/map')) {
    return {stage: 1, percent: 0, label: 'mapping the application', detail: ''};
  }
  if (!(report && report.memoryReady)) {
    const p = report?.progress;
    return {stage: 2, percent: p ? p.percent : 0,
      label: p ? p.label : 'starting the probe',
      detail: p && p.profile ? p.profile : ''};
  }
  if (!done.has('Restore Loader session')) {
    const lane = laneProgress(STAGE3_PLAN, done);
    return {stage: 3, percent: lane.percent, label: `${lane.steps}/${lane.total} RO steps`, detail: ''};
  }
  const lane = laneProgress(STAGE4_PLAN, done);
  return {stage: 4, percent: lane.percent, label: `${lane.steps}/${lane.total} process steps`, detail: ''};
}
const clients = new Set();
let child = null;
// Set while the pipeline is holding the FS endpoint after stage 4. The pipeline
// child stays alive on its IPC channel until the GUI sends {type:'release'}.
let held = null;

function publicState() {
  return {
    phase: state.phase, message: state.message, consoleUp: state.consoleUp,
    stage: state.stage, stages: state.stages, report: state.report,
    pipeline: state.pipeline, progress: state.progress,
    startedAt: state.startedAt, finishedAt: state.finishedAt,
    console: CONSOLE, logSeq: state.seq,
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

function readStatus() {
  try {
    const text = fs.readFileSync(STATUS, 'utf8').trim();
    if (text !== state.stage) setState({stage: text});
  } catch {}
}

function readPipeline() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(SWITCH2, 'pipeline.json'), 'utf8'));
    return {
      stages: (p.stages || []).map(s => ({name: s.name, status: s.status,
        error: s.error ? String(s.error).split('\n')[0] : null})),
    };
  } catch { return null; }
}

function readReport() {
  try {
    const dir = path.join(SWITCH2, 'memory');
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

// ---- Pico W controller bridge (set NS2_PICO_CONN to its seedsow-connection.json) --
// The bridge serves POST /tap {button,down,up} on 127.0.0.1:39391 with a bearer
// token from seedsow-connection.json; the Pico times HOLD/SLEEP/RELEASE itself.
const PICO_CONN_FILE = process.env.NS2_PICO_CONN ||
  path.join(TOOLS, 'seedsow-connection.json');

function picoConnection() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(PICO_CONN_FILE, 'utf8')); }
  catch (error) { throw Error(`cannot read ${PICO_CONN_FILE} (${error.message})`); }
  if (!raw || typeof raw.token !== 'string' || !raw.token) throw Error('the Pico bridge connection file has no token');
  return {host: raw.host || '127.0.0.1', port: Number(raw.port) || 39391, token: raw.token};
}

async function picoCall(path, body) {
  const {host, port, token} = picoConnection();
  const init = {method: body === undefined ? 'GET' : 'POST',
    headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15000)};
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(`http://${host}:${port}${path}`, init);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw Error(`${path}: ${data && data.error ? data.error : `HTTP ${res.status}`}`);
  return data;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function picoTap(buttons, down = 0.12, up = 0.16) {
  const list = Array.isArray(buttons) ? buttons : [buttons];
  return (await picoCall('/tap', {buttons: list, down, up})) || {};
}

// The bridge answers MARK once the Pico executed the press, so a tap can report
// "rejected by the firmware" or "no confirmation" instead of failing silently.
function picoTapProblems(label, reply) {
  if (reply.errors && reply.errors.length) {
    addLine(`[pico] ${label} rejected: ${reply.errors.join('; ')}`);
    return true;
  }
  if (reply.confirmed === false) {
    addLine(`[pico] ${label}: the Pico did not confirm the press (queued, not acknowledged)`);
    return true;
  }
  return false;
}

// Manual controller surface. Must match pico_bridge.py's ALL_BUTTONS.
const PICO_BUTTONS = new Set(['A', 'B', 'X', 'Y', 'L', 'R', 'ZL', 'ZR', 'PLUS', 'MINUS',
  'HOME', 'CAPTURE', 'L_STICK', 'R_STICK', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT']);

// Restart Game: same cleanup as "App crashed / relaunched", then the controller
// sequence HOME, X, A, A(xN), Y. The second A block is 2 presses by default and 1
// when the caller asks for it (e.g. after removing a profile).
async function restartGame(aPresses, yDelayMs) {
  if (state.phase === 'restarting') return {ok: false, error: 'a restart is already in progress'};
  const presses = Number(aPresses) === 1 ? 1 : 2;
  const yDelay = Math.min(60000, Math.max(0, Number(yDelayMs ?? 3000)));
  setState({phase: 'restarting', message: 'Restarting: stopping the run, then sending controller input ...'});
  addLine(`[pico] restart-game: second A block = ${presses} press(es); Y delay = ${yDelay} ms`);
  try {
    await stopEverything('restart-game: stopped the run and the bridge');
    killTree();
    const status = await picoCall('/status');
    const controller = status && status.controller ? status.controller.state : 'unknown';
    addLine(`[pico] bridge ok (controller: ${controller})`);
    const sequence = [
      {button: 'HOME', wait: 1000, label: 'HOME'},
      {button: 'X', wait: 1000, label: 'X'},
      {button: 'A', wait: 1000, label: 'A'},
      ...Array.from({length: presses}, (_, index) => ({button: 'A',
        wait: index === presses - 1 ? yDelay : 180, label: `A (${index + 1}/${presses})`})),
      {button: 'Y', wait: 0, label: 'Y'},
    ];
    for (const step of sequence) {
      const reply = await picoTap(step.button, 0.15, 0.2);
      addLine(`[pico] ${step.label}`);
      picoTapProblems(step.label, reply);
      if (step.wait) await sleep(step.wait);
    }
    addLine('[pico] sequence sent; waiting for the console HTTP server');
    setState({message: 'Sequence sent. Waiting for the console ...'});
    const deadline = Date.now() + 90000;
    let up = false;
    while (Date.now() < deadline) {
      up = await probeConsole();
      if (up) break;
      await sleep(2000);
    }
    if (up) {
      addLine('[pico] console is up');
      bootFresh = true;
      setState({phase: 'idle', message: 'Console restarted - press Start to set up this boot.'});
    } else {
      addLine('[pico] console did not answer within 90 s');
      setState({phase: 'crashed', message: 'Controller sequence sent, but the console HTTP server is still down - check the screen.'});
    }
    return {ok: true, consoleUp: up};
  } catch (error) {
    addLine(`[pico] restart-game failed: ${error.message}`);
    setState({phase: 'crashed', message: `Restart failed: ${error.message}`});
    return {ok: false, error: error.message};
  }
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 8192) data = data.slice(0, 8192); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

function probeConsole() {
  // Re-read the host every probe so the IP field takes effect immediately.
  CONSOLE = consoleHost();
  return new Promise(resolve => {
    const socket = net.connect({host: CONSOLE, port: 8080});
    const done = ok => { try { socket.destroy(); } catch {} resolve(ok); };
    socket.setTimeout(2500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function poller() {
  for (;;) {
    const up = await probeConsole();
    if (up !== state.consoleUp) setState({consoleUp: up});
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
      // Grandchildren (e.g. the bridge started by resume.ps1) inherit our pipes,
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

async function setupBoot() {
  setState({phase: 'setup', message: 'Setting up the boot: stop-all, shim, mounts, bridge ...'});
  const code = await runStream('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'resume.ps1')],
    {prefix: '[setup] ', timeoutMs: 10 * 60 * 1000});
  if (code !== 0) return 'resume.ps1 failed (see log)';

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

  const clean = await runStream('node', [path.join(TOOLS, 'save-list.cjs'), '--clean'], {prefix: '[save] '});
  if (clean !== 0) addLine('[gui] save cleanup returned a non-zero code (continuing)');
  return null;
}

// Extra pipeline overrides for the next Start, e.g.
//   NS2_SKIP_REPRO=1
//   NS2_COMMIT_MB=8
// One KEY=VALUE per line; read on every Start so a boot can be A/B tested
// without restarting the controller. Blank lines and # comments are ignored.
// `env.local.txt` (gitignored) is read after `env.txt` and overrides it, so
// machine-specific values such as the dump host never land in the repository.
function readEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 1) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

function extraEnv() {
  return {...readEnvFile(path.join(__dirname, 'env.txt')),
    ...readEnvFile(path.join(__dirname, 'env.local.txt'))};
}

function firstLanIPv4() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const entry of list || [])
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  return null;
}

function tcpConnect(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = net.createConnection({host, port});
    let settled = false;
    const done = ok => { if (settled) return; settled = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// The flags-0 watch run has no host-side way to read the captured window; the
// slot-2 worker sends it over TCP. Refuse Start before touching the console if
// that listener is not reachable, instead of burning a boot.
async function dumpPreflight(extra) {
  if (!(extra.NS2_LAUNCH_WAIT_ONLY === '1' || extra.NS2_LAUNCH_WATCH === '1')) return null;
  const host = extra.NS2_DUMP_HOST || firstLanIPv4();
  const port = Number(extra.NS2_DUMP_PORT || 39401);
  if (!host) return 'No LAN IPv4 found; set NS2_DUMP_HOST in gui/env.local.txt.';
  if (!(await tcpConnect(host, port)))
    return `dump listener is not reachable at ${host}:${port} - start "node tools/dump-listener.cjs" and put this PC's LAN address in gui/env.local.txt (NS2_DUMP_HOST).`;
  addLine(`[gui] dump listener reachable at ${host}:${port}`);
  return null;
}

// One acquisition per boot: Start is refused until the app is relaunched.
let bootFresh = true;

async function runPipeline() {
  setState({phase: 'running', message: 'Pipeline running ...', pipeline: null, report: null});
  try { fs.rmSync(path.join(SWITCH2, 'pipeline.json'), {force: true}); } catch {}
  const extra = extraEnv();
  const env = {...process.env, NS2_FAST: '1', NS2_WAVE_SETTLE_MS: '1000',
    NS2_PROBE: path.join(SWITCH2, 'memory', 'probe-reserved-gap-seedsow.cjs'),
    NS2_ACQUIRE_TIMEOUT_MS: '2700000', NS2_ACQUIRE_ATTEMPTS: '1', ...extra};
  if (Object.keys(extra).length) addLine('[gui] env overrides: ' +
    Object.entries(extra).map(([key, value]) => `${key}=${value}`).join(' '));
  // Stage 4 is the last fixed step. Hold the FS endpoint and the console RPC
  // afterwards instead of dumping firmware, so commands can be sent without a
  // relaunch. The pipeline exits only after the GUI sends {type:'release'}.
  const code = await runStream('node', ['pipeline.cjs', '--hold-rpc'], {
    cwd: SWITCH2, env, prefix: '[run] ', ipc: true,
    onMessage: message => {
      if (message?.type === 'held-ready') {
        held = {session: message.session, at: Date.now()};
        setState({phase: 'held',
          message: 'Stage 4 passed. RPC held - use the bridge, then Release.',
          pipeline: readPipeline(), report: readReport(),
          progress: computeProgress() || state.progress});
        addLine(`[gui] stage 4 passed; RPC held (session ${message.session}).`);
        addLine('[gui] console RPC: http://127.0.0.1:31337 (rpc-run / call / read / write)');
        addLine('[gui] FS endpoint: tools/fs-memory.cjs connect(); POST /api/release to retire.');
      }
    }
  });
  held = null;

  const pipeline = readPipeline();
  const report = readReport();
  let message;
  if (report && report.memoryReady && !(pipeline && pipeline.stages.some(s => s.status === 'failed'))) {
    message = 'Pipeline finished.';
  } else if (report && /No changedLink candidate/.test(report.error || '')) {
    message = 'Boot rejected (no usable address plan). Relaunch Seedsow, press Y, then Start.';
  } else if (pipeline && pipeline.stages.length) {
    const bad = pipeline.stages.filter(s => s.status === 'failed').pop();
    message = bad ? `Failed at ${bad.name} — see log.` : 'Pipeline finished.';
  } else {
    message = `Pipeline exited with code ${code}.`;
  }
  setState({phase: 'finished', message, pipeline, report,
    progress: computeProgress() || state.progress, finishedAt: Date.now()});
  if (report) {
    addLine(`[gui] probe: ${report.file} memoryReady=${report.memoryReady} strong=${report.strong} weak=${report.weak} stable=${report.stable} cleanedUp=${report.cleanedUp} ${report.error ? 'error=' + report.error : ''}`);
  }
  const failed = code !== 0 || Boolean(pipeline && pipeline.stages.some(s => s.status === 'failed'));
  const bad = pipeline && pipeline.stages.filter(s => s.status === 'failed').pop();
  // Retrying only makes sense for the boot lottery. Once stage 3 starts, the FS
  // state is native and the app usually cannot be relaunched cleanly.
  const beforeStage3 = Boolean(bad && ['app/map', 'FS read, write and restoration'].includes(bad.name));
  if (failed) {
    const cleanup = pipeline && pipeline.failureCleanup ? 'retained state retired'
      : pipeline && pipeline.cleanupError ? 'cleanup failed: ' + String(pipeline.cleanupError).split('\n')[0]
      : 'no cleanup recorded';
    addLine(`[gui] failure cleanup: ${cleanup}`);
    addLine(`[gui] failed at ${bad ? bad.name : 'setup'}; boot is used up.`);
  } else {
    bootFresh = false;
  }
  return {failed, beforeStage3, stage: bad ? bad.name : null};
}

let busy = false;
let autoRunning = false;

// Auto mode: the stage-2 acquisition is a per-boot lottery, so when a run fails
// before 3/4 relaunch the app and try another boot. Never auto-retries a stage-3
// failure: the FS is in native state there and needs a power-cycle.
async function autoRun(options = {}) {
  if (autoRunning) return {ok: false, error: 'an auto run is already active'};
  const total = Math.min(20, Math.max(1, Number(options.attempts) || 1));
  const aPresses = Number(options.aPresses) === 1 ? 1 : 2;
  const yDelayMs = Math.min(60000, Math.max(0, Number(options.yDelayMs ?? 3000)));
  autoRunning = true;
  let badBoots = 0;
  try {
    for (let attempt = 1; attempt <= total; attempt++) {
      if (total > 1) addLine(`[auto] attempt ${attempt}/${total}`);
      const result = await startRun({keepLog: attempt > 1});
      if (!result.ok) return result;               // setup problem: do not loop
      if (!result.failed) return result;           // success
      if (!result.beforeStage3) {
        addLine(`[auto] failed at ${result.stage || 'stage 3+'}; not restarting (needs a power-cycle)`);
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
      if (attempt >= total) { addLine('[auto] out of attempts'); return result; }
      addLine(`[auto] failed at ${result.stage}; restarting the app for another boot`);
      const restarted = await restartGame(aPresses, yDelayMs);
      if (!restarted.consoleUp) { addLine('[auto] restart did not bring the console back; stopping'); return result; }
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
    return {ok: false, error: 'This boot was already used. Relaunch Seedsow, then press "App crashed / relaunched" (or Restart Game) before Start.'};
  }
  busy = true;
  try {
    // The line sequence is never reset: the browser filters on `seq > lastSeq`,
    // and a reset made it drop every line of the new run whenever a late line
    // from the previous run landed between the click and this point.
    if (!options.keepLog) { state.lines.length = 0; }
    state.startedAt = Date.now(); state.finishedAt = null;
    state.stages = []; state.report = null; state.pipeline = null; state.progress = null;
    // status.txt is stale from the previous run; clear it so the stage chips
    // start empty instead of showing an old "[1/4] app/map".
    try { fs.writeFileSync(STATUS, ''); } catch {}
    setState({stage: ''});
    addLine(`[gui] console ${CONSOLE}`);
    const extra = extraEnv();
    const dumpProblem = await dumpPreflight(extra);
    if (dumpProblem) {
      addLine('[gui] ' + dumpProblem);
      setState({phase: 'idle', message: dumpProblem});
      return {ok: false, error: dumpProblem};
    }
    if (!(await probeConsole())) {
      setState({phase: 'idle', message: 'Console HTTP is down — start Seedsow and press Y, then press Start.'});
      addLine('[gui] console 8080 is not reachable');
      return {ok: false, error: 'console not reachable'};
    }
    const problem = await setupBoot();
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
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
        fs.writeFileSync(path.join(TOOLS, 'console-host.txt'), host + '\n');
        CONSOLE = host;
        const up = await probeConsole();
        addLine(`[gui] console address set to ${host} (${up ? 'HTTP is up' : 'HTTP is not answering'})`);
        return send(200, JSON.stringify({ok: true, host, consoleUp: up,
          note: process.env.NS2_CONSOLE
            ? 'NS2_CONSOLE is set in the environment, so it still overrides this value.'
            : 'Press Start to restart the bridge on this address.'}));
      } catch (error) {
        return send(500, JSON.stringify({error: error.message}));
      }
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
    if (req.method === 'GET' && url.pathname === '/api/pico-status') {
      try {
        const status = await picoCall('/status');
        const controller = status && status.controller ? status.controller : {};
        return send(200, JSON.stringify({ok: true,
          state: controller.state || 'unknown',
          player: controller.player_number ?? null,
          device: status && status.device}));
      } catch (error) {
        return send(200, JSON.stringify({ok: false, error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/pico-tap') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
      const raw = Array.isArray(body.buttons) ? body.buttons : [body.button];
      const buttons = raw.map(value => String(value || '').toUpperCase()).filter(Boolean);
      if (!buttons.length || buttons.length > 8) {
        return send(400, JSON.stringify({error: 'send one to eight buttons'}));
      }
      const unknown = buttons.find(button => !PICO_BUTTONS.has(button));
      if (unknown) return send(400, JSON.stringify({error: `unknown button ${unknown}`}));
      const down = Math.min(5, Math.max(0.05, Number(body.down) || 0.12));
      const up = Math.min(5, Math.max(0.08, Number(body.up) || 0.16));
      const label = buttons.join('+');
      try {
        const reply = await picoTap(buttons, down, up);
        addLine(`[pico] tap ${label} (${Math.round(down * 1000)} ms)`);
        picoTapProblems(label, reply);
        return send(200, JSON.stringify({ok: true, buttons, confirmed: reply.confirmed,
          errors: reply.errors || []}));
      } catch (error) {
        addLine(`[pico] tap ${label} failed: ${error.message}`);
        return send(502, JSON.stringify({error: error.message}));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/pico-stop') {
      try {
        await picoCall('/stop', {}); // POST: the bridge only implements POST /stop
        addLine('[pico] stop: queue dropped, all buttons released');
        return send(200, JSON.stringify({ok: true}));
      } catch (error) {
        addLine(`[pico] stop failed: ${error.message}`);
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
    if (req.method === 'POST' && url.pathname === '/api/crashed') {
      await stopEverything('app reported crashed; boot marked dead');
      killTree();
      bootFresh = true;
      setState({phase: 'crashed', message: 'Marked as crashed. Restart Seedsow, press Y, then Start.',
        finishedAt: Date.now()});
      return send(200, JSON.stringify({ok: true}));
    }
    if (req.method === 'POST' && url.pathname === '/api/release') {
      if (!held) return send(409, JSON.stringify({error: 'no held run'}));
      if (!child || child.connected === false)
        return send(409, JSON.stringify({error: 'held pipeline is not connected'}));
      try { child.send({type: 'release'}); }
      catch (error) { return send(500, JSON.stringify({error: error.message})); }
      addLine('[gui] release: retiring the held FS endpoint ...');
      setState({phase: 'running', message: 'Releasing the held endpoint ...'});
      return send(200, JSON.stringify({ok: true}));
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      if (held && child && child.connected !== false) {
        // Retire the held endpoint cleanly instead of killing the pipeline; the
        // pipeline exits after acquisition.retire() completes.
        try { child.send({type: 'release'}); } catch {}
        addLine('[gui] stop: release sent; retiring the held endpoint ...');
        setState({phase: 'running', message: 'Releasing the held endpoint ...'});
      } else {
        killTree();
        setState({phase: 'finished', message: 'Stopped.', finishedAt: Date.now()});
      }
      return send(200, JSON.stringify({ok: true}));
    }
    if (req.method === 'POST' && url.pathname === '/api/clean') {
      const code = await runStream('node', [path.join(TOOLS, 'save-list.cjs'), '--clean'], {prefix: '[save] '});
      return send(200, JSON.stringify({ok: code === 0, code}));
    }
    return send(404, JSON.stringify({error: 'not found'}));
  } catch (err) {
    return send(500, JSON.stringify({error: err.message}));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  addLine(`[gui] listening on http://127.0.0.1:${PORT} (console ${CONSOLE})`);
  poller().catch(() => {});
});
server.on('error', err => {
  console.error(`cannot listen on 127.0.0.1:${PORT}: ${err.message}`);
  process.exit(1);
});
