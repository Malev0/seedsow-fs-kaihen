'use strict';
// Download the latest kaiHEN release ZIP, extract it, copy the release into
// <repo>/kaihen, and remove the temporary ZIP.
//
// kaiHEN 20261123+ ships bootstrap.bin and ro/main plus an sdcard/ folder that
// mirrors the card. Older releases have the flat layout (hbmenu.nro, ro/main,
// hen/main, game/main, programs/, licenses/). A release is allowed to wrap
// either layout in one top-level folder; findReleaseRoot() handles both.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {download, getJson, extract} = require('./zip.cjs');
const {update, isRelease} = require('./update-kaihen.cjs');

const OWNER = 'ouncebrew';
const REPO = 'kaihen';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const KAIHEN = path.join(__dirname, '..', 'kaihen');
const MARKER = path.join(KAIHEN, 'release.json');

// Known release fingerprints. The marker written by update() is the primary
// version check; this lets a hand-copied release be recognized without one.
const KNOWN_RELEASES = {
  '20261123': {
    'bootstrap.bin': '92481a1622ccde9978d789eec251d6d1d338c9bd1e6adbcc62f4057c2f188665',
    'ro/main': 'b8f289cb47b435d726bc4fd1429620721697e2a5fcd08686cf33a62dad94437b',
    'sdcard/kaihen/bin/hen/main': 'b4bc8e5610397181901048453bf18acce89a6818e53432e1460a07c41ab00cb7',
    'sdcard/kaihen/bin/game/main': '6e88c054a8ba1d16a5d57bd38be61a196954ddafa8f5233c55c9e5bcd92143f5',
    'sdcard/hbmenu.nro': '7fcc5531bde8d0b0182c36e70ef86262170cd62968745eb0f0997b7a12203517',
    'sdcard/kaihen/lib/libounce.so.1': '78769040daaf31a2d927229c3693d8cf6cdcdf17142da1aba7a5fa2efdc6ee10',
  },
};

function hasRelease(dir) {
  try { return isRelease(dir); } catch { return false; }
}

function findReleaseRoot(directory) {
  const queue = [directory];
  while (queue.length) {
    const dir = queue.shift();
    if (hasRelease(dir)) return dir;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
    }
  }
  throw Error('the kaiHEN release ZIP has no bootstrap.bin + ro/main with an sdcard/ folder or the flat layout');
}

async function latest(options = {}) {
  const release = await getJson(API, options);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const zip = assets.find(asset => /^kaiHEN-.*\.zip$/i.test(asset.name)) ||
    assets.find(asset => /\.zip$/i.test(asset.name));
  if (!zip) throw Error('the latest kaiHEN release has no ZIP asset');
  return {
    tag: release.tag_name,
    name: release.name || release.tag_name,
    publishedAt: release.published_at,
    htmlUrl: release.html_url,
    asset: {name: zip.name, url: zip.browser_download_url, size: zip.size},
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function matches(dir, files) {
  return Object.entries(files).every(([relative, hash]) => {
    try { return sha256(path.join(dir, relative)) === hash; } catch { return false; }
  });
}

function readMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch { return null; }
}

// What is actually installed in kaihen/. The marker is authoritative for a
// release the kit installed; the hashes recognize a hand-copied known release.
function localRelease() {
  const marker = readMarker();
  if (marker?.tag) {
    const known = KNOWN_RELEASES[marker.tag];
    if (known && !matches(KAIHEN, known))
      return {tag: null, source: 'marker-mismatch', markerTag: marker.tag};
    return {tag: marker.tag, name: marker.name || null,
      source: 'marker', installedAt: marker.installedAt || null};
  }
  for (const [tag, files] of Object.entries(KNOWN_RELEASES)) {
    if (matches(KAIHEN, files)) return {tag, source: 'hash'};
  }
  return {tag: null, source: marker ? 'marker-no-tag' : 'none'};
}

async function status() {
  const local = localRelease();
  try {
    const info = await latest({timeout: 10000});
    return {ok: true, upToDate: Boolean(local.tag && local.tag === info.tag),
      local, latest: {tag: info.tag, name: info.name, htmlUrl: info.htmlUrl,
        asset: info.asset?.name || null}};
  } catch (error) {
    return {ok: false, error: error.message, upToDate: null, local};
  }
}

async function updateFromLatest() {
  const info = await latest();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ns2-kaihen-'));
  try {
    const zipFile = path.join(temp, info.asset.name || 'kaiHEN.zip');
    await download(info.asset.url, zipFile, {timeout: 10 * 60 * 1000});
    const extracted = path.join(temp, 'release');
    extract(zipFile, extracted);
    const root = findReleaseRoot(extracted);
    const result = update(root, {tag: info.tag, name: info.name, asset: info.asset.name});
    return {tag: info.tag, name: info.name, asset: info.asset.name,
      target: result.target, files: result.files, count: result.count};
  } finally {
    try { fs.rmSync(temp, {recursive: true, force: true}); } catch {}
  }
}

module.exports = {latest, updateFromLatest, findReleaseRoot, hasRelease,
  localRelease, status, KNOWN_RELEASES};

if (require.main === module) {
  const mode = process.argv.includes('--status') ? 'status'
    : process.argv.includes('--check') ? 'check' : 'update';
  const run = mode === 'status' ? status : mode === 'check' ? latest : updateFromLatest;
  run().then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
