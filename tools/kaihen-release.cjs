'use strict';
// Download the latest kaiHEN release ZIP, extract it, copy the release into
// <repo>/kaihen, and remove the temporary ZIP.
//
// The release layout is the one kaiHEN ships (bootstrap.bin, hbmenu.nro,
// ro/main, hen/main, game/main, programs/, licenses/). A release is allowed to
// wrap that in one top-level folder; findReleaseRoot() handles both.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {download, getJson, extract} = require('./zip.cjs');
const {update, required} = require('./update-kaihen.cjs');

const OWNER = 'ouncebrew';
const REPO = 'kaihen';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

function hasRelease(dir) {
  return required.every(rel => {
    try {
      return fs.statSync(path.join(dir, rel), {throwIfNoEntry: false})?.isFile();
    } catch { return false; }
  });
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
  throw Error('the kaiHEN release ZIP does not contain bootstrap.bin, hbmenu.nro, ro/main, hen/main and game/main');
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
