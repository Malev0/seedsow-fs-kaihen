// Sanity check for the probe's describePhase mapping (same logic as the probe).
function describePhase(profile) {
  const name = String(profile);
  const cache = /^cache-(.*)-(\d+)-(\d+)$/.exec(name);
  if (cache) {
    const step = cache[1], batch = Number(cache[2]), attempt = Number(cache[3]);
    const label = step.replace(/-/g, ' ');
    if (step.startsWith('combined-leak')) {
      return {percent: 54 + Math.min(9, batch * 3 + Math.min(2.5, attempt * 0.1)),
        label: 'clean cache alias: ' + label};
    }
    if (step.startsWith('address-header')) {
      return {percent: 92 + Math.min(3, batch + Math.min(2.5, attempt * 0.1)),
        label: 'address matrix: ' + label};
    }
    if (step.startsWith('period-offset') || step.startsWith('retire-address-entry')) {
      return {percent: 88 + Math.min(2, batch), label: 'address preparation: ' + label};
    }
    return {percent: 64, label: 'cache control: ' + label};
  }
  if (name === 'extent-absent') return {percent: 10, label: 'input extent control'};
  if (name === 'extent-present') return {percent: 16, label: 'requalifying the input extent'};
  if (name.startsWith('abort-')) return {percent: 22, label: name.replace(/-/g, ' ')};
  if (name === 'negative') return {percent: 28, label: 'negative canary control'};
  if (name === 'positive') return {percent: 34, label: 'positive canary wave'};
  if (name === 'address-encoding-control') return {percent: 50, label: 'pointer encoding control'};
  return {percent: 8, label: name.replace(/-/g, ' ')};
}

const samples = [
  'extent-absent', 'extent-present', 'abort-control', 'abort-hole-control', 'negative', 'positive',
  'address-encoding-control',
  'cache-combined-leak-0-0-0', 'cache-combined-leak-0-17-0', 'cache-combined-leak-1-3-1', 'cache-combined-leak-2-39-0',
  'cache-period-offset-3-0-0', 'cache-retire-address-entry-0-0-1',
  'cache-address-header-40-0-2', 'cache-address-header-40-2-9',
];
for (const s of samples) {
  const p = describePhase(s);
  console.log(String(s).padEnd(36), String(Math.round(p.percent)).padStart(3) + '%', p.label);
}
