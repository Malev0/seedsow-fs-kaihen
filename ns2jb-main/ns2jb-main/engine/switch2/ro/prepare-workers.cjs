// Bind the seven FS API worker threads.
//
// The gate needs svcCancelSynchronization on those threads: an injected waiter
// selection is only retired when the kernel cancels the wait the injection
// installed. The app has no OpenThread syscall, so each KThread handle is
// obtained by pointing the already-identified FS notifier at the thread's
// existing FS handle and letting the FS duplicate its own handle back to us.
// That is the same export the proven Switch 2 flow uses, and each copy is
// proven with svcGetThreadId before it is bound.
const fs = require('node:fs/promises');
const path = require('node:path');
const {artifactDir} = require('../../shared/paths.cjs');
const OUT = artifactDir(__dirname);
const {connect} = require("../tools/fs-memory.cjs");
const {exportHandle} = require("./export-handle.cjs");
const check = (ok, message) => { if (!ok) throw Error(message); };

async function main() {
  const memory = await connect();
  const ring = JSON.parse(await fs.readFile(path.join(OUT, memory.info.session + '-thread-ring.json')));
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
  const file = path.join(OUT, memory.info.session + '-api-workers.json'), proof = {session: memory.info.session, workers: []};
  const save = () => fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  for (const node of matches[0]) {
    console.log(JSON.stringify({step: 'thread', id: node.id, address: node.address,
      handle: node.handle, entry: node.entry}));
    const current = await memory.read(node.address, 0x1c0);
    check(current[0x40] === 3 && current.readUInt32LE(0x1b0) === node.handle &&
      current.readBigUInt64LE(0x68) === BigInt(node.entry), 'Native API thread changed');
    const row = {address: node.address, sourceHandle: node.handle, id: node.id,
      entry: node.entry, handle: null};
    // A boot that cannot export a KThread is not fatal: bind every thread
    // handle-free, exactly like before, and the gate falls back to the FS
    // notifier wake. A partial export would leave the seven slots
    // inconsistent, which worker-bind rejects, so the first failure drops
    // every copy.
    if (!proof.exportError) {
      try {
        const copy = await exportHandle(memory, node.handle, 'FS API thread ' + node.id);
        const identity = await memory.request({command: 'root-native-thread-id', handle: copy.handle});
        check(identity.result === 0 && Number(identity.value) === node.id,
          'Copied API thread has the wrong ID');
        row.handle = copy.handle;
        row.proof = copy.proof;
        console.log(JSON.stringify({step: 'exported', id: node.id, handle: copy.handle}));
      } catch (error) {
        proof.exportError = error.message;
        console.log(JSON.stringify({step: 'export-failed', id: node.id, error: error.message}));
      }
    }
    proof.workers.push(row);
    await save();
  }
  if (proof.workers.some(row => !row.handle)) {
    proof.workers = proof.workers.map(row => ({...row, handle: null, proof: undefined}));
    proof.handleFree = true;
  }
  console.log(JSON.stringify({step: 'bind', workers: proof.workers.length}));
  await memory.request({command: 'root-native-worker-bind', workers: proof.workers});
  proof.cancellation = await memory.request({command: 'root-native-worker-cancel'});
  check(proof.cancellation.every(reply => reply.result === 0),
    'CancelSynchronization was rejected on a bound API thread');
  console.log(JSON.stringify({step: 'cancelled', cancellation: proof.cancellation}));
  await save();
  console.log(JSON.stringify({file, ...proof}));
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
