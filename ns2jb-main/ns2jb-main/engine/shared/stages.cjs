const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {runDirectory, runPath} = require('./paths.cjs');

// A stage is never retried after a timeout or incomplete cleanup. Each stage
// keeps its native ownership records in the current launch directory.
async function run(directory, name, args = [], timeout = 10 * 60 * 1000) {
  if (!/^[a-z0-9-]+$/.test(name)) throw Error('Invalid stage name');
  console.log(name.replaceAll('-', ' ') + (args.length ? ': ' + args.join(' ') : ''));
  // Stage output is a run artifact, not source: keep it with the rest of the
  // run instead of next to the script it invoked.
  const file = runPath(name + '-' + Date.now() + '.log');
  const log = await fs.open(file, 'wx+', 0o600);
  let timedOut = false, timer, killTimer;
  try {
    const child = spawn(process.execPath, [path.join(directory, name + '.cjs'), ...args.map(String)],
      {cwd: directory, stdio: ['ignore', log.fd, log.fd], windowsHide: true});
    timer = setTimeout(() => {
      timedOut = true; child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeout);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0 || timedOut)
      throw Error(`${name} ${timedOut ? 'timed out' : 'failed'}. Inspect ${file}; restart the application before a new launch.`);
    const {size} = await log.stat();
    const tail = Buffer.alloc(Math.min(size, 1024 * 1024));
    await log.read(tail, 0, tail.length, size - tail.length);
    const runDir = runDirectory();
    for (const line of tail.toString().trim().split('\n').reverse()) {
      let value;
      try {value = JSON.parse(line);} catch {continue;}
      if (!value.file || !path.isAbsolute(value.file)) continue;
      // The report must be the one this child just wrote: either inside the run
      // directory (normal) or next to its own script (entry point without a run).
      if (runDir && !value.file.startsWith(runDir + path.sep) && !value.file.startsWith(directory + path.sep))
        continue;
      if (!await fs.stat(value.file).catch(() => null)) continue;
      return {...JSON.parse(await fs.readFile(value.file, 'utf8')), file: value.file, summary: value};
    }
    return null;
  } finally {clearTimeout(timer); clearTimeout(killTimer); await log.close();}
}

module.exports = {run};
