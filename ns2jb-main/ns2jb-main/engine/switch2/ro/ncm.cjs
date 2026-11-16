// Read-only enumeration of installed content metadata.
// This is a bounded NCM IPC query, never a raw NAND or generic memory read.
const fs = require('node:fs/promises');
const path = require('node:path');
const {artifactDir} = require('../../shared/paths.cjs');
const OUT = artifactDir(__dirname);
const crypto = require('node:crypto');
const check = (ok, message) => {if (!ok) throw Error(message);};
const CAPACITY = 1024;
const KEY_SIZE = 16;

// NcmStorageId on this build: 3 = built-in system, 4 = built-in user,
// 5 = SD card, 2 = game card. NcmContentMetaType: 0 = application,
// 1 = system program (also patch/DLC values in the same byte).
function listInput(metaType = 1, installType = 0) {
  const data = Buffer.alloc(32);
  data[0] = metaType;
  data[1] = installType;
  data.writeBigUInt64LE(0xffffffffffffffffn, 24);
  return data;
}

function parse(reply, bytes, metaType = 1, installType = 0) {
  check(!reply.result && reply.data.length >= 8, 'NCM list returned an error or short reply');
  const total = reply.data.readInt32LE(0), written = reply.data.readInt32LE(4);
  check(total >= 0 && written >= 0 && written <= CAPACITY && written <= total &&
    bytes.length === CAPACITY * KEY_SIZE, 'NCM list count or output buffer is invalid');
  const keys = [];
  for (let i = 0; i < written; i++) {
    const at = i * KEY_SIZE;
    check(bytes[at + 12] === metaType && bytes[at + 13] === installType,
      'NCM returned an unexpected metadata/install type');
    keys.push({id: '0x' + bytes.readBigUInt64LE(at).toString(16).padStart(16, '0'),
      version: bytes.readUInt32LE(at + 8), type: metaType, installType});
  }
  check(new Set(keys.map(item => item.id)).size === keys.length, 'NCM returned duplicate title IDs');
  return {total, written, complete: total === written, keys};
}

async function list(context, request, state) {
  const {s, live, save} = context;
  const handle = Number(request.handle);
  const storage = Number(request.storage ?? 3);
  const metaType = Number(request.metaType ?? 1);
  const installType = Number(request.installType ?? 0);
  check(Number.isInteger(storage) && storage >= 0 && storage <= 5, 'Invalid NCM storage');
  check(Number.isInteger(metaType) && metaType >= 0 && metaType <= 0xff, 'Invalid NCM meta type');
  check(Number.isInteger(installType) && installType >= 0 && installType <= 0xff, 'Invalid NCM install type');
  const dumpDirectory = request.dumpDirectory || process.env.NS2_FIRMWARE_DUMP_DIR;
  check(!request.dumpOutput || dumpDirectory && path.isAbsolute(dumpDirectory),
    'Firmware inventory requires a dedicated output directory');
  check(state.services?.some(item => item.name === 'ncm' && item.handle === handle) && s.handles.has(handle) &&
    !s.threads.size, 'NCM enumeration requires an owned service and idle native worker');
  const opened = await s.ipc('NCM OpenContentMetaDatabase ' + storage, handle, 5, Buffer.from([storage]));
  check(!opened.result && opened.moves.length === 1 && !opened.copies.length,
    'NCM storage ' + storage + ' database did not open');
  const database = opened.moves[0], address = s.base + 0x4000;
  const length = CAPACITY * KEY_SIZE;
  let safeToClose = false;
  try {
    check(address + length <= s.base + s.bytes, 'Owned NCM output allocation is too small');
    await s.write(address, Buffer.alloc(length));
    const reply = await s.ipc('NCM List ' + storage + '/' + metaType + '/' + installType, database, 5,
      listInput(metaType, installType), {receive: [{address, size: length, mode: 0}]});
    const bytes = await s.readOwned(address, length);
    safeToClose = true;
    const listed = parse(reply, bytes, metaType, installType);
    const rawFile = request.dumpOutput ?
      path.join(dumpDirectory, 'ncm-' + storage + '-' + metaType + '-' + installType + '.bin') :
      path.join(OUT, live.session + '-ncm-' + storage + '-' + metaType + '-' + installType + '.bin');
    await fs.writeFile(rawFile, bytes, {flag: 'wx', mode: 0o600});
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const result = {at: new Date().toISOString(), storage, metaType, installType, ...listed, rawFile, sha256};
    (state.ncmInventories ||= []).push(result);
    await save();
    return result;
  } finally {
    if (safeToClose) await s.close(database);
  }
}

async function listSystem(context, request, state) {
  return list(context, request, state);
}

module.exports = {listInput, parse, list, listSystem};
