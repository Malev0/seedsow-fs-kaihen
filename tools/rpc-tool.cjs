#!/usr/bin/env node
// CLI for the Seedsow console RPC.
//   ping | status | run <file.lua>   -> bridge HTTP first (the console serves one
//                                       client at a time), then a direct socket
//   stop                              -> direct socket only (frees the /eval queue)
//   stop-all                          -> stop the local bridge, then stop the console loop
const fs = require('node:fs');
const http = require('node:http');
const {execFileSync} = require('node:child_process');
const {ConsoleRpc} = require('./console-rpc.cjs');

const HOST = require('./console-host.cjs').consoleHost();
const PORT = Number(process.env.NS2_RPC_PORT || 39380);
const BRIDGE = Number(process.env.NS2_BRIDGE_PORT || 31337);

function bridgeRequest(body, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({host: '127.0.0.1', port: BRIDGE, path: '/', method: 'POST',
      headers: {'content-type': 'application/json', 'content-length': data.length}}, res => {
      const parts = [];
      res.on('data', p => parts.push(p));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        try {
          const value = JSON.parse(text);
          if (res.statusCode !== 200) return reject(Error(value.error || text));
          resolve(value);
        } catch (error) {reject(error);}
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(Error('bridge request timed out')));
    req.end(data);
  });
}

const PID_FILE = require('node:path').join(__dirname, 'bridge.pid');
const WIN = process.platform === 'win32';

function isBridgePid(pid) {
  try {
    // PowerShell is Windows-only; the setup and stop scripts run on all three
    // platforms, so ask ps elsewhere. Both return the full command line.
    const command = WIN
      ? execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue).CommandLine`],
      {encoding: 'utf8', timeout: 5000})
      : execFileSync('ps', ['-p', String(pid), '-o', 'command='], {encoding: 'utf8', timeout: 5000});
    return /seedsow-bridge/i.test(command);
  } catch { return false; }
}

function stopBridge() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()); } catch { /* no pid file */ }
  if (pid) {
    // A crashed bridge leaves bridge.pid behind; the PID can be reused. Never
    // kill an unrelated process just because it inherited that number.
    let killed = false;
    if (isBridgePid(pid)) {
      try { process.kill(pid); killed = true; console.error('stopped bridge pid ' + pid);} catch (error) {
        console.error('bridge pid ' + pid + ': ' + error.message);
      }
    } else {
      console.error('stale bridge.pid ' + pid + ' (not a seedsow-bridge process); ignoring');
    }
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    if (killed) return;
  }
  // Fallback: whoever listens on the bridge port.
  try {
    if (WIN) {
      execFileSync('powershell', ['-NoProfile', '-Command',
        "Get-NetTCPConnection -LocalPort " + BRIDGE +
        " -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"],
      {stdio: 'pipe', timeout: 15000});
    } else {
      const pids = execFileSync('lsof', ['-ti', 'tcp:' + BRIDGE, '-sTCP:LISTEN'],
        {encoding: 'utf8', timeout: 15000}).split(/\s+/).filter(Boolean);
      for (const pid of pids) { try { process.kill(Number(pid)); } catch { /* already gone */ } }
    }
  } catch { /* no bridge */ }
}

async function stopLoop(timeoutMs) {
  const rpc = new ConsoleRpc({host: HOST, port: PORT, serveSeconds: 0, startServer: false,
    log: m => console.error(m)});
  try {
    await rpc.shutdown(timeoutMs);
  } catch (error) {
    console.error('console loop: ' + error.message);
  } finally {rpc.close();}
}

// The bridge holds the console's only RPC socket. A direct stop attempt is
// queued behind it and cannot be accepted until the bridge disconnects, so try
// the bridge's own shutdown first.
async function bridgeStop(timeoutMs = 8000) {
  try {
    const reply = await bridgeRequest({command: 'rpc-shutdown', timeoutMs}, timeoutMs + 7000);
    if (!reply.stopped) console.error('bridge has no console RPC socket; trying a direct stop');
    return reply.stopped === true;
  } catch (error) {
    console.error('bridge stop: ' + error.message);
    return false;
  }
}

// rpc-stats alone only proves the local bridge is alive. A ping must reach the
// console, otherwise a wedged native call is reported as healthy.
async function bridgePing(token = 0x1234) {
  const reply = await bridgeRequest({command: 'rpc-debug', cmd: 10, a0: token, timeoutMs: 5000}, 10000);
  if (reply.status !== 0 || reply.aux !== String(token)) throw Error('console did not answer the ping');
  return reply;
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'ping' || cmd === 'status') {
      if (cmd === 'status') {
        try {console.log('bridge', JSON.stringify(await bridgeRequest({command: 'rpc-stats'}, 15000)));}
        catch (error) {console.error('bridge: ' + error.message);}
      }
      try {
        const reply = await bridgePing();
        console.log(cmd === 'ping' ? 'pong (console via bridge)' : 'console pong ' + JSON.stringify(reply));
      } catch (error) {
        const rpc = new ConsoleRpc({host: HOST, port: PORT, serveSeconds: 0, startServer: false,
          log: m => console.error(m)});
        try {
          if (cmd === 'ping') console.log('pong', await rpc.ping(0x1234, 3000));
          else console.log(JSON.stringify(await rpc.status()));
        } finally {rpc.close();}
      }
    } else if (cmd === 'run') {
      if (!arg) throw Error('usage: rpc-tool.cjs run <file.lua>');
      const source = fs.readFileSync(arg, 'utf8');
      try {
        const reply = await bridgeRequest({command: 'rpc-run', source});
        console.log(reply.output);
      } catch (error) {
        const rpc = new ConsoleRpc({host: HOST, port: PORT, serveSeconds: 0, startServer: false,
          log: m => console.error(m)});
        try {console.log(await rpc.run(source));} finally {rpc.close();}
      }
    } else if (cmd === 'stop') {
      if (await bridgeStop(8000)) console.log('stopped (bridge)');
      else {await stopLoop(8000); console.log('stopped');}
    } else if (cmd === 'stop-all') {
      // Graceful first. The console's serve loop lives inside the launcher's
      // /eval handler, so killing the bridge while it waits for a frame leaves
      // that handler parked (and /eval dead) until its idle deadline. Ask the
      // bridge to shut the loop down, then kill the bridge.
      let graceful = false;
      try { graceful = await bridgeStop(8000); } catch { graceful = false; }
      if (graceful) console.log('console loop stopped (bridge)');
      else console.error('graceful stop unavailable; killing the bridge');
      stopBridge();
      await new Promise(resolve => setTimeout(resolve, 400));
      if (!graceful) await stopLoop(4000);
      console.log('stopped');
    } else {
      console.log('usage: rpc-tool.cjs ping|status|run <file.lua>|stop|stop-all');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error('rpc error:', error.message);
    process.exitCode = 1;
  }
})();
