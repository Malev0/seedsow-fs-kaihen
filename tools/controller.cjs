'use strict';
// Controller bridge client — the only place the GUI talks to a controller.
//
// Any controller (Pico W, ESP32, a PC applet, a phone) can drive the console by
// serving this small HTTP API. Nothing here is specific to one implementation:
// the bridge only has to accept these calls and press buttons.
//
// Connection file (JSON, one per machine):
//   {"host": "127.0.0.1", "port": 39391, "token": "optional"}
// Path: NS2_CONTROLLER_CONN, else <repo>/controller-connection.json, else
// <repo>/tools/seedsow-connection.json (the older Pico name, still accepted).
//
// API (all JSON; Authorization: Bearer <token> is sent only when the file has a
// non-empty token):
//   GET  /status
//        -> {"ok": true, "controller": "ready" | "unknown"}
//   POST /press   {"buttons": ["A", ...]}
//        -> {"ok": true, "confirmed": true}
//   POST /release {"buttons": ["A", ...]}
//        -> {"ok": true}
//   POST /tap     {"buttons": ["A", ...], "down": 0.12, "up": 0.16}
//        -> {"ok": true, "confirmed": true}
//   POST /sequence {"steps": [{"buttons": ["A"], "hold": 0.15, "gap": 1.0}, ...]}
//        -> {"ok": true, "confirmed": true}
//   POST /stop
//        -> {"ok": true}
//
// `down`/`up`/`hold`/`gap` are seconds. `confirmed` is optional: when a bridge
// reports false the GUI warns that the press was queued but not acknowledged.
// Buttons are the Switch names: A B X Y L R ZL ZR PLUS MINUS HOME CAPTURE
// L_STICK R_STICK DPAD_UP DPAD_DOWN DPAD_LEFT DPAD_RIGHT.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUTTONS = new Set(['A', 'B', 'X', 'Y', 'L', 'R', 'ZL', 'ZR', 'PLUS', 'MINUS',
  'HOME', 'CAPTURE', 'L_STICK', 'R_STICK', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT']);

function connectionFile() {
  const candidates = [
    process.env.NS2_CONTROLLER_CONN,
    process.env.NS2_PICO_CONN,
    path.join(ROOT, 'controller-connection.json'),
    path.join(ROOT, 'tools', 'seedsow-connection.json'),
  ].filter(Boolean);
  for (const file of candidates) if (fs.existsSync(file)) return file;
  throw Error('no controller connection file; copy controller-connection.example.json to ' +
    'controller-connection.json and set host/port/token (looked for ' +
    candidates.join(', ') + ')');
}

function connection() {
  const file = connectionFile();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw Error(`cannot read ${file} (${error.message})`); }
  if (!raw || typeof raw !== 'object') throw Error(`${file} is not a JSON object`);
  // The token is optional. A controller that is only reachable from this PC
  // (127.0.0.1) does not need one; a bridge on the LAN can set one and this
  // client will send it. Nothing is required in the file beyond host/port.
  return {host: raw.host || '127.0.0.1', port: Number(raw.port) || 39391,
    token: typeof raw.token === 'string' ? raw.token : '', file};
}

async function call(pathname, body, timeoutMs = 15000) {
  const {host, port, token} = connection();
  const init = {method: body === undefined ? 'GET' : 'POST', headers: {},
    signal: AbortSignal.timeout(timeoutMs)};
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(`http://${host}:${port}${pathname}`, init);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* a bridge may answer with plain text */ }
  if (!res.ok) throw Error(`${pathname}: ${data && data.error ? data.error : `HTTP ${res.status}`}`);
  return data || {};
}

function names(buttons) {
  const list = (Array.isArray(buttons) ? buttons : [buttons])
    .map(value => String(value || '').toUpperCase()).filter(Boolean);
  if (!list.length || list.length > 8) throw Error('expected 1..8 buttons');
  const unknown = list.find(name => !BUTTONS.has(name));
  if (unknown) throw Error('unknown button ' + unknown);
  return list;
}

const seconds = (value, fallback, min, max) => {
  const n = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(n) && n > 0 ? n : fallback));
};

module.exports = {
  BUTTONS,
  connection,
  status: () => call('/status'),
  press: buttons => call('/press', {buttons: names(buttons)}),
  release: buttons => call('/release', {buttons: names(buttons)}),
  tap: (buttons, down = 0.12, up = 0.16) =>
    call('/tap', {buttons: names(buttons), down: seconds(down, 0.12, 0.04, 5),
      up: seconds(up, 0.16, 0, 5)}),
  sequence: steps => {
    if (!Array.isArray(steps) || !steps.length || steps.length > 64)
      throw Error('a sequence needs 1..64 steps');
    return call('/sequence', {steps: steps.map(step => ({
      buttons: names(step.buttons ?? step.button),
      hold: seconds(step.hold ?? step.down, 0.15, 0.04, 5),
      gap: seconds(step.gap ?? step.wait, 0, 0, 60),
    }))});
  },
  stop: () => call('/stop', {}),
};
