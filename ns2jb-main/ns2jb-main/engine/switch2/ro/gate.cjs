// Native request gating. The wait word is distinct from the receive handle.
const check = (ok, message) => { if (!ok) throw Error(message); };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pointer = (b, o) => Number(b.readBigUInt64LE(o));
const WAKE_SETTLE_MS = 100;

// Keep the event asserted only for a bounded quiet wake interval.
// Retained FS reads must not run until the event has been cleared: a repeatedly
// selected event can starve the FS request used to inspect the waiter epoch.
async function wakeAndClear(memory, event, restoration, extra = null) {
  let failure;
  try {
    const signaled = await memory.request({command: 'root-native-event-signal', handle: event.write});
    restoration.signal = {at: signaled.at, result: signaled.result};
    check(signaled.result === 0, 'Restoration event did not signal');
    // The FS worker's wait snapshot is the session's old wait handle; signal
    // its exported copy too. A port that rejects SignalEvent is recorded, not
    // fatal: the park event above is still the primary restoration signal.
    if (extra) {
      try {
        const extraSignaled = await memory.request({command: 'root-native-event-signal', handle: extra});
        restoration.extraSignal = {handle: extra, at: extraSignaled.at, result: extraSignaled.result};
      } catch (error) { restoration.extraSignal = {handle: extra, error: error.message}; }
    }
    await new Promise(resolve => setTimeout(resolve, WAKE_SETTLE_MS));
  } catch (error) {
    failure = error;
    restoration.wakeError = error.message;
  } finally {
    try {
      const cleared = await memory.request({command: 'root-native-event-clear', handle: event.read});
      restoration.clear = {at: cleared.at, result: cleared.result};
      check(cleared.result === 0, 'Restoration event did not clear');
      if (extra) {
        try {
          const extraCleared = await memory.request({command: 'root-native-event-clear', handle: extra});
          restoration.extraClear = {handle: extra, at: extraCleared.at, result: extraCleared.result};
        } catch (error) { restoration.extraClear = {handle: extra, error: error.message}; }
      }
    } catch (error) {
      restoration.clearError = error.message;
      if (failure) failure.clearError = error.message;
      else failure = error;
    }
  }
  if (failure) throw failure;
}

class Gate {
  constructor(memory, row, workers, waiters, serverCopy, event = null, waitCopy = null) {
    this.memory = memory;
    this.row = row;
    this.vptr = pointer(Buffer.from(row.raw, 'hex'), 0);
    this.event = event;
    this.park = event ? event.sourceHandle : workers[0].sourceHandle;
    this.waiters = waiters;
    check(waiters.length === 7 && waiters.every((address, i) => address === waiters[0] + i * 0x110),
      'Expected the verified contiguous native waiter array');
    this.serverCopy = serverCopy;
    this.waitCopy = waitCopy;
    this.holder = this.row.address;
    this.steps = [];
  }

  async inspect(parked = true) {
    const b = await this.memory.read(this.row.address, 0x88);
    check(pointer(b, 0) === this.vptr && pointer(b, 0x70) === this.row.domain &&
      pointer(b, 0x78) === this.row.metadata && b.readUInt32LE(0x48) === this.row.receive &&
      pointer(b, 0x60) === this.row.request && pointer(b, 0x68) === 0x100,
    'The bound server session changed');
    check(b.readUInt32LE(0x30) === (parked ? this.park : this.row.wait), 'The wait word changed');
    return {parent: pointer(b, 0x28), state: b.readUInt32LE(0x40),
      receiveResult: b.readUInt32LE(0x44), raw: b.toString('hex')};
  }

  // CancelSynchronization on the seven FS API workers is what makes the kernel
  // drop the selection our injection installed. The proven Switch 2 flow relies
  // on it and never wakes the notifier; the skip record is only possible when
  // the console exposed no KThread handles, and then the notifier wake is the
  // fallback.
  async cancel() {
    const replies = await this.memory.request({command: 'root-native-worker-cancel'});
    this.cancelSkipped = Array.isArray(replies) && replies.length > 0 &&
      replies.every(reply => reply.skipped);
    return replies;
  }

