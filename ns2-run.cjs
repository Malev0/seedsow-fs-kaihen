#!/usr/bin/env node
'use strict';
// One run from a terminal: setup, pipeline, kaiHEN.
//
// This is the same sequence the web GUI performs, with the stage lines printed
// as they happen. Every artifact lands in runs/switch-XXXXX (the directory is
// printed first and on failure).
//
//   node ns2-run.cjs                       one run with <repo>/kaihen
//   node ns2-run.cjs --ip 192.168.1.50     save the console address first
//   node ns2-run.cjs --dir D:\kaiHEN-...   use another kaiHEN release folder
//   node ns2-run.cjs --no-setup            skip stop-all/shim/mounts/bridge
//   node ns2-run.cjs --probe               run the RO probe instead of HEN
//   node ns2-run.cjs --update-kaihen <dir> replace <repo>/kaihen, then run
const fs = require('node:fs');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {prepareRun, root} = require('./tools/env.cjs');
const {update: updateKaihen} = require('./tools/update-kaihen.cjs');
const {writeConsoleHost} = require('./tools/console-host.cjs');
const kaihenRelease = require('./tools/kaihen-release.cjs');
const selfUpdate = require('./tools/self-update.cjs');

const TOOLS = path.join(root, 'tools');
const SWITCH2 = path.join(root, 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2');
const PIPELINE = path.join(SWITCH2, 'pipeline.cjs');

// Children are tracked so Ctrl-C can stop the pipeline, the HEN start and the
// bridge together. Without this a failed CLI run leaves the bridge alive and
// the next boot's setup fails with `ERR bind 98` on the console RPC port.
const activeChildren = new Set();
function track(child) {
  activeChildren.add(child);
  child.once('close', () => activeChildren.delete(child));
  return child;
}
function killTree() {
  for (const child of activeChildren) {
    try {
      if (process.platform === 'win32')
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true});
      else {
        try { spawn('pkill', ['-P', String(child.pid)]); } catch {}
        child.kill('SIGKILL');
      }
    } catch {}
  }
  activeChildren.clear();
}
function stopAllSync() {
  try {
    spawnSync(process.execPath, [path.join(TOOLS, 'rpc-tool.cjs'), 'stop-all'],
      {cwd: root, windowsHide: true, stdio: 'ignore', timeout: 15000});
  } catch {}
}
async function stopAll() {
  console.error('cleaning up the bridge and console RPC loop ...');
  await new Promise(resolve => {
    const child = track(spawn(process.execPath, [path.join(TOOLS, 'rpc-tool.cjs'), 'stop-all'],
      {cwd: root, windowsHide: true, stdio: 'ignore'}));
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 15000);
    child.on('close', () => { clearTimeout(timer); resolve(); });
    child.on('error', () => { clearTimeout(timer); resolve(); });
  });
}
process.once('SIGINT', () => { killTree(); stopAllSync(); process.exit(130); });
process.once('SIGTERM', () => { killTree(); stopAllSync(); process.exit(143); });

const USAGE = `usage: node ns2-run.cjs [options]

  --ip <address>          save the console address to tools/console-host.txt
  --dir <folder>          use kaiHEN from <folder> instead of <repo>/kaihen
  --update-kaihen <dir>   copy <dir> over <repo>/kaihen first
  --update-kaihen-latest  download the latest kaiHEN release into <repo>/kaihen
  --check-updates         check this kit for a newer version
  --self-update           download and apply the latest kit, keeping kaihen/
  --version               print the local version
  --no-setup              skip stop-all, shim upload, mounts and bridge start
  --probe                 run the RO instruction probe instead of HEN
  -h, --help              show this text`;

