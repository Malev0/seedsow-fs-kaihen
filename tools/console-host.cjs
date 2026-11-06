// Resolve the console address: NS2_CONSOLE env, else console-host.txt, else the
// historical LAN address. The Switch's IP changes with the network (hotspot vs LAN).
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'console-host.txt');
const DEFAULT = '192.168.1.50';

function consoleHost() {
  if (process.env.NS2_CONSOLE) return process.env.NS2_CONSOLE.trim();
  try {
    const text = fs.readFileSync(FILE, 'utf8').split(/\r?\n/)[0].trim();
    if (text) return text;
  } catch { /* no file */ }
  return DEFAULT;
}

module.exports = {consoleHost, FILE, DEFAULT};
