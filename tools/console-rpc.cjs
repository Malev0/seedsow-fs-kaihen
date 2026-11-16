// Persistent binary RPC to the Seedsow console (n2h_rpc.lua R.serve).
// The console listens on TCP (default 39380); the launcher's /eval is only used
// to start the serve loop when no listener is up.
const net = require('node:net');
const http = require('node:http');

const MAGIC = 0x5248324e; // 'N2HR' read as a little-endian u32
const HDR = 64;
const RSP = 24;

const CMD = {
  status: 1, call: 2, callAddress: 3, read: 4, write: 5, query: 6, verify: 7,
  workersStart: 8, workersJoin: 9, ping: 10, shutdown: 11, run: 12, say: 13,
};

function u64(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}
function i64(v) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
}

class ConsoleRpc {
  constructor({host, port = 39380, httpPort = 8080, serveSeconds = 1800, log = () => {},
    startServer = true}) {
    this.host = host;
    this.port = port;
    this.httpPort = httpPort;
    this.serveSeconds = serveSeconds;
    this.allowStart = startServer;
    this.idleSeconds = Number(process.env.NS2_IDLE_SECONDS || 75);
    this.log = log;
    this.socket = null;
    this.pending = null;
    this.buffer = Buffer.alloc(0);
    this.connecting = null;
    this.starting = null;
    this.queue = Promise.resolve();
    this.stats = {requests: 0, connects: 0, starts: 0, bytesIn: 0, bytesOut: 0};
    this.lastError = null;
  }

