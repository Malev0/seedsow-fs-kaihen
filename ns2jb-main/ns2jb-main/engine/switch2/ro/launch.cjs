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
  let stopLiveness = null;
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
        // The retained cache maps a fixed plan readOffset to the plan target.
        // Retarget it to the window while the shim is free, then tell the
        // worker that exact storage offset. The pre-launch window is the
        // baseline the post-launch dump is compared against.
        const storageSize = Number(memory.report.storageSize);
        const cycle = Number(memory.report.retainedMemory.bootstrapPlan.cycle || 0x28000);
        const next = require('../memory/signed-cache-plan.cjs')
          .plan(proof.watch.windowAddress, storageSize, cycle);
        proof.watch.readOffset = next.readOffset;
        const before = await memory.read(proof.watch.windowAddress, proof.watch.windowLength);
        proof.watch.preLaunchSha256 = require('node:crypto').createHash('sha256')
          .update(before).digest('hex');
        proof.watch.prepare = await memory.request({command: 'root-native-worker-prepare', slot: 2,
          areaOffset: 0x100000, kind: 'retained-dump',
          handle: memory.report.retained.candidateHandle, readOffset: next.readOffset,
          length: proof.watch.windowLength,
          delayNs: Number(process.env.NS2_LAUNCH_DUMP_DELAY_MS || 1000) * 1e6,
          pcAddress: proof.watch.pcAddress, port: proof.watch.port});
        proof.watch.release = await memory.request({command: 'root-native-worker-release', slot: 2});
        await save();
      }
      stopLiveness = startLiveness(proof, save,
        Number(process.env.NS2_LAUNCH_LIVENESS_MS || 0));
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
        if (proof.watch) {
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
      while (Date.now() < deadline) {
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
    await gate.parkSession(); proof.parked = true; await save();
    await memory.request({command: 'root-native-worker-release'});
    const deadline = Date.now() + 240000;
    for (let i = 0; i < 160; i++) {
      while (!await gate.pending()) {
        const worker = await memory.request({command: 'root-native-worker-state'});
        if (worker.finished) break;
        check(Date.now() < deadline, 'PM launch did not reach the parked FS session');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if ((await memory.request({command: 'root-native-worker-state'})).finished) break;
      const before = await entries(memory, layout, root.targetDomain);
      const step = await gate.step(), info = requestInfo(step.request);
      const after = await entries(memory, layout, root.targetDomain);
      const added = after.filter(a => !before.some(b => b.id === a.id && b.object === a.object));
      const record = {index: i, ...info, added, removed: before.filter(b => !after.some(a => a.id === b.id && a.object === b.object))};
      proof.requests.push(record);
      const rootId = (root.targetEntry - layout.table) / 0x30 + 1;
      if (info.kind === 'request' && info.object === rootId && info.command === 0) {
        const input = Buffer.from(info.input, 'hex');
        check(input.length >= 16 && input[0] === 1 && input[1] === 3 &&
          input.readBigUInt64LE(8) === BigInt(proof.target), 'The queued CodeFS mount is not the selected native target');
        proof.mounts++;
        record.targetMount = proof.mounts;
        check(added.length === 1 && added[0].metadata === donor.metadata, 'Target mount did not return one compatible filesystem');
        if (proof.mounts === wantedMount) {
          const code = added[0], currentDonor = await memory.read(donor.entry, 0x30);
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
      console.log(JSON.stringify({stage: 'stepped', index: i, kind: info.kind, object: info.object,
        command: info.command, added: added.map(a => a.id), mounts: proof.mounts}));
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
    try {
      await gate.restore();
      proof.restored = true; proof.restoration = gate.restoration;
    } catch (error) {
      proof.restoreError = error.stack;
    }
    await save();
  }
  if (!serve) {
    const until = Date.now() + 20000;
    while (!(await memory.request({command: 'root-native-worker-state'})).finished) {
      check(Date.now() < until, 'PM did not complete after the gate was restored');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    proof.completion = await memory.request({command: 'root-native-worker-join'});
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
