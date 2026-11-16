// Track the one acquisition run. Stop at a checkpoint, then finish restoration.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');

class StopRequested extends Error {
  constructor() {super('Run stopped at a checkpoint'); this.name = 'StopRequested';}
}

class RunControl {
  constructor({id, save}) {
    this.save = save;
    this.events = new EventEmitter();
    this.state = {id, pid: process.pid, mode: 'running', active: false, checkpoint: 'starting'};
    this.stopSignal = () => {
      if (this.state.mode !== 'running') return;
      this.state.mode = 'stopping';
      this.events.emit('stop');
    };
  }
  async start() {
    this.state.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ns2-'));
    try { await fs.chmod(this.state.directory, 0o700); } catch {}
    this.started = true;
    process.on('SIGINT', this.stopSignal);
    process.on('SIGTERM', this.stopSignal);
    await this.save();
  }
  async checkpoint(name) {
    this.state.active = false;
    this.state.checkpoint = name;
    await this.save();
    if (['stopping', 'closed'].includes(this.state.mode)) throw new StopRequested();
  }
  async begin(name) {
    await this.checkpoint('before ' + name);
    this.state.active = true;
    this.state.checkpoint = name;
    await this.save();
  }
  async end(name) {await this.checkpoint('after ' + name);}
  retire() {this.state.mode = 'retiring';}
  async close() {
    process.off('SIGINT', this.stopSignal);
    process.off('SIGTERM', this.stopSignal);
    this.state.active = false;
    this.state.mode = 'closed';
    if (this.started) { try { await fs.rmdir(this.state.directory); } catch {} }
    this.started = false;
  }
}

// Windows refuses a rename over a file another process has open, and
// acquire.cjs polls this report while the probe writes it. Retry briefly.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {return await fs.rename(from, to);}
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 40) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

// Latest-wins report writer. The probe calls save() several times per wave and
// a wave is seconds long, so serialising a 300 KB report for each call was
// pure host cost with no forensic value: only the newest state can matter.
// Bytes for a call that is still queued are replaced by the newer call, and
// every caller awaits the drain that includes its own state.
function reportWriter(file, snapshot) {
  const replacer = (_, v) => typeof v === 'bigint' ? v.toString() : v;
  let queued = null, running = null, error = null;
  async function drain() {
    for (; ;) {
      if (queued === null) break;
      const bytes = queued;
      queued = null;
      try {
        const temporary = file + '.' + process.pid + '.tmp';
        await fs.writeFile(temporary, bytes, {mode: 0o600});
        await renameWithRetry(temporary, file);
      } catch (failure) {
        // A report write must never kill a run that is otherwise healthy.
        error = failure;
      }
    }
    running = null;
  }
  const save = () => {
    queued = JSON.stringify(snapshot(), replacer, 2) + '\n';
    if (!running) running = drain();
    return running;
  };
  save.error = () => error;
  return save;
}

module.exports = {RunControl, StopRequested, reportWriter};
