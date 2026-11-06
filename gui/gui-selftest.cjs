// Self-test of the controller API. Never starts a run (POST /api/start blocks
// until the whole run is over; use `npm`-less helper gui-start.cjs for that).
const base = 'http://127.0.0.1:31338';
const get = async p => {
  const r = await fetch(base + p);
  return {status: r.status, type: r.headers.get('content-type'), body: await r.text()};
};
(async () => {
  const page = await get('/');
  console.log('GET / ->', page.status, page.type, 'bytes', page.body.length,
    'start', page.body.includes('id="start"'), 'crashed', page.body.includes('id="crashed"'),
    'log', page.body.includes('id="log"'));

  const state = JSON.parse((await get('/api/state')).body);
  console.log('GET /api/state ->', state.phase, '| consoleUp', state.consoleUp, '| stage', JSON.stringify(state.stage));
  console.log('  message:', state.message);

  const log = JSON.parse((await get('/api/log?since=0')).body);
  console.log('GET /api/log ->', log.lines.length, 'line(s)');
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
