'use strict';
// The console's launcher HTTP server: POST /eval runs a Lua chunk, PUT /save
// writes a file into the save. Both are only used during setup, before the RPC
// bridge is up.
//
// This used to be Python (urllib). It is Node now because `python` on PATH is
// frequently an MSYS2/msys build (devkitPro ships one) that rewrites a Windows
// path like C:\... into a POSIX path and then cannot open it, which broke setup
// on machines that had never noticed which python they had.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const TOOLS = __dirname;
const ROOT = path.join(TOOLS, '..');

function consoleHost() {
  const fromEnv = (process.env.NS2_CONSOLE || '').trim();
  if (fromEnv) return fromEnv;
  for (const file of [path.join(TOOLS, 'console-host.txt'),
    path.join(ROOT, 'tools', 'console-host.txt')]) {
    try {
      const first = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
      if (first) return first;
    } catch { /* try the next one */ }
  }
  throw Error('no console address: put it in tools/console-host.txt ' +
    '(copy tools/console-host.example.txt) or set NS2_CONSOLE');
}

function request(method, pathname, body, timeoutMs = 60000) {
  const host = consoleHost();
  return new Promise((resolve, reject) => {
    const req = http.request({host, port: 8080, path: pathname, method,
      headers: {'content-type': 'text/plain', 'content-length': body.length}},
    res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        if (res.statusCode !== 200) return reject(Error(`${method} ${pathname}: HTTP ${res.statusCode} ${text.slice(0, 200).trim()}`));
        resolve(text);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Error(`${method} ${pathname}: no answer in ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

// Run a Lua file on the console. The launcher answers with whatever it printed.
async function evalFile(file) {
  return request('POST', '/eval', fs.readFileSync(file));
}

// Write one file into the console's save. http.lua's REQ_CAP is 0x8000
// (32,768) on this save; report an oversized body clearly instead of a bare 413.
async function uploadSave(file, name) {
  const bytes = fs.readFileSync(file);
  if (bytes.length > 32768)
    throw Error(`${name} is ${bytes.length} bytes; the save upload limit is 32768`);
  return request('PUT', '/save?path=' + encodeURIComponent(name), bytes, 20000);
}

module.exports = {consoleHost, evalFile, uploadSave, ROOT, TOOLS};
