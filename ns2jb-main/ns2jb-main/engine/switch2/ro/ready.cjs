// Confirm that the launched RO service accepts its standard Initialize call.
// The replacement RO process owns ldr:ro (spaces 1 and 2) and registers it
// only after the stock RO is terminated. A single open right after handoff can
// still resolve the stock Loader, so wait, reopen and retry SetProcess until
// the replacement owns the name.
const {Session, check} = require('../app/session.cjs');
const {argumentsWithPid} = require('./nro.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A dead stock session (F601), a not-yet-registered replacement (1216) and an
// already-initialized process (80c16) all mean "try a fresh session". SM
// MaxSessions (615) is transient too.
const retryable = new Set([0x1216, 0xF601, 0x615, 0x80c16]);

async function main() {
  const waitMs = Number(process.env.NS2_RO_REGISTER_WAIT_MS ?? 15000);
  const pollMs = Math.max(50, Number(process.env.NS2_RO_REGISTER_POLL_MS ?? 250));
  const settleMs = Math.max(0, Number(process.env.NS2_RO_REGISTER_SETTLE_MS ?? 1500));
  const session = new Session('ro-ready');
  await session.initialize();
  const started = Date.now();
  let attempts = 0, last = null;
  try {
    if (settleMs) await delay(settleMs);
    const deadline = Date.now() + waitMs;
    for (;;) {
      attempts++;
      let ro = null;
      try {
        ro = await session.openService('ldr:ro');
        const reply = await session.ipc('RO Initialize', ro, 4, argumentsWithPid(),
          {pid: true, copies: [0xffff8001]});
        last = reply.result;
        if (!reply.result) {
          return {ready: true, attempts, waitedMs: Date.now() - started, result: 0};
        }
        // 80c16: this ldr:ro process already had SetProcess (a previous probe
        // or the stock). ready.cjs cannot tell which without LoadNro, so let
        // nro.cjs's LoadNro retry be the real gate instead of timing out here.
        if (reply.result === 0x80c16) {
          return {ready: true, alreadyInitialized: true, attempts,
            waitedMs: Date.now() - started, result: reply.result};
        }
      } catch (error) {
        last = error.message;
      } finally {
        if (ro !== null && session.handles.has(ro)) await session.close(ro).catch(() => {});
      }
      if (Date.now() >= deadline) break;
      await delay(pollMs);
    }
  } finally {
    await session.cleanup();
  }
  const shown = typeof last === 'number' ? '0x' + last.toString(16) : String(last);
  check(false, 'RO frontend did not register ldr:ro within ' + (Date.now() - started) +
    ' ms (' + attempts + ' attempts; last ' + shown + ')');
}
module.exports = {main, retryable};
