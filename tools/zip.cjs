'use strict';
// Cross-platform download and ZIP extraction with no external dependencies.
//
// Node has zlib but no ZIP reader, and the release assets are ZIPs on every
// platform. Keeping this here means the GUI and the CLI use the same code on
// Windows, Linux and macOS instead of shelling out to Expand-Archive/unzip.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const UA = 'seedsow-fs-kaihen-updater/1.1 (+https://github.com/Malev0/seedsow-fs-kaihen)';

async function download(url, destination, options = {}) {
  const timeout = Number(options.timeout || 10 * 60 * 1000);
  const response = await fetch(url, {
    headers: {'user-agent': UA, ...(options.headers || {})},
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok)
    throw Error(`download failed: HTTP ${response.status} ${response.statusText} (${url})`);
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  let total = Number(response.headers.get('content-length')) || Number(options.totalHint) || 0;
  const hash = crypto.createHash('sha256');
  let received = 0;
  const progress = () => {
    if (typeof options.onProgress === 'function')
      options.onProgress({phase: 'downloading', received, total,
        percent: total ? Math.min(100, Math.round(received / total * 100)) : 0});
  };

  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(destination, bytes);
    hash.update(bytes);
    received = bytes.length;
    if (!total) total = received;
    progress();
    return {url, file: destination, bytes: received, sha256: hash.digest('hex')};
  }

  const out = fs.createWriteStream(destination);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) {
        await new Promise((resolve, reject) => {
          const onDrain = () => { out.off('error', onError); resolve(); };
          const onError = error => { out.off('drain', onDrain); reject(error); };
          out.once('drain', onDrain);
          out.once('error', onError);
        });
      }
      progress();
    }
    await new Promise((resolve, reject) => {
      out.once('error', reject);
      out.end(resolve);
    });
  } catch (error) {
    out.destroy();
    throw error;
  }
  return {url, file: destination, bytes: received, sha256: hash.digest('hex')};
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {'user-agent': UA, accept: 'application/vnd.github+json',
      ...(options.headers || {})},
    redirect: 'follow',
    signal: AbortSignal.timeout(Number(options.timeout || 60000)),
  });
  if (!response.ok)
    throw Error(`HTTP ${response.status} ${response.statusText} (${url})`);
  return response.json();
}

async function getText(url, options = {}) {
  const response = await fetch(url, {
    headers: {'user-agent': UA, ...(options.headers || {})},
    redirect: 'follow',
    signal: AbortSignal.timeout(Number(options.timeout || 60000)),
  });
  if (!response.ok)
    throw Error(`HTTP ${response.status} ${response.statusText} (${url})`);
  return response.text();
}

function findEndOfCentralDirectory(bytes) {
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= earliest; at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) return at;
  }
  throw Error('not a ZIP file (no end-of-central-directory record)');
}

function safeTarget(destination, name) {
  const clean = String(name).replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean))
    throw Error(`ZIP entry has an absolute path: ${name}`);
  const parts = clean.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..'))
    throw Error(`ZIP entry escapes the extraction folder: ${name}`);
  const target = path.resolve(destination, ...parts);
  if (target !== destination && !target.startsWith(destination + path.sep))
    throw Error(`ZIP entry escapes the extraction folder: ${name}`);
  return {target, parts, isDirectory: clean.endsWith('/')};
}

function extract(zipFile, destination) {
  const bytes = fs.readFileSync(zipFile);
  const eocd = findEndOfCentralDirectory(bytes);
  const entries = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    throw Error('ZIP64 archives are not supported by this updater');
  if (directoryOffset + directorySize > bytes.length)
    throw Error('ZIP central directory is outside the file');

  fs.mkdirSync(destination, {recursive: true});
  const root = path.resolve(destination);
  const files = [];
  let at = directoryOffset;
  for (let index = 0; index < entries; index++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50)
      throw Error('ZIP central directory entry is malformed');
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const uncompressedSize = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const externalAttributes = bytes.readUInt32LE(at + 38);
    const localOffset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;

    const entry = safeTarget(root, name);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const isDirectory = entry.isDirectory || (unixMode & 0o170000) === 0o040000;
    if (isDirectory) {
      fs.mkdirSync(entry.target, {recursive: true});
      continue;
    }

    if (bytes.readUInt32LE(localOffset) !== 0x04034b50)
      throw Error(`ZIP local header is malformed for ${name}`);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    if (compressed.length !== compressedSize)
      throw Error(`ZIP entry is truncated: ${name}`);

    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw Error(`ZIP compression method ${method} is not supported (${name})`);
    if (data.length !== uncompressedSize)
      throw Error(`ZIP entry size mismatch: ${name}`);

    fs.mkdirSync(path.dirname(entry.target), {recursive: true});
    fs.writeFileSync(entry.target, data);
    if (process.platform !== 'win32') {
      const mode = unixMode & 0o777;
      if (mode) {
        try { fs.chmodSync(entry.target, mode); } catch {}
      }
    }
    files.push(path.relative(root, entry.target).split(path.sep).join('/'));
  }
  return {file: zipFile, directory: root, entries, files};
}

module.exports = {download, getJson, getText, extract, safeTarget};
