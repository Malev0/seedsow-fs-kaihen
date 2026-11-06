#!/usr/bin/env node
// Seedsow bridge: ns2jb host Session -> console RPC -> _G.n2h.
// Listens on 127.0.0.1:31337 and writes engine/connection.json at startup.
//
// Transport: the console runs a persistent binary TCP RPC loop (n2h_rpc.lua
// R.serve); this process speaks to it directly. The launcher's HTTP /eval is
// only used to start that loop, and remains a per-request fallback.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {ConsoleRpc} = require('./console-rpc.cjs');

const CONSOLE_HOST = require('./console-host.cjs').consoleHost();
const CONSOLE_PORT = Number(process.env.NS2_HTTP_PORT || 8080);
const RPC_PORT = Number(process.env.NS2_RPC_PORT || 39380);
const PORT = 31337;
// Transport switch for this process only; worker building is controlled by
// NS2_FAST in the pipeline/native-worker process.
const FAST = process.env.NS2_TRANSPORT !== 'eval';
const SERVE_SECONDS = Number(process.env.NS2_SERVE_SECONDS || 3600);

const PROJECT = path.resolve(__dirname, '..');
function discoverEngine() {
  const top = fs.readdirSync(PROJECT).find(n => /2jb-main$/.test(n) &&
    fs.statSync(path.join(PROJECT, n)).isDirectory());
  if (!top) throw Error('ns2jb-main top directory not found');
  const nested = fs.readdirSync(path.join(PROJECT, top)).find(n => /2jb-main$/.test(n) &&
    fs.statSync(path.join(PROJECT, top, n)).isDirectory());
  if (!nested) throw Error('ns2jb-main nested directory not found');
  return path.join(PROJECT, top, nested, 'engine');
}
const ENGINE = discoverEngine();

function log(message) {
  console.log(new Date().toISOString() + ' ' + message);
}

const rpc = new ConsoleRpc({host: CONSOLE_HOST, port: RPC_PORT, httpPort: CONSOLE_PORT,
  serveSeconds: SERVE_SECONDS, log});

// ---------------------------------------------------------------- legacy /eval
function consoleEval(source) {
  const data = Buffer.from(source);
  return new Promise((resolve, reject) => {
    const req = http.request({host: CONSOLE_HOST, port: CONSOLE_PORT, path: '/eval', method: 'POST',
      headers: {'content-type': 'text/plain', 'content-length': data.length}}, res => {
      const parts = [];
      res.on('data', p => parts.push(p));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        if (!text.startsWith('status: ok')) return reject(Error(text));
        const at = text.indexOf('output:\n');
        resolve((at >= 0 ? text.slice(at + 8) : text).replace(/\n$/, ''));
      });
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(Error('console /eval timed out')));
    req.end(data);
  });
}

const PRE = 'if not _G.__rpc then dofile("save:/n2h_rpc.lua") end\n';
const num = v => Number(v);
const args4 = args => [0, 0, 0, 0].map((d, i) => num((args || [])[i] || 0));