function parse(argv) {
  const options = {setup: true, mode: '--hen', dir: null, update: null, ip: null,
    updateKaihenLatest: false, checkUpdates: false, selfUpdate: false, version: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { console.log(USAGE); process.exit(0); }
    else if (arg === '--no-setup') options.setup = false;
    else if (arg === '--probe') options.mode = '--probe';
    else if (arg === '--update-kaihen-latest') options.updateKaihenLatest = true;
    else if (arg === '--check-updates') options.checkUpdates = true;
    else if (arg === '--self-update') options.selfUpdate = true;
    else if (arg === '--version') options.version = true;
    else if (arg === '--ip') {
      const value = argv[++i];
      if (!value) throw Error('--ip needs an address');
      options.ip = value;
    }
    else if (arg === '--dir' || arg === '--update-kaihen') {
      const value = argv[++i];
      if (!value) throw Error(arg + ' needs a folder');
      if (arg === '--dir') options.dir = value; else options.update = value;
    } else throw Error('unknown argument: ' + arg);
  }
  if (options.update) options.dir = options.update;
  return options;
}

function run(file, args, options = {}) {
  return new Promise(resolve => {
    const child = track(spawn(file, args, {stdio: 'inherit', windowsHide: true, ...options}));
    child.on('error', error => { console.error(error.message); resolve(-1); });
    child.on('close', code => resolve(code === null ? -1 : code));
  });
}

// The --hen pipeline holds the retained FS endpoint open and waits for an IPC
// release message. Run tools/hen.cjs during that hold, then release with the
// real outcome, exactly like the GUI. Without the IPC parent the pipeline
// retires the endpoint first and hen.cjs fails with "A ready retained endpoint
// on the current boot is required".
function runPipelineHen(env) {
  return new Promise(resolve => {
    const child = track(spawn(process.execPath, [PIPELINE, '--hen'],
      {cwd: SWITCH2, env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc']}));
    let settled = false, held = false, henRan = false, henOk = null;
    const finish = code => {
      if (settled) return;
      settled = true;
      resolve({code: code === null ? -1 : code, henRan, henOk});
    };
    const release = (ok, reason) => {
      if (!held) return;
      held = false;
      try { child.send({type: 'release', ok, reason}); } catch {}
    };
    child.on('message', message => {
      if (message?.type !== 'held-ready') return;
      held = true;
      if (message.mode !== 'hen') {
        release(false, (message.mode || 'research') + ' hold');
        return;
      }
      henRan = true;
      console.log('\nRO replacement held; starting kaiHEN ...');
      run(process.execPath, [path.join(TOOLS, 'hen.cjs')], {cwd: root, env})
        .then(code => {
          henOk = code === 0;
          console.log(henOk ? 'kaiHEN started.' : 'kaiHEN startup failed.');
          release(henOk, henOk ? 'kaiHEN started' : 'kaiHEN startup failed');
        })
        .catch(error => {
          henOk = false;
          console.error('HEN startup error: ' + error.message);
          release(false, 'HEN startup error: ' + error.message);
        });
    });
    child.on('error', error => { console.error('pipeline spawn error: ' + error.message); finish(-1); });
    child.on('exit', code => {
      // If the pipeline dies while HEN is still starting, do not leave the
      // hen.cjs child (and its console connection) running.
      if (henRan && henOk === null) killTree();
      setTimeout(() => finish(code), 300);
    });
  });
}

function stages(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'pipeline.json'), 'utf8')).stages || []; }
  catch { return []; }
}

