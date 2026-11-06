#!/usr/bin/env node
// Receive a worker-side dump from the console over TCP.
//
// The flags-0 launch holds the launcher shim, so the host cannot read the
// slot-2 worker's app-memory buffer. The worker opens its own socket and sends
// the captured window here instead. Run this before pressing Start:
//
//   node tools/dump-listener.cjs
//
// The console connects to this PC's LAN IPv4 on NS2_DUMP_PORT (default 39401).
// Set NS2_DUMP_HOST in gui/env.txt if the auto-detected PC address is wrong.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.NS2_DUMP_PORT || 39401);
const dir = path.join(__dirname, '..');

const server = net.createServer(socket => {
  const from = socket.remoteAddress;
  const chunks = [];
  console.log(JSON.stringify({at: new Date().toISOString(), connected: from,
    remotePort: socket.remotePort}));
  socket.on('data', chunk => chunks.push(chunk));
  socket.on('end', () => {
    const bytes = Buffer.concat(chunks);
    // The GUI preflights the listener with a bare connect; do not save that.
    if (!bytes.length) return;
    const out = process.env.NS2_DUMP_FILE ||
      path.join(dir, 'dump-' + Date.now() + '.bin');
    fs.writeFileSync(out, bytes);
    console.log(JSON.stringify({at: new Date().toISOString(), from,
      bytes: bytes.length, file: out}));
  });
  socket.on('close', () => console.log(JSON.stringify({at: new Date().toISOString(),
    closed: from, bytes: Buffer.concat(chunks).length})));
  socket.on('error', error => console.error('dump socket:', error.message));
});

server.on('error', error => {
  console.error('dump listener:', error.message);
  process.exitCode = 1;
});
server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({listening: port,
  file: process.env.NS2_DUMP_FILE || 'dump-<timestamp>.bin (per connection)'})));
