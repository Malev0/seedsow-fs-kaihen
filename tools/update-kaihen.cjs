'use strict';
// Replace <repo>/kaihen with another kaiHEN release folder.
//
// A release has bootstrap.bin and ro/main at its top level. kaiHEN 20261123+
// also ships sdcard/, which mirrors the SD card; older releases instead have
// hbmenu.nro, hen/main and game/main at the top level. Everything present is
// copied over the current release; files the new release does not contain are
// left alone (libkaihen/ is usually not shipped).
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'kaihen');
const required = ['bootstrap.bin'];

function isFile(file) {
  return Boolean(fs.statSync(file, {throwIfNoEntry: false})?.isFile());
}

// 20261128 moved ro/main into sdcard/kaihen/bin/ro/main; older releases and
// the flat layout keep it at the release root.
function hasRo(dir) {
  return isFile(path.join(dir, 'ro', 'main')) ||
    isFile(path.join(dir, 'sdcard', 'kaihen', 'bin', 'ro', 'main'));
}

function isRelease(dir) {
  if (!required.every(rel => isFile(path.join(dir, rel))) || !hasRo(dir)) return false;
  if (fs.statSync(path.join(dir, 'sdcard'), {throwIfNoEntry: false})?.isDirectory())
    return ['sdcard/kaihen/bin/hen/main', 'sdcard/kaihen/bin/game/main']
      .every(rel => isFile(path.join(dir, rel)));
  return ['ro/main', 'hbmenu.nro', 'hen/main', 'game/main']
    .every(rel => isFile(path.join(dir, rel)));
}

function isLayout(dir, layout) {
  if (!required.every(rel => isFile(path.join(dir, rel)))) return false;
  if (layout === 'new')
    return hasRo(dir) &&
      ['sdcard/kaihen/bin/hen/main', 'sdcard/kaihen/bin/game/main']
        .every(rel => isFile(path.join(dir, rel)));
  if (layout === 'flat')
    return ['ro/main', 'hbmenu.nro', 'hen/main', 'game/main']
      .every(rel => isFile(path.join(dir, rel)));
  return isRelease(dir);
}

function normalizeRelease(dir) {
  const sdcardRo = path.join(dir, 'sdcard', 'kaihen', 'bin', 'ro', 'main');
  if (!isFile(sdcardRo)) return false;
  const rootRo = path.join(dir, 'ro', 'main');
  fs.mkdirSync(path.dirname(rootRo), {recursive: true});
  fs.copyFileSync(sdcardRo, rootRo);
  return true;
}

function checkDir(source) {
  if (!source) throw Error('no folder given');
  const dir = path.resolve(String(source).trim().replace(/^"|"$/g, ''));
  if (!fs.statSync(dir, {throwIfNoEntry: false})?.isDirectory())
    throw Error(`not a folder: ${dir}`);
  if (!isRelease(dir))
    throw Error(`${dir} is not a kaiHEN release (missing bootstrap.bin, ro/main or sdcard/kaihen/bin/ro/main, or the hen/game files)`);
  return dir;
}

function copyTree(from, to, files) {
  fs.mkdirSync(to, {recursive: true});
  for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
    if (entry.name.startsWith('.')) continue;
    const source = path.join(from, entry.name), destination = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, destination, files);
    else if (entry.isFile()) {
      fs.copyFileSync(source, destination);
      files.push(path.relative(target, destination).split(path.sep).join('/'));
    }
  }
}

function writeMarker(meta = {}) {
  fs.mkdirSync(target, {recursive: true});
  const marker = {...meta, installedAt: new Date().toISOString()};
  fs.writeFileSync(path.join(target, 'release.json'), JSON.stringify(marker, null, 2) + '\n');
  return marker;
}

function removeLayout(dir, layout) {
  const paths = layout === 'new'
    ? ['hen', 'game', 'hbmenu.nro']
    : layout === 'flat' ? ['sdcard'] : [];
  for (const rel of paths)
    fs.rmSync(path.join(dir, rel), {recursive: true, force: true});
}

function clearManaged(dir) {
  for (const rel of ['sdcard/kaihen/bin', 'sdcard/kaihen/lib', 'sdcard/kaihen/system.json'])
    fs.rmSync(path.join(dir, rel), {recursive: true, force: true});
}

function update(source, meta = {}) {
  const dir = checkDir(source);
  const sourceNew = fs.statSync(path.join(dir, 'sdcard'), {throwIfNoEntry: false})?.isDirectory();
  removeLayout(target, sourceNew ? 'new' : 'flat');
  if (sourceNew) clearManaged(target);
  const files = [];
  copyTree(dir, target, files);
  normalizeRelease(target);
  writeMarker({...meta, source: dir});
  return {source: dir, target, files, count: files.length};
}

function clearMarker() {
  try { fs.rmSync(path.join(target, 'release.json'), {force: true}); } catch {}
}

module.exports = {update, checkDir, required, isRelease, isLayout, writeMarker, clearMarker, removeLayout, normalizeRelease, hasRo};

if (require.main === module) {
  try {
    const result = update(process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
