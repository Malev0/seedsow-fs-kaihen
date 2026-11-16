// Serve a request left on the Loader session by the pre-launch stages, using
// the old gate's stepServe()/parkSession() (the dev gate's parkSession expects
// an empty session and cannot rebuild while this request is queued).
const fs = require('node:fs/promises');
const path = require('node:path');
const {artifactDir} = require('../../shared/paths.cjs');
const OUT = artifactDir(__dirname);
const {connect} = require('../tools/fs-memory.cjs');
const {exportHandle} = require('./export-handle.cjs');
const {Gate} = require('./gate-old.cjs');
const check = (ok, message) => { if (!ok) throw Error(message); };

async function main() {
  const memory = await connect();
  const read = name => fs.readFile(path.join(OUT, memory.info.session + name)).then(JSON.parse);
  const layout = await read('-layout.json');
  const root = await read('-loader-root-copy.json');
  const bound = await read('-bound-sessions.json');
  const event = await read('-gate-event.json');
  check(layout.report === memory.reportFile && root.report === memory.reportFile &&
    bound.report === memory.reportFile && (!event || event.report === memory.reportFile),
  'Stale gate proofs');
  const row = bound.rows.find(item => item.domain === root.targetDomain);
  check(row, 'Loader session is missing');
  const state = await memory.request({command: 'root-native-info'});
  const copy = await exportHandle(memory, row.receive, 'drain server readiness');
  const gate = new Gate(memory, row, state.apiWorkers, bound.waiters, copy.handle, event);
  try {
    const park = await gate.parkSession();
    const step = await gate.stepServe({force: true});
    await gate.restore();
    console.log(JSON.stringify({verified: true, restored: true, drained: true,
      steps: gate.steps.length, park: park?.state ?? null, header: step?.header ?? null}));
  } finally {
    await memory.request({command: 'root-native-close-handle', handle: copy.handle}).catch(() => {});
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