const legacy = {
  async status() {
    const out = await consoleEval(PRE + 'print(__rpc.status())\n');
    const m = out.match(/^S (\d+) (\d+) (\d+) (\S+)$/m);
    if (!m) throw Error('bad status: ' + out);
    return {sdk: Number(m[1]), main: Number(m[2]), scratch: Number(m[3]), session: m[4]};
  },
  async call(offset, args) {
    const [a0, a1, a2, a3] = args4(args);
    const out = await consoleEval(PRE + `print(__rpc.call(${num(offset)},${a0},${a1},${a2},${a3}))\n`);
    const m = out.match(/^R (\d+)\s*\nO ([0-9a-f]*)$/m);
    if (!m) throw Error('bad call reply: ' + out);
    return {result: m[1], output: Buffer.from(m[2], 'hex').toString('base64')};
  },
  async callAddress(address, args) {
    const [a0, a1, a2, a3] = args4(args);
    const out = await consoleEval(PRE + `print(__rpc.call_addr(${num(address)},${a0},${a1},${a2},${a3}))\n`);
    const m = out.match(/^R (\d+)\s*\nO ([0-9a-f]*)$/m);
    if (!m) throw Error('bad call-address reply: ' + out);
    return {result: m[1], output: Buffer.from(m[2], 'hex').toString('base64')};
  },
  async read(address, length) {
    const out = await consoleEval(PRE + `print(__rpc.read(${num(address)},${num(length)}))\n`);
    const m = out.match(/^D ([0-9a-f]*)$/m);
    if (!m) throw Error('bad read reply: ' + out.slice(0, 200));
    return {data: Buffer.from(m[1], 'hex').toString('base64')};
  },
  async write(address, bytes) {
    const chunk = 0x400;
    for (let at = 0; at < bytes.length; at += chunk) {
      const part = bytes.subarray(at, at + chunk);
      const out = await consoleEval(PRE +
        `print(__rpc.write(${num(address) + at},'${part.toString('hex')}'))\n`);
      if (!/^OK$/m.test(out)) throw Error('bad write reply: ' + out.slice(0, 200));
    }
    return {};
  },
  async query(address) {
    const out = await consoleEval(PRE + `print(__rpc.query(${num(address)}))\n`);
    const m = out.match(/^Q (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/m);
    if (!m) throw Error('bad query reply: ' + out);
    return {address: Number(m[2]), size: Number(m[3]), type: Number(m[4]),
      attributes: Number(m[5]), permissions: Number(m[6]), ipcReferences: Number(m[7]),
      deviceReferences: Number(m[8])};
  },
  async verify(address, hex) {
    const out = await consoleEval(PRE + `print(__rpc.verify(${num(address)},'${hex}'))\n`);
    return {result: /^OK$/m.test(out) ? 0 : 1};
  },
};

// ------------------------------------------------------------------- transport
let fastDownUntil = 0;
function fastAvailable() {
  return FAST && Date.now() >= fastDownUntil;
}
async function withFast(name, fastFn, legacyFn) {
  if (fastAvailable()) {
    try {
      return await fastFn();
    } catch (error) {
      if (!/not reachable|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(error.message)) throw error;
      log(`rpc: ${name} unavailable (${error.message}); using /eval for 30 s`);
      fastDownUntil = Date.now() + 30000;
    }
  }
  return legacyFn();
}

const transport = {
  async status() {
    if (fastAvailable()) {
      try {
        const st = await rpc.status();
        return {...st, transport: 'tcp'};
      } catch (error) {
        // Only a transport-level failure may fall back to /eval. A request
        // timeout means the console's single RPC thread is wedged; /eval is
        // parked behind that same loop, so falling back there hung the bridge
        // for another 180 s and buried the real error.
        if (!/not reachable|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(error.message))
          throw error;
        log('rpc: status unavailable (' + error.message + '); using /eval for 30 s');
        fastDownUntil = Date.now() + 30000;
      }
    }
    return {...await legacy.status(), transport: 'eval'};
  },
  call: (offset, args) => withFast('call',
    async () => {
      const r = await rpc.call(offset, args);
      return {result: r.result.toString(), output: r.output.toString('base64')};
    },
    () => legacy.call(offset, args)),
  callAddress: (address, args) => withFast('call-address',
    async () => {
      const r = await rpc.callAddress(address, args);
      return {result: r.result.toString(), output: r.output.toString('base64')};
    },
    () => legacy.callAddress(address, args)),
  read: (address, length) => withFast('read',
    async () => ({data: (await rpc.read(address, length)).toString('base64')}),
    () => legacy.read(address, length)),
  write: (address, bytes) => withFast('write',
    async () => {
      await rpc.write(address, bytes);
      return {};
    },
    () => legacy.write(address, bytes)),
  query: address => withFast('query',
    async () => rpc.query(address),
    () => legacy.query(address)),
  verify: (address, hex) => withFast('verify',
    async () => rpc.verify(address, hex),
    () => legacy.verify(address, hex)),
};

// ------------------------------------------------------------------- dispatch
async function doCall(offset, args) { return transport.call(offset, args); }
async function doCallAddress(address, args) { return transport.callAddress(address, args); }
async function doRead(address, length) { return transport.read(address, length); }
async function doWrite(address, bytes) { return transport.write(address, bytes); }
async function doQuery(address) { return transport.query(address); }

async function doStartWorkers(workers) {
  if (!fastAvailable()) throw Error('workers require the TCP RPC transport');
  const started = await rpc.startWorkers(workers);
  if (started.length !== workers.length) throw Error('console started a different worker count');
  return {workers: started};
}

async function doJoinWorkers(workers) {
  if (!fastAvailable()) throw Error('workers require the TCP RPC transport');
  const joined = await rpc.joinWorkers(workers.map(w => w.index));
  if (joined.length !== workers.length) throw Error('console joined a different worker count');
  return {workers: joined.map(w => ({results: w.values.map(v => v.toString()),
    exitValue: w.exitValue.toString()}))};
}

async function dispatch(body) {
  switch (body.command) {
    case 'status': return {ready: true};
    case 'call': return doCall(body.offset, body.args);
    case 'call-address': return doCallAddress(body.address, body.args);
    case 'pair': {
      const results = [];
      let output = '';
      for (const c of body.calls || []) {
        const r = await doCall(c.offset, c.args);
        results.push(r.result);
        output = r.output;
      }
      return {results, output};
    }
    case 'read': return doRead(body.address, body.length);
    case 'write': return doWrite(body.address, Buffer.from(body.data || '', 'base64'));
    case 'query': return doQuery(body.address);
    case 'verify-function': return transport.verify(body.address, body.hex);
    case 'workers-start': return doStartWorkers(body.workers || []);
    case 'workers-join': return doJoinWorkers(body.workers || []);
    case 'rpc-stats': return {stats: rpc.stats, fast: fastAvailable(), port: RPC_PORT};
    case 'rpc-debug': {
      if (!fastAvailable()) throw Error('rpc-debug requires the TCP RPC transport');
      const reply = await rpc.request(Number(body.cmd), {a0: body.a0 || 0, a1: body.a1 || 0,
        a2: body.a2 || 0, a3: body.a3 || 0, a4: body.a4 || 0,
        payload: Buffer.from(body.hex || '', 'hex'),
        timeoutMs: Number(body.timeoutMs || 120000)});
      return {status: reply.status, aux: reply.aux.toString(), length: reply.payload.length,
        hex: reply.payload.toString('hex').slice(0, 512)};
    }
    case 'rpc-run': {
      if (!fastAvailable()) throw Error('rpc-run requires the TCP RPC transport');
      return {output: await rpc.run(body.source || '')};
    }
    case 'rpc-shutdown': {
      // Only ask over an existing console socket; otherwise the direct client
      // in rpc-tool can reach the loop (or report that a relaunch is required).
      if (!rpc.socket) return {stopped: false};
      await rpc.shutdown(Number(body.timeoutMs || 8000));
      return {stopped: true};
    }
    case 'prepare-worker': {
      const out = await consoleEval(PRE +
        `print(__rpc.prepare_worker('${body.call4}','${body.longjmp}'))\n`);
      const m = out.match(/^W (\d+) (\d+)$/m);
      if (!m) throw Error('bad prepare-worker reply: ' + out.slice(0, 200));
      return {call4: Number(m[1]), longjmp: Number(m[2])};
    }
    default: throw Error('unknown command: ' + body.command);
  }
}

let connection = null;
async function refresh() {
  const st = await transport.status();
  connection = {port: PORT, addresses: {sdk: st.sdk, main: st.main, scratch: st.scratch,
    platform: 2, session: st.session}, transport: st.transport};
  fs.writeFileSync(path.join(ENGINE, 'connection.json'), JSON.stringify(connection, null, 2) + '\n');
  return connection;
}

const server = http.createServer((req, res) => {
  const parts = [];
  req.on('data', p => parts.push(p));
  req.on('end', async () => {
    try {
      if (req.url === '/refresh') {
        const reply = await refresh();
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify(reply));
        return;
      }
      const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
      const reply = await dispatch(body);
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(reply));
    } catch (e) {
      log('request failed: ' + (e.stack || e));
      res.writeHead(500, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: e.message}));
    }
  });
});

const PID_FILE = path.join(__dirname, 'bridge.pid');
for (const signal of ['exit', 'SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
    if (signal !== 'exit') process.exit(0);
  });

(async () => {
  log('bridge starting (fast=' + FAST + ', rpc port ' + RPC_PORT + ')');
  fs.writeFileSync(PID_FILE, String(process.pid) + '\n');
  await refresh();
  server.listen(PORT, '127.0.0.1', () => log('READY ' + JSON.stringify(connection)));
  setInterval(async () => {
    try {
      await rpc.ping();
    } catch (error) {
      // ensure() will restart the console serve loop on the next request.
    }
  }, 20000).unref();
})().catch(e => {console.error(e.stack || e); process.exit(1);});
