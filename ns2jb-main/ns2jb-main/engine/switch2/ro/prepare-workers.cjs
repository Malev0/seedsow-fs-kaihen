const fs = require('node:fs/promises');
const path = require('node:path');
const {connect} = require("../tools/fs-memory.cjs");
const {exportHandle} = require("./export-handle.cjs");
const check = (ok, message) => { if (!ok) throw Error(message); };

async function main() {
  const memory = await connect();
  const ring = JSON.parse(await fs.readFile(path.join(__dirname, memory.info.session + '-thread-ring.json')));
  check(ring.session === memory.info.session, 'Stale thread ring');
  const groups = new Map();
  for (const node of ring.nodes.filter(t => t.state === 3 && t.size === 0xc000 && t.argument === 0)) {
    if (!groups.has(node.entry)) groups.set(node.entry, []);
    groups.get(node.entry).push(node);
  }
  const matches = [...groups.values()].filter(rows => rows.length === 7);
  console.log(JSON.stringify({step: 'ring', nodes: ring.nodes.length, groups: groups.size,
    matches: matches.length}));
  check(matches.length === 1, 'Native API-worker group is not unique');
  const file = path.join(__dirname, memory.info.session + '-api-workers.json'), proof = {session: memory.info.session, workers: []};
  const save = () => fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  // Switch/Switch 2 expose no OpenThread syscall (SVC 0x33 is GetThreadContext3,
  // 0x34 WaitForAddress), so an app-side KThread handle for an FS API thread
  // cannot be created; exporting one through the notifier aborts the Seedsow FS
  // service. Bind the verified threads by address/id/entry instead, with no
  // handle. Cancellation then becomes a no-op (see worker-cancel).
  proof.fsProcess = await exportHandle(memory, 0xffff8001, 'FS process for API thread handles');
  await save();
  for (const node of matches[0]) {
    console.log(JSON.stringify({step: 'thread', id: node.id, address: node.address,
      handle: node.handle, entry: node.entry}));
    const current = await memory.read(node.address, 0x1c0);
    console.log(JSON.stringify({step: 'read', id: node.id}));
    check(current[0x40] === 3 && current.readUInt32LE(0x1b0) === node.handle &&
      current.readBigUInt64LE(0x68) === BigInt(node.entry), 'Native API thread changed');
    console.log(JSON.stringify({step: 'verified', id: node.id}));
    proof.workers.push({address: node.address, sourceHandle: node.handle, id: node.id,
      entry: node.entry, handle: null});
    await save();
  }
  console.log(JSON.stringify({step: 'bind', workers: proof.workers.length}));
  await memory.request({command: 'root-native-worker-bind', workers: proof.workers});
  console.log(JSON.stringify({step: 'bound'}));
  proof.cancellation = await memory.request({command: 'root-native-worker-cancel'});
  console.log(JSON.stringify({step: 'cancelled', cancellation: proof.cancellation}));
  await save();
  console.log(JSON.stringify({file, ...proof}));
}

main().catch(error => {console.error(error); process.exitCode = 1;});
