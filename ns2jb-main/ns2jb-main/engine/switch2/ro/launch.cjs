// Gate the real PM/Loader path and exchange the mounted CodeFS reference with
// the kaiHEN donor package reference.
//
// This is a port of the proven Switch 2 launch flow (civ7-fs-kaihen): wait for
// the *second* target CodeFS mount, serve every request with `gate.step()`, and
// exchange the two owning references two-way with rollback. Nothing is swapped
// before the mount reply and nothing is redirected after it: kaiHEN's own
// `DomainMount::exchange` is the whole mechanism.
const fs = require('node:fs/promises');
const path = require('node:path');
const {artifactDir} = require('../../shared/paths.cjs');
const OUT = artifactDir(__dirname);
const {connect, encodeU64} = require("../tools/fs-memory.cjs");
const {exportHandle} = require("./export-handle.cjs");
const {Gate} = require("./gate.cjs");
const wire = require("../../shared/domain.cjs");
const check = (ok, message) => { if (!ok) throw Error(message); };
const ptr = (b, o = 0) => Number(b.readBigUInt64LE(o));

async function entries(memory, layout, domain) {
  const sentinel = domain + 0x20, rows = [], seen = new Set();
  let at = await memory.pointer(sentinel);
  while (at !== sentinel) {
    check(at >= layout.table && at < layout.table + layout.count * 0x30 &&
      (at - layout.table) % 0x30 === 0 && !seen.has(at) && rows.length < 128,
    'Domain list left its verified entry table or repeated an entry');
    seen.add(at);
    const b = await memory.read(at, 0x30);
    check(ptr(b, 0x18) === domain, 'Domain entry owner changed');
    rows.push({id: (at - layout.table) / 0x30 + 1, entry: at, domain,
      object: ptr(b, 0x20), metadata: ptr(b, 0x28), raw: b.toString('hex')});
    at = ptr(b);
  }
  return rows;
}

function requestInfo(hex) {
  const b = Buffer.from(hex, 'hex'), at = wire.dataStart(b), type = b.readUInt32LE() & 0xffff;
  check(at + 16 <= b.length, 'Saved request descriptors exceed the capture');
  if (type === 5 || type === 7) return {kind: 'control', command: b.readUInt32LE(at + 8)};
  check(type === 4 || type === 6, 'Unexpected Loader request type');
  const id = b.readUInt32LE(at + 4);
  if (b[at] === 2) return {kind: 'close', object: id};
  check(b[at] === 1 && b.toString('ascii', at + 16, at + 20) === 'SFCI', 'Saved domain request is malformed');
  return {kind: 'request', object: id, command: b.readUInt32LE(at + 24),
    input: b.subarray(at + 32, at + 16 + b.readUInt16LE(at + 2)).toString('hex')};
}

// kaiHEN common/domain_mount.hpp exchange(): both entries must belong to the
// same concrete filesystem class and carry the same metadata, so the mounted
// CodeFS entry can take the donor package object and the donor entry can take
// the mounted one. The second write is what keeps both owners' reference
// counts balanced; if it fails the first write is rolled back.
async function exchange(memory, donor, code) {
  check(code.metadata === donor.metadata, 'Target mount metadata differs from the donor package');
  check(code.entry !== donor.entry && code.object !== donor.object,
    'Target mount is the donor entry itself');
  const codeVptr = ptr(await memory.read(code.object, 8));
  const donorVptr = ptr(await memory.read(donor.object, 8));
  check(codeVptr === donor.vptr && donorVptr === donor.vptr,
    'Target mount and donor package are not the same filesystem class');
  check(ptr(await memory.read(code.entry + 0x20, 8)) === code.object,
    'Owning-reference exchange preconditions changed');
  const result = {codeVptr: codeVptr.toString(16), donorVptr: donorVptr.toString(16),
    started: new Date().toISOString(), firstWritten: false, secondWritten: false};
  await memory.writeU64(code.entry + 0x20, code.object, donor.object);
  result.firstWritten = true;
  try {
    await memory.writeU64(donor.entry + 0x20, donor.object, code.object);
    result.secondWritten = true;
  } catch (error) {
    if (await memory.pointer(donor.entry + 0x20) === donor.object)
      await memory.writeU64(code.entry + 0x20, donor.object, code.object);
    result.rolledBack = true;
    result.error = error.message;
    throw error;
  }
  check(await memory.pointer(code.entry + 0x18) === code.domain &&
    await memory.pointer(code.entry + 0x20) === donor.object &&
    await memory.pointer(donor.entry + 0x18) === donor.domain &&
    await memory.pointer(donor.entry + 0x20) === code.object,
  'Owning-reference exchange did not verify');
  return result;
}

