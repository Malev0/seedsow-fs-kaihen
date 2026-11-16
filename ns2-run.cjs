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
const {spawn} = require('node:child_process');
const {prepareRun, root} = require('./tools/env.cjs');
const {update: updateKaihen} = require('./tools/update-kaihen.cjs');
const {writeConsoleHost} = require('./tools/console-host.cjs');

const TOOLS = path.join(root, 'tools');
const SWITCH2 = path.join(root, 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2');
const PIPELINE = path.join(SWITCH2, 'pipeline.cjs');

const USAGE = `usage: node ns2-run.cjs [options]

  --ip <address>          save the console address to tools/console-host.txt
  --dir <folder>          use kaiHEN from <folder> instead of <repo>/kaihen
  --update-kaihen <dir>   copy <dir> over <repo>/kaihen first
  --no-setup              skip stop-all, shim upload, mounts and bridge start
  --probe                 run the RO instruction probe instead of HEN
  -h, --help              show this text`;

function parse(argv) {
  const options = {setup: true, mode: '--hen', dir: null, update: null, ip: null};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { console.log(USAGE); process.exit(0); }
    else if (arg === '--no-setup') options.setup = false;
    else if (arg === '--probe') options.mode = '--probe';
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
    const child = spawn(file, args, {stdio: 'inherit', windowsHide: true, ...options});
    const stop = () => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true}); } catch {} };
    process.once('SIGINT', stop);
    child.on('error', error => { console.error(error.message); resolve(-1); });
    child.on('close', code => { process.removeListener('SIGINT', stop); resolve(code === null ? -1 : code); });
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
  if (options.ip) env.NS2_CONSOLE = options.ip;
  console.log(`run directory: ${runDir}`);
  if (options.dir) console.log(`kaiHEN: ${path.resolve(options.dir)}`);

  if (options.setup) {
    const [command, args] = process.platform === 'win32'
      ? ['powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'launch', 'windows', 'setup.ps1')]]
      : ['bash', [path.join(root, 'launch', 'unix', 'setup.sh')]];
    const setup = await run(command, args, {cwd: root, env});
    if (setup !== 0) { console.error('setup failed (launch/' + (process.platform === 'win32' ? 'windows' : 'unix') + ')'); return 1; }
    const ping = await run(process.execPath, [path.join(TOOLS, 'rpc-tool.cjs'), 'ping'], {cwd: root, env});
    if (ping !== 0) { console.error('bridge ping failed'); return 1; }
  }

  const pipeline = await run(process.execPath, [PIPELINE, options.mode], {cwd: SWITCH2, env});
  const rows = stages(runDir);
  printStages(runDir);
  if (pipeline !== 0 || rows.some(row => row.status === 'failed')) {
    console.error(`\nrun failed; artifacts in ${runDir}`);
    return 1;
  }
  if (options.mode === '--probe') {
    console.log(`\nRO probe complete; artifacts in ${runDir}`);
    return 0;
  }

  const hen = await run(process.execPath, [path.join(TOOLS, 'hen.cjs')], {cwd: root, env});
  console.log(hen === 0
    ? `\nkaiHEN started. Quit the game, then hold R while launching a native game.\nartifacts: ${runDir}`
    : `\nkaiHEN startup failed; artifacts: ${runDir}`);
  return hen === 0 ? 0 : 1;
}

main().then(code => { process.exitCode = code; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
