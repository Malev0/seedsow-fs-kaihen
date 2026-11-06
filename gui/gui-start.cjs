// Fire-and-forget POST /api/start (the controller runs for minutes; do not wait).
const http = require('node:http');
const req = http.request(
  {host: '127.0.0.1', port: Number(process.env.NS2_GUI_PORT || 31338), path: '/api/start', method: 'POST'},
  res => res.resume());
req.on('error', err => console.error('start failed:', err.message));
req.end();
setTimeout(() => { console.log('start sent'); process.exit(0); }, 800);
