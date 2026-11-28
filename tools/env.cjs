'use strict';
// The run environment, independent of how the run was started.
//
// `env.txt` holds the committed defaults and `env.local.txt` is read after it,
// so a machine can override anything without touching the defaults. Both live
// at the repository root; the GUI and `ns2-run.cjs` load the same files and
// pass the result to the pipeline and to tools/hen.cjs.
const fs = require('node:fs');
const path = require('node:path');
const {openRun, runDirectory} = require('../ns2jb-main/ns2jb-main/engine/shared/paths.cjs');
const {normalizeRelease} = require('./update-kaihen.cjs');

const root = path.resolve(__dirname, '..');

// One KEY=VALUE per line. Blank lines and # comments are ignored.
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

function loadEnv() {
  return {...readEnvFile(path.join(root, 'env.txt')),
    ...readEnvFile(path.join(root, 'env.local.txt'))};
}

// Open a fresh run directory and return it with the environment that should
// reach the pipeline and hen.cjs. Always fresh: the auto-retry loop calls this
// once per attempt, and reusing the previous attempt's directory mixed two
// boots' proofs (and left pipeline.json behind).
function prepareRun(extra = {}) {
  // 20261128 keeps ro/main inside sdcard/kaihen/bin; the pipeline still reads
  // <repo>/kaihen/ro/main. Normalize before every run so a manually copied
  // release works as well as one installed by the updater.
  try { normalizeRelease(path.join(root, 'kaihen')); } catch {}
  const previous = runDirectory();
  const dir = openRun();
  if (previous && previous !== dir)
    console.warn(`[run] new run directory: ${dir} (previous: ${previous})`);
  return {dir, env: {...loadEnv(), ...extra, NS2_RUN_DIR: dir}};
}

module.exports = {root, readEnvFile, loadEnv, prepareRun};
