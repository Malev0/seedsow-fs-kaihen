// Read-only probe of the dedicated fsp-srv root's BIS filesystems.
// Run while the retained endpoint is idle (after a stop-after-launch run).
const {connect} = require('../ns2jb-main/ns2jb-main/engine/switch2/tools/fs-memory.cjs');
(async () => {
  const m = await connect();
  console.log('session', m.info.session);
  const info = await m.request({command: 'root-info'});
  console.log('root-info initialized=', info.initialized, 'clones=', info.clones?.length,
    'storages=', info.storages?.length, 'filesystems=', info.filesystems?.length);
  for (const id of [30, 31]) {
    try {
      const r = await m.request({command: 'root-probe-bis-filesystem', id});
      console.log('bis', id, JSON.stringify(r));
    } catch (e) {
      console.log('bis', id, 'ERR', e.message);
    }
  }
})().catch(e => {console.error(e.stack); process.exitCode = 1;});
