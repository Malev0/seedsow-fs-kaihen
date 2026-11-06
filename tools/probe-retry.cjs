#!/usr/bin/env node
// Runs probe-reserved-gap-seedsow.cjs, retrying while it fails *cleanly*
// (cleanedUp true) so a boot-geometry miss costs ~90 s instead of a relaunch.
// Stops immediately when the console is left dirty (a relaunch is then required).
//   node probe-retry.cjs [attempts] [extra args...]
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const attempts = Number(process.argv[2] || 4);
const PROJECT = path.resolve(__dirname, '..');
const top = fs.readdirSync(PROJECT).find(n => /2jb-main$/.test(n));
const nested = fs.readdirSync(path.join(PROJECT, top)).find(n => /2jb-main$/.test(n));
const engine = path.join(PROJECT, top, nested, 'engine', 'switch2');
const probe = path.join(engine, 'memory', 'probe-reserved-gap-seedsow.cjs');

function once(index) {
  return new Promise(resolve => {
    console.log(`=== probe attempt ${index}/${attempts} ===`);
    const child = spawn(process.execPath, [probe], {cwd: engine,
      stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, NS2_FAST: '1'}});
    let summary = null, tail = '';
    let buffer = '';
    const scan = chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.includes('"stage":"memory-ready"')) console.log('>>> memory-ready');
        if (line.includes('"stage":"bounded-failure"')) console.log('>>> ' + line.slice(0, 200));
        if (line.includes('"cleanedUp"') && line.includes('"completed"')) {
          try {summary = JSON.parse(line);} catch { /* partial */ }
        }
        if (line.length < 2000) tail = line;
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('close', code => {
      if (!summary) {
        try {summary = JSON.parse(tail);} catch { /* keep null */ }
      }
      resolve({code, summary});
    });
  });
}

(async () => {
  for (let i = 1; i <= attempts; i++) {
    const {code, summary} = await once(i);
    if (!summary) {console.log('no summary; stopping'); process.exitCode = 1; return;}
    console.log(JSON.stringify({completed: summary.completed, cleanedUp: summary.cleanedUp,
      qualifiedReadSize: summary.qualifiedReadSize, error: summary.error && summary.error.split('\n')[0]}));
    if (summary.completed && summary.qualifiedReadSize) {console.log('OK'); return;}
    if (!summary.cleanedUp) {console.log('console left dirty (or wedged); relaunch required'); process.exitCode = 2; return;}
    if (code === 0 && summary.completed) {console.log('probe completed without qualifying'); return;}
    console.log('clean failure; retrying');
  }
  process.exitCode = 3;
})();
