// Read-only SM liveness canary through an exported FS SM client handle.
// Every canary is appended to <session>-sm-canary.jsonl so the boot's timeline
// shows exactly which stage closed the FS's SM session (svc SessionClosed,
// transport 0xf601). The lookup session is closed again so the canaries do not
// consume pm:shell's small session budget.
const fs = require('node:fs/promises');
const path = require('node:path');

async function smCanary(memory, handle, label) {
  const record = {at: new Date().toISOString(), label, handle};
  try {
    const reply = await memory.request({command: 'root-native-sm-service', handle, name: 'pm:shell'});
    record.transport = reply.transport ?? 0;
    record.result = reply.result ?? null;
    record.ok = !record.transport && !record.result;
    // Do not leak a pm:shell session per canary: the service has a small
    // session limit and later stages still need their own lookups.
    const opened = (reply.moves || [])[0];
    if (opened) {
      try {
        await memory.request({command: 'root-native-close-handle', handle: opened});
        record.closed = opened;
      } catch (failure) { record.closeError = failure.message; }
    }
  } catch (error) {
    record.error = error.message;
    record.ok = false;
  }
  const file = path.join(__dirname, memory.info.session + '-sm-canary.jsonl');
  await fs.appendFile(file, JSON.stringify(record) + '\n', {mode: 0o600}).catch(() => {});
  console.log(JSON.stringify({stage: 'sm-canary', ...record}));
  return record;
}

module.exports = {smCanary};
