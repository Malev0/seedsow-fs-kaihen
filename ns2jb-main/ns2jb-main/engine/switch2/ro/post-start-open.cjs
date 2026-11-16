'use strict';

// Post-start code-filesystem redirect.
//
// The Loader/ldr mounts the program's code filesystem again after the
// suspended replacement is resumed, then opens files on that mount (17:38:
// `cmd 2` mount, then a file open). The mount entry is the class-compatible
// exchange point kaiHEN uses: replace its `+0x20` object with the kaiHEN
// package object, which serves both `main` and `main.npdm`.
//
// Do NOT redirect individual file objects here. The first file read after the
// mount is `main.npdm` (ldr reads it for `GetProgramInfo`); pointing that IFile
// at the donor `/main` makes ldr return `0x809` (`Ldr/InvalidMeta`) and the
// start fails before the Loader runs (17:38 run).
const fs = require('node:fs/promises');
const path = require('node:path');
const {artifactDir} = require('../../shared/paths.cjs');
const OUT = artifactDir(__dirname);
const {connect} = require('../tools/fs-memory.cjs');
const {Gate} = require('./gate.cjs');
const {exportHandle} = require('./export-handle.cjs');
const {entries, requestInfo} = require('./launch.cjs');

const check = (ok, message) => { if (!ok) throw Error(message); };
const ptr = (b, o = 0) => Number(b.readBigUInt64LE(o));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readLocal(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function watch(memoryOverride = null, options = {}) {
  const watchMode = Boolean(options.watchMode);
  const memory = memoryOverride || await connect();
  const stopped = () => {
    if (options.signal?.aborted) throw Error('Post-start watcher stopped');
  };
  const local = suffix => path.join(OUT, memory.info.session + suffix);
  const layout = await readLocal(local('-layout.json'));
  const root = await readLocal(local('-loader-root-copy.json'));
  const bound = await readLocal(local('-bound-sessions.json'));
  const event = await readLocal(local('-gate-event.json'));
  const types = await readLocal(local('-filesystem-types.json'));
  const state = await memory.request({command: 'root-native-info'});
  const donor = types.rows?.find(item => item.name === 'donor');
  check(donor?.object > 2 ** 32 && donor?.vptr > 2 ** 32 && donor.metadata,
    'Post-start redirect has no donor package filesystem proof');
  check(root.report === memory.reportFile && bound.report === memory.reportFile &&
    event.report === memory.reportFile && root.verified && event.verified,
    'Post-start gate proofs belong to another acquisition');

  const mode = process.env.NS2_POST_START_SWAP || 'mount';
  check(['mount', 'impl', 'entry', 'observe'].includes(mode), 'Unsupported NS2_POST_START_SWAP');

  const row = bound.rows.find(item => item.domain === root.targetDomain);
  check(row, 'The Loader target server binding is missing');
  const server = await exportHandle(memory, row.receive, 'Post-start Loader server');
  const waitReady = await exportHandle(memory, row.wait, 'Post-start Loader wait')
    .catch(error => ({error: error.message}));
  const gate = new Gate(memory, row, state.apiWorkers, bound.waiters,
    server.handle, event, waitReady.handle ?? null);
  const file = options.file || process.env.NS2_POST_START_FILE || local('-post-start-main.json');
  const swap = state.mainSwap || null;
  const proof = {
    session: memory.info.session, report: memory.reportFile,
    started: new Date().toISOString(), target: '0x0400000000000037',
    mode, donor: {entry: donor.entry, object: donor.object, vptr: donor.vptr.toString(16)},
    requests: [], mounts: [], swapped: false,
    watchMode: watchMode ? 'armed-before-activation' : 'standalone',
  };
  const save = async () => {
    proof.gateTrace = gate.snapshot();
    await fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  };
  let parked = false;
  try {
    await save();
    await gate.parkSession();
    parked = true;
    proof.armed = true;
    proof.armedAt = new Date().toISOString();
    await save();
    if (typeof options.onArmed === 'function') await options.onArmed({...proof});
    const deadline = Date.now() + Math.max(1000,
      Number(process.env.NS2_POST_START_OPEN_MS || 60000));
    proof.deadline = new Date(deadline).toISOString();
    proof.polls = 0;
    let followUntil = 0;
    const swappedObjects = new Set();
    while (Date.now() < deadline) {
      stopped();
      if (followUntil && Date.now() > followUntil) break;
      proof.polls++;
      const readiness = await gate.pendingSnapshot();
      if (!readiness.pending || readiness.empty) { await delay(25); continue; }
      const pending = await gate.peek();
      if (!pending) { await delay(25); continue; }
      let info;
      try { info = requestInfo(pending.request); }
      catch (error) { info = {error: error.message}; }
      const request = {at: new Date().toISOString(), info, raw: pending.request};
      proof.requests.push(request); await save();
      const before = await entries(memory, layout, root.targetDomain);
      // Native step() lets the FS process the queued request; stepServe() only
      // acknowledges it and does not create the objects the Loader will use.
      const served = await gate.step();
      let nextInfo = null;
      if (served.request) {
        try { nextInfo = requestInfo(served.request); }
        catch (error) { nextInfo = {error: error.message}; }
      }
      request.served = {empty: !!served.empty, injected: served.injected !== false,
        attempts: served.attempts?.length ?? null, next: nextInfo};
      const after = await entries(memory, layout, root.targetDomain);
      request.removed = before.filter(old => !after.some(item =>
        item.entry === old.entry && item.object === old.object));
      request.added = after.filter(item => !before.some(old =>
        old.entry === item.entry && old.object === item.object));
      await save();
      if (served.empty) continue;

      // ---- Default: exchange the freshly mounted code filesystem. ----------
      // The new mount entry has the donor's concrete filesystem class and
      // metadata. The donor package serves `main.npdm` (captured stock policy)
      // and `main` (kaiHEN), so the later opens resolve to the right bytes
      // without touching individual files.
      if (mode === 'mount') {
        let exchanged = false;
        for (const item of request.added) {
          if (item.entry === donor.entry || item.object === donor.object) continue;
          const vptr = await memory.pointer(item.object).catch(() => 0);
          if (vptr !== donor.vptr) continue;
          const owner = await memory.pointer(item.entry + 0x20).catch(() => 0);
          if (owner !== item.object) continue;
          const metadata = await memory.read(item.entry + 0x28, 8);
          if (Number(metadata.readBigUInt64LE()) !== donor.metadata) continue;
          await memory.writeU64(item.entry + 0x20, item.object, donor.object);
          const afterExchange = await memory.pointer(item.entry + 0x20);
          const record = {at: new Date().toISOString(), entry: item.entry,
            before: item.object, after: afterExchange, donor: donor.object,
            took: afterExchange === donor.object};
          proof.mounts.push(record);
          request.mountExchange = record;
          if (record.took) {
            proof.swapped = true;
            exchanged = true;
            swappedObjects.add(item.object);
            await save();
            break;
          }
        }
        if (exchanged) {
          proof.completed = new Date().toISOString();
          if (!followUntil)
            followUntil = Date.now() +
              Math.max(1000, Number(process.env.NS2_POST_START_FOLLOW_MS || 10000));
          await save();
          continue;
        }
        continue;
      }

      if (mode === 'observe') continue;

      // ---- Experimental: redirect one file object (same class only). -------
      const wrapperVptr = swap?.content?.wrapperVptr &&
        String(swap.content.wrapperVptr).replace(/^0x/i, '').toLowerCase();
      if (!swap?.source?.impl || !wrapperVptr) continue;
      let wrapper = null;
      const candidates = [];
      for (const item of after) {
        if (item.object === swap.source.object) continue;
        const vptr = await memory.pointer(item.object).catch(() => 0);
        const summary = {...item, vptr: vptr ? vptr.toString(16) : null};
        candidates.push(summary);
        if (!wrapper && !swappedObjects.has(item.object) && vptr &&
            vptr.toString(16).toLowerCase() === wrapperVptr) wrapper = item;
      }
      request.wrapperCandidates = candidates;
      request.wrapperFound = Boolean(wrapper);
      await save();
      if (!wrapper) continue;
      if (typeof options.beforeSwap === 'function') {
        const approval = await options.beforeSwap({request, wrapper, proof});
        if (approval === false || approval?.approved === false)
          throw Error('Post-start wrapper swap was cancelled');
        proof.swapApproval = typeof approval === 'object' ? approval : {approved: true};
      }
      const beforeImpl = await memory.pointer(wrapper.object + 0x10);
      if (!(beforeImpl > 2 ** 32 && beforeImpl < 2 ** 39)) {
        request.wrapperError = 'The Loader file wrapper has no mapped implementation';
        await save();
        continue;
      }
      const stockClass = await memory.pointer(beforeImpl).catch(() => 0);
      const donorClass = await memory.pointer(swap.source.impl).catch(() => 0);
      proof.implClasses = {stock: stockClass ? stockClass.toString(16) : null,
        donor: donorClass ? donorClass.toString(16) : null,
        equal: Boolean(stockClass) && stockClass === donorClass};
      await save();
      let strategy = mode;
      if (strategy === 'auto' || strategy === 'mount')
        strategy = proof.implClasses.equal ? 'impl' : 'entry';
      let took = false, afterImpl = null, afterEntry = null;
      if (strategy === 'impl') {
        await memory.writeU64(wrapper.object + 0x10, beforeImpl, swap.source.impl);
        afterImpl = await memory.pointer(wrapper.object + 0x10);
        took = afterImpl === swap.source.impl;
      } else {
        check(swap.source.wrapper > 2 ** 32 && swap.source.wrapper < 2 ** 39,
          'The donor swap has no IFile wrapper object');
        await memory.writeU64(wrapper.entry + 0x20, wrapper.object, swap.source.wrapper);
        afterEntry = await memory.pointer(wrapper.entry + 0x20);
        took = afterEntry === swap.source.wrapper;
      }
      proof.swapMode = strategy;
      request.beforeImpl = beforeImpl.toString(16);
      request.afterImpl = afterImpl === null ? null : afterImpl.toString(16);
      request.afterEntry = afterEntry === null ? null : afterEntry.toString(16);
      proof.swapped = proof.swapped || took;
      proof.completed = new Date().toISOString();
      if (took) {
        swappedObjects.add(wrapper.object);
        if (strategy === 'entry') swappedObjects.add(swap.source.wrapper);
      }
      proof.wrappers = proof.wrappers || [];
      proof.wrappers.push({object: wrapper.object, entry: wrapper.entry,
        at: new Date().toISOString(), strategy, took});
      if (!followUntil)
        followUntil = Date.now() + Math.max(0, Number(process.env.NS2_POST_START_FOLLOW_MS || 2000));
      await save();
      check(took, 'The Loader file wrapper did not take the donor ' + strategy + ' swap');
    }
    if (!proof.swapped && mode !== 'observe')
      throw Error('The resumed Loader never exposed a swappable code mount; ' +
        proof.requests.length + ' requests observed across ' + proof.polls + ' polls');
    return {file, ...proof};
  } catch (error) {
    proof.error = error.stack || error.message;
    await save();
    throw error;
  } finally {
    if (parked) {
      try { await gate.restore(); proof.restored = true; }
      catch (error) { proof.restoreError = error.message; }
    }
    for (const handle of [server.handle, waitReady.handle].filter(Boolean))
      await memory.request({command: 'root-native-close-handle', handle}).catch(() => {});
    proof.finished = new Date().toISOString();
    await save();
  }
}

if (require.main === module)
  watch(null, {watchMode: process.argv.includes('--watch')})
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = {watch};
