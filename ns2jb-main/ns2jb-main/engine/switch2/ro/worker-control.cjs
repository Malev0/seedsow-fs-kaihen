const path = require('node:path');
const {packet, response} = require("../../shared/ipc.cjs");
const check = (ok, message) => { if (!ok) throw Error(message); };
// Seedsow CancelSynchronization veneer (svc #0x19); SmileBASIC used 0x158414.
const cancelCode = {offset: 0x168c0c, bytes: '210300d4c0035fd6'};

// Two workers can be live at once: slot 1 is the blocking launch/start send,
// slot 2 is the retained read/write worker that must act while slot 1 holds the
// launcher shim. `state.worker` stays the slot-1 alias for older callers.
function workerFor(state, request) {
  const slot = Number(request?.slot || 1);
  if (slot === 1) return state.worker || null;
  return (state.workers || [])[slot - 1] || null;
}

async function cancelWorkers(context) {
  const {s, live, report} = context;
  const workers = report.nativeRo.apiWorkers;
  check(workers?.length === 7, 'API-worker copies are missing');
  // No OpenThread syscall exists on this console, so the bound workers may have
  // no thread handles. CancelSynchronization needs one; report a skipped cancel
  // (result 0 so callers that only check the result keep working) until an
  // FS-side cancel is implemented.
  if (!workers.every(w => Number.isInteger(w.handle) && w.handle > 0 && s.handles.has(w.handle))) {
    const list = (report.nativeRo.cancelSkipped ||= []);
    const last = list.at(-1);
    if (!last || Date.now() - Date.parse(last.at) > 1000) {
      list.push({at: new Date().toISOString(), skipped: true,
        reason: 'no app-side KThread handles (no OpenThread syscall)'});
      await context.save();
    }
    // Without CancelSynchronization the kernel keeps our selection until the FS
    // worker is scheduled again. Give it time instead of failing the caller's
    // retry loop in microseconds; if the service does re-arm on its own, the
    // gate can still settle.
    await new Promise(resolve => setTimeout(resolve, Number(process.env.NS2_CANCEL_SETTLE_MS || 200)));
    return workers.map(w => ({id: w.id, handle: null, result: 0, skipped: true}));
  }
  await s.verifyCode(cancelCode, 'CancelSynchronization');
  const replies = await s.rpc.batch(workers.map(w => ({fn: live.sdk + cancelCode.offset, args: [w.handle, 0, 0]})));
  return replies.map((r, i) => ({handle: workers[i].handle, result: r.result}));
}

