#!/usr/bin/env node
'use strict';
// Collect the facts a run depends on, so a console whose build differs from the
// one this port was developed against can be compared without guessing.
//
//   node tools/preflight.cjs            # human-readable report
//   node tools/preflight.cjs --json     # one JSON object (send this back)
//
// Everything is best effort: a console that is off, an app that is not running
// or a missing shim only removes that line from the report.
const {execFileSync} = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const json = process.argv.includes('--json');
const report = {at: new Date().toISOString(), repo: ROOT, checks: {}};

function step(name, run) {
  try {
    report.checks[name] = {ok: true, value: run()};
  } catch (error) {
    report.checks[name] = {ok: false, error: String(error.message || error).split('\n')[0]};
  }
}

const run = (file, args, timeout = 20000) => {
  try {
    return execFileSync(file, args, {cwd: ROOT, encoding: 'utf8', timeout,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}).trim();
  } catch (error) {
    // Keep the tool's own last line: "bridge: connect ECONNREFUSED" says far
    // more than "Command failed".
    const detail = String(error.stderr || error.stdout || '').trim().split('\n')
      .filter(line => line.trim() && !/^\s+at\s/.test(line) && !/^Node\.js v/.test(line)).pop();
    throw Error(detail || error.message);
  }
};

step('runtime', () => ({node: process.version, platform: process.platform}));

step('env', () => {
  const {loadEnv} = require('./env.cjs');
  const env = loadEnv();
  const keys = Object.keys(env).filter(key => key.startsWith('NS2_')).sort();
  return {count: keys.length,
    key: Object.fromEntries(['NS2_HEN', 'NS2_SKIP_GAME_ARM', 'NS2_HEN_RETIRE', 'NS2_RETIRE_LEAK',
      'NS2_HEN_DETACH', 'NS2_POST_START_OPEN', 'NS2_LAUNCH_MOUNT', 'NS2_CONNECT_OFFSET',
      'NS2_COMMIT_MB', 'NS2_ALIAS_OFFSETS'].map(k => [k, env[k]]))};
});

step('kaihen', () => {
  const files = ['ro/main', 'hen/main', 'game/main', 'bootstrap.bin', 'hbmenu.nro'];
  return Object.fromEntries(files.map(name => {
    const file = path.join(ROOT, 'kaihen', name);
    const bytes = fs.readFileSync(file);
    return [name, {size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')}];
  }));
});

step('console-host', () => {
  const file = path.join(ROOT, 'tools', 'console-host.txt');
  return {file, host: fs.readFileSync(file, 'utf8').trim().split('\n')[0]};
});

step('controller', () => {
  const controller = require('./controller.cjs');
  const {host, port, file} = controller.connection();
  return {file, host, port};
});

step('engine-connection', () => {
  // Written by the bridge when it connects: the console's SDK/main/scratch
  // addresses. A retail build with a different SDK shows up here first.
  const file = path.join(ROOT, 'ns2jb-main', 'ns2jb-main', 'engine', 'connection.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return value.addresses;
});

step('bridge', () => {
  // Needs the bridge running (resume.ps1 starts it).
  return run('node', [path.join(ROOT, 'tools', 'rpc-tool.cjs'), 'status']);
});

step('save', () => {
  // Needs the console shim loaded; lists the save and its free space.
  return run('node', [path.join(ROOT, 'tools', 'save-list.cjs')]);
});

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const [name, check] of Object.entries(report.checks)) {
    if (!check.ok) { console.log(name.padEnd(20) + ' -  ' + check.error); continue; }
    const value = check.value;
    if (value && typeof value === 'object' && !Array.isArray(value))
      for (const [key, item] of Object.entries(value))
        console.log((name + '.' + key).padEnd(28) + ' ' +
          (item && typeof item === 'object' ? JSON.stringify(item) : item));
    else console.log(name.padEnd(28) + ' ' + value);
  }
  console.log('\nSend the output of `node tools/preflight.cjs --json` with any report.');
}
