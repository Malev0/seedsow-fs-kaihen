// List (and optionally delete) entries on the mounted save filesystem.
// Usage: node save-list.cjs [--delete name ...]
const fs = require('node:fs');
const path = require('node:path');

const PROJECT = path.resolve(__dirname, '..');
const top = fs.readdirSync(PROJECT).find(n => /2jb-main$/.test(n));
const nested = fs.readdirSync(path.join(PROJECT, top)).find(n => /2jb-main$/.test(n));
const engine = path.join(PROJECT, top, nested, 'engine');
const app = path.join(engine, 'switch2', 'app');
const {connect} = require(path.join(app, 'session.cjs'));
const mounted = require(path.join(app, 'mounted-save.cjs'));
const filesystem = require(path.join(app, 'filesystem.cjs'));
const domain = require(path.join(app, 'domain.cjs'));
const {paths} = require(path.join(engine, 'switch2', 'memory', 'paths.cjs'));

(async () => {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--path');
  const where = at >= 0 ? argv[at + 1] : '/';
  const args = argv.filter((value, i) => at < 0 || (i !== at && i !== at + 1));
  const {s} = await connect('save-list-' + Date.now(), 0x100000);
  try {
    const {normal} = paths(s, domain);
    const saved = await mounted.cloneMountedFilesystem(s, 'save');
    const entries = await filesystem.listDirectory(s, saved, where, 256).catch(error => {
      console.error('list failed: ' + error.message);
      return [];
    });
    entries.sort((a, b) => Number(BigInt(b.size) - BigInt(a.size)));
    for (const entry of entries)
      console.log(`${entry.size.padStart(12)}  type=${entry.type}  ${entry.name}`);
    const space = await normal(saved, 11, '/');
    console.log('free', space.result, space.result ? null : space.data.readBigUInt64LE().toString());
    if (argv.includes('--clean')) {
      // Remove every /NS2_GAP_* tree left by a previous probe (the 16 MiB
      // commit_data is what matters), then commit so the space is reclaimed.
      async function removeTree(dir) {
        const children = await filesystem.listDirectory(s, saved, dir, 256).catch(() => []);
        for (const child of children) {
          const target = dir + '/' + child.name;
          if (child.type === 0) await removeTree(target);
          else {
            const reply = await normal(saved, 4, target);
            console.log('delete', target, reply.result, reply.canonicalResult);
          }
        }
        const reply = await normal(saved, 4, dir);
        console.log('delete', dir, reply.result, reply.canonicalResult);
      }
      for (const entry of entries)
        if (entry.type === 0 && entry.name.startsWith('NS2_GAP_')) await removeTree('/' + entry.name);
    }
    for (const name of args) {
      if (name === '--clean') continue;
      const target = name.startsWith('/') ? name : '/' + name;
      const reply = await normal(saved, 4, target);
      console.log('delete', target, reply.result, reply.canonicalResult);
    }
    if (args.length || argv.includes('--clean')) {
      const committed = await s.ipc('Commit save cleanup', saved, 10);
      console.log('commit', committed.result, committed.canonicalResult);
      const after = await normal(saved, 11, '/');
      console.log('free after', after.result, after.result ? null : after.data.readBigUInt64LE().toString());
    }
  } finally {
    await s.cleanup();
  }
})().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
