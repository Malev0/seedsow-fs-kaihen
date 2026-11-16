// Seedsow worker frames. Every call is a ROP sequence entered through
// longjmp; see seed-rop-chain.cjs. All memory belongs to this Session.
const fs = require('node:fs/promises');
const path = require('node:path');
const {artifactDir} = require('../../shared/paths.cjs');
const OUT = artifactDir(__dirname);
const crypto = require('node:crypto');
const {live, check} = require("./session.cjs");
const {nativeHash} = require("./filesystem.cjs");
const chain = require("./seed-rop-chain.cjs");
const transport = require('../../shared/rpc.cjs');

// NS2_FAST=1 builds and launches the V/B/S frame on the console (n2h_rpc.lua),
// so a wave costs one RPC instead of per-worker frame writes, hashing and
// thread management. The PC-side path below stays as the reference fallback.
const FAST = process.env.NS2_FAST === '1';

const align = n => Math.ceil(n / 4096) * 4096;
function capacity(calls) {
  const count = calls.reduce((n, call) => n + 1 + (call.args || []).filter(a => typeof a === 'object').length, 0);
  // V/B/S = 0x90 per call, result cells, and 0x60 jobs, above the 0x8000
  // jmp_buf/stack area; leave a page of slack.
  return align(0x8000 + count * 0x90 + 0x1000 + count * 0x60 + 0x1000);
}

async function writeSparse(s, address, bytes) {
  check(address % 8 === 0 && bytes.length % 8 === 0 && address >= s.base && address + bytes.length <= s.base + s.bytes,
    'Sparse write is outside the owned allocation');
  // start() has already cleared the whole allocation. Send only occupied
  // pages; the native hash below still checks every byte, including zeroes.
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    const page = bytes.subarray(offset, Math.min(offset + 4096, bytes.length));
    if (page.some(Boolean)) await s.write(address + offset, page);
  }
}

// The console owns the frame layout, the memset, the pthread_create and (on
// join) the result-cell validation. One RPC per worker, no hashing.
function applyFastWorker(s, worker, info) {
  check(info && Number.isSafeInteger(info.thread) && info.thread > 0 && info.thread < 2 ** 48,
    'Invalid worker pointer');
  s.threads.add(info.thread);
  Object.assign(worker, {thread: info.thread, index: info.index, cancelCell: info.cancelCell,
    bytes: info.bytes, resultOffset: info.resultOffset, startCell: info.startCell,
    resultOffsets: info.resultOffsets, logicalResultIndices: info.logicalResultIndices,
    nativeCalls: info.nativeCalls, joined: false, fast: true});
  delete worker.results;
  return worker;
}

// Optional worker tuning, validated on this build by the parallel Seedsow port:
// priorities are 5..35 (5 = highest accepted) and creation-time affinity is the
// only way to pin (post-create pthread_setaffinity_np returns EINVAL).
function workerTuning() {
  const priority = Number(process.env.NS2_WORKER_PRIO || 0);
  return {priority: Number.isInteger(priority) && priority > 0 ? priority : 0,
    affinity: process.env.NS2_WORKER_AFFINITY === '1'};
}

async function launchFast(s, worker) {
  const [info] = await transport.startWorkers([{base: worker.base, limit: worker.limit,
    slot: worker.slot, snapshot: 0, calls: worker.calls, ...workerTuning()}]);
  applyFastWorker(s, worker, info);
  await s.record({operation: 'workerStarted', label: worker.label, thread: info.thread,
    base: worker.base, startCell: info.startCell, fast: true});
  return worker;
}

async function start(s, base, limit, slot, calls, label, snapshot = 0, options = {}) {
  check(base % 4096 === 0 && base >= s.base && base + limit <= s.base + s.bytes, 'Worker frame is outside allocation');
  check(slot % 8 === 0 && slot >= s.base && slot + 16 <= base, 'Worker output slot overlaps its frame');
  check(Array.isArray(calls) && calls.length > 0, 'Worker needs at least one call');
  // The console-side builder does not understand {result:n} dynamic arguments,
  // so a worker that needs them (the socket dump) is built by the host path.
  const fast = FAST && !options.forceHost;
  if (fast) {
    await s.record({operation: 'workerPrepared', label, base, slot, format: 'seedsow-rop-console'});
    return launchFast(s, {label, base, limit, slot, calls, snapshot, fast: true});
  }
  const {frame, proof} = chain.build(base, limit, calls, live.sdk, live.main);
  check(frame.length <= limit, 'Worker frame exceeds reserved space');
  const plan = path.join(OUT, label + '-plan.json'), filename = path.join(OUT, label + '-frame.bin');
  await fs.writeFile(plan, JSON.stringify({base, sdk: live.sdk, main: live.main, format: 'seedsow-rop', calls}) + '\n');
  await fs.writeFile(filename, frame, {flag: 'wx', mode: 0o600});
  await s.call('memset', base, 0, limit);
  await writeSparse(s, base, frame);
  const hash = crypto.createHash('sha256').update(frame).digest('hex');
  check(await nativeHash(s, base, frame.length) === hash, 'Full worker frame hash differs');
  if (snapshot) {
    check(snapshot >= base + limit && snapshot + frame.length <= s.base + s.bytes, 'Worker snapshot is outside allocation');
    await s.rpc.call3(live.sdk + 0x5224e0, snapshot, base, frame.length);
    check(await nativeHash(s, snapshot, frame.length) === hash, 'Worker snapshot differs');
  }
  await s.record({operation: 'workerPrepared', label, base, slot, ...proof, frameSha256: hash});
  return launch(s, {label, base, slot, calls, ...proof, snapshot, frameSha256: hash});
}

