'use strict';
// Download the latest kaiHEN release ZIP, extract it, copy the release into
// <repo>/kaihen, and remove the temporary ZIP.
//
// kaiHEN 20261123+ ships bootstrap.bin and ro/main plus an sdcard/ folder that
// mirrors the card. Older releases have the flat layout (hbmenu.nro, ro/main,
// hen/main, game/main, programs/, licenses/). A release is allowed to wrap
// either layout in one top-level folder; findReleaseRoot() handles both.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {download, getJson, extract} = require('./zip.cjs');
const {update, isRelease} = require('./update-kaihen.cjs');

const OWNER = 'ouncebrew';
const REPO = 'kaihen';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

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

async function latest() {
  const release = await getJson(API);
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

async function updateFromLatest() {
  const info = await latest();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ns2-kaihen-'));
  try {
    const zipFile = path.join(temp, info.asset.name || 'kaiHEN.zip');
    await download(info.asset.url, zipFile, {timeout: 10 * 60 * 1000});
    const extracted = path.join(temp, 'release');
    extract(zipFile, extracted);
    const root = findReleaseRoot(extracted);
    const result = update(root);
    return {tag: info.tag, name: info.name, asset: info.asset.name,
      target: result.target, files: result.files, count: result.count};
  } finally {
    try { fs.rmSync(temp, {recursive: true, force: true}); } catch {}
  }
}

module.exports = {latest, updateFromLatest, findReleaseRoot, hasRelease};

if (require.main === module) {
  const check = process.argv.includes('--check');
  (check ? latest() : updateFromLatest()).then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
