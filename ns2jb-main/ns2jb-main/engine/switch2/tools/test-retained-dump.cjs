// Local repro for the retained-dump worker-prepare path. No console.
const path = require('node:path');
const workerControl = require('../ro/worker-control.cjs');
const workerCode = require('../app/worker.cjs');
const events = require('../app/events.cjs');
const native = require('../app/native-worker.cjs');
const chain = require('../app/seed-rop-chain.cjs');

workerCode.verifyWorkerCode = async () => {};
events.verify = async () => {};
events.initialize = async () => {};
native.start = async (s, base, limit, slot, calls) => {
  const built = chain.build(base, limit, calls, 0x400000, 0x500000);
  return {thread: 0x1234, base, count: calls.length,
    resultOffsets: built.proof.resultOffsets,
    logicalResultIndices: built.proof.logicalResultIndices,
    results: [], bytes: built.proof.bytes};
};

const s = {
  base: 0x10000000, bytes: 0x2400000,
  handles: new Set([8487335]), threads: new Set(),
  write: async () => {},
  readOwned: async () => Buffer.alloc(256),
  verifyCode: async () => {},
  rpc: {call3: async () => 0, batch: async () => []},
};
const state = {worker: {released: true, joined: false}, workers: [], services: []};
const context = {s, live: {sdk: 0x400000, session: 'seedsow'}, save: async () => {}};
const domain = {wire: require('../../shared/domain.cjs')};
const request = {
  command: 'root-native-worker-prepare', slot: 2, areaOffset: 0x100000,
  kind: 'retained-dump', handle: 8487335,
  readOffset: 67010560, length: 16384,
  delayNs: 250000000, pcAddress: 3232235955, port: 39401
};

workerControl.dispatch(context, request, state, domain)
  .then(result => console.log('ok', JSON.stringify(result)))
  .catch(error => { console.error('FAILED:', error.stack); process.exitCode = 1; });