  // Read the queued request without injecting the holder. Used to identify a
  // close-before-mount Loader order, which the dev gate's injected step wedges
  // on (the old NS2_LAUNCH_RESTORE_AFTER_READ path handed it back instead).
  async peek() {
    const header = await this.memory.u32(this.row.request);
    if (header === 0xffffffff) return null;
    const bytes = await this.memory.read(this.row.request, 0x100);
    return {header, request: bytes.toString('hex')};
  }

  async wake() {
    const mode = process.env.NS2_GATE_WAKE || 'park';
    if (mode === '0') return false;
    const targets = [];
    // Fallback path only (see cancelSkipped): when the console gave us no
    // KThread handles the FS worker cannot be cancelled, so the FS's own wait
    // object is signalled instead. The FS's real cancellation path
    // (fs.elf +0x211950) is CancelSynchronization on the parent thread, and that
    // is what the proven flow uses.
    if (this.event && mode !== 'receive' && mode !== 'wait')
      targets.push({signal: this.event.write, clear: this.event.read, name: 'notifier'});
    if ((mode === 'receive' || mode === 'both') && this.serverCopy)
      targets.push({signal: this.serverCopy, clear: this.serverCopy, name: 'readiness'});
    if ((mode === 'wait' || mode === 'both') && this.waitCopy)
      targets.push({signal: this.waitCopy, clear: this.waitCopy, name: 'wait'});
    if (!targets.length) return false;
    const log = this.wakeLog ||= [];
    const woken = [];
    for (const target of targets) {
      const reply = await this.memory.request({command: 'root-native-event-signal', handle: target.signal});
      log.push({name: target.name, signal: reply.result});
      if (!reply.result) woken.push(target);
    }
    if (!woken.length) { this.wakeFailed = true; return false; }
    await new Promise(resolve => setTimeout(resolve, Number(process.env.NS2_GATE_WAKE_MS || 25)));
    for (const target of woken) {
      const reply = await this.memory.request({command: 'root-native-event-clear', handle: target.clear});
      if (reply.result) log.push({name: target.name, clear: reply.result});
    }
    this.wakeCount = (this.wakeCount || 0) + 1;
    return true;
  }

  async selections() {
    const bytes = await this.memory.read(this.waiters[0] + 0x10, 6 * 0x110 + 8);
    return this.waiters.map((_, i) => pointer(bytes, i * 0x110));
  }

