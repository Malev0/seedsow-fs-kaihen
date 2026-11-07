const {connect} = require('../ns2jb-main/ns2jb-main/engine/switch2/tools/fs-memory.cjs');
(async () => {
  const memory = await connect();
  console.log('connected', memory.info.session, memory.reportFile);
  const info = await memory.request({command: 'root-native-info'});
  console.log('worker before', JSON.stringify(info.worker && {
    label: info.worker.label, kind: info.worker.kind, joined: info.worker.joined,
    released: info.worker.released, slot: info.worker.slot}));
  const settle = await memory.request({command: 'root-native-worker-settle'});
  console.log('settle', JSON.stringify(settle).slice(0, 500));
  const after = await memory.request({command: 'root-native-info'});
  console.log('worker after', JSON.stringify(after.worker && {
    label: after.worker.label, kind: after.worker.kind, joined: after.worker.joined,
    threadLeftRunning: after.worker.threadLeftRunning}));
  console.log('donor ready', after.donor && after.donor.ready);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
