// Remove the scratch tree left by a prior probe. The 16 MiB commit_data is
// what matters; the command-4 deletes of the directory are best-effort.
// Exported for pipeline.cjs; a CLI scratch path still works.
const fs = require('node:fs/promises');
const path = require('node:path');
const {connect} = require('./session.cjs');
const {paths} = require('./paths.cjs');

async function latestScratch() {
  const entries = await fs.readdir(__dirname);
  const reports = [];
  for (const name of entries) {
    if (!/^reserved-gap-.*\.json$/.test(name)) continue;
    const file = path.join(__dirname, name);
    const stat = await fs.stat(file);
    reports.push({file, time: stat.mtimeMs});
  }
  reports.sort((a, b) => b.time - a.time);
  for (const {file} of reports) {
    try {
      const report = JSON.parse(await fs.readFile(file, 'utf8'));
      if (report.scratch) return report.scratch;
    } catch {}
  }
  return null;
}

async function main(rootArg) {
  const root = rootArg || await latestScratch();
  if (!root) { console.log('no prior scratch'); return {skipped: true}; }
  const {s, directory} = await connect('scratch-clean', 0x100000);
  try {
    const domain = require(path.join(directory, 'domain.cjs'));
    const mounted = require(path.join(directory, 'mounted-save.cjs'));
    const {normal} = paths(s, domain);
    const saved = await mounted.cloneMountedFilesystem(s, 'save');
    for (const target of [root + '/commit_data', root + '/canary', root + '/selected', root]) {
      const reply = await normal(saved, 4, target);
      console.log(JSON.stringify({delete: target, result: reply.result,
        canonical: reply.canonicalResult}));
    }
    const committed = await s.ipc('Commit scratch cleanup', saved, 10);
    console.log('commit', committed.result, committed.canonicalResult);
    const space = await normal(saved, 11, '/');
    const free = space.result ? null : space.data.readBigUInt64LE().toString();
    console.log('free', space.result, free);
    return {root, free};
  } finally {
    await s.cleanup();
  }
}

module.exports = {main};
if (require.main === module)
  main(process.argv[2]).catch(error => {console.error(error.stack || error); process.exitCode = 1;});
