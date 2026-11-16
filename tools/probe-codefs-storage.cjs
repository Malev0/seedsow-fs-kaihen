#!/usr/bin/env node
// Read-only recon of the code/donor FS service objects and the storage objects
// they point at. Stays inside the captured FS heap; no writes.
//
// Run while held (post-activate or early), after filesystem-types.json exists.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {connect} = require('./ns2jb-main/ns2jb-main/engine/switch2/tools/fs-memory.cjs');

const engine = path.join(__dirname, 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2');
// Proofs live in the run directory now; --run (or NS2_RUN_DIR) selects one,
// otherwise the newest run is used.
const runDir = process.env.NS2_RUN_DIR ||
  fs.readFileSync(path.join(__dirname, 'runs', 'latest.txt'), 'utf8').trim();
const current = JSON.parse(fs.readFileSync(path.join(engine, 'current-acquisition.json')));
const types = JSON.parse(fs.readFileSync(path.join(runDir, 'switch2', 'ro', current.session + '-filesystem-types.json')));
const report = JSON.parse(fs.readFileSync(current.report));
const hex = value => '0x' + BigInt(value).toString(16);

(async () => {
  const proof = {session: current.session, report: current.report, started: new Date().toISOString(),
    rows: {}, ranges: []};
  const out = path.join(runDir, 'fs-storage-probe-' + Date.now() + '.json');
  const save = () => fsp.writeFile(out, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  const memory = await connect();
  proof.endpoint = {report: memory.reportFile, session: memory.info.session};

  // The acquisition's 5 MiB heap capture and the explicit reads define the
  // addresses the retained primitive can reach without a cache retarget.
  const ranges = [];
  for (const capture of report.retainedMemory?.captures || [])
    if (capture.address && capture.length)
      ranges.push({address: capture.address, length: capture.length,
        command: capture.command, file: capture.outputFile});
  ranges.sort((a, b) => b.length - a.length);
  proof.ranges = ranges.slice(0, 4);
  const inRange = address => ranges.some(r => address >= r.address && address < r.address + r.length);

  const read = async (label, address, length) => {
    if (!inRange(address)) return {address: hex(address), length, skipped: 'outside captured heap'};
    try {
      const bytes = await memory.read(Number(address), length);
      return {address: hex(address), length, ok: true, hex: bytes.toString('hex')};
    } catch (error) { return {address: hex(address), length, ok: false, error: error.message}; }
  };
  const qwords = bytes => {
    const values = [];
    for (let i = 0; i + 8 <= bytes.length; i += 8) values.push(bytes.readBigUInt64LE(i));
    return values;
  };
  const describe = (label, address, bytes) => ({
    label, address: hex(address), hex: bytes.toString('hex'),
    qwords: qwords(bytes).map(v => ({value: v.toString(), hex: hex(v)})).slice(0, 12)});

  const follow = async (label, address, depth) => {
    if (!address || depth > 2) return null;
    const readback = await read(label, Number(address), 0x80);
    if (!readback.ok) return readback;
    const bytes = Buffer.from(readback.hex, 'hex');
    const row = describe(label, address, bytes);
    row.children = [];
    // Follow the object-specific words only; 0/1 are flags/refcounts.
    for (const offset of [0x10, 0x18, 0x30]) {
      const pointer = bytes.readBigUInt64LE(offset);
      if (pointer < 0x10000n || pointer > 0x8000000000n) continue;
      row.children.push({offset: hex(offset), ...(await follow(
        label + '+' + hex(offset), pointer, depth + 1))});
    }
    return row;
  };

  // The bind-sessions donor row can be stale after HEN staging replaces the
  // package object. Re-open the staged ro package to get a fresh live donor.
  if (process.env.NS2_REOPEN_DONOR === '1') {
    const report = JSON.parse(fs.readFileSync(current.report));
    const root = report.ownedRoot && report.ownedRoot.clones && report.ownedRoot.clones[0];
    if (!root) throw Error('The report has no owned root clone');
    const layout = JSON.parse(fs.readFileSync(path.join(engine, 'ro', current.session + '-layout.json')));
    const opened = await memory.request({command: 'root-native-package-open',
      kind: 'ro', root, selectDonor: true});
    if (opened.result) throw Error('Package reopen failed: 0x' + Number(opened.result).toString(16));
    const entry = layout.table + (opened.root - 1) * 0x30;
    const entryBytes = await memory.read(entry, 0x30);
    const object = Number(entryBytes.readBigUInt64LE(0x20));
    proof.rows.donorPackage = {root: opened.root, handle: opened.handle, entry: hex(entry),
      object: hex(object), entryHex: entryBytes.toString('hex'),
      entries: opened.entries, tree: await follow('donorPackage', object, 0)};
    await save();
  }

  for (const type of types.rows) {
    proof.rows[type.name] = {object: hex(type.object), vptr: hex(type.vptr),
      header: type.header, tree: await follow(type.name, type.object, 0)};
    await save();
  }
  proof.finished = new Date().toISOString();
  await save();
  console.log('written:', out);
  for (const [name, row] of Object.entries(proof.rows)) {
    const flat = [];
    const walk = (node, depth) => {
      if (!node || !node.hex) return;
      flat.push('  '.repeat(depth) + (node.label || name) + ' ' + node.address +
        ' vptr=' + (node.qwords?.[0]?.hex || '?'));
      for (const child of node.children || []) walk(child, depth + 1);
    };
    walk(row.tree, 0);
    console.log(name + ':\n' + flat.join('\n'));
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
