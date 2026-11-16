#!/usr/bin/env node
'use strict';
// Stage the kaiHEN release and start HEN through ldr:ro.
//
// This is the FS-only path: the Seedsow app's NPDM grants ldr:ro, so the
// bootstrap NRO can be mapped and executed. The bootstrap builds the HEN
// package from the staged files and the Loader migration main.npdm, then
// starts HEN.
//
// Requires:
//   - a held FS endpoint with the kaiHEN RO replacement running (pipeline --hen)
//   - the compiled kaiHEN release in <repo>/kaihen
//   - an SD card inserted (HEN stages /kaihen, /switch and /hbmenu.nro there)
const fs = require('node:fs');
const path = require('node:path');

const ENGINE = path.join(__dirname, '..', 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2');
const {request: endpointRequest} = require(path.join(ENGINE, 'tools', 'endpoint.cjs'));
const SHIP = process.env.KAIHEN_SHIP || path.join(__dirname, '..', 'kaihen');
const {main: startHen} = require(path.join(ENGINE, 'ro', 'start-hen.cjs'));
const {connect} = require(path.join(ENGINE, 'tools', 'fs-memory.cjs'));

const ship = (...parts) => path.join(SHIP, ...parts);

// One line on the console screen. Best effort: the bridge's `say` runs a print
// in the game, which the launcher draws in its overlay.
function announce(text) {
  try {
    require(path.join(ENGINE, '..', 'shared', 'rpc.cjs'))
      .request({command: 'say', text, timeoutMs: 2000}).catch(() => {});
  } catch { /* screen banner is a nicety */ }
}

async function probe() {
  const memory = await connect();
  const info = await memory.request({command: 'root-native-info'});
  const current = JSON.parse(fs.readFileSync(path.join(ENGINE, 'current-acquisition.json'), 'utf8'));
  const report = JSON.parse(fs.readFileSync(current.report, 'utf8'));
  const root = report.ownedRoot?.clones?.[0];
  const sm = info.services?.find(item => item.sm)?.sm;
  const result = {session: info.session, worker: Boolean(info.worker?.joined),
    donor: Boolean(info.donor?.ready), notifiers: info.notifiers?.length || 0,
    services: (info.services || []).map(item => item.name)};
  if (!sm) {
    result.ldr = 'no retained SM client';
    return result;
  }
  const ldr = await memory.request({command: 'root-native-sm-service', handle: sm, name: 'ldr:ro'});
  result.ldr = {result: ldr.result, transport: ldr.transport, opened: ldr.moves?.length === 1};
  if (ldr.moves?.length)
    await memory.request({command: 'root-native-close-handle', handle: ldr.moves[0]}).catch(() => {});
  if (!root) {
    result.sd = 'no owned FS root';
    return result;
  }
  const sd = await memory.request({command: 'root-native-ipc', handle: root, id: 18, hex: ''});
  result.sd = {result: sd.result, transport: sd.transport, opened: sd.moves?.length === 1};
  // Older endpoints do not have close-owned; leaking one SD handle is harmless.
  if (sd.moves?.length)
    await memory.request({command: 'root-native-close-owned', handle: sd.moves[0]}).catch(() => {});
  return result;
}

async function main() {
  // A close-path bisect boot stops the pipeline early on purpose; the controller
  // still runs this tool afterwards, so make it a no-op.
  if (process.env.NS2_HEN_SKIP === '1') {
    console.log('HEN skipped (NS2_HEN_SKIP=1)');
    return;
  }
  for (const file of ['ro/main', 'hen/main', 'game/main', 'bootstrap.bin', 'hbmenu.nro']) {
    if (!fs.statSync(ship(file), {throwIfNoEntry: false})?.isFile())
      throw Error('Missing kaihen/' + file);
  }
  process.env.HBMENU_NRO = ship('hbmenu.nro');
  const programs = fs.readdirSync(ship('programs'), {withFileTypes: true})
    .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
    .map(entry => ({source: ship('programs', entry.name), target: `/switch/${entry.name}`}));

  console.log('Staging HEN to SD and starting it through ldr:ro...');
  // The fourth main stage of a HEN boot; the pipeline covers 1-3.
  announce('[ns2jb] stage 4: HEN');
  const started = await startHen(ship('hen', 'main'), ship('bootstrap.bin'),
    ship('game', 'main'), programs);
  console.log(JSON.stringify({started, ship: SHIP}, null, 2));
  // The console RPC loop is still running here - the detach below is what stops
  // it - so this is the last moment a banner can reach the screen. If the retire
  // inside startHen already wedged the console the line simply does not appear.
  announce('[ns2jb] HEN ready (pid ' + started.pid + ')');
  // HEN owns the system now; this app has no further job. Retire the retained
  // endpoint so the exploit's cache entry is restored: a half-retired endpoint
  // leaves a poisoned cache entry installed, and that is what hangs the app and
  // the console UI (see acquire.cjs retire()).
  if (process.env.NS2_HEN_RETIRE !== '0') {
    // start-hen.cjs retires after Complete in this mode. Asking a second time
    // only reaches a pipe whose endpoint has just closed, which is the
    // "connect ENOENT ...-memory" line that looked like a failed retire.
    let record = null;
    try { record = JSON.parse(fs.readFileSync(started.file, 'utf8')); } catch {}
    if (record?.retire)
      console.log(JSON.stringify({retired: {alreadyRetired: record.retire}}, null, 2));
    else
      console.log(JSON.stringify({retired: await retireEndpoint()}, null, 2));
  }
  // The console-side RPC loop (console/n2h_rpc.lua R.serve) was started
  // through the launcher's /eval, and that /eval handler only returns when the
  // loop ends - so the app keeps a Lua coroutine blocked in a socket loop plus
  // an open HTTP connection for the whole session. Closing the game in that
  // state is what leaves "closing software" spinning and then takes the
  // console down. Stop the loop once HEN is up: nothing of ours may talk to the
  // console after this point anyway, and HEN does not use it.
  if (process.env.NS2_HEN_DETACH !== '0') {
    // Never detach over a cleanup that is still running: the endpoint's
    // post-retire cleanup is what closes the app's handles, and in
    // switch-tNBR5 the shutdown raced it and left 42 handles open.
    let record = null;
    try { record = JSON.parse(fs.readFileSync(started.file, 'utf8')); } catch {}
    const retire = record?.retire;
    if (retire && retire.cleanedUp === false && !retire.cleanupSkipped) {
      console.log(JSON.stringify({detached: {skipped: 'retire cleanup did not finish',
        cleanupError: retire.cleanupError || null}}, null, 2));
    } else {
      // Optional wait before stopping the console RPC loop, so a freeze can be
      // timed against the last two things we do: the retire (before this) and
      // the detach (after it). With 0 the detach follows immediately.
      const delayMs = Math.max(0, Number(process.env.NS2_HEN_DETACH_DELAY_MS || 0));
      if (delayMs) {
        console.log(JSON.stringify({detachDelayMs: delayMs, at: new Date().toISOString()}, null, 2));
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      const result = await detachConsole();
      console.log(JSON.stringify({detached: result, at: new Date().toISOString()}, null, 2));
    }
  }
}

// Ask the bridge to send the serve loop's stop command (cmd 11). The bridge
// drops its console socket afterwards, so this is the last console request of
// the boot; a Release afterwards cannot reach the console.
async function detachConsole(timeoutMs = 8000) {
  // Never let this step fail the run: HEN is already up by the time it is
  // called, and the worst case is that the console keeps its RPC loop until it
  // idles out (75 s), which is exactly the old behaviour.
  try {
    // ENGINE is engine/switch2; the transport lives in engine/shared.
    const transport = require(path.join(ENGINE, '..', 'shared', 'rpc.cjs'));
    const reply = await transport.request({command: 'rpc-shutdown', timeoutMs});
    return {stopped: Boolean(reply?.stopped)};
  } catch (error) {
    return {error: error.message};
  }
}

// Same request acquire.cjs retire() sends, from this process: the supervisor
// socket is recorded in current-acquisition.json.
async function retireEndpoint() {
  try {
    const current = JSON.parse(fs.readFileSync(path.join(ENGINE, 'current-acquisition.json'), 'utf8'));
    // start-hen.cjs retires as soon as the module reports Complete, which is
    // earlier and better; this is only the fallback for an older path.
    let already = null;
    try { already = JSON.parse(fs.readFileSync(current.report, 'utf8')); } catch {}
    if (already?.cleanedUp) return {alreadyRetired: true};
    const reply = await endpointRequest(current.socketPath, {command: 'retire'}, 120000, 120000);
    const deadline = Date.now() + 60000;
    let report = null;
    while (Date.now() < deadline) {
      try { report = JSON.parse(fs.readFileSync(current.report, 'utf8')); } catch {}
      if (report?.cleanedUp) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return {reply, cleanedUp: Boolean(report?.cleanedUp), cleanupError: report?.cleanupError || null};
  } catch (error) {
    return {error: error.message};
  }
}

if (require.main === module) {
  // --detach alone stops the console RPC loop on an already-started boot, for
  // when HEN is running and the app is about to be closed by hand.
  if (process.argv.includes('--detach') && !process.argv.includes('--probe')) {
    detachConsole().then(result => console.log(JSON.stringify({detached: result}, null, 2)))
      .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
  } else {
  const run = process.argv.includes('--probe') ? probe : main;
  run().then(result => {
    if (process.argv.includes('--probe')) console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
  }
}

module.exports = {main, probe, detachConsole};
