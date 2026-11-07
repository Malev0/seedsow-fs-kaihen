// Native request gating. The wait word is distinct from the receive handle.
const check = (ok, message) => { if (!ok) throw Error(message); };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pointer = (b, o) => Number(b.readBigUInt64LE(o));

class Gate {
  constructor(memory, row, workers, waiters, serverCopy, event = null) {
    this.memory = memory;
    this.row = row;
    this.vptr = pointer(Buffer.from(row.raw, 'hex'), 0);
    this.event = event;
    this.park = event ? event.sourceHandle : workers[0].sourceHandle;
    this.waiters = waiters;
    check(waiters.length === 7 && waiters.every((address, i) => address === waiters[0] + i * 0x110),
      'Expected the verified contiguous native waiter array');
    this.serverCopy = serverCopy;
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

  async cancel() { return this.memory.request({command: 'root-native-worker-cancel'}); }

  // There is no app-side KThread handle to cancel (no OpenThread syscall), so
  // worker-cancel is a no-op. The parked session waits on our notifier, so
  // signalling that event forces its wait to return and the kernel to
  // re-evaluate the wait array we just rewrote. NS2_GATE_WAKE=0 disables it.
  async wake() {
    const mode = process.env.NS2_GATE_WAKE || 'park';
    if (mode === '0') return false;
    const targets = [];
    if (this.event && mode !== 'receive') targets.push({signal: this.event.write, clear: this.event.read, name: 'notifier'});
    if (mode === 'receive' || mode === 'both') targets.push({signal: this.serverCopy, clear: this.serverCopy, name: 'readiness'});
    if (!targets.length) return false;
    // Some exported handles are read-only (signalling fails); record each result
    // and keep going as long as at least one wake was accepted.
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

  async cancelOrWake() {
    const replies = await this.cancel();
    const skipped = Array.isArray(replies) && replies.length > 0 && replies.every(reply => reply.skipped);
    if (skipped) await this.wake();
    return {replies, skipped};
  }

  async selections() {
    const bytes = await this.memory.read(this.waiters[0] + 0x10, 6 * 0x110 + 8);
    return this.waiters.map((_, i) => pointer(bytes, i * 0x110));
  }

  async parkSession() {
    const before = await this.inspect(false);
    check(before.state === 1 && this.waiters.includes(before.parent), 'Session is not idle on a known waiter');
    await this.memory.write(this.row.address + 0x30, u32(this.row.wait), u32(this.park));
    await this.cancelOrWake();
    const after = await this.inspect(); // fresh ordinary FS request after cancellation
    check(after.state === 1 && this.waiters.includes(after.parent), 'Parked session did not rearm');
    // Only claim the session once the park actually took effect, so a failed
    // wake does not send restore() after a snapshot that never existed.
    this.parked = true;
    // NS2_GATE_STEP_MODE=wake/prime never writes the fake `selected` pointer, so
    // the idle rebuild (which needs that injection) is skipped as well.
    if (process.env.NS2_GATE_STEP_MODE === 'wake' || process.env.NS2_GATE_STEP_MODE === 'prime' ||
        process.env.NS2_GATE_STEP_MODE === 'unpark-first') return after;
    // From remote-lua-sw2: skip the empty rebuild and let the first real request
    // drive step(). Their hypothesis is that the idle injection is what leaves
    // the persistent selection. Not a fix on its own: step() still injects for
    // the real request, and any injection has frozen this console so far.
    if (process.env.NS2_SKIP_REBUILD === '1') {
      console.log(JSON.stringify({stage: 'gate-rebuild-skipped'}));
      this.rebuildSkipped = true;
      return after;
    }
    // Native FS has separate wait queues. A null-selected cancellation retries
    // the same kernel wait array. Select the idle session once to rebuild it.
    await this.step({empty: true});
    return after;
  }

  // Put the real wait handle back. fs.elf shows +0x30 is the handle the wait
  // array is built from (getter at text+0x214ac0) and +0x48 is the handle the
  // receive syscall uses, so restoring +0x30 is enough for the FS to receive.
  async unpark() {
    check(this.parked, 'Gate is not parked');
    await this.memory.write(this.row.address + 0x30, u32(this.park), u32(this.row.wait));
    this.parked = false;
  }

  async pending() {
    const reply = await this.memory.request({command: 'root-native-wait-zero', handle: this.serverCopy});
    check(reply.result === 0 || reply.result === 0xea01, 'Server readiness check failed');
    return reply.result === 0;
  }

  // Wake-only step (NS2_GATE_STEP_MODE=wake): no fake `selected` pointer. It
  // captures a queued request, optionally wipes the header (NS2_GATE_PRIME=1),
  // signals our notifier once and reports what the session did.
  async stepWake({empty = false, force = false} = {}) {
    check(this.parked && !this.outstanding, 'Gate is not parked or an earlier step is unresolved');
    const unpark = process.env.NS2_GATE_UNPARK === '1';
    // The session is still parked here; the real handle is written below.
    const before = await this.inspect();
    check(before.state === 1 && this.waiters.includes(before.parent), 'Session is not idle on a known waiter');
    // force skips pending(): the readiness check has hung the console while the
    // session is parked. Read the queued header directly instead.
    if (!force) check(await this.pending() === !empty, empty ? 'An idle session was expected' : 'A queued request is required');
    const header = await this.memory.u32(this.row.request);
    if (force && !empty && header === 0xffffffff)
      return {empty: true, forced: true, header: 'ffffffff', started: new Date().toISOString()};
    const step = this.outstanding = {empty, mode: 'wake', attempts: [], started: new Date().toISOString()};
    this.steps.push(step);
    if (!empty) {
      check(header !== 0xffffffff, 'The queued request header is empty');
      step.request = (await this.memory.read(this.row.request, 0x100)).toString('hex');
    }
    // NS2_GATE_UNPARK=1 puts the session's real wait handle back before the wake.
    // Without it the FS wakes and re-arms on our notifier forever (30 identical
    // wake-loop rows in the 02:40 run) and never looks at the queued session.
    if (unpark) {
      await this.memory.write(this.row.address + 0x30, u32(this.park), u32(this.row.wait));
      step.unparked = true;
    }
    // NS2_GATE_PRIME=1 wipes the queued header before the wake, exactly like the
    // injected path does, but without writing the fake `selected` pointer. This
    // separates "the priming" from "the fake holder" as the thing the FS needs.
    const original = await this.memory.read(this.row.request, 4);
    step.original = original.toString('hex');
    if (process.env.NS2_GATE_PRIME === '1' || process.env.NS2_GATE_STEP_MODE === 'prime') {
      await this.memory.write(this.row.request, original, u32(0xffffffff));
      step.primed = true;
    }
    // Prime mode keeps waking until the worker moves on: the first signal gets
    // the kernel to deliver the queued request; the FS may need another pass
    // before it replies. Each iteration is logged so a stuck handler is obvious.
    const attempts = process.env.NS2_GATE_STEP_MODE === 'prime' ? 30 : 1;
    step.wakes = [];
    const settleMs = Number(process.env.NS2_GATE_STEP_MS || (attempts > 1 ? 100 : 250));
    for (let i = 0; i < attempts; i++) {
      await this.wake();
      await new Promise(resolve => setTimeout(resolve, settleMs));
      const pending = await this.pending();
      const header = await this.memory.u32(this.row.request);
      const session = await this.inspect(!unpark);
      step.wakes.push({i, pending, header: header.toString(16),
        state: session.state, receiveResult: session.receiveResult});
      console.log('wake loop', JSON.stringify(step.wakes.at(-1)));
      if (pending) break;
    }
    const after = await this.inspect(!unpark);
    step.sessionAfter = {state: after.state, receiveResult: after.receiveResult};
    step.finished = new Date().toISOString();
    delete this.outstanding;
    return step;
  }

  async step({empty = false} = {}) {
    if (process.env.NS2_GATE_STEP_MODE === 'wake' || process.env.NS2_GATE_STEP_MODE === 'prime')
      return this.stepWake({empty});
    check(this.parked && !this.outstanding, 'Gate is not parked or an earlier step is unresolved');
    const before = await this.inspect();
    console.log('step: inspect ok', JSON.stringify({state: before.state, parent: before.parent, empty}));
    check(before.state === 1 && this.waiters.includes(before.parent) && await this.pending() === !empty,
      empty ? 'An empty idle session is required to rebuild the wait array' : 'A queued request on an idle parked session is required');
    console.log('step: readiness ok');
    const original = await this.memory.read(this.row.request, 4);
    const step = this.outstanding = {empty, original: original.toString('hex'), attempts: [], started: new Date().toISOString()};
    this.steps.push(step);
    await this.memory.write(this.row.request, original, u32(0xffffffff));
    console.log('step: header primed');
    for (let i = 0; i < 30; i++) {
      // A previous selection must settle before another pointer store.
      const selected = await this.selections();
      const session = await this.inspect();
      const epoch = this.waiters.includes(session.parent) ? (await this.memory.u64(session.parent + 0x18)).toString() : null;
      const header = await this.memory.u32(this.row.request);
      const injected = step.attempts.filter(a => a.injected).at(-1);
      console.log('step loop', JSON.stringify({i, selected: selected.includes(this.row.address),
        header, state: session.state, receiveResult: session.receiveResult}));
      if (empty && injected && !selected.includes(this.row.address) && header === 0xffffffff &&
        session.state === 1 && session.receiveResult === 3 && this.waiters.includes(session.parent) &&
        (session.parent !== injected.parent || epoch !== injected.epoch)) {
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
        await this.cancelOrWake();
        continue;
      }
      check(await this.pending() === !empty, 'Server readiness changed before receipt');
      const result = await this.memory.request({command: 'retained-inject-holder',
        server: this.row.address, parent: session.parent, vptr: this.vptr,
        park: this.park, receive: this.row.receive, buffer: this.row.request,
        domain: this.row.domain, metadata: this.row.metadata});
      step.attempts.push(result);
      // Without cancellation the kernel keeps our selection until the session
      // is scheduled again; wake it right away instead of waiting a full loop.
      if (result.injected) await this.wake();
    }
    throw Error('One-shot request did not settle; inspect the saved step before retrying');
  }

  async restore() {
    if (!this.parked) return;
    const session = await this.inspect();
    check(session.state === 1 && this.waiters.includes(session.parent), 'Cannot restore an unsettled session');
    if (this.outstanding) {
      check(!(await this.selections()).includes(this.row.address), 'A selection remains pending');
      const settled = await this.inspect();
      check(settled.state === 1 && this.waiters.includes(settled.parent), 'The last injection has not settled');
      if (await this.memory.u32(this.row.request) === 0xffffffff)
        await this.memory.write(this.row.request, u32(0xffffffff), Buffer.from(this.outstanding.original, 'hex'));
    }
    await this.memory.write(this.row.address + 0x30, u32(this.park), u32(this.row.wait));
    if (this.event) {
      // Waking the old kernel wait object is safe even if the real handle has
      // already become selectable. No synthetic selection or receipt marker
      // is written after restoring the real handle.
      this.parked = false;
      const epoch = await this.memory.u64(session.parent + 0x18);
      const signaled = await this.memory.request({command: 'root-native-event-signal', handle: this.event.write});
      check(!signaled.result, 'Restoration event did not signal');
      for (let i = 0; i < 30; i++) {
        const changed = await this.memory.u64(session.parent + 0x18) !== epoch;
        const current = await this.inspect(false);
        if (changed || current.state === 2 || current.state === 3 || current.parent !== session.parent) {
          const cleared = await this.memory.request({command: 'root-native-event-clear', handle: this.event.read});
          check(!cleared.result, 'Restoration event did not clear');
          this.restoration = {event: true, snapshotRetired: true};
          return;
        }
      }
      throw Error('Event wake did not retire the old wait snapshot');
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
  const parent = sessions[0].parent, epoch = await memory.u64(parent + 0x18);
  for (const gate of parked) gate.parked = false;
  const signaled = await memory.request({command: 'root-native-event-signal', handle: event.write});
  check(!signaled.result, 'Grouped restoration event did not signal');
  try {
    for (let i = 0; i < 30; i++) {
      const current = await parked[0].inspect(false);
      if (await memory.u64(parent + 0x18) === epoch && current.parent === parent &&
          current.state !== 2 && current.state !== 3) continue;
      for (const gate of parked) {
        await gate.inspect(false);
        gate.restoration = {event: true, snapshotRetired: true, grouped: parked.length};
      }
      return;
    }
    throw Error('Grouped restoration did not retire the old wait snapshot');
  } finally {
    const cleared = await memory.request({command: 'root-native-event-clear', handle: event.read});
    check(!cleared.result, 'Grouped restoration event did not clear');
  }
}

module.exports = {Gate, restoreGates};