  // ---- transport ----
  async rawConnect(timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({host: this.host, port: this.port});
      socket.setNoDelay(true);
      const timer = setTimeout(() => socket.destroy(new Error('connect timeout')), timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        socket.on('error', error => this.dropped(error));
        socket.on('close', () => this.dropped(Error('console closed the RPC socket')));
        socket.on('data', chunk => this.onData(chunk));
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.stats.connects++;
        this.log(`rpc: connected to ${this.host}:${this.port}`);
        resolve(socket);
      });
      socket.once('error', error => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      });
    });
  }

  dropped(error) {
    if (this.socket) this.log('rpc: disconnected: ' + error.message);
    this.lastError = error;
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (this.pending) {
      const {reject, timer} = this.pending;
      clearTimeout(timer);
      this.pending = null;
      reject(error);
    }
  }

  onData(chunk) {
    this.stats.bytesIn += chunk.length;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.pending && this.buffer.length >= RSP) {
      if (this.buffer.readUInt32LE(0) !== MAGIC) {
        this.dropped(Error('bad RPC reply magic'));
        return;
      }
      const status = this.buffer.readUInt32LE(4);
      const length = Number(this.buffer.readBigUInt64LE(8));
      const aux = this.buffer.readBigInt64LE(16);
      if (this.buffer.length < RSP + length) return;
      const payload = this.buffer.subarray(RSP, RSP + length);
      this.buffer = this.buffer.subarray(RSP + length);
      const {resolve, timer} = this.pending;
      clearTimeout(timer);
      this.pending = null;
      resolve({status, aux, payload});
    }
  }

  async startServer() {
    if (this.starting) return this.starting;
    // The blocking loop is the proven transport: it held the game's /eval slot
    // (so /eval looked dead) but the app still closes and relaunches fine, which
    // the controller's auto-restart proves every boot. Frame pump mode is opt-in
    // and experimental - it returns from /eval immediately and services the
    // socket from the frame handler - so enable it only to work on it.
    const mode = process.env.NS2_RPC_PUMP === '1' ? 'pump' : 'blocking';
    const body = Buffer.from(
      'if not _G.__rpc then dofile("save:/n2h_rpc.lua") end\n' +
      `print(__rpc.serve(${this.port}, ${this.serveSeconds}, ${this.idleSeconds}, "${mode}"))\n`);
    this.log('rpc: starting console serve loop via /eval');
    this.stats.starts++;
    const post = new Promise(resolve => {
      const req = http.request({host: this.host, port: this.httpPort, path: '/eval', method: 'POST',
        headers: {'content-type': 'text/plain', 'content-length': body.length}}, res => {
        const parts = [];
        res.on('data', p => parts.push(p));
        res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        res.on('error', error => resolve('POST ERROR: ' + error.message));
      });
      req.on('error', error => resolve('POST ERROR: ' + error.message));
      req.setTimeout((this.serveSeconds + 120) * 1000, () => req.destroy(Error('serve request timed out')));
      req.end(body);
    });
    // The /eval response only arrives when the serve loop ends; keep it watched
    // so a bind failure is visible in the log.
    this.starting = post.then(text => {
      this.starting = null;
      this.log('rpc: serve loop ended: ' + text.trim().split('\n').slice(-1)[0]);
      return text;
    });
    // Give the console a moment to create the listener before the retry loop.
    await new Promise(resolve => setTimeout(resolve, 250));
    return post;
  }

  async ensure() {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        return await this.rawConnect(1200);
      } catch (error) {
        this.lastError = error;
      }
      if (!this.allowStart)
        throw Error('console RPC listener is not running: ' + (this.lastError?.message || 'unknown'));
      this.startServer();
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        try {
          return await this.rawConnect(1200);
        } catch (error) {
          this.lastError = error;
        }
      }
      throw Error('console RPC listener is not reachable: ' + (this.lastError?.message || 'unknown'));
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async rawRequest(cmd, {a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, payload = Buffer.alloc(0),
    timeoutMs = 120000} = {}) {
    const socket = await this.ensure();
    const header = Buffer.alloc(HDR);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt32LE(cmd, 4);
    header.writeBigUInt64LE(BigInt(a0), 8);
    header.writeBigUInt64LE(BigInt(a1), 16);
    header.writeBigUInt64LE(BigInt(a2), 24);
    header.writeBigUInt64LE(BigInt(a3), 32);
    header.writeBigUInt64LE(BigInt(a4), 40);
    header.writeUInt32LE(payload.length, 48);
    const body = payload.length ? Buffer.concat([header, payload]) : header;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending) return;
        this.pending = null;
        const detail = 'cmd ' + cmd + (cmd === CMD.call || cmd === CMD.callAddress ?
          ' offset/address 0x' + BigInt(a0).toString(16) : '') + ' a1 0x' + BigInt(a1).toString(16);
        reject(Error('console RPC request timed out (' + detail + ')'));
        // The console serves one client until EOF; drop the socket so the next
        // request reconnects (and the serve loop is free to accept it).
        this.dropped(Error('request timeout'));
      }, timeoutMs);
      this.pending = {resolve, reject, timer};
      this.stats.requests++;
      this.stats.bytesOut += body.length;
      socket.write(body, error => {
        if (error && this.pending) {
          clearTimeout(this.pending.timer);
          this.pending = null;
          reject(error);
        }
      });
    });
  }

  // The console serves one request at a time and this client has a single
  // pending slot, so every request (including the keepalive) goes through one
  // queue. Concurrent sends would interleave replies and truncate payloads.
  async request(cmd, options) {
    const run = () => this.requestOnce(cmd, options);
    const task = this.queue.then(run, run);
    this.queue = task.then(() => {}, () => {});
    return task;
  }

  async requestOnce(cmd, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        const reply = await this.rawRequest(cmd, options);
        if (reply.status !== 0) throw Error(reply.payload.toString('utf8'));
        return reply;
      } catch (error) {
        // One transparent reconnect for a dropped connection. Do NOT retry a
        // request timeout: the console is single-threaded, so a timeout almost
        // always means a native call is wedged inside the serve loop. Retrying
        // just waited another full timeout and produced the 2-minute reconnect
        // loop that kept /eval parked.
        if (attempt >= 1 || !/closed|not reachable|EPIPE|ECONNRESET|socket hang up/i.test(error.message))
          throw error;
        this.dropped(error);
      }
    }
  }

  // ---- commands ----
  async ping(token = 1, timeoutMs = 120000) {
    const reply = await this.request(CMD.ping, {a0: token, timeoutMs});
    return reply.aux === BigInt(token);
  }

  async status() {
    const reply = await this.request(CMD.status);
    const parts = reply.payload.toString('utf8').split('\0');
    return {sdk: Number(parts[1]), main: Number(parts[2]), scratch: Number(parts[3]),
      session: parts[4] || 'seedsow'};
  }

  async call(offset, args = []) {
    const [a0, a1, a2, a3] = [0, 1, 2, 3].map(i => BigInt(args[i] || 0));
    const reply = await this.request(CMD.call, {a0: offset, a1: a0, a2: a1, a3: a2, a4: a3});
    return {result: reply.aux, output: reply.payload};
  }

  async callAddress(address, args = []) {
    const [a0, a1, a2, a3] = [0, 1, 2, 3].map(i => BigInt(args[i] || 0));
    const reply = await this.request(CMD.callAddress,
      {a0: address, a1: a0, a2: a1, a3: a2, a4: a3});
    return {result: reply.aux, output: reply.payload};
  }

  async read(address, length) {
    const reply = await this.request(CMD.read, {a0: address, a1: length});
    if (reply.payload.length !== Number(length)) throw Error('RPC read was truncated');
    return reply.payload;
  }

  async write(address, bytes) {
    await this.request(CMD.write, {a0: address, payload: bytes});
  }

  async query(address) {
    const reply = await this.request(CMD.query, {a0: address});
    const v = i => reply.payload.readBigUInt64LE(i * 8);
    return {result: Number(reply.aux), address: Number(v(0)), size: Number(v(1)),
      type: Number(v(2)), attributes: Number(v(3)), permissions: Number(v(4)),
      ipcReferences: Number(v(5)), deviceReferences: Number(v(6))};
  }

  async verify(address, hex) {
    const reply = await this.request(CMD.verify, {a0: address, payload: Buffer.from(hex)});
    return {result: Number(reply.aux)};
  }

  // Write one line to the game's on-screen console (the launcher's print).
  async say(text) {
    await this.request(CMD.say, {payload: Buffer.from(String(text))});
  }

  async run(source) {
    const reply = await this.request(CMD.run, {payload: Buffer.from(source)});
    return reply.payload.toString('utf8');
  }

  async shutdown(timeoutMs = 120000) {
    try {
      await this.request(CMD.shutdown, {timeoutMs});
    } finally {
      this.dropped(Error('shutdown requested'));
    }
  }

  // workers: [{base, limit, slot, snapshot, calls: [{function, args}]}]
  async startWorkers(workers) {
    const parts = [];
    const head = Buffer.alloc(8);
    head.writeUInt32LE(workers.length, 0);
    parts.push(head);
    for (const worker of workers) {
      // 48-byte spec: base, limit, slot, snapshot, call count, then the
      // optional thread tuning (priority, flags bit 0 = pin at creation).
      const spec = Buffer.alloc(48);
      spec.writeBigUInt64LE(BigInt(worker.base), 0);
      spec.writeBigUInt64LE(BigInt(worker.limit || 0x40000), 8);
      spec.writeBigUInt64LE(BigInt(worker.slot), 16);
      spec.writeBigUInt64LE(BigInt(worker.snapshot || 0), 24);
      spec.writeBigUInt64LE(BigInt(worker.calls.length), 32);
      spec.writeUInt32LE(Number(worker.priority || 0), 40);
      spec.writeUInt32LE(worker.affinity ? 1 : 0, 44);
      parts.push(spec);
      for (const call of worker.calls) {
        const rec = Buffer.alloc(48);
        rec.writeBigUInt64LE(BigInt(call.function), 0);
        const args = call.args || [];
        rec.writeUInt8(args.length, 8);
        for (let i = 0; i < 4; i++) {
          const arg = args[i];
          if (arg && typeof arg === 'object') {
            rec.writeUInt8(1, 9 + i);
            rec.writeBigUInt64LE(BigInt(arg.u32), 16 + i * 8);
          } else {
            rec.writeBigUInt64LE(BigInt(arg || 0), 16 + i * 8);
          }
        }
        parts.push(rec);
      }
    }
    const reply = await this.request(CMD.workersStart, {payload: Buffer.concat(parts)});
    const payload = reply.payload;
    const count = payload.readUInt32LE(0);
    const out = [];
    let at = 8;
    for (let i = 0; i < count; i++) {
      const thread = Number(payload.readBigUInt64LE(at));
      const bytes = Number(payload.readBigUInt64LE(at + 8));
      const resultOffset = Number(payload.readBigUInt64LE(at + 16));
      const cancelCell = Number(payload.readBigUInt64LE(at + 24));
      const startCell = payload.readBigUInt64LE(at + 32).toString();
      const index = Number(payload.readBigUInt64LE(at + 40));
      const nativeCalls = payload.readUInt32LE(at + 48);
      const logicalCalls = payload.readUInt32LE(at + 52);
      at += 56;
      const resultOffsets = [];
      for (let k = 0; k < nativeCalls; k++) resultOffsets.push(Number(payload.readBigUInt64LE(at + k * 8)));
      at += nativeCalls * 8;
      const logicalResultIndices = [];
      for (let k = 0; k < logicalCalls; k++) logicalResultIndices.push(payload.readUInt32LE(at + k * 4));
      at += logicalCalls * 4;
      out.push({thread, bytes, resultOffset, cancelCell, startCell, index,
        nativeCalls, logicalCalls, resultOffsets, logicalResultIndices});
    }
    return out;
  }

  async joinWorkers(indices) {
    const payload = Buffer.alloc(8 + indices.length * 4);
    payload.writeUInt32LE(indices.length, 0);
    indices.forEach((index, i) => payload.writeUInt32LE(index, 8 + i * 4));
    const reply = await this.request(CMD.workersJoin, {payload});
    const data = reply.payload;
    const count = data.readUInt32LE(0);
    const out = [];
    let at = 8;
    for (let i = 0; i < count; i++) {
      const exitValue = data.readBigUInt64LE(at);
      const n = Number(data.readBigUInt64LE(at + 8));
      at += 16;
      const values = [];
      for (let k = 0; k < n; k++) values.push(data.readBigUInt64LE(at + k * 8));
      at += n * 8;
      out.push({exitValue, values});
    }
    return out;
  }

  close() {
    this.dropped(Error('client closed'));
  }
}

module.exports = {ConsoleRpc, CMD};
