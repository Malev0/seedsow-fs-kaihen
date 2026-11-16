// Host-side batching and measurements for an already connected session.
const {performance} = require('node:perf_hooks');

function check(ok, message) { if (!ok) throw Error(message); }

function packPages(base, size, writes) {
  check(Number.isSafeInteger(base) && base % 4096 === 0 && Number.isInteger(size) &&
    size > 0 && size % 4096 === 0, 'Invalid page staging range');
  const bytes = Buffer.alloc(size), occupied = new Set();
  for (const item of writes) {
    const offset = item.address - base;
    check(Number.isInteger(offset) && offset % 4096 === 0 && offset >= 0 && offset < size &&
      Buffer.isBuffer(item.bytes) && item.bytes.length > 0 && item.bytes.length <= 4096,
      'Packet is outside its staging page');
    check(!occupied.has(offset), 'Two packets share a staging page');
    occupied.add(offset);
    item.bytes.copy(bytes, offset);
  }
  return bytes;
}

function install(s, live, bulk) {
  if (s.metrics) return s;
  const rpc = s.rpc;
  const counters = {requests: 0, elapsedMs: 0, methods: {}};
  for (const name of Object.keys(rpc).filter(name => typeof rpc[name] === 'function')) {
    const original = rpc[name].bind(rpc);
    rpc[name] = async (...args) => {
      const started = performance.now();
      counters.requests++;
      counters.methods[name] = (counters.methods[name] || 0) + 1;
      try { return await original(...args); }
      finally {
        counters.elapsedMs += performance.now() - started;
      }
    };
  }
  s.metrics = counters;
  s.measure = async (stage, work) => {
    const started = performance.now(), requests = counters.requests;
    let passed = false;
    try { const value = await work(); passed = true; return value; }
    finally { await s.record({operation: 'timing', stage, passed,
      elapsedMs: performance.now() - started,
      requests: counters.requests - requests}); }
  };

  // The caller must wait until every producer of these ranges is finished.
  //
  // A read costs one console round trip whatever its size (measured 13-26 ms
  // each), so contiguous ranges are fetched as one span and sliced here. The
  // 13 reply pages of a wave and the five input pieces are both a few pages
  // apart; this turns 13 + 5 requests per wave into 2.
  s.readOwnedMany = async ranges => {
    check(Array.isArray(ranges) && ranges.length > 0 && ranges.length <= 64,
      'Expected 1..64 owned ranges');
    for (const range of ranges)
      check(Number.isSafeInteger(range.address) && Number.isInteger(range.bytes) && range.bytes > 0,
        'Invalid owned range');
    // Group in address order so a span always starts at its lowest range, then
    // put the results back in the caller's order.
    const outputs = new Array(ranges.length);
    const ordered = ranges.map((range, index) => ({range, index}))
      .sort((a, b) => a.range.address - b.range.address);
    let group = [];
    const flush = async () => {
      if (!group.length) return;
      const start = group[0].range.address;
      const end = Math.max(...group.map(item => item.range.address + item.range.bytes));
      if (group.length > 1 && end - start <= 0x80000) {
        const bytes = await s.readOwned(start, end - start);
        for (const item of group) {
          const at = item.range.address - start;
          outputs[item.index] = bytes.subarray(at, at + item.range.bytes);
        }
      } else {
        for (const item of group) outputs[item.index] = await s.readOwned(item.range.address, item.range.bytes);
      }
      group = [];
    };
    for (const item of ordered) {
      if (group.length) {
        const start = group[0].range.address;
        const end = Math.max(Math.max(...group.map(entry => entry.range.address + entry.range.bytes)),
          item.range.address + item.range.bytes);
        if (end - start > 0x80000) await flush();
      }
      group.push(item);
    }
    await flush();
    return outputs;
  };

  // The allocation was already checked by initialize and remains owned until
  // cleanup. Avoid querying the same mapping before every small hash/result.
  const originalRead = s.read.bind(s);
  s.read = (address, bytes) => {
    if (s.base && Number.isSafeInteger(address) && Number.isInteger(bytes) && bytes > 0 && bytes <= 524288 &&
        address >= s.base && address + bytes <= s.base + s.bytes)
      return s.readOwned(address, bytes);
    return originalRead(address, bytes);
  };

  // Keep scalar stores for small words; use the existing authenticated upload
  // channel for buffers. This changes transport only, not their destinations.
  const originalWrite = s.write.bind(s);
  s.uploadThreshold = 512;
  s.write = (address, bytes) => {
    if (s.bulkUploads && bytes.length >= s.uploadThreshold && s.base &&
        address >= s.base && address + bytes.length <= s.base + s.bytes)
      return bulk.write(s, address, bytes);
    return originalWrite(address, bytes);
  };
  return s;
}

module.exports = {install, packPages};
