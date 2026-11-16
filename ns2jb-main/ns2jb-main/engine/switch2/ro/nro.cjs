// Map, execute and unload a supplied NRO through the standard ldr:ro interface.
const fs = require('node:fs/promises');
const {runPath} = require('../../shared/paths.cjs');

const PageSize = 0x1000;
const EntryOffset = 0x80;
const CurrentProcessHandle = 0xffff8001;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// A dead stock session (F601), a not-yet-registered replacement (1216) and an
// already-initialized process (80c16) all mean "try a fresh session". SM
// MaxSessions (615) is transient too.
const retryable = new Set([0x1216, 0xF601, 0x615, 0x80c16]);

// Standard RO commands carry a PID placeholder before their arguments.
function argumentsWithPid(...values) {
  const data = Buffer.alloc(8 * (values.length + 1));
  values.forEach((value, index) => data.writeBigUInt64LE(BigInt(value), 8 * (index + 1)));
  return data;
}

async function main(options = {}) {
  const {Session, live, check} = require('../app/session.cjs');
  const session = new Session(options.label, options.sessionBytes || 0x20000);
  const file = runPath('switch2', 'ro', options.filename);
  const record = {session: live.session, steps: [], complete: false};
  const save = () => fs.writeFile(file, JSON.stringify(record, null, 2) + '\n');
  const commandRaw = async (handle, id, data, copies = []) => {
    record.pending = id;
    await save();
    const reply = await session.ipc('ldr:ro command ' + id, handle, id, data,
      {pid: true, copies});
    record.steps.push({command: id, result: reply.result});
    delete record.pending;
    await save();
    return reply;
  };
  const command = async (handle, id, data, copies = []) => {
    const reply = await commandRaw(handle, id, data, copies);
    check(!reply.result, 'ldr:ro command ' + id + ' failed: 0x' + reply.result.toString(16));
    return reply;
  };
  try {
    await session.initialize();
    record.allocation = session.base;
    await save();
    const image = options.image;
    check(image.length >= 0x80 && image.subarray(0x10, 0x14).toString('latin1') === 'NRO0',
      'Supplied image is not an NRO');
    // ldr:ro compares these against the NRO header exactly and rejects a
    // mismatch. The file can be longer than nro_size (trailing data), and the
    // BSS size/address must come from the header, not from the file length.
    const nroSize = options.nroSize || image.readUInt32LE(0x18);
    const bssSize = options.bssSize ?? image.readUInt32LE(0x38);
    check(nroSize > 0 && nroSize <= image.length && nroSize % PageSize === 0,
      'NRO size is invalid or not page-aligned');
    check(bssSize % PageSize === 0, 'NRO BSS size is not page-aligned');
    // ldr:ro also requires contiguous, page-aligned segments with text at 0.
    check(image.readUInt32LE(0x20) === 0 &&
      image.readUInt32LE(0x20) + image.readUInt32LE(0x24) === image.readUInt32LE(0x28) &&
      image.readUInt32LE(0x28) + image.readUInt32LE(0x2c) === image.readUInt32LE(0x30) &&
      image.readUInt32LE(0x30) + image.readUInt32LE(0x34) === nroSize,
      'NRO segment layout is not contiguous');
    const source = session.base + 0x8000;
    const bss = source + nroSize;
    check(bss + bssSize <= session.base + session.bytes, 'NRO and BSS exceed the session buffer');
    await session.write(source, image.subarray(0, nroSize));
    if (bssSize) await session.write(bss, Buffer.alloc(bssSize));

    // The replacement RO registers ldr:ro only after the stock RO is
    // terminated. A single open can still resolve the stock Loader, which
    // accepts SetProcess but rejects LoadNro with 0x1216. Retry a fresh
    // session until LoadNro reaches the replacement frontend.
    const waitMs = Number(process.env.NS2_RO_REGISTER_WAIT_MS ?? 15000);
    const pollMs = Math.max(50, Number(process.env.NS2_RO_REGISTER_POLL_MS ?? 250));
    const settleMs = Math.max(0, Number(process.env.NS2_RO_REGISTER_SETTLE_MS ?? 1500));
    if (settleMs) await delay(settleMs);
    const deadline = Date.now() + waitMs;
    record.registerAttempts = [];
    let handle = null, reply = null, last = null, attempts = 0;
    const attempt = async () => {
      let ro = null;
      try {
        ro = await session.openService('ldr:ro');
        let setResult = null;
        if (!options.skipSetProcess) {
          const set = await commandRaw(ro, 4, argumentsWithPid(), [CurrentProcessHandle]);
          setResult = set.result;
          // 80c16: this process already had SetProcess (ready.cjs or an earlier
          // attempt). Continue to LoadNro; only the replacement can succeed.
          if (setResult && setResult !== 0x80c16)
            return {handle: ro, setResult, reply: null, loadResult: setResult,
              retry: retryable.has(setResult)};
        }
        const loaded = await commandRaw(ro, 0, argumentsWithPid(source, nroSize, bss, bssSize));
        return {handle: ro, setResult, reply: loaded, loadResult: loaded.result,
          retry: !!loaded.result && retryable.has(loaded.result)};
      } catch (error) {
        return {handle: ro, error, retry: true};
      }
    };
    for (;;) {
      attempts++;
      const result = await attempt();
      record.registerAttempts.push({attempt: attempts, set: result.setResult ?? null,
        load: result.reply ? result.loadResult : null, error: result.error?.message});
      if (!result.error && result.reply && !result.loadResult) {
        handle = result.handle; reply = result.reply; break;
      }
      last = result.error?.message ?? result.loadResult ?? result.setResult;
      if (result.handle !== null && session.handles.has(result.handle))
        await session.close(result.handle).catch(() => {});
      if (!result.retry || Date.now() >= deadline)
        check(false, 'ldr:ro did not reach the replacement frontend (' + attempts +
          ' attempts; last ' + (typeof last === 'number' ? '0x' + last.toString(16) : last) + ')');
      await delay(pollMs);
    }
    record.handle = handle;
    record.registerAttempts.at(-1).selected = true;
    const destination = Number(reply.data.readBigUInt64LE());
    record.destination = destination;
    record.mappings = [];
    const segmentOffsets = [0, image.readUInt32LE(0x28), image.readUInt32LE(0x30), nroSize];
    for (const offset of segmentOffsets) {
      record.mappings.push(await session.rpc.query(destination + offset));
    }
    const expectedPermissions = [5, 1, 3, 3];
    check(record.mappings.every((mapping, page) =>
      !mapping.result && mapping.permissions === expectedPermissions[page]),
      'Mapped segment permissions differ from RX/R/RW/RW');
    await save();

    let operationError;
    try {
      record.returnValue = await options.execute(session, destination + EntryOffset, record, save);
      check(record.returnValue === 0, 'Bootstrap returned error ' + record.returnValue);
    } catch (error) {
      if (!record.joined) throw error;
      operationError = error;
    }
    await save();
    // `keepMapped` stops here instead of unloading and querying: every request
    // runs on the game's onEnterFrame thread (the launcher's HTTP /eval), so a
    // single SDK call that does not return wedges the frame loop, and a Switch
    // cannot suspend or return to HOME an app whose frame loop is stuck -- the
    // screen freezes with no fatal. Once the mapped module has reported
    // success the run has nothing left to ask the console.
    if (options.keepMapped && !operationError && record.returnValue === 0) {
      record.keepMapped = true;
      record.complete = true;
      await save();
      return {file, complete: true, returnValue: record.returnValue};
    }
    await command(handle, 1, argumentsWithPid(destination));
    record.unmappedRegions = [];
    for (const offset of segmentOffsets) {
      record.unmappedRegions.push(await session.rpc.query(destination + offset));
    }
    check(record.unmappedRegions.every(mapping => !mapping.result && mapping.permissions === 0),
      'An NRO segment remains accessible after unload');
    await save();
    await session.close(handle);
    await session.cleanup();
    if (operationError) throw operationError;
    record.complete = true;
    await save();
    return {file, complete: true, returnValue: record.returnValue};
  } catch (error) {
    // Preserve source memory if a mapping or synchronous call has uncertain state.
    // Do not free pages that RO may still have mapped into this process.
    record.error = error.stack;
    await save();
    throw error;
  }
}

module.exports = {main, argumentsWithPid};
