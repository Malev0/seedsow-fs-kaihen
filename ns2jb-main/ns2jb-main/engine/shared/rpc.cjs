const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const connectionFile = path.join(__dirname, '..', 'connection.json');
let connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
const addresses = connection.addresses;

// The controller GUI is long-lived and the bridge rewrites connection.json on
// every fresh exploit boot. Re-read it per request so an in-process savekit or
// game list never uses the previous boot's scratch/sdk addresses.
function refresh() {
  try {
    const next = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
    Object.assign(addresses, next.addresses);
    connection = next;
  } catch { /* keep the last good connection */ }
  return connection;
}

function request(body) {
  const current = refresh();
  const timeoutMs = Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : 180000;
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: current.port, path: '/', method: 'POST',
      headers: {'content-type': 'application/json'}}, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(parts));
          if (res.statusCode !== 200) throw Error(value.error || 'Native bridge failed');
          resolve(value);
        } catch (error) {reject(error);}
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Error('Native request timed out; it was not replayed')));
    req.on('error', reject);
    req.end(JSON.stringify(body, (_, value) => typeof value === 'bigint' ? value.toString() : value));
  });
}

async function call(offset, args) {
  const reply = await request({command: 'call', offset, args});
  return {result: BigInt(reply.result), output: Buffer.from(reply.output, 'base64')};
}
async function pair(calls) {
  const reply = await request({command: 'pair', calls});
  return {results: reply.results.map(BigInt), output: Buffer.from(reply.output, 'base64')};
}
async function callAddress(address, args) {
  const reply = await request({command: 'call-address', address, args});
  return {result: BigInt(reply.result), output: Buffer.from(reply.output, 'base64')};
}
async function read(address, length, timeoutMs) {
  if (!Number.isSafeInteger(address) || !Number.isInteger(length) || length < 0 || length > 0x4000000)
    throw Error('Invalid memory transfer');
  const parts = [];
  for (let offset = 0; offset < length; offset += 0x80000) {
    const size = Math.min(0x80000, length - offset);
    // A caller that polls app memory while the console may be busy passes its
    // own deadline; the default 180 s would otherwise dominate the run.
    const body = {command: 'read', address: address + offset, length: size};
    if (Number(timeoutMs) > 0) body.timeoutMs = Number(timeoutMs);
    const bytes = Buffer.from((await request(body)).data, 'base64');
    if (bytes.length !== size) throw Error('Memory read was truncated');
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}
async function write(address, bytes) {
  if (!Number.isSafeInteger(address) || !Buffer.isBuffer(bytes) || bytes.length > 0x4000000)
    throw Error('Invalid memory transfer');
  for (let offset = 0; offset < bytes.length; offset += 0x80000)
    await request({command: 'write', address: address + offset,
      data: bytes.subarray(offset, offset + 0x80000).toString('base64')});
}
async function say(text) {
  return request({command: 'say', text: String(text)});
}
async function query(address) {
  const result = await request({command: 'query', address});
  return {...result, result: 0, address: Number(result.address), size: Number(result.size)};
}
// Console-side worker build/launch (n2h_rpc.lua R.start_workers). Workers are
// addressed by the console-assigned index for the matching join.
async function startWorkers(workers) {
  const reply = await request({command: 'workers-start', workers});
  return reply.workers;
}
async function joinWorkers(workers) {
  const reply = await request({command: 'workers-join', workers});
  return reply.workers;
}

module.exports = {request, call, callAddress, pair, read, write, query, say,
  startWorkers, joinWorkers, a: addresses, refresh,
  get output() { return addresses.scratch + 0x4040; },
  get directory() { return path.resolve(__dirname, '..', 'switch' + addresses.platform); }};