async function launch(s, prepared) {
  if (prepared.fast) return launchFast(s, prepared);
  const {label, base, slot} = prepared;
  await s.write(slot, Buffer.alloc(16));
  const pending = label + ':creating';
  s.threads.add(pending);
  const result = await s.rpc.call4(live.sdk + chain.PTHREAD_CREATE,
    slot, 0, live.sdk + chain.LONGJMP, base);
  if (result) s.threads.delete(pending);
  check(!result, 'pthread_create failed: ' + result);
  const thread = Number((await s.readOwned(slot, 8)).readBigUInt64LE());
  // Seedsow's pthread_t carries low state bits (e.g. 0x...007); it is not
  // pointer-aligned like the SmileBASIC thread handle.
  check(Number.isSafeInteger(thread) && thread > 0 && thread < 2 ** 48, 'Invalid worker pointer');
  s.threads.delete(pending); s.threads.add(thread);
  const worker = {...prepared, thread, joined: false};
  // The worker can finish before this read (the bridge round-trip is slower
  // than a short call list), so this is diagnostic only. join() is authoritative.
  const startCell = (await s.readOwned(base + worker.resultOffset, 8)).readBigUInt64LE();
  await s.record({operation: 'workerStarted', label, thread, base, startCell: String(startCell)});
  return worker;
}

async function restart(s, worker) {
  check(worker.joined, 'Cannot restore an active worker');
  if (FAST || worker.fast) return launchFast(s, worker);
  // A joined thread's address can already belong to another worker.
  check(worker.snapshot, 'Cannot restore a worker without a snapshot');
  await s.rpc.call3(live.sdk + 0x5224e0, worker.base, worker.snapshot, worker.bytes);
  delete worker.results;
  return launch(s, worker);
}

async function join(s, worker, timeoutMs = 15000) {
  check(!worker.joined && s.threads.has(worker.thread), 'Worker is not owned');
  if (worker.fast) {
    const [joined] = await transport.joinWorkers([{index: worker.index}]);
    check(joined, 'Console did not return a join result');
    const values = joined.results.map(value => BigInt(value));
    check(values.every(value => value !== chain.SENTINEL), 'Native batch did not store every result');
    s.threads.delete(worker.thread);
    worker.joined = true;
    worker.results = values;
    await s.record({operation: 'workerJoined', label: worker.label, thread: worker.thread,
      values: values.map(String), nativeCalls: values.length, fast: true});
    return worker.results;
  }
  // Seedsow: use blocking pthread_join (no pthread_tryjoin_np in this SDK).
  check(!await s.rpc.call3(live.sdk + chain.PTHREAD_JOIN, worker.thread, worker.slot + 8, 0), 'pthread_join failed');
  const raw = await s.readOwned(worker.base + worker.resultOffsets[0], worker.resultOffsets.length * 8);
  const values = worker.resultOffsets.map((_, i) => raw.readBigUInt64LE(i * 8));
  check(values.every(value => value !== chain.SENTINEL), 'Native batch did not store every result');
  s.threads.delete(worker.thread);
  worker.joined = true;
  check((await s.readOwned(worker.slot + 8, 8)).readBigUInt64LE() === values.at(-1), 'Thread exit result differs');
  worker.results = worker.logicalResultIndices.map(i => values[i]);
  await s.record({operation: 'workerJoined', label: worker.label, thread: worker.thread,
    values: worker.results.map(String), nativeCalls: values.length});
  return worker.results;
}

async function restartAll(s, workers) {
  // One workers-start request for the whole group (the console loops internally
  // and hands each worker its own index), instead of 13 round trips per wave.
  if (FAST && workers.length > 1 && workers.every(worker => worker.joined && worker.fast)) {
    const infos = await transport.startWorkers(workers.map(worker => ({base: worker.base,
      limit: worker.limit, slot: worker.slot, snapshot: 0, calls: worker.calls, ...workerTuning()})));
    check(Array.isArray(infos) && infos.length === workers.length,
      'Console did not return every worker');
    for (const [position, worker] of workers.entries()) {
      applyFastWorker(s, worker, infos[position]);
      await s.record({operation: 'workerStarted', label: worker.label, thread: worker.thread,
        base: worker.base, startCell: worker.startCell, fast: true, batch: true});
    }
    return workers;
  }
  for (const worker of workers) Object.assign(worker, await restart(s, worker));
  return workers;
}

async function joinAll(s, workers, timeoutMs = 15000) {
  // The console joins a whole group in one request: joinWorkers waits for every
  // result cell before pthread_join, so one request replaces N round trips.
  if (FAST && workers.length > 1 &&
    workers.every(worker => worker.fast && !worker.joined && s.threads.has(worker.thread))) {
    const joined = await transport.joinWorkers(workers.map(worker => ({index: worker.index})));
    check(Array.isArray(joined) && joined.length === workers.length,
      'Console did not return every join result');
    for (const [position, worker] of workers.entries()) {
      const entry = joined[position];
      check(entry && Array.isArray(entry.results), 'Console did not return a join result');
      const values = entry.results.map(value => BigInt(value));
      check(values.every(value => value !== chain.SENTINEL), 'Native batch did not store every result');
      s.threads.delete(worker.thread);
      worker.joined = true;
      worker.results = values;
      await s.record({operation: 'workerJoined', label: worker.label, thread: worker.thread, batch: true});
    }
    return;
  }
  for (const worker of workers) await join(s, worker, timeoutMs);
}

module.exports = {capacity, writeSparse, start, restart, join, restartAll, joinAll};
