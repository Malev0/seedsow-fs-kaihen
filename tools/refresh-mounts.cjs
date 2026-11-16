#!/usr/bin/env node
'use strict';
// Run the console's mount accessor and record every mount it resolves into
// engine/switch2/app/mounts.json. Mount objects are per boot, so this has to run
// after every game relaunch, before the RPC bridge starts.
//
// The file is created when it does not exist yet: a fresh install has never run
// anything, and the exploit needs it (app/mounted-save.cjs requires it) before
// the first pipeline stage.
const fs = require('node:fs');
const path = require('node:path');
const {evalFile, ROOT, TOOLS} = require('./console-http.cjs');

const HEX = '(0x[0-9a-fA-F]+)';
const MOUNT = new RegExp('^mount name=(\\S+) accessor=' + HEX + ' impl=' + HEX +
  ' service=' + HEX + ' vtable=' + HEX + ' manager=' + HEX +
  ' objectId=(\\d+) borrowed=(\\d+)\\r?$', 'gm');

// The engine's own app directory. It is tracked, so it always exists in a clean
// checkout; only mounts.json inside it is generated.
function targetPath() {
  return path.join(ROOT, 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2', 'app', 'mounts.json');
}

function parse(out) {
  const sdk = /sdk=(0x[0-9a-fA-F]+)/.exec(out);
  if (!sdk) throw Error('could not parse sdk from the accessor output');
  const mounts = [];
  for (const match of out.matchAll(MOUNT)) {
    mounts.push({name: match[1], accessor: parseInt(match[2], 16),
      implementation: parseInt(match[3], 16), service: parseInt(match[4], 16),
      serviceVtable: parseInt(match[5], 16)});
  }
  if (!mounts.length) {
    // Older accessor output: only the save mount was resolved.
    const entry = new RegExp('accessor=' + HEX + '.*?impl=' + HEX).exec(out);
    const service = new RegExp('^impl=0x[0-9a-fA-F]+ service=' + HEX, 'm').exec(out);
    const vtable = /service vtable=(0x[0-9a-fA-F]+)/.exec(out);
    if (!(entry && service && vtable))
      throw Error('could not parse accessor/service/vtable from the accessor output');
    mounts.push({name: 'save', accessor: parseInt(entry[1], 16),
      implementation: parseInt(entry[2], 16), service: parseInt(service[1], 16),
      serviceVtable: parseInt(vtable[1], 16)});
  }
  return {session: 'seedsow', at: new Date().toISOString(),
    sdk: parseInt(sdk[1], 16), mounts};
}

function writeMounts(data, file = targetPath()) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', {mode: 0o600});
  return file;
}

async function main() {
  const out = await evalFile(path.join(ROOT, 'console', 'n2h_accessor.lua'));
  console.log(out);
  // Keep the full walk: it lists every mount name, so a donor backing other than
  // the app's live save (e.g. tmp/game/empty) can be chosen later.
  try { fs.writeFileSync(path.join(TOOLS, 'mounts.log'), out); } catch { /* best effort */ }
  const data = parse(out);
  const file = writeMounts(data);
  console.log('wrote ' + file);
  console.log(JSON.stringify(data, null, 2));
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}

module.exports = {parse, writeMounts, targetPath};
