const fs = require('node:fs');
const path = require('node:path');

// Where run artifacts live.
//
// A run is one Start: acquisition, launch, HEN. Every report, capture and log
// it produces goes into <repo>/runs/switch-XXXXX so the tree does not fill up
// with per-boot files spread over ro/, retained/, memory/ and app/.
//
// The entry point (gui/ns2-gui.cjs or ns2-run.cjs) opens the run and exports
// NS2_RUN_DIR, which children inherit. Anything started without an entry point
// falls back to the historical in-tree directories.
const engine = path.resolve(__dirname, '..');                 // engine/
const switch2 = path.resolve(__dirname, '..', 'switch2');     // engine/switch2
const root = path.resolve(__dirname, '..', '..', '..', '..'); // repository root

const RUN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// Mirrors engine/ inside the run so runPath('switch2', 'ro', name) and
// artifactDir(engine/switch2/ro) resolve to the same file.
const RUN_SUBDIRS = ['switch2', 'switch2/ro', 'switch2/retained', 'switch2/memory', 'switch2/app'];

function runName() {
  let name = '';
  for (let i = 0; i < 5; i++)
    name += RUN_ALPHABET[Math.floor(Math.random() * RUN_ALPHABET.length)];
  return 'switch-' + name;
}

// Create (or adopt) the directory for this run and export it to children.
// No default from NS2_RUN_DIR on purpose: an entry point that opens a run wants
// a new one, while children simply read runDirectory().
function openRun(explicitDir) {
  const runs = path.join(root, 'runs');
  fs.mkdirSync(runs, {recursive: true});
  let dir;
  if (explicitDir) {
    dir = path.resolve(explicitDir);
  } else {
    for (;;) {
      dir = path.join(runs, runName());
      try {
        fs.mkdirSync(dir);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  }
  for (const sub of ['', ...RUN_SUBDIRS]) fs.mkdirSync(path.join(dir, sub), {recursive: true});
  process.env.NS2_RUN_DIR = dir;
  // The GUI and the CLI both read this, and a failed run is easier to inspect
  // when the newest directory is easy to find.
  fs.writeFileSync(path.join(runs, 'latest.txt'), dir + '\n');
  return dir;
}

const runDirectory = () => process.env.NS2_RUN_DIR
  ? path.resolve(process.env.NS2_RUN_DIR)
  : null;

function runPath(...parts) {
  const dir = runDirectory();
  return path.join(dir || engine, ...parts);
}

// Boot state shared between runs (the bridge and the acquisition rewrite it):
// it must not move into a run directory, or a child started with a different
// run context cannot find the endpoint.
function statePath(...parts) {
  return path.join(switch2, ...parts);
}

// Output directory for a module: the engine layout is mirrored inside the run,
// so engine/switch2/ro writes to runs/<run>/switch2/ro and runPath('switch2',
// 'ro', ...) names the same directory.
function artifactDir(moduleDir) {
  const dir = runDirectory();
  if (!dir) return moduleDir;
  const target = path.join(dir, path.relative(engine, moduleDir));
  fs.mkdirSync(target, {recursive: true});
  return target;
}

module.exports = {root, engine, switch2, openRun, runName, runDirectory, runPath,
  statePath, artifactDir};
