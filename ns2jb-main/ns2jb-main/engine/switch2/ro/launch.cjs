// Gate the real PM/Loader path and exchange two existing filesystem references.
//
// The multi-session / multi-domain launch scan, the second bound session kick
// (NS2_LAUNCH_KICK_OTHER) and the whole-table scan are ported from Manupera's
// remote-lua-sw2 (ns2jb-engine / vendored ns2jbstuff), docs/STATUS.md section 10.
// Credit: Manupera, remote-lua-sw2.
//
// 2026-11-05 correction: in this CMIF build control 0 is ConvertToDomain and
// control 1 is CopyObject. The "control 1" request seen in the second bound
// session is the app's own save-filesystem CopyObject (object 139) left over
// from stage 1, not the Loader. The second bound row is `ownDomain`, not the
// Loader's clone. Only a control 0 or a post-launch mount request is evidence
// that the Loader reached a session; treat an unchanged buffer as stale.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {connect, encodeU64} = require("../tools/fs-memory.cjs");
const {exportHandle} = require("./export-handle.cjs");
const {Gate} = require("./gate.cjs");
const wire = require("../../shared/domain.cjs");
const {response} = require("../../shared/ipc.cjs");
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

// Host-only liveness probe. A TCP connect to the app's HTTP port needs no
// console RPC, so it keeps working while the control path is wedged.
function consoleHost() {
  if (process.env.NS2_CONSOLE) return process.env.NS2_CONSOLE.trim();
  try {
    const first = require('node:fs').readFileSync(
      path.join(__dirname, '../../../../../tools/console-host.txt'), 'utf8').split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch {}
  return '192.168.1.50';
}

function tcpUp(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = net.createConnection({host, port});
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// The PC address the slot-2 worker connects back to for the TCP dump.
function dumpHost() {
  const parse = value => {
    const parts = String(value).trim().split('.').map(Number);
    check(parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255),
      'Invalid IPv4 address: ' + value);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  };
  if (process.env.NS2_DUMP_HOST) return parse(process.env.NS2_DUMP_HOST);
  const nets = require('node:os').networkInterfaces();
  for (const list of Object.values(nets)) for (const entry of list || [])
    if (entry.family === 'IPv4' && !entry.internal) return parse(entry.address);
  throw Error('No LAN IPv4 address found; set NS2_DUMP_HOST in gui/env.txt');
}

function startLiveness(proof, save, durationMs) {
  if (!durationMs) return null;
  const host = consoleHost(), samples = proof.liveness = [];
  let stopped = false;
  const loop = async () => {
    const until = Date.now() + durationMs;
    while (!stopped) {
      const at = new Date().toISOString(), up = await tcpUp(host, 8080);
      samples.push({at, up});
      console.log(JSON.stringify({stage: 'launch-liveness', at, up}));
      await save().catch(() => {});
      if (!up || Date.now() >= until) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  };
  const task = loop();
  return async () => { stopped = true; await task; };
}

async function main() {
  // Fail fast when the control thread wedges instead of holding a stage for a
  // full minute.
  process.env.NS2_MEMORY_TIMEOUT_MS ||= '15000';
  const memory = await connect();
  const read = suffix => fs.readFile(path.join(__dirname, memory.info.session + suffix)).then(JSON.parse);
  const layout = await read('-layout.json'), root = await read('-loader-root-copy.json');
  const bound = await read('-bound-sessions.json'), types = await read('-filesystem-types.json');
  const event = await read('-gate-event.json');
  check([layout, root, bound, types, event].every(p => p.report === memory.reportFile) &&
    root.verified && types.compatible && event.verified, 'Current native proofs are incomplete');
  const wantedMount = 2;
  check(wantedMount === 1 || wantedMount === 2, 'Only the observed first or second target mount is supported');
  // NS2_LAUNCH_MODE=serve: park, hand the session back, then let the real
  // PM/Loader mount requests be served normally. The old path holds each reply
  // with the fake `selected` pointer, which is fatal on this console.
  const serve = process.env.NS2_LAUNCH_MODE === 'serve';

  const state = await memory.request({command: 'root-native-info'});
  check(state.donor?.ready && (!state.worker || state.worker.joined), 'Donor or worker is not ready');
  const target = '0x0400000000000037';
  // 0x10 = StartSuspended: PM creates the process but the Loader's image load is
  // deferred. 0 = normal launch, where the load blocks inside this request.
  const flags = Number(process.env.NS2_LAUNCH_FLAGS ?? 0x10);
  check(flags === 0 || flags === 0x10, 'Unsupported launch flags');
  check(['0x0400000000000037', '0x0400000000000019', '0x040000000000000a', '0x040000000000004f',
    '0x0400000000000014', '0x0400000000000013', '0x040000000000001d'].includes(target), 'Unsupported native research target');
  check(target === (state.donor.title || '0x0400000000000037'), 'Donor policy belongs to a different target');
  const shell = state.services.find(x => x.name === 'pm:shell').handle;
  const row = bound.rows.find(r => r.domain === root.targetDomain);
  const otherRow = bound.rows.find(r => r.address !== row.address) || null;
  const donor = types.rows.find(r => r.name === 'donor');
  const server = await exportHandle(memory, row.receive, 'Loader server readiness');
  const gate = new Gate(memory, row, state.apiWorkers, bound.waiters, server.handle, event);
  const proof = {session: memory.info.session, report: memory.reportFile, target,
    wantedMount, flags, row, otherRow, donor, server, requests: [], steps: gate.steps,
    mounts: 0, swapped: false};
  const file = path.join(__dirname, memory.info.session + '-launch-' + Date.now() + '.json');
  const save = () => fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  await save();
  console.log(JSON.stringify({stage: 'launch-prepared', file, wantedMount, flags,
    otherRow: otherRow ? otherRow.address : null}));
  // Confirm the env actually reached this child; a missing liveness probe in
  // the 00:46 proof showed the override did not apply.
  console.log(JSON.stringify({stage: 'launch-env',
    restoreAfterRead: process.env.NS2_LAUNCH_RESTORE_AFTER_READ ?? null,
    livenessMs: process.env.NS2_LAUNCH_LIVENESS_MS ?? null,
    postMs: process.env.NS2_LAUNCH_POST_MS ?? null,
    mode: process.env.NS2_LAUNCH_MODE ?? null}));
  // Pay for the borrowed donor reference. The swap later points the Loader's
  // save-FS entry at the donor object without incrementing its refcount. When
  // the Loader's file is destroyed it releases its parent filesystem, so the
  // donor must have a reference of its own or it is destroyed with the file.
  try {
    const owned = await memory.request({command: 'root-native-domain-open'});
    const ownEntry = Number(layout.table) + (Number(owned.root) - 1) * 0x30;
    const original = await memory.read(ownEntry, 0x30);
    const borrowed = Buffer.from(original);
    borrowed.writeBigUInt64LE(BigInt(donor.object), 0x20);
    borrowed.writeBigUInt64LE(BigInt(donor.metadata), 0x28);
    await memory.write(ownEntry, original, borrowed);
    let copy;
    try {
      copy = await memory.request({command: 'root-native-domain-copy',
        handle: Number(owned.handle), object: Number(owned.root)});
    } finally {
      await memory.write(ownEntry, borrowed, original);
    }
    check((await memory.read(ownEntry, 0x30)).equals(original),
      'Inspection slot did not restore after the donor copy');
    proof.donorReference = {object: Number(donor.object), copy: Number(copy.handle)};
    await save();
    console.log(JSON.stringify({stage: 'donor-reference', ...proof.donorReference}));
  } catch (error) {
    proof.donorReferenceError = error.message;
    await save();
  }
  let stopLiveness = null;
  let restoredEarly = false;
  // The Loader mount is not guaranteed to land in the domain that was bound at
  // boot: a launch can open a new fsp-srv session and ConvertToDomain it. Find
  // sessions of the same class in the session pool, walk any new domain and
  // swap the entry whose metadata matches the donor.
  const rowVptr = ptr(Buffer.from(row.raw, 'hex'));
  const slotBase = Number(layout.slots), slotSize = 0x10000;
  const scanSessions = async () => {
    const bytes = await memory.read(slotBase, slotSize), found = [];
    for (let o = 0; o + 0x80 <= bytes.length; o += 8) {
      if (Number(bytes.readBigUInt64LE(o)) !== rowVptr) continue;
      const domain = Number(bytes.readBigUInt64LE(o + 0x70));
      if (!domain) continue;
      found.push({at: slotBase + o, domain});
    }
    return found;
  };
  const knownDomains = new Set([row.domain, root.targetDomain, donor.domain]);
  const reportedDomains = new Set();
  for (const session of await scanSessions()) knownDomains.add(session.domain);
  const domainBaseline = new Map();
  for (const domain of knownDomains) {
    try { domainBaseline.set(domain, await entries(memory, layout, domain)); }
    catch { domainBaseline.set(domain, null); }
  }
  proof.sessionBaseline = {domains: knownDomains.size};
  proof.domainBaseline = [...domainBaseline.values()].filter(Boolean).length;
  // The mount may be created in a domain whose session we never see. Read the
  // whole domain table once and watch it for a new donor-matching entry.
  const tableStride = 0x30, tableTotal = Number(layout.count) * tableStride;
  async function tableRows() {
    const rows = [];
    for (let off = 0; off < tableTotal; off += 0x4000) {
      const length = Math.min(0x4000, tableTotal - off);
      const buf = await memory.read(Number(layout.table) + off, length);
      for (let i = 0; i + tableStride <= length; i += tableStride) {
        const domain = Number(buf.readBigUInt64LE(i + 0x18));
        if (!domain) continue;
        rows.push({id: (off + i) / tableStride + 1, entry: Number(layout.table) + off + i,
          domain, object: Number(buf.readBigUInt64LE(i + 0x20)),
          metadata: Number(buf.readBigUInt64LE(i + 0x28))});
      }
    }
    return rows;
  }
  const tableKey = row => row.id + ':' + row.object + ':' + row.metadata;
  const tableBaseline = process.env.NS2_LAUNCH_TABLE_SCAN === '1'
    ? new Set((await tableRows()).map(tableKey)) : null;
  proof.tableBaseline = tableBaseline ? tableBaseline.size : 'off';
  async function exchange(code, ownerDomain) {
    const currentDonor = await memory.read(donor.entry, 0x30);
    check(currentDonor.subarray(0x18).equals(Buffer.from(donor.raw, 'hex').subarray(0x18)) &&
      await memory.pointer(code.object) === donor.vptr && await memory.pointer(donor.object) === donor.vptr,
    'Filesystem identity or concrete adapter type changed');
    proof.exchange = {code, donor, ownerDomain, started: new Date().toISOString(),
      firstWritten: false, secondWritten: false};
    await save();
    await memory.writeU64(code.entry + 0x20, code.object, donor.object);
    proof.exchange.firstWritten = true; await save();
    try {
      await memory.writeU64(donor.entry + 0x20, donor.object, code.object);
      proof.exchange.secondWritten = true; await save();
    } catch (error) {
      check(await memory.pointer(donor.entry + 0x20) === donor.object, 'Donor write failed without restoration');
      await memory.writeU64(code.entry + 0x20, donor.object, code.object);
      proof.exchange.rolledBack = true; await save();
      throw error;
    }
    check(await memory.pointer(code.entry + 0x18) === ownerDomain &&
      await memory.pointer(code.entry + 0x20) === donor.object &&
      await memory.pointer(donor.entry + 0x18) === donor.domain &&
      await memory.pointer(donor.entry + 0x20) === code.object, 'Owning-reference exchange did not verify');
    proof.swapped = true; await save();
    console.log(JSON.stringify({stage: 'filesystem-exchanged', file, mount: proof.mounts,
      object: code.id, domain: ownerDomain}));
  }
  try {
    proof.worker = await memory.request({command: 'root-native-worker-prepare', kind: 'pm-launch',
      handle: shell, title: proof.target, flags: proof.flags});
    if (serve) {
      // Park, then hand the session back before the request exists. The wait
      // array is rebuilt on the real handle and the mount requests are served
      // normally: no fake holder, no injection, no freeze.
      process.env.NS2_GATE_STEP_MODE ||= 'unpark-first';
      await gate.parkSession(); proof.parked = true; await save();
      // The second bound session can still hold the park handle in +0x30 if an
      // earlier stage left it parked; restore the real wait handle before the
      // Loader uses it for ConvertToDomain/mount.
      if (otherRow) {
        const wait = Number(otherRow.wait), current = await memory.u32(otherRow.address + 0x30);
        proof.otherWait = {before: current, expected: wait};
        if (current !== wait) {
          const bytes = Buffer.alloc(4); bytes.writeUInt32LE(wait);
          await memory.write(otherRow.address + 0x30, bytes, bytes);
          proof.otherWait.restored = true; await save();
        }
      }
      await gate.unpark(); proof.unparked = true;
      // Force the Loader's own session through the same wait-array rebuild: its
      // ConvertToDomain can stay queued forever if that array is stale.
      if (otherRow && process.env.NS2_LAUNCH_KICK_OTHER !== '0') {
        try {
          const otherGate = new Gate(memory, otherRow, state.apiWorkers, bound.waiters,
            server.handle, event);
          await otherGate.parkSession();
          await otherGate.unpark();
          // The notifier is shared by the whole pool and an auto-reset signal
          // wakes one waiter. Signal once per waiter so the second session's
          // parent actually leaves the notifier and re-arms on its real handle.
          const burst = Number(process.env.NS2_LAUNCH_KICK_WAKES || 8);
          const wakes = [];
          for (let i = 0; i < burst; i++) wakes.push(await otherGate.wake());
          proof.otherKick = {wakes, wake: wakes.some(Boolean),
            after: await otherGate.inspect(false)};
          await save();
        } catch (error) { proof.otherKickError = error.message; await save(); }
      }
      await gate.wake();
      await new Promise(resolve => setTimeout(resolve, Number(process.env.NS2_GATE_UNPARK_SETTLE_MS || 300)));
      proof.armed = await gate.inspect(false); await save();
      console.log(JSON.stringify({stage: 'launch-armed', file, armed: proof.armed}));
      if (process.env.NS2_LAUNCH_SOCKET_MAIN === '1') {
        // Diagnostic: run the raw socket chain on the app's main thread before
        // any worker exists. Test the sockaddr byte orders and the bind-style
        // zero address; the working bind uses the same 16-byte layout.
        const make = (ip, port, little) => {
          const sa = Buffer.alloc(16);
          sa[0] = 16; sa[1] = 2; sa.writeUInt16BE(port, 2);
          if (little) sa.writeUInt32LE(ip >>> 0, 4); else sa.writeUInt32BE(ip >>> 0, 4);
          return sa.toString('hex');
        };
        const host = dumpHost();
        const ip = host.split('.').reduce((a, b) => (a * 256) + Number(b), 0) >>> 0;
        const port = Number(process.env.NS2_DUMP_PORT || 39401);
        const cases = [
          ['zero', make(0, 0, false)],
          ['pc-be', make(ip, port, false)],
          ['pc-le', make(ip, port, true)],
          ['console-be', make(3232235994, 8080, false)],
          ['console-le', make(3232235994, 8080, true)]
        ];
        proof.socketMain = [];
        for (const [name, sockaddr] of cases) {
          const row = {name, connect: 0x14d3d0, sockaddr};
          try {
            Object.assign(row, await memory.request({command: 'root-native-socket-test',
              sockaddr, connect: 0x14d3d0}));
          } catch (error) { row.error = error.message; }
          proof.socketMain.push(row);
          await save();
        }
        throw Error('Socket main-thread diagnostic complete; see proof.socketMain');
      }
      const watch = process.env.NS2_LAUNCH_WAIT_ONLY === '1' || process.env.NS2_LAUNCH_WATCH === '1';
      if (process.env.NS2_LAUNCH_TCP_TEST === '1') {
        // Pure socket probe before the launch: no FS read, just connect/send a
        // fixed marker. If the listener sees this, the worker socket path and
        // the PC network path are good; if not, the retained-dump failure is not
        // the table read.
        const port = Number(process.env.NS2_DUMP_PORT || 39401);
        const host = dumpHost();
        proof.tcpTest = {pcAddress: host, port};
        try {
          proof.tcpTest.prepare = await memory.request({command: 'root-native-worker-prepare', slot: 2,
            areaOffset: 0x80000, kind: 'tcp-test', pcAddress: host, port});
          proof.tcpTest.release = await memory.request({command: 'root-native-worker-release', slot: 2});
          let state = null;
          for (let i = 0; i < 12; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            state = await memory.request({command: 'root-native-worker-state', slot: 2});
            if (state.finished) break;
          }
          proof.tcpTest.state = state;
          if (state?.finished) proof.tcpTest.join = await memory.request({command: 'root-native-worker-join', slot: 2});
          else proof.tcpTest.pending = true;
        } catch (error) { proof.tcpTest.error = error.message; }
        await save();
        if (proof.tcpTest.pending) throw Error('TCP test worker did not finish; see proof.tcpTest');
      }
      if (watch) {
        const bias = Number(memory.report.retainedMemory.bootstrapPlan.addressBias);
        const live = new Set((tableBaseline ? [...tableBaseline] : [])
          .map(key => Number(String(key).split(':')[0])));
        let firstFree = 1;
        while (live.has(firstFree)) firstFree++;
        const tableEnd = Number(layout.table) + Number(layout.count) * 0x30;
        const windowAddress = Number(layout.table) + (firstFree - 1) * 0x30;
        const windowLength = Math.min(0x4000, tableEnd - windowAddress);
        const port = Number(process.env.NS2_DUMP_PORT || 39401);
        const host = dumpHost();
        proof.watch = {kind: 'retained-dump', bias, firstFree, windowAddress, windowLength,
          pcAddress: host, port};
      }
      // Snapshot before the release: PM can mount inside the first round trip.
      let previous = await entries(memory, layout, root.targetDomain);
      proof.baseline = previous.length;
      if (watch) {
        // The installed signed plan maps logical offset L to bias + L over a
        // very wide range; that linear form is what the proven retained-read
        // path uses. Read the window at windowAddress - bias. A freshly
        // computed plan's readOffset is only valid once its header is written
        // to the cache, which this stage does not do: the 00:56 run passed
        // readOffset 0 and would have read the cache array, not the window.
        const storageSize = Number(memory.report.storageSize);
        proof.watch.readOffset = proof.watch.windowAddress - proof.watch.bias;
        check(proof.watch.readOffset >= 0 &&
          proof.watch.readOffset + proof.watch.windowLength <= storageSize,
          'Window offset is outside the retained storage');
        const before = await memory.read(proof.watch.windowAddress, proof.watch.windowLength);
        proof.watch.preLaunchSha256 = require('node:crypto').createHash('sha256')
          .update(before).digest('hex');
        proof.watch.prepare = await memory.request({command: 'root-native-worker-prepare', slot: 2,
          areaOffset: 0x100000, kind: 'retained-dump',
          handle: memory.report.retained.candidateHandle, readOffset: proof.watch.readOffset,
          length: proof.watch.windowLength,
          delayNs: Number(process.env.NS2_LAUNCH_DUMP_DELAY_MS || 1000) * 1e6,
          pcAddress: proof.watch.pcAddress, port: proof.watch.port});
        proof.watch.release = await memory.request({command: 'root-native-worker-release', slot: 2});
        await save();
      }
      stopLiveness = startLiveness(proof, save,
        Number(process.env.NS2_LAUNCH_LIVENESS_MS ?? 180000));
      await memory.request({command: 'root-native-worker-release'});
      if (process.env.NS2_LAUNCH_WAIT_ONLY === '1') {
        // Diagnostic for flags 0: the load is synchronous with the launch send,
        // so the shim is blocked while it runs. Wait host-side (no console RPC),
        // then inspect every fsp-srv session and the whole domain table once the
        // send has returned. If the app aborts, `up` is false and the proof says
        // so; the error code on the console is the next clue.
        const waitMs = Number(process.env.NS2_LAUNCH_WAIT_MS || 90000);
        proof.waitOnly = {started: new Date().toISOString(), waitMs, up: null};
        await save();
        await new Promise(resolve => setTimeout(resolve, waitMs));
        proof.waitOnly.up = await tcpUp(consoleHost(), 8080);
        await save();
        // The slot-2 worker's reads landed in app memory during the load. Read
        // them first: this is the data the retained endpoint cannot reach while
        // the slot-1 send holds the shim.
        // The socket dump is the primary channel. Reading the worker buffer
        // through the shim after the load wedged the endpoint in the 00:56 run
        // (60 s timeout, then every later request saw "active"), which cost the
        // post-launch table scan. Keep it opt-in for debugging only.
        if (proof.watch && process.env.NS2_LAUNCH_WORKER_OUTPUT === '1') {
          try {
            proof.watch.sentinel = await memory.request({command: 'root-native-worker-output', slot: 2,
              offset: 0x1100, length: 16});
            proof.watch.windows = [];
            const count = proof.watch.kind === 'retained-dump' ? 1 : 3;
            for (let i = 0; i < count; i++) {
              proof.watch.windows.push(await memory.request({command: 'root-native-worker-output', slot: 2,
                offset: 0x10000 + i * 0x4000, length: proof.watch.windowLength}));
            }
          } catch (error) { proof.watch.outputError = error.message; }
          await save();
        }
        // `up` only means the app's HTTP server is listening. The 23:37 run
        // proved it can be false while the retained endpoint still works, so the
        // dump runs unconditionally; a dead endpoint shows up as a read error.
        const inspectBudget = proof.watch ? 60000 : 120000;
        const inspectUntil = Date.now() + Number(process.env.NS2_LAUNCH_INSPECT_MS || inspectBudget);
        if (Date.now() < inspectUntil) {
          try { proof.postTargetEntries = await entries(memory, layout, root.targetDomain); }
          catch (error) { proof.postTargetError = error.message; }
        }
        if (Date.now() < inspectUntil) {
          try {
            proof.postSessions = [];
            for (const session of await scanSessions()) {
              if (Date.now() >= inspectUntil) break;
              try {
                const b = await memory.read(session.at, 0x88);
                const header = await memory.u32(Number(b.readBigUInt64LE(0x60)));
                const entry = {at: session.at, domain: session.domain,
                  parent: Number(b.readBigUInt64LE(0x28)), wait: b.readUInt32LE(0x30),
                  state: b.readUInt32LE(0x40), receiveResult: b.readUInt32LE(0x44),
                  receive: b.readUInt32LE(0x48),
                  header: header === 0xffffffff ? 'ffffffff' : '0x' + header.toString(16)};
                if (header !== 0xffffffff) {
                  const request = (await memory.read(Number(b.readBigUInt64LE(0x60)), 0x100)).toString('hex');
                  entry.request = request;
                  try { entry.requestInfo = requestInfo(request); }
                  catch (error) { entry.requestError = error.message; }
                }
                proof.postSessions.push(entry);
              } catch (error) {
                (proof.postSessionErrors ||= []).push({at: session.at, error: error.message});
                if (/timed out/i.test(error.message)) break;
              }
            }
          } catch (error) { proof.postSessionScanError = error.message; }
        }
        if (Date.now() < inspectUntil) {
          try {
            const rows = await tableRows(), baseline = tableBaseline || new Set();
            proof.postTableAdded = rows.filter(item => !baseline.has(tableKey(item)));
            proof.postTableMatches = proof.postTableAdded.filter(item => item.metadata === donor.metadata);
          } catch (error) { proof.postTableError = error.message; }
        }
        await save();
        proof.completion = {waitOnly: true, up: proof.waitOnly.up};
      } else {
      // PM should answer within seconds; keep this bounded so the send wait and
      // the pipeline's own 300 s script limit still fit.
      const deadline = Date.now() + Number(process.env.NS2_LAUNCH_TIMEOUT_MS || 120000);
      const rootId = (root.targetEntry - layout.table) / 0x30 + 1;
      // flags 0x10 = StartSuspended: the launch creates the process but does no
      // FS work, so the mount is deferred to the pm:dmnt start (late 47). Trigger
      // that start here, while the serve gate is still armed, instead of in the
      // later Start RO payload stage where the table is no longer watched.
      const monitor = state.services.find(x => x.name === 'pm:dmnt')?.handle;
      let startSent = false;
      while (Date.now() < deadline) {
        if (flags === 0x10 && !startSent && monitor) {
          try {
            const peek = await memory.request({command: 'root-native-worker-peek'});
            if (peek.values.every(value => value !== peek.sentinel)) {
              const raw = Buffer.from(peek.responses[0], 'hex');
              const reply = response(raw);
              const pid = reply.data && reply.data.length >= 8
                ? reply.data.readBigUInt64LE().toString() : null;
              if (reply.result === 0 && pid) {
                // The start is itself a blocking svcSendSyncRequest: it cannot
                // return until the Loader's mount request is served. Run it on a
                // slot-2 worker so the host stays free to poll the table.
                proof.startWorker = await memory.request({command: 'root-native-worker-prepare',
                  slot: 2, areaOffset: 0x100000, kind: 'pm-start', handle: monitor, pid: Number(pid)});
                proof.startRelease = await memory.request({command: 'root-native-worker-release', slot: 2});
                proof.start = {result: 0, worker: true};
                proof.startPid = pid; startSent = true;
                await save();
                console.log(JSON.stringify({stage: 'launch-start-worker', pid,
                  thread: proof.startWorker.thread}));
              } else proof.startWaiting = {result: reply.result, pid};
            }
          } catch (error) { proof.startError = error.message; await save(); }
        }
        await new Promise(resolve => setTimeout(resolve, Number(process.env.NS2_LAUNCH_POLL_MS || 20)));
        let current;
        try { current = await entries(memory, layout, root.targetDomain); }
        catch (error) { proof.pollError = error.message; await save(); continue; }
        const added = current.filter(a => !previous.some(b => b.id === a.id && b.object === a.object));
        if (added.length) {
          const record = {index: proof.requests.length, added: added.map(a => a.id),
            removed: previous.filter(b => !current.some(a => a.id === b.id && a.object === b.object)).map(b => b.id),
            at: new Date().toISOString()};
          try {
            const request = (await memory.read(row.request, 0x100)).toString('hex');
            record.request = request;
            record.requestInfo = requestInfo(request);
          } catch (error) { record.requestError = error.message; }
          proof.requests.push(record);
          const code = added.find(a => a.metadata === donor.metadata);
          if (code) {
            proof.mounts++;
            record.targetMount = proof.mounts;
            console.log(JSON.stringify({stage: 'mount-seen', mount: proof.mounts, object: code.id}));
            if (proof.mounts === wantedMount) {
              const currentDonor = await memory.read(donor.entry, 0x30);
              check(currentDonor.subarray(0x18).equals(Buffer.from(donor.raw, 'hex').subarray(0x18)) &&
                await memory.pointer(code.object) === donor.vptr && await memory.pointer(donor.object) === donor.vptr,
              'Filesystem identity or concrete adapter type changed');
              proof.exchange = {code, donor, started: new Date().toISOString(), firstWritten: false, secondWritten: false};
              await save();
              await memory.writeU64(code.entry + 0x20, code.object, donor.object);
              proof.exchange.firstWritten = true; await save();
              try {
                await memory.writeU64(donor.entry + 0x20, donor.object, code.object);
                proof.exchange.secondWritten = true; await save();
              } catch (error) {
                check(await memory.pointer(donor.entry + 0x20) === donor.object, 'Donor write failed without restoration');
                await memory.writeU64(code.entry + 0x20, donor.object, code.object);
                proof.exchange.rolledBack = true; await save();
                throw error;
              }
              check(await memory.pointer(code.entry + 0x18) === root.targetDomain &&
                await memory.pointer(code.entry + 0x20) === donor.object &&
                await memory.pointer(donor.entry + 0x18) === donor.domain &&
                await memory.pointer(donor.entry + 0x20) === code.object, 'Owning-reference exchange did not verify');
              proof.swapped = true; await save();
              console.log(JSON.stringify({stage: 'filesystem-exchanged', file, mount: proof.mounts, object: code.id}));
              break;
            }
          }
          await save();
        }
        // A launch can use a session/domain that already existed at boot, so
        // watching only new domains is not enough. Snapshot every session
        // domain once, then look for an entry that appears in any of them with
        // the donor metadata.
        if (Date.now() - (proof.lastDomainScan || 0) >= Number(process.env.NS2_LAUNCH_DOMAIN_POLL_MS || 500)) {
          proof.lastDomainScan = Date.now();
          try {
            for (const session of await scanSessions()) {
              knownDomains.add(session.domain);
              if (!reportedDomains.has(session.domain)) {
                reportedDomains.add(session.domain);
                (proof.newDomains ||= []).push({domain: session.domain, session: session.at});
              }
            }
            for (const domain of knownDomains) {
              let baseline = domainBaseline.get(domain);
              if (!baseline) {
                // The domain was not walkable when snapshotted. Its first
                // successful walk is treated as all-new so a mount that created
                // it is not missed.
                try {
                  await entries(memory, layout, domain);
                  baseline = [];
                  domainBaseline.set(domain, baseline);
                } catch { proof.domainWalkFailed = (proof.domainWalkFailed || 0) + 1; continue; }
              }
              let rows;
              try { rows = await entries(memory, layout, domain); }
              catch { proof.domainWalkFailed = (proof.domainWalkFailed || 0) + 1; continue; }
              const added = rows.filter(a => !baseline.some(b => b.id === a.id && b.object === a.object));
              if (!added.length) continue;
              const code = added.find(a => a.metadata === donor.metadata);
              (proof.domainRows ||= []).push({domain, added: added.map(a => a.id),
                metadataMatch: Boolean(code)});
              console.log(JSON.stringify({stage: 'launch-domain-entry', domain,
                added: added.map(a => a.id), match: Boolean(code)}));
              if (!code) continue;
              proof.mounts++;
              proof.mountDomain = domain;
              await exchange(code, domain);
              break;
            }
          } catch (error) { proof.domainScanError = error.message; }
          await save();
          if (proof.swapped) break;
        }
        if (tableBaseline && Date.now() - (proof.lastTableScan || 0) >=
            Number(process.env.NS2_LAUNCH_TABLE_POLL_MS || 2000)) {
          proof.lastTableScan = Date.now();
          try {
            const rows = await tableRows();
            const added = rows.filter(item => !tableBaseline.has(tableKey(item)));
            if (added.length) {
              (proof.tableAdded ||= []).push({at: new Date().toISOString(), rows: added.length,
                ids: added.slice(0, 8).map(item => item.id)});
              const code = added.find(item => item.metadata === donor.metadata);
              console.log(JSON.stringify({stage: 'launch-table-entry', added: added.length,
                ids: added.slice(0, 8).map(item => item.id), match: Boolean(code)}));
              if (code) {
                proof.mounts++;
                proof.mountDomain = code.domain;
                await exchange(code, code.domain);
              }
            }
          } catch (error) { proof.tableScanError = error.message; }
          await save();
          if (proof.swapped) break;
        }
        // Record every change of the bound session's request header so we can
        // tell whether the Loader's mount request reached this session at all.
        try {
          const sessionBytes = await memory.read(row.address, 0x88);
          const header = await memory.u32(row.request);
          const marker = header + ':' + sessionBytes.readUInt32LE(0x40) + ':' +
            sessionBytes.readUInt32LE(0x44);
          if (marker !== proof.sessionMarker) {
            proof.sessionMarker = marker;
            const entry = {at: new Date().toISOString(), header, state: sessionBytes.readUInt32LE(0x40),
              receiveResult: sessionBytes.readUInt32LE(0x44)};
            if (header !== 0xffffffff) {
              const request = (await memory.read(row.request, 0x100)).toString('hex');
              entry.request = request;
              try { entry.requestInfo = requestInfo(request); } catch (error) { entry.requestError = error.message; }
            }
            (proof.sessionTimeline ||= []).push(entry);
            if (proof.sessionTimeline.length > 200) proof.sessionTimeline.shift();
          }
        } catch (error) { proof.sessionTimelineError = error.message; }
        if (otherRow) {
          try {
            const b = await memory.read(otherRow.address, 0x88);
            const header = await memory.u32(otherRow.request);
            const marker = 'o' + header + ':' + b.readUInt32LE(0x40) + ':' + b.readUInt32LE(0x44);
            if (marker !== proof.otherMarker) {
              proof.otherMarker = marker;
              const entry = {row: 'other', at: new Date().toISOString(), header,
              wait30: b.readUInt32LE(0x30), state: b.readUInt32LE(0x40),
              receiveResult: b.readUInt32LE(0x44)};
              if (header !== 0xffffffff) {
                const request = (await memory.read(otherRow.request, 0x100)).toString('hex');
                entry.request = request;
                try { entry.requestInfo = requestInfo(request); } catch (error) { entry.requestError = error.message; }
              }
              (proof.otherTimeline ||= []).push(entry);
            }
          } catch (error) { proof.otherTimelineError = error.message; }
        }
        // The Loader's session may still be parked on the same notifier; keep
        // signalling so its queued ConvertToDomain/mount request is served.
        if (Date.now() - (proof.lastWake || 0) >= Number(process.env.NS2_LAUNCH_WAKE_MS || 500)) {
          proof.lastWake = Date.now();
          // Same shared notifier: one signal wakes one pool thread, so burst
          // enough signals to cover all seven waiters.
          const burst = Number(process.env.NS2_LAUNCH_WAKE_BURST || 8);
          try {
            for (let i = 0; i < burst; i++)
              proof.wakes = (proof.wakes || 0) + (await gate.wake() ? 1 : 0);
          } catch (error) { proof.wakeError = error.message; }
        }
        previous = current;
      }
      // TryWaitThread blocks on this build even after the chain has stored every
      // result (00:21 run), so wait on the cells and settle without joining.
      const until = Date.now() + 60000;
      for (;;) {
        proof.peek = await memory.request({command: 'root-native-worker-peek'});
        if (proof.peek.values.every(value => value !== proof.peek.sentinel)) break;
        check(Date.now() < until, 'PM did not answer after the filesystem exchange');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      proof.completion = await memory.request({command: 'root-native-worker-settle'});
      }
    } else {
    // flags 0x10 = StartSuspended: create the process while the FS session is
    // still unparked (process creation reads the NPDM through it), then park the
    // session and run the deferred pm:dmnt start on a slot-2 worker. Parking
    // before the launch made the NPDM read block and wedged the endpoint.
    if (flags === 0x10) {
      await memory.request({command: 'root-native-worker-release'});
      const monitor = state.services.find(x => x.name === 'pm:dmnt')?.handle;
      check(monitor, 'The owned PM monitor is missing');
      let pid = null;
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        const peek = await memory.request({command: 'root-native-worker-peek'});
        if (peek.values.every(value => value !== peek.sentinel)) {
          const reply = response(Buffer.from(peek.responses[0], 'hex'));
          if (reply.result !== 0) throw Error('The suspended launch failed: ' + reply.result);
          pid = reply.data && reply.data.length >= 8
            ? reply.data.readBigUInt64LE().toString() : null;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      check(pid, 'The suspended launch returned no pid');
      // Probe the holder before parking: the FS wait chain links the session
      // object itself, and before parking the session still holds the real wait
      // handle. Refuse to inject if the object or handle differs.
      proof.holderProbe = await memory.request({command: 'retained-holder-probe',
        server: row.address, holder: gate.holder}); await save();
      proof.holderProbe.handleMatches = proof.holderProbe.handle === row.wait;
      proof.holderProbe.vptrMatches = proof.holderProbe.vptr === gate.vptr.toString();
      console.log(JSON.stringify({stage: 'holder-probe', ...proof.holderProbe, raw: undefined}));
      check(proof.holderProbe.userData === '1' && proof.holderProbe.vptrMatches &&
        proof.holderProbe.handleMatches,
        'Holder candidate is not the bound session object; refusing to inject');
      await gate.parkSession(); proof.parked = true; await save();
      proof.startWorker = await memory.request({command: 'root-native-worker-prepare', slot: 2,
        areaOffset: 0x100000, kind: 'pm-start', handle: monitor, pid: Number(pid)});
      proof.startRelease = await memory.request({command: 'root-native-worker-release', slot: 2});
      proof.start = {result: 0, worker: true}; proof.startPid = pid;
      await save();
      console.log(JSON.stringify({stage: 'launch-start-worker', pid,
        thread: proof.startWorker.thread}));
    } else {
      await gate.parkSession(); proof.parked = true; await save();
      await memory.request({command: 'root-native-worker-release'});
    }
    // The 03:16 captures settle the read: the file Read unlinks its own domain
    // entry (slot 142 came back self-linked, +0x18/+0x20 zero) but leaves
    // +0x28 metadata intact. The IFile object itself is not closed by Read, and
    // the served-request record still has the object pointer from before the
    // free. Serving the bare freed slot dereferences object 0 and faults
    // (02:20); the root-borrow close killed the FS (03:58). So restore the slot
    // from the `removed` record and let the Loader's close release the file
    // normally. This matters now: the deferred pm:dmnt start blocks until the
    // Loader's NPDM thread finishes, so leaving the close queued parks the
    // start forever (the 10:35 run timed out in Start RO payload).
    async function unlinkFree(slot) {
      const manager = Number(layout.manager), table = Number(layout.table), count = Number(layout.count);
      if (!Number.isSafeInteger(manager) || manager < 2 ** 32 ||
          !Number.isSafeInteger(table) || !Number.isInteger(count)) return false;
      const inside = at => at >= table && at < table + count * 0x30 && (at - table) % 0x30 === 0;
      const headAddr = manager + 0x28;
      const head = await memory.pointer(headAddr);
      if (head === slot) {
        const b = await memory.read(slot, 0x30);
        await memory.writeU64(headAddr, slot, ptr(b, 0x10));
        return true;
      }
      let at = head;
      for (let n = 0; n < count && at; n++) {
        if (!inside(at)) return false;
        const b = await memory.read(at, 0x30);
        const next = ptr(b, 0x10);
        if (next === slot) {
          const s = await memory.read(slot, 0x30);
          await memory.writeU64(at + 0x10, slot, ptr(s, 0x10));
          return true;
        }
        at = next;
      }
      return false;
    }

    // Move every live entry from one domain list to another without touching
    // the object references. Used to put the Loader's session domain where the
    // adopted spare entry lives, so the close lookup and the entry's owning
    // domain agree.
    async function migrateDomain(from, to) {
      if (from === to) return {moved: 0};
      const fromSentinel = from + 0x20, toSentinel = to + 0x20;
      const first = await memory.pointer(fromSentinel);
      if (first === fromSentinel) return {moved: 0};
      const last = await memory.pointer(fromSentinel + 0x08);
      let at = first, moved = 0;
      for (let n = 0; n < 128 && at !== fromSentinel; n++) {
        const b = await memory.read(at, 0x30);
        if (ptr(b, 0x18) !== from) throw Error('Domain entry owner changed during migration');
        const updated = Buffer.from(b);
        updated.writeBigUInt64LE(BigInt(to), 0x18);
        await memory.write(at, b, updated);
        at = ptr(b, 0x00);
        moved++;
      }
      if (at !== fromSentinel) throw Error('Domain list did not terminate during migration');
      const toFirst = await memory.pointer(toSentinel);
      await memory.writeU64(last, fromSentinel, toFirst);
      if (toFirst !== toSentinel) {
        const p = await memory.pointer(toFirst + 0x08);
        await memory.writeU64(toFirst + 0x08, p, last);
      } else {
        await memory.writeU64(toSentinel + 0x08, toSentinel, last);
      }
      await memory.writeU64(toSentinel, toFirst, first);
      await memory.writeU64(first + 0x08, fromSentinel, toSentinel);
      await memory.writeU64(fromSentinel, first, fromSentinel);
      await memory.writeU64(fromSentinel + 0x08, last, fromSentinel);
      return {moved, first, last};
    }

    async function recoverRemovedEntry(id) {
      let removed = null;
      for (let i = proof.requests.length - 1; i >= 0 && !removed; i--)
        removed = (proof.requests[i].removed || []).find(entry => entry.id === id) || null;
      if (!removed?.object || !removed?.metadata || !removed?.entry) return null;
      if (!(removed.metadata >= 2 ** 32 && removed.metadata < 2 ** 39)) return null;
      const vptr = await memory.pointer(removed.object);
      // The file object is an FS-module class: its vtable must sit near the
      // donor's vtable, not merely anywhere in the 39-bit user range.
      if (!(vptr >= 2 ** 32 && vptr < 2 ** 39) ||
          Math.abs(vptr - Number(donor.vptr)) > 0x100000) return null;
      const slot = removed.entry, table = Number(layout.table), count = Number(layout.count);
      if (!(slot >= table && slot < table + count * 0x30 && (slot - table) % 0x30 === 0)) return null;
      const b = await memory.read(slot, 0x30);
      if (ptr(b, 0x18) !== 0 || ptr(b, 0x20) !== 0) return null;
      // Removing the slot from the free list also proves the FS has not already
      // handed it to another request; if it did, leave the close stale.
      if (!await unlinkFree(slot).catch(() => false)) return null;
      const sentinel = Number(root.targetDomain) + 0x20;
      const sNext = await memory.pointer(sentinel);
      const updated = Buffer.from(b);
      updated.writeBigUInt64LE(BigInt(sNext), 0x00);
      updated.writeBigUInt64LE(BigInt(sentinel), 0x08);
      updated.writeBigUInt64LE(0n, 0x10);
      updated.writeBigUInt64LE(BigInt(root.targetDomain), 0x18);
      updated.writeBigUInt64LE(BigInt(removed.object), 0x20);
      updated.writeBigUInt64LE(BigInt(removed.metadata), 0x28);
      await memory.write(slot, b, updated);
      if (sNext !== sentinel) {
        const prev = (await memory.read(sNext + 0x08, 8)).readBigUInt64LE();
        await memory.writeU64(sNext + 0x08, Number(prev), slot);
      }
      await memory.writeU64(sentinel, sNext, slot);
      const readback = await memory.read(slot, 0x30);
      if (ptr(readback, 0x18) !== Number(root.targetDomain) || ptr(readback, 0x20) !== removed.object)
        return null;
      // Diagnostic only: the object header lives in the FS heap, which the
      // retained endpoint can still read. If the close faults again this shows
      // whether the target is the file proxy or something else.
      const header = await memory.read(removed.object, 0x80).then(b => b.toString('hex')).catch(() => null);
      return {id, slot, object: removed.object, metadata: removed.metadata, vptr, header, sNext};
    }

    // The consumed NPDM file cannot be restored: its Read frees the entry and
    // the close path faults on the dead object (11:10..14:37). Open a fresh file
    // instead (CodeFS by default), take its domain entry away from its own
    // domain *without releasing the object*, and put the freed NPDM id back into
    // that same domain. The entry and object then share a domain, so the close
    // either closes a normal file object or is rejected without touching the
    // consumed object or the donor filesystem.
    async function adoptSpareEntry(id) {
      const table = Number(layout.table), count = Number(layout.count), manager = Number(layout.manager);
      if (!Number.isSafeInteger(table) || !Number.isInteger(count) ||
          !Number.isSafeInteger(manager)) return null;
      const target = table + (id - 1) * 0x30;
      if (!(target >= table && target < table + count * 0x30 && (target - table) % 0x30 === 0)) return null;
      const targetBefore = await memory.read(target, 0x30);
      const targetDomain = ptr(targetBefore, 0x18), targetObject = ptr(targetBefore, 0x20);
      const freed = targetDomain === 0 && targetObject === 0;
      if (!freed) {
        // The slot is still linked but its object is dead (the Read freed the
        // object without unlinking the entry). Remove it from its domain list
        // before replacing it; the dead reference is not released.
        if (!(targetDomain >= 2 ** 32 && targetDomain < 2 ** 39)) return null;
        const tNext = ptr(targetBefore, 0x00), tPrev = ptr(targetBefore, 0x08);
        if (tNext === target || tPrev === target) return null;
        if (await memory.pointer(tPrev) !== target ||
            await memory.pointer(tNext + 0x08) !== target) return null;
        await memory.writeU64(tPrev, target, tNext);
        await memory.writeU64(tNext + 0x08, target, tPrev);
      }
      let spare;
      try {
        // Use the donor save filesystem: its file objects are ordinary save
        // files, and the adopted entry is linked into the same donor domain the
        // session is migrated to. The CodeFS spare is only a fallback (its
        // object is an aux-data file, which may have a special close path).
        spare = await memory.request({command: 'root-native-file-spare', name: 'main.npdm', source: 'donor'});
      } catch (error) {
        spare = await memory.request({command: 'root-native-file-spare', name: 'main.npdm', source: 'code'});
      }
      const spareSlot = table + (spare.id - 1) * 0x30;
      const sb = await memory.read(spareSlot, 0x30);
      const object = ptr(sb, 0x20), metadata = ptr(sb, 0x28), spareDomain = ptr(sb, 0x18);
      if (!(spareDomain >= 2 ** 32 && spareDomain < 2 ** 39) ||
          !(object >= 2 ** 32 && object < 2 ** 39) ||
          !(metadata >= 2 ** 32 && metadata < 2 ** 39)) return null;
      const vptr = await memory.pointer(object);
      if (!(vptr >= 2 ** 32 && vptr < 2 ** 39)) return null;
      const next = ptr(sb, 0x00), prev = ptr(sb, 0x08);
      if (next === spareSlot || prev === spareSlot) return null;
      // Unlink the spare entry from the donor domain list. The object keeps the
      // entry's reference; we deliberately do not release it, so the target
      // entry can take that reference over.
      if (await memory.pointer(prev) !== spareSlot ||
          await memory.pointer(next + 0x08) !== spareSlot) return null;
      await memory.writeU64(prev, spareSlot, next);
      await memory.writeU64(next + 0x08, spareSlot, prev);
      if (spareSlot !== target) {
        // Return the now-unreferenced donor slot to the manager free list. Its
        // object reference is transferred to the target entry, not released.
        const head = await memory.pointer(manager + 0x28);
        const free = Buffer.alloc(0x30);
        free.writeBigUInt64LE(BigInt(spareSlot), 0x00);
        free.writeBigUInt64LE(BigInt(spareSlot), 0x08);
        free.writeBigUInt64LE(BigInt(head), 0x10);
        free.writeBigUInt64LE(0n, 0x18);
        free.writeBigUInt64LE(0n, 0x20);
        free.writeBigUInt64LE(0n, 0x28);
        await memory.write(spareSlot, sb, free);
        await memory.writeU64(manager + 0x28, head, spareSlot);
        if (freed && !await unlinkFree(target).catch(() => false)) return null;
      }
      // Keep the entry in the same domain as the object it now points at. The
      // close path faults when a target-domain entry references an object whose
      // own domain is elsewhere (the donor target and the target-domain spare
      // both did). The spare entry already lives in the object's domain, so put
      // the freed id there too. If the FS checks the caller's domain it replies
      // with an error; if it uses the table id it closes a normal file object.
      const sentinel = spareDomain + 0x20;
      const sNext = await memory.pointer(sentinel);
      const base = spareSlot === target ? sb : targetBefore;
      const updated = Buffer.from(base);
      updated.writeBigUInt64LE(BigInt(sNext), 0x00);
      updated.writeBigUInt64LE(BigInt(sentinel), 0x08);
      updated.writeBigUInt64LE(0n, 0x10);
      updated.writeBigUInt64LE(BigInt(spareDomain), 0x18);
      updated.writeBigUInt64LE(BigInt(object), 0x20);
      updated.writeBigUInt64LE(BigInt(metadata), 0x28);
      await memory.write(target, base, updated);
      if (sNext !== sentinel) {
        const p = await memory.pointer(sNext + 0x08);
        await memory.writeU64(sNext + 0x08, p, target);
      }
      await memory.writeU64(sentinel, sNext, target);
      const readback = await memory.read(target, 0x30);
      if (ptr(readback, 0x18) !== spareDomain || ptr(readback, 0x20) !== object)
        return null;
      // Put the Loader's session in the same domain as the adopted entry. The
      // close handler looks the id up through the session's domain; leaving the
      // session in targetDomain while the entry lives in the spare's domain is
      // what still faulted at 21:40. Move the root/save-FS entries with it so
      // the Loader's next OpenFile /main keeps working.
      const migrated = await migrateDomain(Number(root.targetDomain), spareDomain);
      const currentDomain = await memory.pointer(row.address + 0x70);
      if (currentDomain !== spareDomain) {
        await memory.writeU64(row.address + 0x70, currentDomain, spareDomain);
        row.domain = spareDomain;
      }
      // The close path appears to run a destructor even when CopyObject has
      // duplicated the handle (13:52, 21:40). Inflate the object's two atomic
      // reference counters before the close so a refcounted release cannot
      // reach zero. The object is intentionally leaked; a live leaked file is
      // harmless, a destructor run during the close faults the FS.
      const headerBytes = await memory.read(object, 0x80).catch(() => null);
      let refs = null;
      if (headerBytes) {
        const bumped = Buffer.from(headerBytes);
        refs = {};
        for (const off of [0x28, 0x58]) {
          const value = bumped.readBigUInt64LE(off);
          const low = value & 0xffffffffffffn;
          if ((value >> 63n) === 1n && low < 0x1000n) {
            refs['0x' + off.toString(16)] = value.toString();
            bumped.writeBigUInt64LE((value & (1n << 63n)) | (low + 0x100n), off);
          }
        }
        if (Object.keys(refs).length) await memory.write(object, headerBytes, bumped);
      }
      const header = headerBytes ? headerBytes.toString('hex') : null;
      return {id, slot: target, object, metadata, vptr, header, refs, spare: spare.id,
        copy: spare.handle, spareDomain, sNext, migrated, sessionDomain: spareDomain};
    }

    // The file Read removes its own domain entry and releases one reference.
    // If that was the last reference the file object is freed and the Loader's
    // close dereferences dead memory (11:10) or, when we substitute a different
    // file, the cross-domain release faults the FS (11:38). Keep the Loader's
    // own object alive: before the Read, briefly expose it through our
    // inspection-domain slot and CopyObject it twice, then restore the slot.
    // The Read drops the entry reference; the close drops another one. Two
    // copies leave one reference alive after the close, so the file object's
    // destructor never runs. That destructor is the fault: with one copy the
    // close released the last reference and the FS died (13:52, 2162-0002).
    async function addObjectReference(entry) {
      const owned = await memory.request({command: 'root-native-domain-open'});
      const ownEntry = Number(layout.table) + (Number(owned.root) - 1) * 0x30;
      const original = await memory.read(ownEntry, 0x30);
      const borrowed = Buffer.from(original);
      borrowed.writeBigUInt64LE(BigInt(entry.object), 0x20);
      borrowed.writeBigUInt64LE(BigInt(entry.metadata), 0x28);
      await memory.write(ownEntry, original, borrowed);
      // Two copies, not one. The Read removes the entry and releases its
      // reference; the Loader's close then removes the restored entry and
      // releases another. With a single copy the close releases the last
      // reference, runs the file object's destructor, and the FS faults. With
      // two, one reference survives the close so the destructor never runs and
      // the close is only a domain-entry removal (the leaked object is fine).
      const copies = [];
      try {
        for (let i = 0; i < 2; i++) {
          const copy = await memory.request({command: 'root-native-domain-copy',
            handle: Number(owned.handle), object: Number(owned.root)});
          check(Number(copy.handle) > 0, 'Reference copy returned no handle');
          copies.push(Number(copy.handle));
        }
      } finally {
        await memory.write(ownEntry, borrowed, original);
      }
      check((await memory.read(ownEntry, 0x30)).equals(original),
        'Inspection slot did not restore after the reference copy');
      return {entry: entry.id, object: entry.object, metadata: entry.metadata,
        copy: copies[0], copy2: copies[1], at: new Date().toISOString()};
    }

    const launchSlot = flags === 0x10 ? 2 : 1;
    const deadline = Date.now() + 240000;
    const quietMs = Number(process.env.NS2_LAUNCH_QUIET_MS || 15000);
    let lastBuffer = null, lastServedAt = Date.now(), sameWaits = 0;
    let closeServeKey = null, closeServeCount = 0;
    const servedFreedCloses = new Set();
    for (let i = 0; i < 160; i++) {
      if (flags === 0x10) {
        // No worker-peek here: reading the worker's response area while it is
        // inside svcSendSyncRequest may be what wedges the control thread.
        // Let stepWake's retained inspect/header read be the first RPC.
        await new Promise(resolve => setTimeout(resolve, Number(process.env.NS2_LAUNCH_GATE_MS || 1000)));
      } else {
        while (!await gate.pending()) {
          const worker = await memory.request({command: 'root-native-worker-state'});
          if (worker.finished) break;
          check(Date.now() < deadline, 'PM launch did not reach the parked FS session');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if ((await memory.request({command: 'root-native-worker-state'})).finished) break;
      }
      check(Date.now() < deadline, 'PM launch did not reach the parked FS session');
      // After the exchange the Loader still owns the FS session: it must open
      // and read the payload main through the swapped entry, and the Loader's
      // subsequent requests are served by the donor object. Breaking here (the
      // 01:45 run) left OpenFile queued forever and the launched process
      // faulted. Keep serving until the deferred pm:dmnt start returns.
      // Do not re-serve a request the FS already consumed during the previous
      // serve window. stepServe snapshots the buffer right after the wake, so a
      // buffer that still matches it means the client has not queued anything
      // new. A close is special: the save-file Read frees its own entry and the
      // Loader blocks on the close (the 03:16 run), so a close still present one
      // full iteration later is pending and gets a read-only request
      // substituted for it. A close the FS already consumed is followed by the
      // Loader's next request within that iteration, so it does not match again.
      // Non-close repeats fall through after two waits so a genuine repeat
      // cannot stall the launch.
      let pending = null, pendingInfo = null;
      if (flags === 0x10 && proof.swapped) {
        pending = (await memory.read(row.request, 0x100)).toString('hex');
        try { pendingInfo = requestInfo(pending); } catch (error) {}
        const repeat = lastBuffer && pending === lastBuffer;
        if (repeat) sameWaits++; else sameWaits = 0;
        // Poll the deferred pm:dmnt start only when the Loader has nothing new
        // queued. A request queued on the parked session blocks the FS that
        // serves the retained endpoint, so polling first stalls for the full
        // RPC timeout and the loop gives up before serving the Loader's next
        // request (the 22:57 run died exactly here after the NPDM close).
        if (!pendingInfo || repeat) {
          try {
            const values = await memory.request({command: 'root-native-worker-values', slot: 2});
            if (values.values.every(value => value !== values.sentinel)) {
              proof.startValues = values.values;
              proof.servedAfterSwap = proof.requests.length - proof.swapIndex;
              await save();
              break;
            }
          } catch (error) { proof.workerValuesError = error.message; }
        }
        if (Date.now() - lastServedAt >= quietMs) break;
        if (repeat) {
          if (pendingInfo?.kind === 'close') {
            if (sameWaits < 1) {
              if (Date.now() - lastServedAt >= quietMs) break;
              continue;
            }
          } else if (sameWaits < 2) continue;
        }
        if (pendingInfo?.kind === 'close') {
          if (servedFreedCloses.has(pendingInfo.object)) {
            // Already answered as a freed slot; the Loader has not queued its
            // next request yet. Do not inject the same close a second time and
            // do not let the repeat guard mark it stale.
            if (Date.now() - lastServedAt >= quietMs) break;
            continue;
          }
          if (closeServeKey !== pendingInfo.object) { closeServeKey = pendingInfo.object; closeServeCount = 0; }
          if (++closeServeCount > 2) {
            (proof.staleCloses ||= []).push({index: i, object: pendingInfo.object,
              reason: 'close repeated after repair'});
            if (Date.now() - lastServedAt >= quietMs) break;
            continue;
          }
          // The Read unlinked its own domain entry, so the close's id is no
          // longer live. Every attempt that restored the consumed file object
          // faulted the FS (11:10, 11:38, 11:51, 13:52, 14:11), hiding the id
          // behind the manager count did not help (14:37), and retargeting the
          // restored slot at the donor filesystem faulted too (20:36). Give the
          // close a valid target-domain entry instead: open a fresh file on the
          // donor filesystem and adopt its object/reference into the freed slot
          // (adoptSpareEntry). The donor filesystem itself is never the target.
          const current = await entries(memory, layout, root.targetDomain);
          const present = current.find(entry => entry.id === pendingInfo.object);
          let live = !!present && present.object >= 2 ** 32 && present.object < 2 ** 39;
          if (live) {
            const vp = await memory.pointer(present.object).catch(() => 0);
            live = vp >= 2 ** 32 && vp < 2 ** 39 &&
              Math.abs(vp - Number(donor.vptr)) < 0x100000;
          }
          if (!live) {
            // fs.elf +0x219EA0 (CmifServerDomain::UnregisterObject) only
            // touches an entry whose owning domain (+0x18) equals the caller's
            // domain; otherwise it returns a null object and the close succeeds
            // without releasing anything. The Read frees its own entry
            // (+0x18/+0x20 = 0), so the close is already safe as-is. Resurrecting
            // the slot (restore/adopt) makes the close release a live FS object
            // and is what faulted the FS at 11:10..22:20.
            if (process.env.NS2_LAUNCH_CLOSE_ADOPT !== '1' &&
                !servedFreedCloses.has(pendingInfo.object)) {
              const slot = Number(layout.table) + (pendingInfo.object - 1) * 0x30;
              const raw = await memory.read(slot, 0x30).catch(() => null);
              const owner = raw ? ptr(raw, 0x18) : null;
              const object = raw ? ptr(raw, 0x20) : null;
              const record = {index: i, id: pendingInfo.object, slot, owner, object,
                raw: raw ? raw.toString('hex') : null};
              (proof.closeSlots ||= []).push(record);
              console.log(JSON.stringify({stage: 'close-slot', index: i,
                id: pendingInfo.object, owner, object}));
              // The slot is off the domain list but may still carry an owner if
              // the Read only unlinked it. Clear the owner/object so the close
              // cannot release it. The +0x00/+0x08 links are untouched.
              if (raw && (owner !== 0 || object !== 0)) {
                const cleared = Buffer.from(raw);
                cleared.writeBigUInt64LE(0n, 0x18);
                cleared.writeBigUInt64LE(0n, 0x20);
                await memory.write(slot, raw, cleared);
                record.cleared = true;
                await save();
              }
              // The Read also puts the freed slot on the manager's free list.
              // If another allocation (the FS's own background work) takes it
              // between this read and the injected close, the close lands on a
              // reused entry and releases the wrong object; that race is why the
              // freed close is intermittent (22:57 succeeded, 23:10 and 23:26
              // faulted). Pin the slot out of the free list while leaving
              // +0x18/+0x20 zero, so UnregisterObject cannot match it and no
              // allocator can reuse it.
              const pinned = await unlinkFree(slot).catch(() => false);
              record.pinned = pinned;
              await save();
              if (!pinned) {
                // The slot already left the free list, so it may have been
                // reused. Do not inject a close that could hit it.
                (proof.staleCloses ||= []).push({index: i, object: pendingInfo.object,
                  reason: 'freed slot could not be pinned out of the free list'});
                if (Date.now() - lastServedAt >= quietMs) break;
                continue;
              }
              try {
                const step = await gate.stepServe({force: true, skipAfter: true});
                servedFreedCloses.add(pendingInfo.object);
                (proof.closesServed ||= []).push({index: i, id: pendingInfo.object,
                  empty: !!step.empty, target: 'freed',
                  request: step.request ? step.request.slice(0, 64) : null});
                await save();
                console.log(JSON.stringify({stage: 'close-served', index: i,
                  id: pendingInfo.object, target: 'freed', empty: !!step.empty}));
                lastBuffer = step.bufferAfterWake || step.request;
                lastServedAt = Date.now(); sameWaits = 0;
                continue;
              } catch (error) {
                // Never hand a failed close back to the FS: the 14:37 fallback
                // did exactly that and faulted. Keep the session parked.
                proof.closeServeError = error.stack;
                proof.heldClose = true;
                await save();
                throw error;
              }
            }
            if (process.env.NS2_LAUNCH_CLOSE_HANDBACK === '1') {
              const recovered = await recoverRemovedEntry(pendingInfo.object).catch(error => {
                (proof.recoverErrors ||= []).push({index: i, object: pendingInfo.object, error: error.message});
                return null;
              });
              if (recovered) {
                (proof.recoveredCloses ||= []).push({index: i, ...recovered});
                console.log(JSON.stringify({stage: 'close-recovered', index: i, ...recovered}));
                proof.closeHandedBack = true;
                await save();
                break;
              }
            }
            const adopted = await adoptSpareEntry(pendingInfo.object).catch(error => {
              (proof.adoptErrors ||= []).push({index: i, object: pendingInfo.object, error: error.message});
              return null;
            });
            if (adopted) {
              (proof.adoptedCloses ||= []).push({index: i, ...adopted});
              console.log(JSON.stringify({stage: 'close-adopted', index: i, ...adopted}));
              proof.closeTarget = {kind: 'spare', slot: adopted.slot, object: adopted.object,
                metadata: adopted.metadata, spare: adopted.spare, copy: adopted.copy};
              await save();
              try {
                // Skip the post-serve buffer/inspect reads: once the close is
                // consumed the FS can start the Loader's next OpenFile and the
                // read races it into "Another memory request is active" (20:16).
                const step = await gate.stepServe({force: true, skipAfter: true});
                (proof.closesServed ||= []).push({index: i, id: pendingInfo.object,
                  empty: !!step.empty, request: step.request ? step.request.slice(0, 64) : null});
                await save();
                console.log(JSON.stringify({stage: 'close-served', index: i,
                  id: pendingInfo.object, target: 'spare', empty: !!step.empty}));
                lastBuffer = step.bufferAfterWake || step.request;
                lastServedAt = Date.now(); sameWaits = 0;
                continue;
              } catch (error) {
                // Never hand a close back to the FS after a failed serve: the
                // 14:37 fallback did exactly that and faulted. Keep the session
                // parked so the console survives for inspection.
                proof.closeServeError = error.stack;
                proof.heldClose = true;
                await save();
                throw error;
              }
            }
            (proof.staleCloses ||= []).push({index: i, object: pendingInfo.object,
              reason: 'adopt-spare failed; close target is not in the target domain'});
            if (Date.now() - lastServedAt >= quietMs) break;
            continue;
          }
        }
        // A 24-byte IFile Read frees its own domain entry and releases the
        // entry's reference. Two CopyObject references are added first so the
        // object survives the Read. This is required: with the references off
        // (23:10 run) the Read's destructor ran, and the freed-slot close's
        // UnregisterObject then wedged the FS at the wake's event-clear. Keep
        // the object alive; the close is a no-op on the freed slot and the
        // Loader's next OpenFile is served immediately (poll reordered below).
        // `NS2_LAUNCH_READ_REFERENCE=0` disables it for experiments.
        if (process.env.NS2_LAUNCH_READ_REFERENCE !== '0' &&
            pendingInfo?.kind === 'request' && pendingInfo.command === 0 &&
            pendingInfo.input && pendingInfo.input.length === 48 &&
            !(proof.readRefs || []).some(ref => ref.entry === pendingInfo.object)) {
          try {
            const current = await entries(memory, layout, root.targetDomain);
            const target = current.find(entry => entry.id === pendingInfo.object);
            if (target && target.metadata === Number(donor.metadata) + 8) {
              const ref = await addObjectReference(target);
              (proof.readRefs ||= []).push(ref);
              await save();
              console.log(JSON.stringify({stage: 'read-reference', index: i, ...ref}));
            }
          } catch (error) {
            (proof.referenceErrors ||= []).push({index: i, object: pendingInfo.object, error: error.message});
            await save();
          }
        }
        if (pendingInfo)
          console.log(JSON.stringify({stage: 'serving', index: i, ...pendingInfo}));
      }
      const before = await entries(memory, layout, root.targetDomain);
      const step = await gate.stepServe({force: flags === 0x10});
      if (step.empty) {
        if (proof.swapped && Date.now() - lastServedAt >= quietMs) break;
        continue;
      }
      lastBuffer = step.bufferAfterWake || step.request;
      lastServedAt = Date.now(); sameWaits = 0;
      const info = requestInfo(step.request);
      if (info.kind !== 'close') { closeServeKey = null; closeServeCount = 0; }
      const after = await entries(memory, layout, root.targetDomain);
      const added = after.filter(a => !before.some(b => b.id === a.id && b.object === a.object));
      const record = {index: i, ...info, added, removed: before.filter(b => !after.some(a => a.id === b.id && a.object === b.object))};
      proof.requests.push(record);
      // The Read frees the file's domain entry and releases the entry's
      // reference, but the two CopyObject duplicates added by read-reference
      // keep the file object alive. Release them now so the object's
      // destructor runs and the save-data transaction closes before the
      // Loader's next OpenFile (/main) on the same filesystem. Leaving it open
      // is what wedged the FS after the close (22:57/23:26/23:43 runs).
      if (info.kind === 'request' && info.command === 0 && info.input &&
          info.input.length === 48) {
        const ref = (proof.readRefs || []).find(item => item.entry === info.object && !item.released);
        if (ref) {
          // These are *kernel handles* returned as moved handles by CopyObject,
          // not domain object IDs, so close them with `close-handle` (the same
          // path copy-loader-root.cjs uses for its reference copies). Passing
          // them to `domain-close` fails its 1..0x4000 domain-ID check and the
          // copies leak, leaving the save-data transaction open (00:03 run).
          const closed = [];
          for (const handle of [ref.copy, ref.copy2]) {
            try {
              await memory.request({command: 'root-native-close-handle', handle});
              closed.push(handle);
            } catch (error) {
              (proof.releaseErrors ||= []).push({entry: info.object, handle, error: error.message});
            }
          }
          ref.released = closed.length === 2;
          await save();
          console.log(JSON.stringify({stage: 'read-released', index: i, entry: info.object,
            released: closed, failed: [ref.copy, ref.copy2].filter(h => !closed.includes(h))}));
          // Hand the session back now and let the FS's own loop serve the close
          // and the /main OpenFile/Read. The close is a no-op on the freed
          // entry (fs.elf +0x219EA0: owner 0 != caller domain -> null object ->
          // success), and the FS would process /main inside the same wake
          // window anyway. Every attempt to inject the close has taken the
          // console down right after the injection (22:57..00:20); upstream
          // restores the gate instead of serving the tail. Injection is still
          // used for the swap and this Read, where it is proven.
          if (process.env.NS2_LAUNCH_RESTORE_AFTER_READ === '1' && ref.released) {
            // Pin the freed Read entry out of the manager free list before the
            // FS dispatches the Loader's close, exactly as the injected path
            // does. Otherwise an allocation can take the slot and the close can
            // release the wrong object. Only touch a slot that is still the
            // freed one (owner/object zero); a reused slot must not be cleared.
            const slot = Number(layout.table) + (info.object - 1) * 0x30;
            const raw = await memory.read(slot, 0x30).catch(() => null);
            const owner = raw ? ptr(raw, 0x18) : null;
            const object = raw ? ptr(raw, 0x20) : null;
            const record = {index: i, id: info.object, slot, owner, object,
              raw: raw ? raw.toString('hex') : null};
            (proof.closeSlots ||= []).push(record);
            console.log(JSON.stringify({stage: 'close-slot', index: i,
              id: info.object, owner, object}));
            if (raw && owner === 0 && object === 0) {
              record.pinned = await unlinkFree(slot).catch(() => false);
              await save();
            }
            // Fire-and-forget handback: put the real wait handle back and wake
            // the session. Do NOT use gate.restore(): its verification loop
            // reads FS memory while the FS is serving /main, and that read is
            // what hung the endpoint at 00:32 (op 527, after the event-signal
            // had already succeeded).
            await gate.unpark();
            // Signal only. gate.wake() also clears the event, and that clear is
            // the first console RPC after the FS wakes; it wedged the console's
            // single-threaded serve loop at 00:46 (bridge: call offset 0x168bb4
            // timed out). Leave the event signalled and issue no further console
            // RPC here: the host samples the app over TCP before the settle.
            const signaled = await memory.request({command: 'root-native-event-signal',
              handle: gate.event.write});
            check(!signaled.result, 'Handback event did not signal');
            proof.handback = {signaled: true};
            restoredEarly = true;
            proof.restored = true;
            proof.restoreReason = 'after the NPDM read; close and /main served by the FS loop';
            await save();
            console.log(JSON.stringify({stage: 'gate-restored-after-read', index: i,
              pinned: !!record.pinned}));
            break;
          }
        }
      }
      const rootId = (root.targetEntry - layout.table) / 0x30 + 1;
      if (info.kind === 'request' && info.object === rootId && info.command === 0) {
        const input = Buffer.from(info.input, 'hex');
        check(input.length >= 16 && input[0] === 1 && input[1] === 3 &&
          input.readBigUInt64LE(8) === BigInt(proof.target), 'The queued CodeFS mount is not the selected native target');
        proof.mounts++;
        record.targetMount = proof.mounts;
      }
      // Swap the first added entry whose concrete adapter matches the donor.
      // This is not limited to command 0: in the 01:17 run the command-2 entry
      // carried the donor metadata (and was used by the Loader's next request),
      // while the command-0 mount returned a different class (vptr + 0x260).
      // Read the object vptr, not the entry metadata, and swap before the next
      // request is served.
      if (!proof.swapped) {
        for (const entry of added) {
          const adapterVptr = await memory.pointer(entry.object);
          (record.adapters ||= []).push({id: entry.id, metadata: entry.metadata, vptr: adapterVptr});
          // The concrete class may differ (CodeFS vs SaveData) while the
          // interface vtable (entry metadata) is the same. The donor is a clone
          // of the save filesystem with the same interface and file layout, so
          // a metadata match is enough to make the swap; the vptr match is the
          // stricter case.
          if (adapterVptr !== donor.vptr && entry.metadata !== donor.metadata) continue;
          const currentDonor = await memory.read(donor.entry, 0x30);
          check(currentDonor.subarray(0x18).equals(Buffer.from(donor.raw, 'hex').subarray(0x18)) &&
            await memory.pointer(donor.object) === donor.vptr,
          'Filesystem identity or concrete adapter type changed');
          const code = entry;
          proof.exchange = {code, donor, started: new Date().toISOString(), firstWritten: false, secondWritten: false};
          await save();
          await memory.writeU64(code.entry + 0x20, code.object, donor.object);
          proof.exchange.firstWritten = true; await save();
          try {
            await memory.writeU64(donor.entry + 0x20, donor.object, code.object);
            proof.exchange.secondWritten = true; await save();
          } catch (error) {
            check(await memory.pointer(donor.entry + 0x20) === donor.object, 'Donor write failed without restoration');
            await memory.writeU64(code.entry + 0x20, donor.object, code.object);
            proof.exchange.rolledBack = true; await save();
            throw error;
          }
          check(await memory.pointer(code.entry + 0x18) === root.targetDomain &&
            await memory.pointer(code.entry + 0x20) === donor.object &&
            await memory.pointer(donor.entry + 0x18) === donor.domain &&
            await memory.pointer(donor.entry + 0x20) === code.object, 'Owning-reference exchange did not verify');
          proof.swapped = true; proof.swapIndex = proof.requests.length; await save();
          console.log(JSON.stringify({stage: 'filesystem-exchanged', file, mount: proof.mounts, object: code.id}));
          break;
        }
      }
      await save();
      console.log(JSON.stringify({stage: 'stepped', index: i, kind: info.kind, object: info.object,
        command: info.command, added: added.map(a => a.id), mounts: proof.mounts, swapped: proof.swapped}));
    }
    // After an early handback the FS serves the close and /main while the host
    // is idle. Sample the app over TCP only (no console RPC) so a dead app is
    // distinguishable from a wedged FS/endpoint. Do this before the settle,
    // which is the next console RPC.
    if (restoredEarly && stopLiveness) { await stopLiveness(); stopLiveness = null; }
    if (restoredEarly) {
      const postMs = Number(process.env.NS2_LAUNCH_POST_MS ?? 8000);
      const host = consoleHost();
      proof.postHandback = [];
      let consoleRpcUp = true;
      for (let waited = 0; waited < postMs; waited += 1000) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const up = await tcpUp(host, 8080);
        const sample = {at: new Date().toISOString(), up};
        // Poll the slot-2 pm:dmnt start's result cells with a short deadline.
        // This is the first console RPC after the handback signal and it tells
        // us both whether the serve loop is still alive and whether the start
        // returned (values leave the sentinel).
        if (consoleRpcUp) {
          try {
            const values = await memory.request({command: 'root-native-worker-values',
              slot: 2, timeoutMs: Number(process.env.NS2_LAUNCH_POLL_TIMEOUT_MS ?? 1500)});
            sample.workerValues = values.values;
            sample.sentinel = values.sentinel;
            sample.started = values.values.some(value => value !== values.sentinel);
          } catch (error) {
            consoleRpcUp = false;
            sample.rpcError = error.message;
          }
        }
        proof.postHandback.push(sample);
        console.log(JSON.stringify({stage: 'post-handback-liveness', waited: waited + 1000, ...sample}));
        await save();
        if (!up) break;
      }
    }
    }
  } catch (error) {
    proof.error = error.stack; await save();
    throw error;
  } finally {
    proof.outstanding = gate.outstanding; await save();
    if (stopLiveness) await stopLiveness();
    // A wedged endpoint or a dead console makes restore throw; record it
    // instead of masking the error that ended the stage.
    if (restoredEarly) {
      // The session was already handed back after the NPDM Read. Do not probe
      // row.request or restore again: the FS is serving the close and /main.
      proof.restoreSkipped = 'restored after the NPDM read';
      await save();
    } else if (proof.staleCloses?.length || proof.heldClose) {
      // The Loader is blocked on a close whose domain entry we could not
      // restore, or the close serve itself failed. Signalling the parked
      // session would make the FS process that close and fault the console
      // (02:53, 14:37), so leave it parked and keep the console alive.
      proof.restoreSkipped = proof.heldClose ?
        'close serve failed; session kept parked' :
        'stale close left queued; session kept parked';
      await save();
    } else try {
      // Restoring into a queued close whose entry is gone makes the FS process
      // that close and fault (02:53). The loop normally serves or records it;
      // this last check covers a close queued after the final serve.
      let queued = null;
      try {
        const info = requestInfo((await memory.read(row.request, 0x100)).toString('hex'));
        if (info.kind === 'close') {
          const current = await entries(memory, layout, root.targetDomain);
          if (!current.some(entry => entry.id === info.object)) queued = info;
        }
      } catch (error) { proof.restoreProbeError = error.message; }
      if (queued) {
        (proof.staleCloses ||= []).push({object: queued.object, reason: 'queued at restore'});
        proof.restoreSkipped = 'stale close left queued at restore; session kept parked';
        await save();
      } else {
        await gate.restore();
        proof.restored = true; proof.restoration = gate.restoration;
      }
    } catch (error) {
      proof.restoreError = error.stack;
    }
    await save();
  }
  if (!serve) {
    if (flags === 0x10) {
      // The loop watched slot 2's result cells, so settle both workers without
      // the blocking TryWaitThread join. Slot 1 is the suspended launch (pid),
      // slot 2 is the deferred pm:dmnt start whose result is the launch result.
      proof.settled = {};
      for (const slot of [1, 2]) {
        // Slot 1 carries the pid and can still be storing its result when the
        // loop breaks on slot 2, so give it a few seconds before giving up.
        // After an early handback the slot-2 pm:dmnt start is still blocked in
        // the Loader, so wait for it too: this is what proves the FS served the
        // tail (/main) and the launch actually completed.
        const until = Date.now() + (slot === 1 ? 10000 : (restoredEarly ? 20000 : 0));
        for (;;) {
          try { proof.settled[slot] = await memory.request({command: 'root-native-worker-settle', slot}); break; }
          catch (error) {
            (proof.settleErrors ||= {})[slot] = error.message;
            if (Date.now() >= until) break;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
      }
      // Slot 1 is the pm-launch reply that carries the new pid; slot 2 is the
      // deferred pm:dmnt start result. Prefer slot 1 so the pid is recorded.
      proof.completion = proof.settled[1] || proof.settled[2];
    } else {
      const until = Date.now() + 20000;
      while (!(await memory.request({command: 'root-native-worker-state'})).finished) {
        check(Date.now() < until, 'PM did not complete after the gate was restored');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      proof.completion = await memory.request({command: 'root-native-worker-join'});
    }
  }
  check(proof.completion, 'The launch worker did not return a completion');
  const reply = proof.completion.responses?.[0] || {};
  proof.result = reply.result ?? reply.transport ?? null;
  if (!proof.result && reply.data) proof.pid = Buffer.from(reply.data, 'hex').readBigUInt64LE().toString();
  proof.imageAccepted = proof.swapped && reply.result === 0;
  await save();
  await memory.request({command: 'root-native-close-handle', handle: server.handle});
  if (!proof.swapped && proof.result === 0 && proof.pid) {
    proof.unmodifiedProcessCleanup = await memory.request({command: 'root-native-ipc', handle: shell,
      id: 1, hex: encodeU64(BigInt(proof.pid)).toString('hex')});
    await save();
  }
  console.log(JSON.stringify({stage: 'launch-complete', file, mounts: proof.mounts, result: proof.result,
    pid: proof.pid, imageAccepted: proof.imageAccepted, restored: proof.restored}));
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });

module.exports = {requestInfo, entries};
