// Read-only diagnostic: dump every fsp-srv server session in the pool and the
// request currently sitting in its buffer. Used to find the Loader's clone when
// it is neither of the two rows bound at boot.
const fs = require('node:fs/promises');
const path = require('node:path');
const {artifactDir} = require('../../shared/paths.cjs');
const OUT = artifactDir(__dirname);
const {connect} = require('../tools/fs-memory.cjs');
const {requestInfo, entries} = require('./launch.cjs');
const check = (ok, message) => { if (!ok) throw Error(message); };
const ptr = (b, o = 0) => Number(b.readBigUInt64LE(o));

function describe(hex) {
  try { return requestInfo(hex); }
  catch (error) { return {error: error.message}; }
}

async function main() {
  const memory = await connect();
  const session = memory.info.session;
  const read = name => fs.readFile(path.join(OUT, session + name)).then(JSON.parse);
  const layout = await read('-layout.json'), bound = await read('-bound-sessions.json');
  const boundByAddress = new Map(bound.rows.map(r => [r.address, r]));
  const bytes = await memory.read(layout.slots, 0x10000);
  const vptr = layout.holderVptr;
  const found = [];
  for (let o = 0; o + 0x88 <= bytes.length; o += 8) {
    if (Number(bytes.readBigUInt64LE(o)) !== vptr) continue;
    const domain = Number(bytes.readBigUInt64LE(o + 0x70));
    if (!domain) continue;
    found.push({address: layout.slots + o, domain});
  }
  console.log(JSON.stringify({session, report: memory.reportFile, slots: layout.slots,
    table: layout.table, count: layout.count, sessions: found.length}));
  const rows = [];
  for (const item of found) {
    const b = await memory.read(item.address, 0x88);
    const header = await memory.u32(ptr(b, 0x60));
    let info = null, text = null;
    if (header !== 0xffffffff) {
      text = (await memory.read(ptr(b, 0x60), 0x100)).toString('hex');
      info = describe(text);
    }
    let domainEntries = null, domainError = null;
    try { domainEntries = (await entries(memory, layout, item.domain)).length; }
    catch (error) { domainError = error.message; }
    const row = {
      address: item.address,
      bound: boundByAddress.has(item.address) ? (boundByAddress.get(item.address).domain === layout.targetDomain ? 'target' : 'own') : null,
      domain: item.domain,
      parent: ptr(b, 0x28),
      wait: b.readUInt32LE(0x30),
      state: b.readUInt32LE(0x40),
      receiveResult: b.readUInt32LE(0x44),
      receive: b.readUInt32LE(0x48),
      request: ptr(b, 0x60),
      metadata: ptr(b, 0x78),
      header: header === 0xffffffff ? 'ffffffff' : '0x' + header.toString(16),
      info,
      domainEntries,
      domainError
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  const interesting = rows.filter(r => r.info && (r.info.kind === 'control' || r.info.kind === 'request' || r.info.kind === 'close'));
  console.log(JSON.stringify({interesting: interesting.length, rows: interesting}));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
