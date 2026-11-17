'use strict';
// Self-update for the Seedsow FS kaiHEN kit.
//
// The GUI downloads and extracts the new repository while it is still running,
// then exits. This script (the copy already on disk) waits for the GUI PID to
// disappear, copies the new tree over the old one, keeps the local kaihen/,
// runs/ and machine-specific files, and starts the GUI again.
//
// The helper is part of the downloaded tree, so the copy also replaces this
// file. That is deliberate: the next update runs the new updater.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {download, getJson, getText, extract} = require('./zip.cjs');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'Malev0';
const REPO = 'seedsow-fs-kaihen';
const BRANCH = 'main';
const RAW_VERSION = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/version.json`;
const ARCHIVE = `https://github.com/${OWNER}/${REPO}/archive/refs/heads/${BRANCH}.zip`;
const COMMIT_API = `https://api.github.com/repos/${OWNER}/${REPO}/commits/${BRANCH}`;

// Local-only paths that an update must never replace. `kaihen` is the
// downloaded release (the "hen folder"); runs/ and env.local.txt are user data.
const EXCLUDED = new Set([
  'kaihen', 'runs', '.git', 'node_modules', 'env.local.txt',
  'tools/console-host.txt', 'self-update.log',
]);

function readVersion(root = ROOT) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
    const version = Number(value.version);
    return {version: Number.isInteger(version) && version >= 0 ? version : 0,
      commit: String(value.commit || '')};
  } catch {
    return {version: 0, commit: ''};
  }
}

// Versions are plain integers: 1, 2, 3, ...
function compareVersions(left, right) {
  const a = Number(left) || 0, b = Number(right) || 0;
  return a === b ? 0 : a > b ? 1 : -1;
}

function hasRepo(dir) {
  // tools/self-update.cjs is deliberately not required: an older archive may
  // not have it yet, and in that case the local updater script is retained.
  return ['gui/ns2-gui.cjs', 'ns2-run.cjs', 'tools/update-kaihen.cjs']
    .every(rel => fs.statSync(path.join(dir, rel), {throwIfNoEntry: false})?.isFile());
}

function findRepoRoot(directory) {
  const queue = [directory];
  while (queue.length) {
    const dir = queue.shift();
    if (hasRepo(dir)) return dir;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
    }
  }
  throw Error('the downloaded archive does not look like the seedsow-fs-kaihen repository');
}

async function check(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const local = readVersion(root);
  try {
    const text = await getText(`${RAW_VERSION}?t=${Date.now()}`,
      {headers: {'cache-control': 'no-cache'}});
    const remote = JSON.parse(text);
    const version = Number(remote.version);
    if (!Number.isInteger(version) || version < 0)
      throw Error('version.json must contain an integer version');
    return {update: compareVersions(version, local.version) > 0,
      source: 'version', local, remote: {version, commit: remote.commit || ''},
      version, label: `V${version}`};
  } catch (versionError) {
    // Before the first version.json is pushed, use the latest commit. The local
    // version file can carry that commit so a developer tree does not report
    // its own unpushed work as an update.
    let commit;
    try { commit = await getJson(COMMIT_API); }
    catch (error) {
      throw Error(`could not read the remote version or commit: ${versionError.message}; ${error.message}`);
    }
    const sha = String(commit.sha || '');
    // Keep the UI on integer versions. Without a published version.json there
    // is no release number to compare, so report up to date and ask the
    // maintainer to publish it rather than showing a commit hash as a version.
    return {update: false, source: 'commit', local,
      remote: {version: local.version, commit: sha,
        date: commit.commit?.author?.date || null},
      version: local.version, label: `V${local.version}`,
      note: 'remote version.json is missing; publish it to enable updates'};
  }
}

async function prepare(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ns2-self-update-'));
  try {
    const zipFile = path.join(temp, 'repo.zip');
    await download(ARCHIVE, zipFile, {timeout: 10 * 60 * 1000});
    const extracted = path.join(temp, 'repo');
    extract(zipFile, extracted);
    const dir = findRepoRoot(extracted);
    const remote = readVersion(dir);
    return {dir, temp, version: remote.version, commit: remote.commit,
      archive: ARCHIVE, root};
  } catch (error) {
    try { fs.rmSync(temp, {recursive: true, force: true}); } catch {}
    throw error;
  }
}

function copyTree(from, to, relative, result) {
  for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (EXCLUDED.has(rel) || rel.startsWith('kaihen/')) continue;
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(target, {recursive: true});
      copyTree(source, target, rel, result);
      continue;
    }
    if (!entry.isFile()) continue;
    fs.mkdirSync(path.dirname(target), {recursive: true});
    try { fs.chmodSync(target, 0o666); } catch {}
    fs.copyFileSync(source, target);
    result.files.push(rel);
  }
}