function printStages(dir) {
  const rows = stages(dir);
  if (!rows.length) return;
  console.log('\nstages:');
  for (const row of rows) {
    const mark = row.status === 'complete' ? 'ok  ' : row.status === 'failed' ? 'FAIL' : '... ';
    console.log(`  ${mark} ${row.name}`);
  }
  const failed = rows.find(row => row.status === 'failed');
  if (failed) console.log('\n' + String(failed.error || '').split('\n').slice(0, 6).join('\n'));
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.version) {
    console.log(`V${selfUpdate.readVersion(root).version}`);
    return 0;
  }
  if (options.updateKaihenLatest) {
    const result = await kaihenRelease.updateFromLatest();
    console.log(`kaiHEN ${result.tag}: ${result.count} file(s) copied into kaihen/`);
    return 0;
  }
  if (options.checkUpdates) {
    const result = await selfUpdate.check({root});
    console.log(result.update
      ? `update available: ${result.label} (local V${result.local.version})`
      : `up to date (V${result.local.version})`);
    if (result.note) console.log(result.note);
    return 0;
  }
  if (options.selfUpdate) {
    const preparedUpdate = await selfUpdate.prepare({root});
    try {
      const localVersion = selfUpdate.readVersion(root).version;
      if (Number(preparedUpdate.version) <= Number(localVersion)) {
        console.log(`already up to date (V${localVersion})`);
        return 0;
      }
      const result = selfUpdate.applyPrepared(preparedUpdate, {root});
      console.log(`updated to V${result.version}: ${result.count} file(s); ` +
        'kept kaihen/, runs/, env.local.txt and tools/console-host.txt');
    } finally {
      selfUpdate.cleanup(preparedUpdate);
    }
    return 0;
  }
  if (options.update) {
    const result = updateKaihen(options.update);
    console.log(`kaihen: replaced ${result.count} files in ${result.target} from ${result.source}`);
  }
  if (options.ip) {
    try {
      const host = writeConsoleHost(options.ip);
      console.log(`console: ${host} (saved to tools/console-host.txt)`);
      if (process.env.NS2_CONSOLE)
        console.log('warning: NS2_CONSOLE is set and overrides the saved address');
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  }
  // NS2_RUN_DIR is inherited by the pipeline, its stage children and hen.cjs.
  const prepared = prepareRun(options.dir ? {KAIHEN_SHIP: options.dir, KAIHEN_DIR: options.dir} : {});
  const runDir = prepared.dir;
  const env = {...process.env, ...prepared.env};
  // The GUI's working defaults. env.txt/env.local.txt (prepared.env) win; these
  // only fill the gaps that made a stock CLI run use the generic probe or the
  // wrong acquisition timeouts.
  env.NS2_FAST ??= '1';
  env.NS2_WAVE_SETTLE_MS ??= '1000';
  env.NS2_ACQUIRE_TIMEOUT_MS ??= '2700000';
  env.NS2_ACQUIRE_ATTEMPTS ??= '1';
  env.NS2_PROBE ??= path.join(SWITCH2, 'memory', 'probe-reserved-gap-seedsow.cjs');
  if (options.ip) env.NS2_CONSOLE = options.ip;
  console.log(`run directory: ${runDir}`);
  if (options.dir) console.log(`kaiHEN: ${path.resolve(options.dir)}`);

  if (options.setup) {
    const [command, args] = process.platform === 'win32'
      ? ['powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'launch', 'windows', 'setup.ps1')]]
      : ['bash', [path.join(root, 'launch', 'unix', 'setup.sh')]];
    const setup = await run(command, args, {cwd: root, env});
    if (setup !== 0) {
      console.error('setup failed (launch/' + (process.platform === 'win32' ? 'windows' : 'unix') + ')');
      await stopAll();
      return 1;
    }
    const ping = await run(process.execPath, [path.join(TOOLS, 'rpc-tool.cjs'), 'ping'], {cwd: root, env});
    if (ping !== 0) {
      console.error('bridge ping failed');
      await stopAll();
      return 1;
    }
  }

  if (options.mode === '--probe') {
    const pipeline = await run(process.execPath, [PIPELINE, options.mode], {cwd: SWITCH2, env});
    const rows = stages(runDir);
    printStages(runDir);
    if (pipeline !== 0 || rows.some(row => row.status === 'failed')) {
      console.error(`\nrun failed; artifacts in ${runDir}\nRelaunch Seedsow, press Y, then run again.`);
      await stopAll();
      return 1;
    }
    console.log(`\nRO probe complete; artifacts in ${runDir}`);
    return 0;
  }

  const outcome = await runPipelineHen(env);
  const rows = stages(runDir);
  printStages(runDir);
  const failed = outcome.code !== 0 || rows.some(row => row.status === 'failed') ||
    outcome.henOk !== true;
  if (failed) {
    if (!outcome.henRan) console.error('\nkaiHEN hand-off never started; the pipeline did not hold the FS endpoint.');
    console.error(`\nrun failed; artifacts in ${runDir}\nRelaunch Seedsow, press Y, then run again.`);
    await stopAll();
    return 1;
  }
  console.log(`\nkaiHEN started. Quit the game, then hold R while launching a native game.\nartifacts: ${runDir}`);
  return 0;
}

main().then(code => { process.exitCode = code; })
  .catch(async error => {
    console.error(error.message);
    killTree();
    await stopAll();
    process.exitCode = 1;
  });