async function dispatch(context, request, state, domain) {
  const {s, live, save} = context;
  const directory = path.join(__dirname, '../app');
  const native = require(path.join(directory, 'native-worker.cjs'));
  const events = require(path.join(directory, 'events.cjs'));
  const workerCode = require(path.join(directory, 'worker.cjs'));
  const command = request.command.slice('root-native-'.length);
  // Parse a completed chain's reply pages without joining the thread. Both the
  // join path and the no-join settle path use it: TryWaitThread blocks inside
  // pthread_exit on this build, so the join is not always reachable.
  async function parseResponses(values, result, worker = state.worker) {
    result.responses = [];
    for (let i = 0; i < worker.count; i++) {
      const raw = await s.readOwned(worker.area + 0x1000 * (i + 1), 256);
      if (values[i + 1] !== '0') { result.responses.push({transport: Number(values[i + 1]), raw: raw.toString('hex')}); continue; }
      if (worker.kind === 'app-service') {
        const handle = raw.readUInt32LE();
        check(handle > 0 && handle < 0xffff8000, 'Application SM returned no handle');
        s.handles.add(handle);
        state.services.push({name: worker.serviceName, handle, application: true});
        result.responses.push({result: 0, handle, raw: raw.subarray(0, 32).toString('hex')});
      } else if (worker.kind === 'sm-get') {
        check(raw.readUInt32LE() === 0x11 && raw.readUInt32LE(4) === 0x80000001 &&
          raw.readUInt32LE(8) === 0x20, 'Unexpected native SM reply');
        const handle = raw.readUInt32LE(12), status = raw.readUInt32LE(16);
        const reply = {result: status, handle, raw: raw.subarray(0, 32).toString('hex')};
        result.responses.push(reply);
        if (!status) {
          check(handle > 0, 'SM returned a null session');
          s.handles.add(handle);
          state.services.push({name: worker.serviceName, handle, sm: worker.handle});
        }
      } else {
        const reply = response(raw);
        if (worker.kind === 'notifier-probe') {
          for (const handle of [...reply.copies, ...reply.moves]) {
            s.handles.add(handle); state.events.push({handle, operation: 'notifier-probe'});
          }
        }
        if (worker.kind === 'control-test') {
          for (const handle of [...reply.copies, ...reply.moves]) {
            s.handles.add(handle);
            (state.domainCopies ||= []).push({handle, domainHandle: worker.handle, controlTest: true});
          }
        }
        const kernelPid = raw.readUInt32LE(4) >>> 31 && raw.readUInt32LE(8) & 1 ?
          raw.readBigUInt64LE(12).toString() : null;
        result.responses.push({...reply, kernelPid, data: reply.data.toString('hex'), raw: raw.toString('hex')});
        if (worker.processCommand === 0x524f0016 && !reply.result) {
          const length = Number(Buffer.from(worker.challenge, 'hex').readBigUInt64LE(16));
          check(Number(reply.data.readBigUInt64LE(48)) === length, 'RO bulk output length differs');
          const bulk = require(path.join(directory, 'bulk-transfer.cjs'));
          const data = await bulk.read(s, s.base + 0x1800000, length);
          const fs = require('node:fs/promises'), crypto = require('node:crypto');
          const outputFile = path.join(__dirname,
            live.session + '-ro-bulk-' + Date.now() + '.bin');
          await fs.writeFile(outputFile, data, {mode: 0o600});
          Object.assign(result.responses.at(-1), {outputFile, length,
            sha256: crypto.createHash('sha256').update(data).digest('hex')});
        }
      }
    }
  }
  if (command === 'worker-bind') {
    const rows = request.workers;
    check(Array.isArray(rows) && rows.length === 7, 'Expected seven native API workers');
    const withHandles = rows.filter(w => Number.isInteger(w.handle) && w.handle > 0);
    if (withHandles.length === rows.length) {
      check(new Set(rows.map(w => w.handle)).size === 7, 'Expected seven different native API-worker copies');
      check(rows.every(w => state.events.some(e => e.handle === w.handle) && s.handles.has(w.handle) &&
        state.calls.some(e => e.operation === 'thread-id' && e.handle === w.handle && e.result === 0 &&
          Number(e.value) === w.id)), 'Worker copies lack their native thread-ID checks');
      await s.verifyCode(cancelCode, 'CancelSynchronization');
    } else {
      // Handle-free binding (no OpenThread syscall on this console): the ring
      // verification in prepare-workers is the identity proof.
      check(withHandles.length === 0, 'Mixed worker handle state');
      check(new Set(rows.map(w => w.id)).size === 7, 'Expected seven different API-worker thread IDs');
      check(rows.every(w => Number.isInteger(w.address) && Number.isInteger(w.id) &&
        Number.isInteger(w.entry)), 'Worker rows need address/id/entry');
      state.boundWithoutHandles = true;
    }
    state.apiWorkers = rows;
    await save();
    return rows;
  }
  if (command === 'worker-cancel') {
    const replies = await cancelWorkers(context);
    (state.cancellations ||= []).push({at: new Date().toISOString(), replies});
    await save();
    check(replies.every(r => r.result === 0), 'Foreign thread cancellation was rejected');
    return replies;
  }
  if (command === 'worker-prepare') {
    const workerSlot = Number(request.slot || 1);
    check(workerSlot === 1 || workerSlot === 2, 'Only worker slots 1 and 2 are supported');
    if (workerSlot === 1) {
      check(!s.threads.size && (!state.worker || state.worker.joined), 'A native worker is still active');
    } else {
      check(state.worker && !state.worker.joined,
        'Worker slot 2 requires a prepared slot-1 worker');
      check(!(state.workers || [])[1] || state.workers[1].joined, 'Worker slot 2 is still active');
    }
    await workerCode.verifyWorkerCode(s);
    await events.verify(s);
    // A settled-but-unjoined thread can still be inside pthread_exit, so the
    // caller may place a later worker in another part of the same region.
    const areaOffset = Number(request.areaOffset || 0);
    check(Number.isInteger(areaOffset) && areaOffset >= 0 && areaOffset % 0x1000 === 0 &&
      areaOffset <= 0x100000, 'Invalid worker area offset');
    const area = s.base + 0x2100000 + areaOffset, gate = area, slot = area + 0x10;
    check(area + 0x60000 <= s.base + s.bytes, 'Worker area exceeds the retained allocation');
    await events.initialize(s, gate);
    const handle = Number(request.handle);
    check(request.kind === 'app-service' || s.handles.has(handle), 'Worker IPC requires a retained caller handle');
    const batchInputs = request.kind === 'notifier-probe' && request.candidates;
    if (batchInputs) check(Array.isArray(batchInputs) && batchInputs.length > 0 && batchInputs.length <= 16 &&
      batchInputs.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff), 'Expected 1..16 candidate handles');
    const count = batchInputs ? batchInputs.length : request.kind === 'control-test' ? 2
      : request.kind === 'retained-read' ? (request.reads?.length || 1)
      : request.kind === 'retained-write' ? Number(request.count || 1) : 1;
    const upload = batchInputs ? Buffer.alloc(count * 0x1000) : null;
    check(['control-test', 'cmif-control', 'pm-launch', 'pm-start', 'sm-get', 'app-service', 'ro-probe', 'ro-process', 'notifier-probe', 'retained-read', 'retained-write', 'retained-dump'].includes(request.kind), 'Unknown worker operation');
    const calls = [{function: live.sdk + events.code.wait.offset, args: [gate, 0, 0, 0]}];
    for (let i = 0; i < count; i++) {
      let bytes;
      const address = area + 0x1000 * (i + 1);
      if (request.kind === 'app-service') {
        check(typeof request.name === 'string' && /^[a-z0-9:-]{1,8}$/.test(request.name), 'Invalid application service name');
        const code = require("../../shared/sdk-functions.json").getService;
        await s.verifyCode(code, 'Application GetService');
        bytes = Buffer.alloc(32); bytes.write(request.name, 8);
        await s.write(address, bytes);
        calls.push({function: live.sdk + code.offset, args: [address, address + 8, request.name.length, 0]});
        continue;
      } else if (request.kind === 'cmif-control') {
        const service = state.services.find(item => item.handle === handle);
        check(service && ['fsp-srv', 'spl:fs', 'pm:dmnt'].includes(service.name) &&
          [0, 3].includes(request.id), 'Expected an owned qualification session and manager command 0 or 3');
        bytes = domain.wire.control(request.id);
      } else if (request.kind === 'control-test') bytes = domain.wire.control(3);
      else if (request.kind === 'sm-get') {
        check(state.services.some(x => x.sm === handle) && typeof request.name === 'string' &&
          /^[a-z0-9:-]{1,8}$/.test(request.name), 'SM worker requires the established borrowed client and a service name');
        bytes = Buffer.alloc(256); bytes.writeUInt32LE(0x11); bytes.writeUInt32LE(2, 4); bytes.write(request.name, 8);
      } else if (request.kind === 'ro-probe') {
        check(typeof request.hex === 'string' && /^[0-9a-fA-F]{16}$/.test(request.hex), 'RO proof needs one 64-bit challenge');
        bytes = packet(0x524f0001, Buffer.from(request.hex, 'hex'));
      } else if (request.kind === 'ro-process') {
        const target = Number(request.processHandle), id = Number(request.id);
        check(state.services.some(x => x.name === 'ro:dmnt' && x.handle === handle), 'Process probe requires the owned RO service');
        check(s.handles.has(target) || target === 0xffff8001, 'Target process handle is not owned');
        check([0x524f0010, 0x524f0011, 0x524f0012, 0x524f0013, 0x524f0014,
          0x524f0015, 0x524f0016].includes(id), 'Unknown process probe');
        const size = id === 0x524f0014 ? 128 : 64;
        check(typeof request.hex === 'string' && request.hex.length === size && /^[0-9a-fA-F]+$/.test(request.hex),
          'Process probe input length differs');
        const receive = [];
        if (id === 0x524f0016) {
          const length = Number(Buffer.from(request.hex, 'hex').readBigUInt64LE(16));
          const output = s.base + 0x1800000;
          check(Number.isInteger(length) && length > 0 && length <= 0x400000 &&
            output + length <= s.base + s.bytes, 'Bulk RO read exceeds the owned buffer');
          receive.push({address: output, size: length});
        }
        bytes = packet(id, Buffer.from(request.hex, 'hex'), {pid: true, copies: [target], receive});
      } else if (request.kind === 'notifier-probe') {
        check(state.notifiers.includes(handle), 'Native execution probe requires our owned FS notifier');
        const input = Buffer.alloc(batchInputs ? 4 : 0);
        if (batchInputs) input.writeUInt32LE(batchInputs[i]);
        bytes = packet(0, input);
      } else if (request.kind === 'retained-read') {
        const reads = request.reads;
        check(Array.isArray(reads) && reads.length === count, 'retained-read needs one read per call');
        const read = reads[i];
        check(Number.isInteger(read.address) && read.address > 0 &&
          Number.isInteger(read.length) && read.length > 0 && read.length <= 0x4000,
          'Invalid retained read');
        const offset = BigInt(read.address) - BigInt(request.addressBias);
        check(offset >= 0n, 'Retained read is below the address bias');
        const input = Buffer.alloc(16);
        input.writeBigUInt64LE(offset); input.writeBigUInt64LE(BigInt(read.length), 8);
        const output = i === 0 ? address + 0x100 : area + 0x10000 + (i - 1) * 0x4000;
        check(output + read.length <= area + 0x20000, 'Retained read output overlaps the frame');
        if (Number(read.delayNs || 0) > 0)
          calls.push({function: live.sdk + 0x168b54, args: [Number(read.delayNs), 0, 0, 0]});
        bytes = packet(0, input, {receive: [{address: output, size: read.length, mode: 1}]});
        await s.write(address, bytes);
        calls.push({function: live.sdk + require("../../shared/sdk-functions.json").send.offset,
          args: [address, 4096, handle, 0]});
        continue;
      } else if (request.kind === 'retained-write') {
        const offset = BigInt(request.address) - BigInt(request.addressBias);
        check(offset >= 0n, 'Retained write is below the address bias');
        check(typeof request.hex === 'string' && request.hex.length === 16, 'Retained write needs one qword');
        const input = Buffer.alloc(8); Buffer.from(request.hex, 'hex').copy(input);
        await s.write(address + 0x800, input);
        const payload = Buffer.alloc(16);
        payload.writeBigUInt64LE(offset); payload.writeBigUInt64LE(8n, 8);
        bytes = packet(1, payload, {send: [{address: address + 0x800, size: 8, mode: 1}]});
        await s.write(address, bytes);
        const delay = Number(request.delayNs || 50000000);
        if (i === 0) calls.push({function: live.sdk + 0x168b54, args: [delay, 0, 0, 0]});
        calls.push({function: live.sdk + require("../../shared/sdk-functions.json").send.offset,
          args: [address, 4096, handle, 0]});
        if (i + 1 < count) calls.push({function: live.sdk + 0x168b54, args: [delay, 0, 0, 0]});
        continue;
      } else if (request.kind === 'retained-dump') {
        // The retained cache maps a fixed storage readOffset to the plan target;
        // an arbitrary address-bias offset reads storage file data, not FS
        // memory. The host pre-retargets to the window and passes its readOffset.
        const offset = BigInt(request.readOffset);
        check(offset >= 0n, 'Retained dump needs a plan readOffset');
        check(Number.isInteger(request.length) && request.length > 0 && request.length <= 0x4000,
          'Invalid retained dump length');
        const input = Buffer.alloc(16);
        input.writeBigUInt64LE(offset); input.writeBigUInt64LE(BigInt(request.length), 8);
        if (Number(request.delayNs || 0) > 0)
          calls.push({function: live.sdk + 0x168b54, args: [Number(request.delayNs), 0, 0, 0]});
        bytes = packet(0, input, {receive: [{address: area + 0x10000, size: request.length, mode: 1}]});
      } else if (request.kind === 'pm-start') {
        check(state.services?.some(x => x.name === 'pm:dmnt' && x.handle === handle),
          'Start requires the owned PM monitor');
        const pid = Number(request.pid);
        check(Number.isSafeInteger(pid) && pid > 0, 'Start requires a valid pid');
        const input = Buffer.alloc(8); input.writeBigUInt64LE(BigInt(pid));
        bytes = packet(1, input);
      } else {
        check(state.services?.some(x => x.name === 'pm:shell' && x.handle === handle), 'Launch requires the owned PM session');
        const flags = Number(request.flags ?? 0);
        check(flags === 0 || flags === 0x10, 'Unsupported launch flags');
        const storage = Number(request.storage ?? 3);
        check(storage === 3 && request.title === '0x0400000000000037',
          'Only the qualified RO replacement may be launched');
        const input = Buffer.alloc(24); input.writeUInt32LE(flags);
        input.writeBigUInt64LE(BigInt(request.title), 8); input[16] = storage;
        bytes = packet(0, input);
      }
      if (upload) bytes.copy(upload, i * 0x1000);
      else await s.write(address, bytes);
      calls.push({function: live.sdk + require("../../shared/sdk-functions.json").send.offset,
        args: [address, 4096, handle, 0]});
    }
    if (upload) await s.write(area + 0x1000, upload);
    if (request.kind === 'retained-dump') {
      // Send the captured window straight to the PC. This is the only channel
      // that works while the slot-1 launch send holds the launcher shim.
      const sa = Buffer.alloc(16);
      sa[0] = 2; sa.writeUInt16BE(Number(request.port), 2);
      sa.writeUInt32BE(Number(request.pcAddress) >>> 0, 4);
      await s.write(area + 0x1800, sa);
      const socketIndex = calls.length;
      calls.push({function: live.sdk + 0x14d4c0, args: [2, 1, 0, 0]});        // socket
      calls.push({function: live.sdk + 0x140c50,
        args: [{result: socketIndex}, area + 0x1800, 16, 0]});                // connect
      calls.push({function: live.sdk + 0x14d350,
        args: [{result: socketIndex}, area + 0x10000, Number(request.length), 0]}); // send
      calls.push({function: live.sdk + 0x14d510, args: [{result: socketIndex}, 0, 0, 0]}); // close
    }
    const worker = await native.start(s, area + 0x20000, 0x40000, slot, calls,
      'ro-' + request.kind + '-' + Date.now(), 0,
      {forceHost: request.kind === 'retained-dump'});
    Object.assign(worker, {kind: request.kind, handle, gate, area, count, released: false,
      serviceName: request.name, challenge: request.hex, candidates: batchInputs || undefined,
      processCommand: request.kind === 'ro-process' ? Number(request.id) : undefined,
      launchTitle: request.kind === 'pm-launch' ? request.title : undefined,
      launchFlags: request.kind === 'pm-launch' ? Number(request.flags ?? 0) : undefined});
    (state.workers ||= [])[workerSlot - 1] = worker;
    if (workerSlot === 1) state.worker = worker;
    await save();
    return {slot: workerSlot, kind: worker.kind, thread: worker.thread, gate, count};
  }
  const worker = workerFor(state, request);
  if (command === 'worker-output') {
    check(worker, 'No worker is prepared');
    const offset = Number(request.offset), length = Number(request.length);
    check(Number.isInteger(offset) && offset >= 0 && Number.isInteger(length) && length > 0 &&
      length <= 0x10000 && offset + length <= 0x60000, 'Invalid worker output range');
    return {hex: (await s.readOwned(worker.area + offset, length)).toString('hex')};
  }
  check(worker && !worker.joined && s.threads.has(worker.thread), 'No active native worker');
  if (command === 'worker-discard-unreleased-launch') {
    check(worker.kind === 'pm-launch' && worker.launchTitle === '0x0400000000000037' &&
      worker.launchFlags === 0x10 && !worker.released, 'Only this unreleased helper launch may be discarded');
    const before = await s.readOwned(worker.area + 0x1000, 256);
    check(before.readUInt32LE() === 4 && before.toString('ascii', 16, 20) === 'SFCI' &&
      before.readUInt32LE(24) === 0, 'The pending request is not the prepared PM launch');
    // Replace the not-yet-issued launch with the read-only application-PID query.
    await s.write(worker.area + 0x1000, packet(6));
    worker.discardedLaunch = before.toString('hex'); await save();
    return {discarded: true};
  }
  if (command === 'worker-release') {
    check(!worker.released, 'Worker start gate was already released');
    await events.signal(s, worker.gate);
    worker.released = true;
    await save();
    return {released: true};
  }
  if (command === 'worker-peek') {
    // Read the worker's result cells without TryWaitThread: that call blocks
    // while the worker is still in its IPC send, which wedged the console in
    // the 23:59 and 23:21 runs. The cells alone say how far the chain got, and
    // the response pages hold the replies (safe: app memory, no native wait).
    check(worker, 'No worker is prepared');
    const raw = await s.readOwned(worker.base + worker.resultOffsets[0], worker.resultOffsets.length * 8);
    const values = worker.logicalResultIndices.map(i => raw.readBigUInt64LE(i * 8).toString());
    const responses = [];
    for (let i = 0; i < worker.count; i++)
      responses.push((await s.readOwned(worker.area + 0x1000 * (i + 1), 256)).toString('hex'));
    return {values, sentinel: workerCode.SENTINEL.toString(), released: !!worker.released,
      responses};
  }
  if (command === 'worker-state' || command === 'worker-join') {
    const finished = await s.rpc.call3(live.sdk + workerCode.code.tryWait.offset, worker.thread, 0, 0);
    const raw = await s.readOwned(worker.base + worker.resultOffsets[0], worker.resultOffsets.length * 8);
    const values = worker.logicalResultIndices.map(i => raw.readBigUInt64LE(i * 8).toString());
    const result = {finished: !!finished, values, sentinel: workerCode.SENTINEL.toString()};
    if (command === 'worker-join') {
      check(finished, 'Worker is still pending');
      await native.join(s, worker, 1000);
      worker.results = worker.results.map(String);
      await parseResponses(values, result, worker);
      await events.finalize(s, worker.gate);
      worker.completion = result;
      await save();
    }
    return result;
  }
  if (command === 'worker-settle') {
    // The chain has stored every result, but the thread can still be inside
    // pthread_exit, where TryWaitThread blocks on this build (the 00:21 run
    // wedged the endpoint there). Parse the replies and release the bookkeeping
    // without waiting; the thread is left to finish on its own.
    const raw = await s.readOwned(worker.base + worker.resultOffsets[0], worker.resultOffsets.length * 8);
    const values = worker.logicalResultIndices.map(i => raw.readBigUInt64LE(i * 8).toString());
    check(values.every(value => value !== workerCode.SENTINEL.toString()), 'Native batch did not store every result');
    const result = {settled: true, values, sentinel: workerCode.SENTINEL.toString()};
    await parseResponses(values, result, worker);
    s.threads.delete(worker.thread);
    worker.joined = true;
    worker.threadLeftRunning = true;
    await save();
    return result;
  }
  throw Error('Unknown native worker command');
}

module.exports = {dispatch, cancelWorkers, cancelCode};
