'use strict';
// Replace <repo>/kaihen with another kaiHEN release folder.
//
// The folder must have the same layout kaiHEN ships: ro/, hen/, game/,
// programs/, licenses/ (spelling varies), bootstrap.bin and hbmenu.nro.
// Everything present is copied over the current release; files the new release
// does not contain are left alone (libkaihen/ is usually not shipped).
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'kaihen');
const required = ['bootstrap.bin', 'hbmenu.nro', 'ro/main', 'hen/main', 'game/main'];

function checkDir(source) {
  if (!source) throw Error('no folder given');
  const dir = path.resolve(String(source).trim().replace(/^"|"$/g, ''));
  if (!fs.statSync(dir, {throwIfNoEntry: false})?.isDirectory())
    throw Error(`not a folder: ${dir}`);
  const missing = required.filter(rel => !fs.statSync(path.join(dir, rel), {throwIfNoEntry: false})?.isFile());
  if (missing.length)
    throw Error(`${dir} is not a kaiHEN release (missing ${missing.join(', ')})`);
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

function update(source) {
  const dir = checkDir(source);
  const files = [];
  copyTree(dir, target, files);
  return {source: dir, target, files, count: files.length};
}

module.exports = {update, checkDir, required};

if (require.main === module) {
  try {
    const result = update(process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
