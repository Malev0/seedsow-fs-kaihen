// Confirm the replacement RO is alive and the stock RO is gone, over the
// retained endpoint. Run while the endpoint is idle after stop-after-launch.
const {connect, encodeU64} = require('../ns2jb-main/ns2jb-main/engine/switch2/tools/fs-memory.cjs');
(async () => {
  const m = await connect();
  const info = await m.request({command: 'root-native-info'});
  console.log('services', JSON.stringify((info.services || []).map(s => s.name)));
  const monitor = info.services.find(s => s.name === 'pm:dmnt')?.handle;
  console.log('pm:dmnt', monitor);
  for (const pid of [208, 168]) {
    try {
      const r = await m.request({command: 'root-native-ipc', handle: monitor, id: 7,
        hex: encodeU64(BigInt(pid)).toString('hex')});
      const value = r.hex && r.hex.length >= 16 ? '0x' + Buffer.from(r.hex, 'hex').readBigUInt64LE().toString(16) : null;
      console.log('pid', pid, 'result', r.result, 'canonical', r.canonicalResult, 'value', value);
    } catch (e) {
      console.log('pid', pid, 'ERR', e.message);
    }
  }
})().catch(e => {console.error(e.stack); process.exitCode = 1;});