async function main(options = {}) {
  const memory = options.memory || await connect();
  const read = suffix => fs.readFile(path.join(OUT, memory.info.session + suffix)).then(JSON.parse);
  const layout = await read('-layout.json'), root = await read('-loader-root-copy.json');
  const bound = await read('-bound-sessions.json'), types = await read('-filesystem-types.json');
  const event = await read('-gate-event.json');
  check([layout, root, bound, types, event].every(p => p.report === memory.reportFile) &&
    root.verified && types.compatible && event.verified,
  'Current native proofs are incomplete');
  // The Loader issues the title/interface mount first and the code mount second.
  // The exchange only matters on the code mount, so the default is the second
  // one (proven on this firmware); NS2_LAUNCH_MOUNT=1 keeps the old order.
  const wantedMount = Number(process.env.NS2_LAUNCH_MOUNT || options.wantedMount || 2);
  check(wantedMount === 1 || wantedMount === 2,
    'Only the observed first or second target mount is supported');

  const state = await memory.request({command: 'root-native-info'});
  check(state.donor?.ready && state.donor.mount === 'package' && state.donor.kind === 'ro',
    'The kaiHEN RO package donor is not ready');
  check(!state.worker || state.worker.joined, 'Launch worker is not idle');
  const target = options.target || '0x0400000000000037';
  const flags = options.flags ?? 0x10;
  // A staged SD exefs package is opened by the Loader itself, so the mount reply
  // is already the donor and no entry exchange is possible or needed.
  const redirected = Boolean(state.donor?.package?.redirect);
  const shell = state.services.find(x => x.name === 'pm:shell').handle;
  const row = bound.rows.find(r => r.domain === root.targetDomain);
  const donor = types.rows.find(r => r.name === 'donor');
  check(donor && donor.root === state.donor.root && donor.entry && donor.object &&
    donor.metadata && donor.vptr,
  'The donor proof is not the opened kaiHEN package');
  const server = await exportHandle(memory, row.receive, 'Loader server readiness');
  const waitReady = await exportHandle(memory, row.wait, 'Loader wait readiness')
    .catch(error => ({error: error.message}));
  const gate = new Gate(memory, row, state.apiWorkers, bound.waiters, server.handle, event,
    waitReady.handle ?? null);
  const proof = {session: memory.info.session, report: memory.reportFile, target,
    wantedMount, flags, row, donor, server, waitReady, requests: [], steps: gate.steps,
    mounts: 0, swapped: false};
  const file = path.join(OUT, memory.info.session + '-launch-' + Date.now() + '.json');
  const save = () => fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  await save();
  console.log(JSON.stringify({stage: 'launch-prepared', file, wantedMount, donor: donor.vptr.toString(16)}));

  // TryWaitThread blocks while the worker is inside its IPC send and again in
  // pthread_exit on this build. Poll the result cells instead.
  const workerDone = async () => {
    const values = await memory.request({command: 'root-native-worker-values'});
    return {finished: values.values.every(value => value !== values.sentinel), values};
  };
  let launchError;
  try {
    proof.worker = await memory.request({command: 'root-native-worker-prepare', kind: 'pm-launch',
      handle: shell, title: proof.target, flags: proof.flags});
    await gate.parkSession(); proof.parked = true;
    proof.gatePark = {settled: gate.parkSettled ?? null, rounds: gate.parkSettleRounds ?? null,
      rebuilt: !!gate.rebuilt, rebuildSkipped: !!gate.rebuildSkipped,
      drainSkipped: !!gate.drainSkipped, drained: gate.drained?.original ?? null,
      cancelled: !gate.cancelSkipped};
    await save();
    await memory.request({command: 'root-native-worker-release'});
    const deadline = Date.now() + 240000;
    const rootId = (root.targetEntry - layout.table) / 0x30 + 1;
    for (let i = 0; i < 160; i++) {
      while (!await gate.pending()) {
        if ((await workerDone()).finished) break;
        check(Date.now() < deadline, 'PM launch did not reach the parked FS session');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if ((await workerDone()).finished) break;
      // Every request is served by step(), exactly like the proven flow: no
      // wake after the injection, no pre-swap, no post-reply redirect. The
      // exchange happens inside the serve window, before the Loader's open.
      const before = await entries(memory, layout, root.targetDomain);
      const step = await gate.step();
      const info = requestInfo(step.request);
      const after = await entries(memory, layout, root.targetDomain);
      const added = after.filter(a => !before.some(b => b.id === a.id && b.object === a.object));
      const record = {index: i, ...info, added,
        removed: before.filter(b => !after.some(a => a.id === b.id && a.object === b.object))};
      proof.requests.push(record);
      if (!(info.kind === 'request' && info.object === rootId && info.command === 0)) {
        await save();
        console.log(JSON.stringify({stage: 'stepped', index: i, kind: info.kind,
          object: info.object, command: info.command, added: added.map(a => a.id),
          mounts: proof.mounts}));
        continue;
      }
      const input = Buffer.from(info.input, 'hex');
      check(input.length >= 16 && input[0] === 1 && input[1] === 3 &&
        input.readBigUInt64LE(8) === BigInt(proof.target),
      'The queued CodeFS mount is not the selected native target');
      proof.mounts++;
      record.targetMount = proof.mounts;
      const wanted = proof.mounts === wantedMount;
      const fresh = added.length === 1 && added[0].metadata === donor.metadata ? added[0] : null;
      if (!fresh && !wanted) {
        record.incompatibleMount = added.map(a => ({id: a.id, metadata: a.metadata}));
        await save();
        continue;
      }
      // A repeated mount can reuse the entry and its object (the reply is then
      // cached and `added` is empty). Accept the live entry from the earlier
      // mount instead of failing, but only when it still owns that object.
      let code = fresh;
      if (!code && proof.lastTarget) {
        const live = await memory.read(proof.lastTarget.entry, 0x30);
        if (ptr(live, 0x18) === root.targetDomain && ptr(live, 0x20) === proof.lastTarget.object) {
          code = proof.lastTarget;
          record.reusedMount = true;
        }
      }
      check(code, 'Target mount did not return one compatible filesystem');
      if (!wanted) {
        // Keep the entry so a boot that never reaches the requested mount can
        // still be exchanged in the fallback below instead of being wasted.
        proof.lastTarget = {id: code.id, entry: code.entry, object: code.object,
          metadata: code.metadata, mount: proof.mounts};
        await save();
        console.log(JSON.stringify({stage: 'stepped', index: i, kind: info.kind,
          object: info.object, command: info.command, added: added.map(a => a.id),
          mounts: proof.mounts}));
        continue;
      }
      const currentDonor = await memory.read(donor.entry, 0x30);
      check(currentDonor.subarray(0x18).equals(Buffer.from(donor.raw, 'hex').subarray(0x18)) &&
        await memory.pointer(code.object) === donor.vptr &&
        await memory.pointer(donor.object) === donor.vptr,
      'Filesystem identity or concrete adapter type changed');
      proof.exchange = {code, donor, started: new Date().toISOString(),
        firstWritten: false, secondWritten: false};
      await save();
      Object.assign(proof.exchange, await exchange(memory, donor, code));
      proof.swapped = true;
      await save();
      console.log(JSON.stringify({stage: 'filesystem-exchanged', file, mount: proof.mounts,
        object: code.id, metadata: code.metadata, vptr: donor.vptr.toString(16)}));
      break;
    }
    // The requested mount never arrived in this window (this entrypoint issues
    // only one CodeFS mount before the suspended launch completes). Exchange
    // that one instead so the boot is not wasted; `fallback:true` marks it as
    // not the proven-flow position.
    if (!proof.swapped && proof.lastTarget) {
      const code = proof.lastTarget;
      const current = await memory.read(code.entry, 0x30);
      check(ptr(current, 0x18) === root.targetDomain && ptr(current, 0x20) === code.object &&
        ptr(current, 0x28) === donor.metadata,
      'The fallback mount entry changed before the exchange');
      proof.exchange = {code, donor, started: new Date().toISOString(), fallback: true,
        firstWritten: false, secondWritten: false};
      await save();
      Object.assign(proof.exchange, await exchange(memory, donor, code));
      proof.swapped = true;
      await save();
      console.log(JSON.stringify({stage: 'filesystem-exchanged', file, mount: code.mount,
        fallback: true, object: code.id, metadata: code.metadata}));
    }
  } catch (error) {
    launchError = error;
    proof.error = error.stack;
  } finally {
    proof.outstanding = gate.outstanding;
    proof.wake = {log: gate.wakeLog || [], failed: !!gate.wakeFailed, count: gate.wakeCount || 0,
      waitCopy: gate.waitCopy ?? null};
    try { await save(); } catch (error) { proof.preRestoreSaveError = error.stack; }
    let restorationError;
    try {
      await gate.restore();
      proof.restored = true;
    } catch (error) {
      restorationError = error;
      proof.restorationError = error.stack;
    }
    proof.restoration = gate.restoration;
    if (launchError && restorationError) launchError.restorationError = restorationError.message;
    try { await save(); } catch (error) { proof.proofSaveError = error.message; }
    if (!launchError && restorationError) launchError = restorationError;
  }
  if (launchError) throw launchError;
  const until = Date.now() + 20000;
  while (!(await workerDone()).finished) {
    check(Date.now() < until, 'PM did not complete after the gate was restored');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  proof.completion = await memory.request({command: 'root-native-worker-settle'});
  const reply = proof.completion.responses[0];
  proof.result = reply.result;
  if (!reply.result) proof.pid = Buffer.from(reply.data, 'hex').readBigUInt64LE().toString();
  proof.imageAccepted = (proof.swapped || redirected) && reply.result === 0;
  proof.redirected = redirected;
  await save();
  await memory.request({command: 'root-native-close-handle', handle: server.handle});
  if (!proof.swapped && !reply.result) {
    proof.unmodifiedProcessCleanup = await memory.request({command: 'root-native-ipc', handle: shell,
      id: 1, hex: encodeU64(BigInt(proof.pid)).toString('hex')});
    await save();
  }
  console.log(JSON.stringify({stage: 'launch-complete', file, mounts: proof.mounts,
    result: proof.result, pid: proof.pid, imageAccepted: proof.imageAccepted,
    restored: proof.restored}));
  return {file, ...proof};
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });

module.exports = {main, requestInfo, entries, exchange};