function applyPrepared(prepared, options = {}) {
  const root = path.resolve(options.root || ROOT);
  if (!prepared?.dir || !fs.statSync(prepared.dir, {throwIfNoEntry: false})?.isDirectory())
    throw Error('the prepared update folder is missing');
  const result = {target: root, files: []};
  copyTree(prepared.dir, root, '', result);
  const remote = readVersion(prepared.dir);
  const version = Number(prepared.version ?? remote.version ?? readVersion(root).version);
  if (!Number.isInteger(version) || version < 0)
    throw Error('the downloaded version.json must contain an integer version');
  const commit = String(prepared.commit || remote.commit || '');
  const versionFile = {version, updatedAt: new Date().toISOString()};
  if (commit) versionFile.commit = commit;
  fs.writeFileSync(path.join(root, 'version.json'),
    JSON.stringify(versionFile, null, 2) + '\n');
  result.version = version;
  result.commit = commit;
  result.count = result.files.length;
  result.retained = ['kaihen', 'runs', 'env.local.txt', 'tools/console-host.txt'];
  return result;
}

function cleanup(prepared) {
  if (prepared?.temp) {
    try { fs.rmSync(prepared.temp, {recursive: true, force: true}); } catch {}
  }
}

function logLine(root, text) {
  const line = `${new Date().toISOString()} ${text}\n`;
  try { fs.appendFileSync(path.join(root, 'self-update.log'), line); } catch {}
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function waitForExit(pid, timeoutMs = 60000) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return !isAlive(pid);
}

function restartGui(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const child = spawn(process.execPath, [path.join(root, 'gui', 'ns2-gui.cjs')], {
    cwd: root, env: process.env, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function parse(argv) {
  const out = {root: ROOT, restart: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') out.check = true;
    else if (arg === '--update') out.update = true;
    else if (arg === '--apply') out.apply = argv[++i];
    else if (arg === '--temp') out.temp = argv[++i];
    else if (arg === '--version') out.version = argv[++i];
    else if (arg === '--commit') out.commit = argv[++i];
    else if (arg === '--wait-pid') out.waitPid = Number(argv[++i]);
    else if (arg === '--restart') out.restart = true;
    else if (arg === '--root') out.root = path.resolve(argv[++i]);
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw Error(`unknown argument: ${arg}`);
  }
  return out;
}

const USAGE = `usage: node tools/self-update.cjs [options]

  --check                 compare version.json with the repository
  --update                download and apply the latest repository now
  --apply <folder>        apply an already extracted repository
  --temp <folder>         temporary folder to remove after --apply
  --version <version>     version to write after --apply
  --commit <sha>          commit to write after --apply
  --wait-pid <pid>        wait for this process to exit before --apply
  --restart               start the GUI after --apply
  --root <folder>         target repository (default: this checkout)`;

if (require.main === module) {
  const args = parse(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
  } else if (args.check) {
    check({root: args.root}).then(result => {
      console.log(args.json ? JSON.stringify(result, null, 2) :
        (result.update ? `update available: ${result.label} (local V${result.local.version})`
          : `up to date (V${result.local.version})`));
    }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  } else if (args.update) {
    (async () => {
      const prepared = await prepare({root: args.root});
      try {
        const result = applyPrepared(prepared, {root: args.root});
        console.log(JSON.stringify(result, null, 2));
      } finally {
        cleanup(prepared);
      }
    })().catch(error => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
  } else if (args.apply) {
    (async () => {
      const root = path.resolve(args.root || ROOT);
      logLine(root, `update: waiting for GUI pid ${args.waitPid || 0}`);
      if (!(await waitForExit(args.waitPid))) {
        logLine(root, 'update aborted: the GUI did not exit');
        if (args.restart) restartGui({root});
        process.exitCode = 1;
        return;
      }
      try {
        const result = applyPrepared({dir: args.apply, temp: args.temp,
          version: args.version, commit: args.commit}, {root});
        logLine(root, `update: applied ${result.count} file(s), version ${result.version}`);
        logLine(root, 'update: retained kaihen/, runs/, env.local.txt and tools/console-host.txt');
        if (args.restart) logLine(root, `update: restarting the GUI (pid ${restartGui({root})})`);
      } catch (error) {
        logLine(root, `update failed: ${error.stack || error.message}`);
        if (args.restart) {
          try { restartGui({root}); } catch {}
        }
        process.exitCode = 1;
      } finally {
        if (args.temp) {
          try { fs.rmSync(args.temp, {recursive: true, force: true}); } catch {}
        }
      }
    })();
  } else {
    console.log(USAGE);
  }
}

module.exports = {ROOT, EXCLUDED, readVersion, compareVersions, check, prepare,
  applyPrepared, cleanup, waitForExit, restartGui, findRepoRoot, hasRepo};
