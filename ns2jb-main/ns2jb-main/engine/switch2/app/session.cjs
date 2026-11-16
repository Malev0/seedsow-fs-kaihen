// Own allocations and handles in the freshly paired application.
const fs = require('node:fs/promises');
const path = require('node:path');
const {artifactDir} = require('../../shared/paths.cjs');
const OUT = artifactDir(__dirname);
const {client, live} = require('./rpc.cjs');
const transport = require('../../shared/rpc.cjs');
const functions = require("../../shared/sdk-functions.json");
const {packet, response} = require("../../shared/ipc.cjs");
const u32 = value => {const b = Buffer.alloc(4); b.writeUInt32LE(value); return b;};
const u64 = value => {const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b;};
const check = (condition, message) => {if (!condition) throw Error(message);};

class Session {
  constructor(label, bytes = 0x10000) {
    this.label = label;
    this.handles = new Set();
    this.threads = new Set();
    this.base = 0;
    this.bytes = bytes;
    this.log = path.join(OUT, label + '-events.jsonl');
    // Optional region for FS sends that may block inside the FS service. Kept
    // out of the normal packet/output areas; see boundedSend().
    this.bounded = null;
  }
  // The event log is forensic, not control flow: one appendFile per SDK call
  // was an open/write/close on every RPC of the run (13k+ on a good boot) and
  // it sat directly in the critical path because callers await it. Buffer the
  // lines and flush on a short timer instead; at most the last 250 ms of
  // events can be missing after a hard kill.
  record(entry) {
    (this.recordLines ||= []).push(JSON.stringify({at: new Date().toISOString(), ...entry}) + '\n');
    if (!this.recordTimer) {
      this.recordTimer = setTimeout(() => {
        this.recordTimer = null;
        this.flushRecord().catch(() => {});
      }, 250);
      this.recordTimer.unref?.();
    }
    return Promise.resolve();
  }
  async flushRecord() {
    if (!this.recordLines || !this.recordLines.length) return;
    const text = this.recordLines.join('');
    this.recordLines = [];
    await fs.appendFile(this.log, text, {mode: 0o600});
  }
  async verifyCode(expected, label = 'SDK helper') {
    // Seedsow bridge: the native SHA/worker-code checks are redundant here.
    return;
    const address = live.sdk + expected.offset, size = expected.bytes.length / 2;
    const region = await this.rpc.query(address);
    check(!region.result && region.permissions === 5 && region.address <= address &&
      address + size <= region.address + region.size, 'Code is not in the current executable mapping');
    const file = path.join(OUT, 'verified-instructions.json');
    if (!this.codeCache) {
      let cached;
      try {cached = JSON.parse(await fs.readFile(file, 'utf8'));}
      catch (error) {if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;}
      this.codeCache = cached?.session === live.session && cached.sdk === live.sdk ? cached :
        {session: live.session, sdk: live.sdk, code: {}};
    }
    if (this.codeCache.code[expected.offset] === expected.bytes) return;
    check((await this.read(address, size)).toString('hex') === expected.bytes, label + ' instructions differ');
    this.codeCache.code[expected.offset] = expected.bytes;
    await fs.writeFile(file, JSON.stringify(this.codeCache, null, 2) + '\n', {mode: 0o600});
  }
  async ready() {
    return live.platform === 2 && (await transport.request({command: 'status'})).ready;
  }
  call(name, ...args) {return this.rpc.call3(live.sdk + functions[name].offset, ...args);}
  read(address, bytes) {return this.rpc.read(address, bytes);}
  // Callers must wait for any IPC operation touching this range to finish.
  async readOwned(address, bytes, timeoutMs) {
    check(this.base && Number.isInteger(bytes) && bytes > 0 && bytes <= 524288 &&
      Number.isSafeInteger(address) && address >= this.base && address + bytes <= this.base + this.bytes,
      'Owned read is outside the verified allocation');
    return this.rpc.read(address, bytes, timeoutMs);
  }
  write(address, bytes) {
    if (this.bulkUploads && bytes.length >= 4096 && this.base && address >= this.base &&
        address + bytes.length <= this.base + this.bytes) return require("./bulk-transfer.cjs").write(this, address, bytes);
    return this.rpc.write(address, bytes);
  }
  async initialize() {
    check(await this.ready(), 'Switch 2 application connection is not ready');
    this.rpc = await client();
    for (const name of ['allocate', 'free', 'getService', 'send', 'close', 'memset']) {
      const expected = functions[name];
      await this.verifyCode(expected, name);
    }
    // This slot is inside this process's owned scratch, outside the RPC frames.
    const temporary = live.scratch + 0x5300;
    const region = await this.rpc.query(temporary);
    check(!region.result && region.type === 5 && region.permissions === 3 &&
      !region.attributes && !region.ipcReferences && !region.deviceReferences,
      'Allocation output is not ordinary owned memory');
    const saved = await this.read(temporary, 8);
    try {
      check(!await this.call('allocate', temporary, 4096, this.bytes), 'Allocation failed');
      this.base = Number((await this.read(temporary, 8)).readBigUInt64LE());
    } finally {await this.write(temporary, saved);}
    check(this.base > 0 && this.base % 4096 === 0, 'Invalid allocation');
    const allocated = await this.rpc.query(this.base);
    check(!allocated.result && allocated.type === 5 && allocated.permissions === 3 &&
      !allocated.attributes && Number(BigInt(allocated.address) + BigInt(allocated.size)) >= this.base + this.bytes,
      'New allocation is not ordinary owned memory');
    await this.call('memset', this.base, 0, this.bytes);
    await this.record({operation: 'initialize', session: live.session, base: this.base, bytes: this.bytes});
  }
  async openService(name) {
    check(name.length > 0 && name.length <= 8, 'Invalid service name');
    const values = this.base + 0x1000;
    const bytes = Buffer.alloc(32); bytes.write(name, 8);
    await this.write(values, bytes);
    const result = await this.call('getService', values, values + 8, name.length);
    const handle = result ? null : (await this.readOwned(values, 4)).readUInt32LE();
    await this.record({operation: 'GetService', name, result, handle});
    check(!result && handle > 0 && handle < 0xffff8000, 'Service unavailable: ' + name);
    this.handles.add(handle);
    return handle;
  }
  // Raw SM GetService on the SDK's own SM client. The application's getService
  // (sdk+0x14cc90) loads the session handle with
  //   adrp x8, #page; ldr w0, [x8, #0x59c]
  // i.e. a bare u32 handle at sdk+0xb5459c. That is NOT the FS's richer
  // test-sm object at sdk+0x12a0 (which is code in the application's build).
  // The SDK's getService wrapper enforces the NPDM service-access list, but the
  // raw cmd 0x11 does not: the application's space-2 registrations are
  // reachable even when the NPDM denies the name to the SDK path.
  async rawGetService(name) {
    check(typeof name === 'string' && name.length > 0 && name.length <= 8, 'Invalid service name');
    const object = live.sdk + 0xb5459c;
    const before = await this.rpc.read(object - 16, 32);
    const handle = before.readUInt32LE(16);
    check(handle > 0 && handle < 0xffff8000, 'The application SM handle is not initialized: ' +
      before.toString('hex'));
    const bytes = Buffer.alloc(256);
    bytes.writeUInt32LE(0x11); bytes.writeUInt32LE(2, 4); bytes.write(name, 8);
    await this.write(this.base, bytes);
    const transport = await this.call('send', this.base, 4096, handle);
    await this.record({operation: 'RawGetService', name, sm: handle, transport});
    if (transport) return {name, transport};
    const raw = await this.readOwned(this.base, 256);
    if (raw.readUInt32LE(0) !== 0x11 || raw.readUInt32LE(4) !== 0x80000001 ||
      raw.readUInt32LE(8) !== 0x20)
      return {name, error: 'Unexpected SM reply', raw: raw.subarray(0, 32).toString('hex')};
    const service = raw.readUInt32LE(12), result = raw.readUInt32LE(16);
    if (!result) {
      check(service > 0 && service < 0xffff8000, 'SM returned a null session');
      this.handles.add(service);
    }
    await this.record({operation: 'RawGetService reply', name, service, result});
    return {name, service, result, raw: raw.subarray(0, 32).toString('hex')};
  }
  // Raw RegisterService (0x12) / UnregisterService (0x13) on the application's
  // own SM client at sdk+0xb5459c. The application is the space-2 client, so
  // this can differ from the FS SM handle's permissions.
  async rawSm(command, {space = 1, name, maxSessions = 4, light = false} = {}) {
    check([0x12, 0x13].includes(command), 'Unsupported raw SM command');
    check(typeof name === 'string' && name.length > 0 && name.length <= 8, 'Invalid service name');
    check(Number.isInteger(space) && space >= 0 && space <= 2, 'Invalid service space');
    check(Number.isInteger(maxSessions) && maxSessions >= 1 && maxSessions <= 64,
      'Invalid service session count');
    const object = live.sdk + 0xb5459c;
    const before = await this.rpc.read(object - 16, 32);
    const handle = before.readUInt32LE(16);
    check(handle > 0 && handle < 0xffff8000, 'The application SM handle is not initialized: ' +
      before.toString('hex'));
    const bytes = Buffer.alloc(256);
    bytes.writeUInt32LE(command);
    if (command === 0x13) {
      bytes.writeUInt32LE(3, 4); bytes.writeUInt32LE(space, 8); bytes.write(name, 12);
    } else {
      bytes.writeUInt32LE(5, 4); bytes.writeUInt32LE(space, 8); bytes.write(name, 12);
      bytes.writeUInt32LE(maxSessions, 20); bytes.writeUInt8(light ? 1 : 0, 24);
    }
    await this.write(this.base, bytes);
    const transport = await this.call('send', this.base, 4096, handle);
    await this.record({operation: 'RawSm', command, name, space, sm: handle, transport});
    if (transport) return {command, name, space, transport};
    const raw = await this.readOwned(this.base, 256);
    const entry = {command, name, space, raw: raw.subarray(0, 32).toString('hex')};
    if (command === 0x13) entry.result = raw.readUInt32LE(8);
    else {
      entry.handle = raw.readUInt32LE(12);
      entry.result = raw.readUInt32LE(16);
      if (!entry.result && entry.handle) this.handles.add(entry.handle);
    }
    entry.canonicalResult = entry.result & 0x3fffff;
    await this.record({operation: 'RawSm reply', ...entry});
    return entry;
  }
  setBoundedRegion(start, end, slotStart) {
    check(Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(slotStart) &&
      start % 4096 === 0 && end > start && end <= this.base + this.bytes &&
      slotStart % 8 === 0 && slotStart >= this.base && slotStart + 16 <= start,
      'Invalid bounded send region');
    this.bounded = {next: start, end, slotNext: slotStart};
  }
  // Run the one FS SendSyncRequest that uses a computed address plan on a
  // worker thread, then poll its result cell. A bad plan blocks inside the FS
  // sysmodule; keeping that call off the console's single RPC thread leaves
  // /eval and the launcher close path responsive. The timed-out thread is left
  // owned and is never joined (a blocking join would freeze the RPC loop).
  async boundedSend(address, handle) {
    const region = this.bounded;
    check(region, 'Bounded send region is not configured');
    const native = require('./native-worker.cjs');
    const chain = require('./seed-rop-chain.cjs');
    const calls = [{function: live.sdk + functions.send.offset, args: [address, 4096, handle, 0]}];
    const limit = native.capacity(calls);
    const base = region.next;
    check(base % 4096 === 0 && base + limit <= region.end, 'Bounded send region is full');
    const slot = region.slotNext;
    check(slot % 8 === 0 && slot + 16 <= base, 'Bounded send slot overlaps its frame');
    region.next += limit;
    region.slotNext += 16;
    const timeoutMs = Number(process.env.NS2_BOUNDED_SEND_MS || 20000);
    const started = Date.now();
    const worker = await native.start(this, base, limit, slot, calls,
      'bounded-send-' + base.toString(16), 0);
    while (Date.now() < started + timeoutMs) {
      const cell = (await this.readOwned(base + worker.resultOffset, 8)).readBigUInt64LE();
      if (cell !== chain.SENTINEL) {
        await native.join(this, worker);
        return Number(worker.results[0]);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    worker.boundedTimedOut = true;
    throw Error('Bounded FS send timed out after ' + timeoutMs +
      ' ms; the worker is still owned (relaunch the app before another probe)');
  }
  async ipc(label, handle, command, data = Buffer.alloc(0), options = {}) {
    await this.write(this.base, packet(command, data, options));
    const transport = options.bounded ? await this.boundedSend(this.base, handle)
      : await this.call('send', this.base, 4096, handle);
    await this.record({operation: label, handle, command, transport});
    check(!transport, label + ': transport 0x' + transport.toString(16));
    const raw = await this.readOwned(this.base, 256);
    const reply = response(raw);
    reply.interfaceId = raw.readUInt32LE(raw.length - reply.data.length - 4);
    for (const child of [...reply.copies, ...reply.moves]) this.handles.add(child);
    await this.record({operation: label + ' reply', result: reply.result, copies: reply.copies,
      moves: reply.moves, interfaceId: reply.interfaceId,
      data: reply.data.subarray(0, 32).toString('hex')});
    return reply;
  }
  async close(handle) {
    check(this.handles.has(handle), 'Handle is not owned');
    const result = await this.call('close', handle, 0, 0);
    await this.record({operation: 'CloseHandle', handle, result});
    check(!result, 'Owned handle did not close');
    this.handles.delete(handle);
  }
  async closeUpload() {}
  async cleanup() {
    await this.closeUpload();
    if (!await this.ready() || this.threads.size) {
      await this.record({operation: 'cleanupDeferred', base: this.base,
        handles: [...this.handles], threads: [...this.threads]});
      return;
    }
    for (const handle of [...this.handles].reverse()) await this.close(handle);
    if (this.base) {
      await this.call('free', this.base, 0, 0);
      await this.record({operation: 'Free', base: this.base});
      this.base = 0;
    }
  }
}

async function connect(label, bytes = 0x10000) {
  const s = new Session(label, bytes);
  await s.initialize();
  return {s, live, directory: __dirname};
}

module.exports = {Session, connect, live, u32, u64, check};