  async parkSession() {
    const before = await this.inspect(false);
    check(before.state === 1 && this.waiters.includes(before.parent), 'Session is not idle on a known waiter');
    await this.memory.write(this.row.address + 0x30, u32(this.row.wait), u32(this.park));
    this.parked = true;
    await this.cancel();
    // With real KThread cancellation the kernel reply retires the selection, so
    // nothing else is needed (the proven flow signals nothing here). Only when
    // this console exposed no KThread handles is the notifier wake required to
    // re-arm the parked session.
    const skipped = this.cancelSkipped;
    if (skipped && this.event) {
      await wakeAndClear(this.memory, this.event, this.parkRestoration = {}, this.waitCopy);
      // kaiHEN's park rebuild re-arms the FS workers on the park event via an
      // injection. On Seedsow the session itself is the holder and that
      // injection cannot settle. Instead, give the notifier wake time to make
      // the pool thread re-read the session's wait word (now the park event),
      // and wait until this session is no longer selected before releasing the
      // launch. Otherwise the first mount is served during the inject, before
      // the host can exchange the entry.
      const settleMs = Number(process.env.NS2_PARK_SETTLE_MS || 1000);
      const until = Date.now() + settleMs;
      let rounds = 0;
      while (Date.now() < until) {
        if (!(await this.selections()).includes(this.row.address)) break;
        if (++rounds % 20 === 0) await wakeAndClear(this.memory, this.event, {}, this.waitCopy);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      this.parkSettled = !(await this.selections()).includes(this.row.address);
      this.parkSettleRounds = rounds;
    }
    const after = await this.inspect(); // fresh ordinary FS request after cancellation
    check(after.state === 1 && this.waiters.includes(after.parent), 'Parked session did not rearm');
    // The pre-launch stages can leave a request queued on this session (the
    // 1uHEKF run recorded a `close`). Serving it with step() is the only
    // handling that keeps the FS receive in sync: clearing the header would
    // leave the issuing client without a reply, and the idle rebuild below
    // requires an empty session. The launch loop then sees only Loader traffic.
    //
    // NS2_GATE_DRAIN=0 disables both the drain and the rebuild and leaves the
    // queued request to the launch loop's first step(), which is the old
    // behaviour. Use it if a boot wedges here.
    if (await this.pending() && await this.memory.u32(this.row.request) !== 0xffffffff) {
      if (process.env.NS2_GATE_DRAIN === '0') {
        this.drainSkipped = true;
        console.log(JSON.stringify({stage: 'gate-drain-skipped'}));
      } else {
        const drained = await this.step();
        this.drained = {original: drained.original, request: drained.request};
        console.log(JSON.stringify({stage: 'gate-drain-stale', original: drained.original}));
      }
    }
    // Once the FS reports the session idle again, select it once with an empty
    // request to rebuild its kernel wait array. This is what the proven flow
    // does unconditionally; it only failed before because the cancellation was
    // skipped and the empty receive never settled. NS2_GATE_IDLE_REBUILD=0
    // skips it and lets the first real request drive step() instead.
    const idleRebuild = process.env.NS2_GATE_IDLE_REBUILD !== '0' && !this.drainSkipped;
    if (this.holder === this.row.address && !idleRebuild) {
      console.log(JSON.stringify({stage: 'gate-rebuild-skipped', reason: 'session holder'}));
      this.rebuildSkipped = true;
      return after;
    }
    // Native FS has separate wait queues. A null-selected cancellation retries
    // the same kernel wait array. Select the idle session once to rebuild it.
    // The queued stale request (if any) was drained above, so this is genuinely
    // empty and the rebuild returns with the session re-armed on the real wait.
    await this.step({empty: true});
    this.rebuilt = true;
    return after;
  }

  async pending() {
    const reply = await this.memory.request({command: 'root-native-wait-zero', handle: this.serverCopy});
    check(reply.result === 0 || reply.result === 0xea01, 'Server readiness check failed');
    return reply.result === 0;
  }

  // The readiness event and the request buffer are separate pieces of state. A
  // signaled readiness handle is not sufficient on its own: after an early PM
  // return the event can stay signaled while the buffer still holds the empty
  // marker. The post-start watcher needs both facts from one coherent read, or
  // it sends step() at an empty descriptor.
  async pendingSnapshot() {
    const reply = await this.memory.request({command: 'root-native-wait-zero', handle: this.serverCopy});
    check(reply.result === 0 || reply.result === 0xea01, 'Server readiness check failed');
    const header = await this.memory.u32(this.row.request);
    return {result: reply.result, pending: reply.result === 0, header,
      empty: header === 0xffffffff};
  }

  // Compact state for a saved proof. Post-start watchers write this after every
  // served request so a wedged run still leaves the last gate state on disk.
  snapshot() {
    return {parked: Boolean(this.parked), outstanding: Boolean(this.outstanding),
      steps: this.steps.length, wakeCount: this.wakeCount || 0,
      wakeFailed: Boolean(this.wakeFailed), restoration: this.restoration ?? null};
  }

  async step({empty = false} = {}) {
    check(this.parked && !this.outstanding, 'Gate is not parked or an earlier step is unresolved');
    const before = await this.inspect();
    check(before.state === 1 && this.waiters.includes(before.parent) && await this.pending() === !empty,
      empty ? 'An empty idle session is required to rebuild the wait array' : 'A queued request on an idle parked session is required');
    const original = await this.memory.read(this.row.request, 4);
    const step = this.outstanding = {empty, original: original.toString('hex'), attempts: [], started: new Date().toISOString()};
    this.steps.push(step);
    await this.memory.write(this.row.request, original, u32(0xffffffff));
    for (let i = 0; i < 30; i++) {
      // A previous selection must settle before another pointer store.
      const selected = await this.selections();
      const session = await this.inspect();
      const epoch = this.waiters.includes(session.parent) ? (await this.memory.u64(session.parent + 0x18)).toString() : null;
      const header = await this.memory.u32(this.row.request);
      const injected = step.attempts.filter(a => a.injected).at(-1);
      if (empty && injected && !selected.includes(this.row.address) && header === 0xffffffff &&
        session.state === 1 && session.receiveResult === 3 && this.waiters.includes(session.parent)) {
        // The 23:46 state: selection cleared and receiveResult 3. The waiter
        // parent/epoch can stay the same on this FS, so do not require a change.
        step.rebuilt = {parent: session.parent, epoch, receiveResult: session.receiveResult};
        await this.memory.write(this.row.request, u32(0xffffffff), original);
        step.finished = new Date().toISOString();
        delete this.outstanding;
        return step;
      }
      if (header !== 0xffffffff && session.state === 1 && this.waiters.includes(session.parent)) {
        step.request = (await this.memory.read(this.row.request, 0x100)).toString('hex');
        step.finished = new Date().toISOString();
        delete this.outstanding;
        check(!empty, 'An unexpected request arrived during the idle rebuild');
        return step;
      }
      if (header !== 0xffffffff || selected.includes(this.row.address) || session.state !== 1 ||
        !this.waiters.includes(session.parent)) {
        await this.cancel();
        // Only a skipped cancellation needs the notifier nudge; with a real
        // CancelSynchronization the FIRM reply already retired the selection and
        // an extra wake would serve the next request too early.
        if (this.cancelSkipped) await this.wake();
        continue;
      }
      // A consumed request leaves header 0xffffffff for a few ms before the
      // Loader's next request lands. Injecting then wedges the endpoint
      // (03:01/13:12). Give the next request a moment first; the loop re-reads
      // and returns it if it arrives.
      if (!empty) {
        await new Promise(resolve => setTimeout(resolve, Number(process.env.NS2_GATE_REQUEST_WAIT_MS || 25)));
        if (await this.memory.u32(this.row.request) !== 0xffffffff) continue;
      }
      check(await this.pending() === !empty, 'Server readiness changed before receipt');
      const result = await this.memory.request({command: 'retained-inject-holder',
        server: this.row.address, holder: this.holder, wait: this.row.wait, primed: true,
        parent: session.parent, vptr: this.vptr,
        park: this.park, receive: this.row.receive, buffer: this.row.request,
        domain: this.row.domain, metadata: this.row.metadata});
      step.attempts.push(result);
      // The injection itself cancels the workers. A real cancellation retires
      // the selection, so the loop re-reads and returns the served request on
      // the next iteration with no extra signal (proven flow). Wake only when
      // those cancellations were skipped.
      if (result.injected && (result.cancellations || []).every(reply => reply.skipped))
        await this.wake();
    }
    throw Error('One-shot request did not settle; inspect the saved step before retrying');
  }

  // Serve one queued request through the parked session. Used to drain a
  // request left by the pre-launch stages before the dev gate's idle rebuild.
  async stepServe({force = false, skipAfter = false} = {}) {
    check(this.parked && !this.outstanding, 'Gate is not parked or an earlier step is unresolved');
    const before = await this.inspect();
    check(before.state === 1 && this.waiters.includes(before.parent), 'Session is not idle on a known waiter');
    if (!force) check(await this.pending(), 'A queued request on an idle parked session is required');
    const header = await this.memory.u32(this.row.request);
    if (header === 0xffffffff)
      return {empty: true, header: 'ffffffff', started: new Date().toISOString()};
    const step = this.outstanding = {empty: false, mode: 'serve', attempts: [], started: new Date().toISOString()};
    this.steps.push(step);
    step.request = (await this.memory.read(this.row.request, 0x100)).toString('hex');
    step.header = header.toString(16);
    let injected = false;
    for (let attempt = 0; attempt < 4 && !injected; attempt++) {
      const current = await this.inspect();
      check(current.state === 1 && this.waiters.includes(current.parent), 'Session is not idle on a known waiter');
      const result = await this.memory.request({command: 'retained-inject-holder',
        server: this.row.address, holder: this.holder, wait: this.row.wait, primed: false,
        parent: current.parent, vptr: this.vptr,
        park: this.park, receive: this.row.receive, buffer: this.row.request,
        domain: this.row.domain, metadata: this.row.metadata});
      step.attempts.push(result);
      if (result.injected) { injected = true; break; }
      if (result.acknowledged || result.empty) break;
      if (result.selected !== undefined && result.selected === this.holder) {
        injected = true; break;
      }
      await this.wake();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (injected) {
      // No wake here. Waking the FS pool after the injection serves the
      // Loader's /main open before the swap (14:16 added the IFile entry 193
      // before the exchange). The restore's wakeAndClear after the swap is the
      // wake that serves it, with the donor already in place.
      // The served reply can re-arm the session's wait word. Hold it at the
      // park event so the Loader's next request (/main open) waits until the
      // launch restores the gate after the donor swap.
      try {
        const bytes = await this.memory.read(this.row.address, 0x88);
        const wait = bytes.readUInt32LE(0x30);
        if (wait !== this.park) {
          const expected = Buffer.alloc(4); expected.writeUInt32LE(wait);
          const replacement = Buffer.alloc(4); replacement.writeUInt32LE(this.park);
          await this.memory.write(this.row.address + 0x30, expected, replacement);
        }
        step.reparked = true;
      } catch (error) { step.reparkError = error.message; }
      if (!skipAfter) {
        try { step.bufferAfterWake = (await this.memory.read(this.row.request, 0x100)).toString('hex'); }
        catch (error) { step.bufferAfterWakeError = error.message; }
        await new Promise(resolve => setTimeout(resolve, Number(process.env.NS2_GATE_SERVE_MS || 250)));
      }
    }
    if (!skipAfter) {
      // Diagnostic only: the served reply can re-arm the session's wait word,
      // so a strict parked inspect must not fail the launch.
      try {
        const after = await this.inspect();
        step.sessionAfter = {state: after.state, receiveResult: after.receiveResult};
      } catch (error) { step.sessionAfterError = error.message; }
    }
    step.injected = injected;
    step.empty = !injected && step.attempts.some(attempt => attempt.empty);
    step.finished = new Date().toISOString();
    delete this.outstanding;
    return step;
  }

  async restore() {
    if (!this.parked) return;
    const session = await this.inspect();
    check(session.state === 1 && this.waiters.includes(session.parent), 'Cannot restore an unsettled session');
    if (this.outstanding) {
      // The FS may still be inside the receive the injection started. Do not
      // abort on a pending selection; restore the real wait handle and let the
      // event wake retire it (the port's previous restore did the same).
      this.pendingSelection = (await this.selections()).includes(this.row.address);
      const settled = await this.inspect();
      check(settled.state === 1 && this.waiters.includes(settled.parent), 'The last injection has not settled');
      if (await this.memory.u32(this.row.request) === 0xffffffff)
        await this.memory.write(this.row.request, u32(0xffffffff), Buffer.from(this.outstanding.original, 'hex'));
    }
    await this.memory.write(this.row.address + 0x30, u32(this.park), u32(this.row.wait));
    if (this.event) {
      // No synthetic selection or receipt marker is written after restoring
      // the real handle. A fresh FS read must prove the old snapshot retired.
      this.parked = false;
      const restoration = this.restoration = {event: true, snapshotRetired: false,
        wakeSettleMs: WAKE_SETTLE_MS, checks: 0};
      try {
        restoration.epochBefore = (await this.memory.u64(session.parent + 0x18)).toString();
      } catch (error) { restoration.epochBeforeError = error.message; }
      await wakeAndClear(this.memory, this.event, restoration, this.waitCopy);
      // The wake lets the FS serve whatever queued behind the gate, and that can
      // move the session onto a different waiter. Reading the old parent's epoch
      // after that is a read of FS memory that may already be freed, and such a
      // read wedges the retained endpoint (2026-11-14 17:36: the launch exchanged
      // mount 2, the notifier was signalled, and the first epoch read never
      // returned). The real wait word is already back above, so this observation
      // is best effort: re-anchor on the live session and stop on the first
      // failure instead of retrying a bad address.
      const until = Date.now() + Number(process.env.NS2_RESTORE_SETTLE_MS || 3000);
      while (Date.now() < until) {
        restoration.checks++;
        let current;
        try { current = await this.inspect(false); }
        catch (error) { restoration.inspectError = error.message; break; }
        if (current.parent !== session.parent || current.state === 2 || current.state === 3) {
          Object.assign(restoration, {snapshotRetired: true,
            epochAfter: restoration.epochBefore, state: current.state,
            parent: current.parent});
          return;
        }
        let currentEpoch;
        try { currentEpoch = await this.memory.u64(current.parent + 0x18); }
        catch (error) { restoration.epochError = error.message; break; }
        if (restoration.epochBefore && currentEpoch.toString() !== restoration.epochBefore) {
          Object.assign(restoration, {snapshotRetired: true,
            epochAfter: currentEpoch.toString(), state: current.state,
            parent: current.parent});
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      // The real wait handle is already restored above. A stale snapshot can
      // make the event wake miss the epoch change even though the session is
      // usable; do not fail the launch after a successful swap. The handoff
      // validates the real wait word next.
      Object.assign(restoration, {snapshotRetired: false, waitRestored: true,
        note: 'event wake did not retire the old wait snapshot; real wait handle restored'});
      return;
    }
    const parkedHandle = this.park;
    this.park = this.row.wait;
    delete this.outstanding;
    await this.cancel();
    await this.step({empty: !await this.pending()});
    this.parked = false;
    this.park = parkedHandle;
    await this.inspect(false);
  }
}

// Sessions sharing one parking event must all leave it before it is signaled.
// Otherwise a still-parked session can repeatedly wake and starve FS requests.
async function restoreGates(gates) {
  const parked = gates.filter(gate => gate.parked);
  if (!parked.length) return;
  if (parked.length === 1) return parked[0].restore();
  const first = parked[0], memory = first.memory, event = first.event;
  check(event && parked.every(gate => gate.memory === memory &&
    gate.event?.sourceHandle === event.sourceHandle && gate.event?.read === event.read &&
    gate.event?.write === event.write && !gate.outstanding),
  'Group restoration requires settled sessions sharing one parking event');
  const sessions = [];
  for (const gate of parked) {
    const session = await gate.inspect();
    check(session.state === 1 && gate.waiters.includes(session.parent), 'A grouped session has not settled');
    sessions.push(session);
  }
  for (const gate of parked)
    await memory.write(gate.row.address + 0x30, u32(gate.park), u32(gate.row.wait));
  const epochs = [];
  for (const session of sessions) epochs.push(await memory.u64(session.parent + 0x18));
  for (const gate of parked) gate.parked = false;
  const restoration = {event: true, snapshotRetired: false, grouped: parked.length,
    epochBefore: epochs.map(epoch => epoch.toString()), wakeSettleMs: WAKE_SETTLE_MS};
  for (const gate of parked) gate.restoration = restoration;
  await wakeAndClear(memory, event, restoration);
  for (let i = 0; i < 30; i++) {
    const snapshots = [];
    for (let n = 0; n < parked.length; n++) {
      const current = await parked[n].inspect(false);
      const currentEpoch = await memory.u64(sessions[n].parent + 0x18);
      snapshots.push({row: parked[n].row.address, parentBefore: sessions[n].parent,
        parentAfter: current.parent, epochBefore: epochs[n].toString(),
        epochAfter: currentEpoch.toString(), state: current.state,
        retired: currentEpoch !== epochs[n] || current.parent !== sessions[n].parent ||
          current.state === 2 || current.state === 3});
    }
    restoration.snapshots = snapshots;
    if (snapshots.every(snapshot => snapshot.retired)) {
      Object.assign(restoration, {snapshotRetired: true, checks: i + 1});
      return;
    }
  }
  throw Error('Grouped restoration did not retire the old wait snapshot');
}

module.exports = {Gate, restoreGates};
