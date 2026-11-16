// Native FS client operations on retained handles; all buffers belong to s.
const fs = require('node:fs/promises');
const path = require('node:path');
const {artifactDir} = require('../../shared/paths.cjs');
const OUT = artifactDir(__dirname);
const crypto = require('node:crypto');
const {packet} = require("../../shared/ipc.cjs");
const check = (ok, message) => { if (!ok) throw Error(message); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const progressFile = path.join(OUT, 'kaihen-donor-progress.log');
const progress = step => fs.appendFile(progressFile,
  `${new Date().toISOString()} ${step}\n`).catch(() => {});

function pathRequest(command, input, address, length = 0x301) {
  const bytes = packet(command, input), pointer = BigInt(address);
  bytes.writeUInt32LE(4 | 1 << 16);
  bytes.writeUInt32LE(Number(BigInt(length) << 16n | (pointer >> 36n & 7n) << 6n |
    (pointer >> 32n & 15n) << 12n), 8);
  bytes.writeUInt32LE(Number(pointer & 0xffffffffn), 12);
  return bytes;
}

// Open an application package on the host and return the domain row the
// bootstrap's mount exchange needs. The bootstrap cannot do this itself on this
// console (FS answers its own cmd 10 with 0x20801), but the host's framing is
// proven - see ro/hen-package-probe.json.
async function packageRow(context, request, state, domain) {
  const {s, live, save} = context;
  const root = Number(request.root), kind = String(request.kind || 'hen');
  check(s.handles.has(root), 'Package row requires the owned FS root');
  let built = null, staged = null;
  if (request.build) {
    // Build and stage the package from the host: capture the migration title's
    // policy, pack main + main.npdm, write it to SD. The bootstrap's own
    // writeExeFsPackage can stall on this console (2026-11-14 19:11), and the
    // host's FS writes are proven by every earlier run.
    const title = BigInt(request.title || '0x040000000000003a');
    const loader = Number(request.loader);
    check(s.handles.has(loader), 'Package build requires the Loader root copy');
    const code = await dispatch(context, {command: 'root-native-code-open', handle: loader,
      title: title.toString(), fresh: true}, state, domain);
    check(!code.result && code.handle, 'Migration CodeFS did not open: 0x' +
      Number(code.result).toString(16));
    await dispatch(context, {command: 'root-native-file-capture', handle: code.handle,
      name: 'main.npdm'}, state, domain);
    const directory = path.join(OUT, live.session + '-code-' +
      title.toString(16).padStart(16, '0'));
    const policy = path.join(directory, 'main.npdm');
    check((await fs.stat(policy).catch(() => null))?.size > 0,
      'Migration policy was not captured: ' + policy);
    const packageFile = path.join(OUT, live.session + '-kaihen-hen-exefs.nsp');
    built = await require('./package-build.cjs').build(String(request.image), policy, packageFile);
    staged = await require('./package.cjs').dispatch(context,
      {command: 'root-native-package-stage', kind, root, source: packageFile}, state, domain);
    console.log(JSON.stringify({stage: 'hen-package-built', size: built.size,
      path: staged.path, policy: {size: (await fs.stat(policy)).size}}));
  }
  if (request.open === false) {
    // Build and stage only: the module opens the package itself (upstream path).
    const row = {kind, built, staged, opened: false};
    (state.packageRows ||= []).push(row);
    await save();
    console.log(JSON.stringify({stage: 'package-staged', kind,
      path: staged && staged.path, size: built && built.size}));
    return row;
  }
  const opened = await require('./package.cjs').dispatch(context,
    {command: 'root-native-package-open', root, kind}, state, domain);
  check(!opened.result && opened.root > 0,
    'Package did not open: 0x' + Number(opened.result).toString(16));
  const retained = context.retained;
  check(retained, 'Package row requires the retained FS memory reader');
  const layout = JSON.parse(await fs.readFile(path.join(OUT, live.session + '-layout.json')));
  const entry = layout.table + (opened.root - 1) * 0x30;
  const read = async at => Number((await retained.read(at, 8)).readBigUInt64LE());
  const object = await read(entry + 0x20);
  const metadata = await read(entry + 0x28);
  const vptr = await read(object);
  check(object > 1 && metadata > 1 && vptr > 1, 'Opened package has no domain object');
  const row = {kind, root: opened.root, handle: opened.handle, title: request.title || null,
    entry, object, metadata, vptr,
    files: (opened.entries || []).map(item => ({name: item.name, size: item.size, sha256: item.sha256}))};
  (state.packageRows ||= []).push(row);
  await save();
  console.log(JSON.stringify({stage: 'package-row', ...row, files: row.files.map(f => f.name)}));
  return row;
}

async function dispatch(context, request, state, domain) {
  const {s, live, save} = context;
  const command = request.command.slice('root-native-'.length);
  // `file-` so control.cjs routes it here (see packageRow above).
  if (command === 'file-package-row') return packageRow(context, request, state, domain);
  if (command === 'code-close') {
    const handle = Number(request.handle);
    const code = state.codeFileSystems?.find(item => item.handle === handle);
    check(!s.threads.size && code && s.handles.has(handle) &&
      code !== state.codeFileSystems[0] && !code.domainRoot,
    'Close requires an idle analysis CodeFS; the retained binding is preserved');
    await s.close(handle);
    code.closedAt = new Date().toISOString();
    (state.closedCodeFileSystems ||= []).push(code);
    state.codeFileSystems = state.codeFileSystems.filter(item => item !== code);
    await save();
    return {handle, title: code.title, closed: true, at: code.closedAt};
  }
  if (command === 'code-domain') {
    const handle = Number(request.handle);
    const code = state.codeFileSystems?.find(item => item.handle === handle);
    check(code && s.handles.has(handle), 'Code-domain conversion requires the owned CodeFS');
    if (!code.domainRoot) {
      const reply = await domain.send(s, 'RO CodeFS ConvertToDomain', handle, domain.wire.control(0));
      check(!reply.result && reply.data.readUInt32LE() > 0, 'CodeFS domain conversion failed');
      code.domainRoot = reply.data.readUInt32LE();
      check(code.domainRoot <= 0x4000, 'CodeFS object ID exceeds the native domain capacity');
      await save();
    }
    return {handle, root: code.domainRoot};
  }
  if (command === 'donor-cleanup') {
    const donor = state.donor;
    check(donor?.ready && !donor.pendingRemoval && !s.threads.size && !s.pendingIpc && state.worker?.joined,
      'Donor cleanup requires the completed launch and an idle worker');
    // kaiHEN opens the donor as an application package on SD. Loader has its
    // own reference after the mount exchange; closing our clone is enough.
    if (donor.mount === 'package') {
      if (s.handles.has(donor.handle)) await s.close(donor.handle);
      donor.cleanedUp = true; await save();
      return {cleanedUp: true, package: donor.kind, files: (donor.files || []).map(item => item.name)};
    }
    const filesystem = require('../app/filesystem.cjs');
    const handle = await require('../app/mounted-save.cjs').cloneMountedFilesystem(s, donor.mount || 'save');
    try {
      for (const item of donor.files.filter(item => item.created && !item.removed)) {
        check(['main', 'main.npdm'].includes(item.name) && item.verified, 'Unknown donor file');
        const name = '/' + item.name;
        const opened = await filesystem.openFile(s, handle, name);
        check(!opened.result, 'Owned donor file is missing');
        try {
          check(await filesystem.fileSize(s, opened.handle) === BigInt(item.size) &&
            hash(await filesystem.readFile(s, opened.handle, 0, item.size)) === item.sha256,
          'Owned donor file changed');
        } finally {await s.close(opened.handle);}
        donor.pendingRemoval = item.name; await save();
        const filename = Buffer.alloc(0x301); filename.write(name);
        await s.write(s.base + 0x2000, filename);
        const removed = await domain.send(s, 'Remove owned RO donor ' + name, handle,
          pathRequest(1, Buffer.alloc(0), s.base + 0x2000));
        check(!removed.result, 'Donor file removal failed');
        check(!(await s.ipc('Commit donor cleanup', handle, 10)).result, 'Donor cleanup commit failed');
        check((await filesystem.pathMethod(s, handle, 7, name)).canonicalResult === 0x202,
          'Owned donor file still exists');
        item.removed = true; delete donor.pendingRemoval; await save();
      }
    } finally {await s.close(handle);}
    donor.cleanedUp = true; await save();
    return {cleanedUp: true, files: donor.files.filter(item => item.removed).map(item => item.name)};
  }
  if (command === 'donor-prepare') {
    // kaiHEN opens the donor through FS as an application package, the same
    // route its bootstrap uses for HEN. Loader's mounted CodeFS and the donor
    // are then the same concrete filesystem class, so kaiHEN's DomainMount
    // exchange (metadata + vptr equality) can redirect the mount entry.
    const kaihenDir = process.env.KAIHEN_DIR ||
      path.join(__dirname, '../../../../../kaihen');
    await progress('prepare-begin');
    const image = path.join(kaihenDir, 'ro', 'main');
    const policy = path.join(OUT, live.session + '-code-0400000000000037/main.npdm');
    const imageBytes = await fs.readFile(image);
    const policyBytes = await fs.readFile(policy);
    check(imageBytes.length > 0 && imageBytes.subarray(0, 4).toString() === 'NSO0',
      'kaiHEN ro/main is missing or not an NSO0 image');
    check(policyBytes.length > 0, 'The captured RO policy is missing');
    check(!s.threads.size, 'Prepare the donor before launching a worker');
    if (state.donor?.ready) {
      check(state.donor.mount === 'package' && state.donor.kind === 'ro',
        'The donor was already prepared from another source; reboot before changing it');
      return state.donor;
    }
    const root = context.report.ownedRoot?.clones?.[0];
    check(s.handles.has(root), 'Owned FS root for the donor package is missing');
    const build = require('./package-build.cjs');
    const packageFile = path.join(OUT, live.session + '-kaihen-ro-exefs.nsp');
    const built = await build.build(image, policy, packageFile);
    await progress('build-done ' + built.size);
    console.log(JSON.stringify({stage: 'donor-package-built', size: built.size, image: imageBytes.length}));
    const package = require('./package.cjs');
    let staged;
    if (process.env.NS2_KAIHEN_SKIP_STAGE === '1') {
      // Diagnostic: the user copied kaihen/ro/exefs.nsp to the SD card from a
      // PC, so test package-open without an SD write from the console.
      await progress('stage-skipped');
      staged = {path: '@Sdcard:/kaihen/bin/ro/exefs.nsp', size: built.size,
        sha256: hash(await fs.readFile(packageFile))};
    } else {
      await progress('stage-begin');
      staged = await package.dispatch(context,
        {command: 'root-native-package-stage', kind: 'ro', root, source: packageFile}, state, domain);
      await progress('stage-done ' + staged.size);
    }
    console.log(JSON.stringify({stage: 'donor-package-staged', path: staged.path, size: staged.size}));
    await progress('open-begin');
    const opened = await package.dispatch(context,
      {command: 'root-native-package-open', kind: 'ro', root, selectDonor: true}, state, domain);
    await progress('open-done ' + opened.root);
    check(!opened.result && opened.root > 0,
      'kaiHEN RO package did not open: 0x' + Number(opened.result).toString(16));
    console.log(JSON.stringify({stage: 'donor-package-opened', root: opened.root}));
    await progress('verify-begin');
    const openedMain = opened.entries?.find(item => item.name === 'main');
    const openedPolicy = opened.entries?.find(item => item.name === 'main.npdm');
    check(openedMain?.sha256 === hash(imageBytes) && openedPolicy?.sha256 === hash(policyBytes),
      'The opened donor package does not contain the staged RO image and policy');
    await progress('verify-ok');
    console.log(JSON.stringify({stage: 'donor-package-verified', files: opened.entries.map(item => item.name)}));
    // Atmosphere's Loader mounts /atmosphere/contents/<id>/exefs.nsp before the
    // base code (ScopedCodeMount::Initialize ->
    // MountCodeForAtmosphereWithRedirection), so the donor can be the mount
    // itself instead of an entry swapped after the reply. Non-fatal: if the SD
    // policy refuses the path the normal launch path still runs.
    if (process.env.NS2_EXEFS_REDIRECT !== '0') {
      try {
        const redirect = await package.dispatch(context, {command: 'root-native-file-stage',
          root, target: '/atmosphere/contents/0400000000000037/exefs.nsp',
          source: packageFile}, state, domain);
        built.redirect = redirect;
        console.log(JSON.stringify({stage: 'donor-exefs-redirect', ...redirect}));
      } catch (error) {
        built.redirectError = error.message;
        console.log(JSON.stringify({stage: 'donor-exefs-redirect-failed',
          error: error.message}));
      }
    }
    // Leave the domain entry read to ro/bind-sessions, which already computes
    // entry/object/metadata/vptr for both the donor and the stock CodeFS. That
    // isolates this stage to the package open and avoids a post-open retained
    // read before we know whether the app survives it.
    state.donor = {...state.donor,
      files: (opened.entries || []).map(item => ({...item, verified: true})),
      image: {file: image, size: imageBytes.length, sha256: hash(imageBytes)},
      policy: {file: policy, size: policyBytes.length, sha256: hash(policyBytes)},
      package: {file: built.file, size: built.size, staged,
        redirect: built.redirect ?? null, redirectError: built.redirectError ?? null}};
    await progress('donor-saved');
    await save();
    await progress('donor-return');
    return state.donor;
    state.donor = {...state.donor,
      files: (opened.entries || []).map(item => ({...item, verified: true})),
      entry: address, object, metadata, vptr,
      image: {file: image, size: imageBytes.length, sha256: hash(imageBytes)},
      policy: {file: policy, size: policyBytes.length, sha256: hash(policyBytes)},
      package: {file: built.file, size: built.size, staged}};
    await save();
    return state.donor;
  }
  if (command === 'file-fs-swap') {
    // Pre-mount content filesystem redirect. The stock CodeFS object and the
    // kaiHEN package donor are the same FileStorageBasedFileSystem class
    // (vptr + metadata match). Copy the donor object header over the content
    // object before the Loader mount, so the mount handler's /main open uses
    // the donor package internals. This opens no files.
    const retained = context.retained;
    check(retained, 'FS swap requires the retained FS memory reader');
    const types = JSON.parse(await fs.readFile(path.join(OUT, live.session + '-filesystem-types.json')));
    const codeRow = types.rows.find(item => item.name === 'code');
    const donorRow = types.rows.find(item => item.name === 'donor');
    check(codeRow && donorRow && codeRow.vptr === donorRow.vptr && codeRow.metadata === donorRow.metadata,
      'CodeFS and donor are not the same filesystem class');
    const size = 0x40;
    const before = await retained.read(codeRow.object, size);
    const donorHeader = await retained.read(donorRow.object, size);
    await retained.write(codeRow.object, donorHeader);
    const after = await retained.read(codeRow.object, size);
    check(after.equals(donorHeader), 'Content filesystem header did not take the donor clone');
    state.fsSwap = {at: new Date().toISOString(), object: codeRow.object, donor: donorRow.object,
      vptr: codeRow.vptr, metadata: codeRow.metadata, before: before.toString('hex'),
      after: after.toString('hex')};
    await progress('fs-swap-done ' + codeRow.object);
    await save();
    return state.fsSwap;
  }
  if (command === 'file-fs-swap-restore') {
    const swap = state.fsSwap, retained = context.retained;
    check(swap && retained, 'No filesystem header swap to restore');
    const before = Buffer.from(swap.before, 'hex');
    await retained.write(swap.object, before);
    const after = await retained.read(swap.object, before.length);
    check(after.equals(before), 'Content filesystem header restore failed');
    swap.restored = new Date().toISOString();
    await save();
    return swap;
  }
  if (command === 'file-code-swap') {
    // Fix A: point the host's cached code filesystem entry at the donor
    // package object before the launch. If the mount handler reuses that cached
    // code FS, the mount reply itself is the donor and the Loader's /main open
    // (which beats any post-reply exchange) reads kaiHEN's main.
    const donor = state.donor;
    check(donor?.ready && donor.root > 0 && s.handles.has(donor.handle),
      'Code swap requires the kaiHEN package donor');
    const types = JSON.parse(await fs.readFile(
      path.join(OUT, live.session + '-filesystem-types.json')));
    // `state.donor` is the package handle record; the entry address, object
    // and metadata come from bind-sessions' analysed rows.
    const donorRow = types.rows?.find(item => item.name === 'donor');
    const code = types.rows?.find(item => item.name === 'code');
    check(code?.entry > 0 && code.object > 0 && donorRow?.object > 0 &&
      donorRow.root === donor.root && code.metadata === donorRow.metadata,
      'Code swap requires the analysed code and donor filesystems');
    const retained = context.retained;
    check(retained, 'Code swap requires the retained FS memory reader');
    const current = Number((await retained.read(code.entry + 0x20, 8)).readBigUInt64LE());
    check(current === code.object, 'Code filesystem entry changed before the swap');
    const replacement = Buffer.alloc(8);
    replacement.writeBigUInt64LE(BigInt(donorRow.object));
    await retained.write(code.entry + 0x20, replacement);
    const readback = Number((await retained.read(code.entry + 0x20, 8)).readBigUInt64LE());
    check(readback === donorRow.object, 'Code filesystem swap did not take the donor object');
    state.codeSwap = {entry: code.entry, before: code.object, after: donorRow.object,
      metadata: code.metadata, at: new Date().toISOString()};
    await save();
    return state.codeSwap;
  }
  if (command === 'file-main-swap') {
    // Pre-mount /main redirect using the package donor. HEN.md's 14:39 test
    // pointed the stock /main IFile at a SAVE-donor impl (class ...43c0) and
    // got 0xF601. The kaiHEN package donor is the same FileStorage class as
    // the stock CodeFS, so this is the class-compatible version of Fix B.
    const code = state.codeFileSystems?.[0], donor = state.donor;
    check(code?.domainRoot > 0 && s.handles.has(code.handle) &&
      donor?.ready && donor.root > 0 && s.handles.has(donor.handle),
    'Main swap requires the stock CodeFS and the kaiHEN package donor');
    const layout = JSON.parse(await fs.readFile(path.join(OUT, live.session + '-layout.json')));
    const {domainPathPacket} = require('../app/filesystem.cjs');
    const retained = context.retained;
    check(retained, 'Main swap requires the retained FS memory reader');
    const open = async (source, handle, root, id) => {
      const filename = Buffer.alloc(0x301); filename.write('/main');
      await s.write(s.base + 0x2000, filename);
      const mode = Buffer.alloc(4); mode.writeUInt32LE(1);
      const reply = await domain.send(s, 'Main swap: open ' + source + ' /main', handle,
        domainPathPacket(root, 8, mode, s.base + 0x2000), {domain: true});
      check(!reply.result && reply.objects.length === 1,
        'Main swap open failed for ' + source + ': ' + reply.canonicalResult);
      const object = layout.table + (reply.objects[0] - 1) * 0x30;
      const entry = await retained.read(object, 0x30);
      const wrapper = Number(entry.readBigUInt64LE(0x20));
      check(wrapper > 2 ** 32 && wrapper < 2 ** 39, 'Main swap wrapper is not mapped for ' + source);
      const header = await retained.read(wrapper, 0x40);
      const impl = Number(header.readBigUInt64LE(0x10));
      check(impl > 2 ** 32 && impl < 2 ** 39, 'Main swap impl is not mapped for ' + source);
      return {id: reply.objects[0], entry: object, wrapper, impl,
        wrapperVptr: Number(header.readBigUInt64LE()).toString(16)};
    };
    await progress('main-swap-begin');
    const captureOnly = process.env.NS2_MAIN_SWAP_MODE === 'capture';
    let content = null;
    if (!captureOnly) content = await open('code', code.handle, code.domainRoot, code.domainRoot);
    const source = await open('donor', donor.handle, donor.root, donor.root);
    if (captureOnly) {
      // Opening the stock CodeFS /main before the Loader mount stalls the
      // launch (23:57 run: mounts 0). Capture only the donor package /main; the
      // IFile wrapper class is the same for both.
      state.mainSwap = {content: {wrapperVptr: source.wrapperVptr}, source,
        captureOnly: true, at: new Date().toISOString()};
      await progress('main-swap-captured ' + source.impl);
      await save();
      return state.mainSwap;
    }
    const contentVptr = Number((await retained.read(content.impl, 8)).readBigUInt64LE());
    const donorVptr = Number((await retained.read(source.impl, 8)).readBigUInt64LE());
    check(contentVptr === donorVptr,
      'Main swap impl classes differ: 0x' + contentVptr.toString(16) + ' vs 0x' + donorVptr.toString(16));
    check(content.wrapper !== source.wrapper, 'Main swap resolved the same wrapper twice');
    const replacement = Buffer.alloc(8); replacement.writeBigUInt64LE(BigInt(source.impl));
    // The retained writer is unguarded; the readback is the proof.
    await retained.write(content.wrapper + 0x10, replacement);
    const readback = Number((await retained.read(content.wrapper + 0x10, 8)).readBigUInt64LE());
    check(readback === source.impl, 'Main swap wrapper did not take the donor impl');
    state.mainSwap = {content, source, contentVptr: contentVptr.toString(16),
      donorVptr: donorVptr.toString(16), oldImpl: content.impl, newImpl: source.impl,
      at: new Date().toISOString()};
    await progress('main-swap-done ' + source.impl);
    await save();
    return state.mainSwap;
  }
  if (command === 'file-main-swap-restore') {
    const swap = state.mainSwap;
    check(swap && s.handles.has(state.codeFileSystems?.[0]?.handle), 'No main swap to restore');
    const retained = context.retained;
    check(retained, 'Main swap restore requires the retained FS memory reader');
    const replacement = Buffer.alloc(8); replacement.writeBigUInt64LE(BigInt(swap.oldImpl));
    await retained.write(swap.content.wrapper + 0x10, replacement);
    const readback = Number((await retained.read(swap.content.wrapper + 0x10, 8)).readBigUInt64LE());
    check(readback === swap.oldImpl, 'Main swap restore did not take the stock impl');
    swap.restored = new Date().toISOString();
    await save();
    return swap;
  }
  if (command === 'code-open') {
    const handle = Number(request.handle), title = BigInt(request.title);
    const dumpDirectory = request.dumpDirectory || process.env.NS2_FIRMWARE_DUMP_DIR;
    check(!request.dumpOutput || dumpDirectory && path.isAbsolute(dumpDirectory),
      'Firmware capture requires a dedicated output directory');
    check(state.domainCopies?.some(item => item.handle === handle) && s.handles.has(handle),
      'Code open requires a retained copied root');
    const existing = !request.fresh && state.codeFileSystems?.find(item => item.title === title.toString() && s.handles.has(item.handle));
    if (existing) return existing;
    const attributes = Number(request.attributes ?? 1), storage = Number(request.storage ?? 3);
    check(Number.isInteger(attributes) && attributes >= 0 && attributes <= 15, 'Invalid content attributes');
    check([3, 4, 5].includes(storage), 'Unsupported code storage');
    const input = Buffer.alloc(16); input[0] = attributes; input[1] = storage; input.writeBigUInt64LE(title, 8);
    const infoSize = Number(request.infoSize ?? 0x1a4);
    check(Number.isInteger(infoSize) && infoSize >= 0x100 && infoSize <= 0x2000, 'Invalid code-info capacity');
    const output = s.base + 0x4000, guard = Buffer.alloc(32, 0x5c);
    await s.write(output - 32, Buffer.concat([guard, Buffer.alloc(infoSize), guard]));
    const reply = await s.ipc('RO pivot: OpenCodeFileSystem', handle, 0, input,
      {receive: [{address: output, size: infoSize}]});
    const entry = {at: new Date().toISOString(), operation: command, sourceRoot: handle,
      title: title.toString(), storage, attributes, infoSize, result: reply.result, canonicalResult: reply.canonicalResult};
    state.calls.push(entry); await save();
    if (reply.result) return entry;
    entry.handle = domain.oneHandle(reply);
    (state.codeFileSystems ||= []).push(entry); await save();
    check((await s.readOwned(output - 32, 32)).equals(guard) &&
      (await s.readOwned(output + infoSize, 32)).equals(guard), 'Code-info output exceeded its buffer');
    const info = await s.readOwned(output, infoSize);
    const directory = request.dumpOutput ?
      path.join(dumpDirectory, title.toString(16).padStart(16, '0')) :
      path.join(OUT, live.session + '-code-' + title.toString(16).padStart(16, '0'));
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    entry.directory = directory;
    entry.codeInfo = {file: path.join(directory, 'code-info.bin'), sha256: hash(info),
      isSigned: info[infoSize - 4], targetHash: info.subarray(infoSize - 0x24, infoSize - 4).toString('hex')};
    await fs.writeFile(entry.codeInfo.file, info, {mode: 0o600});
    await save();
    return entry;
  }
  // Open a throwaway file and duplicate its reference. The launch adopts this
  // object into the freed NPDM slot so the Loader's close has a live,
  // normally-closable target (see launch.cjs). Prefer the retained CodeFS: its
  // file objects are the same class the app already opens/closes successfully
  // during firmware capture, and closing one cannot disturb the donor swap.
  if (command === 'file-spare') {
    const name = request.name || 'main.npdm';
    const source = request.source || 'code';
    let handle, root;
    if (source === 'code') {
      const code = state.codeFileSystems?.[0];
      check(code?.domainRoot > 0 && s.handles.has(code.handle),
        'Spare file requires the retained CodeFS domain');
      handle = code.handle; root = code.domainRoot;
    } else {
      const donor = state.donor;
      check(donor?.ready && donor.root > 0 && s.handles.has(donor.handle),
        'Spare file requires the converted donor filesystem');
      handle = donor.handle; root = donor.root;
    }
    const {domainPathPacket} = require('../app/filesystem.cjs');
    const filename = Buffer.alloc(0x301); filename.write('/' + name);
    await s.write(s.base + 0x2000, filename);
    const mode = Buffer.alloc(4); mode.writeUInt32LE(1);
    const opened = await domain.send(s, 'RO spare: open ' + source + ' /' + name, handle,
      domainPathPacket(root, 8, mode, s.base + 0x2000), {domain: true});
    check(!opened.result && opened.objects.length === 1,
      'Spare file did not open in the ' + source + ' domain: ' + opened.canonicalResult);
    const id = opened.objects[0];
    check(Number.isInteger(id) && id > 0 && id <= 0x4000, 'Spare object ID exceeds the domain capacity');
    const input = Buffer.alloc(4); input.writeUInt32LE(id);
    const copied = await domain.send(s, 'RO spare: CopyObject', handle,
      domain.wire.control(1, input));
    check(!copied.result, 'Spare object copy failed: ' + copied.canonicalResult);
    const copy = domain.oneHandle(copied);
    const entry = {at: new Date().toISOString(), name, source, id, handle: copy};
    (state.spareObjects ||= []).push(entry); await save();
    return entry;
  }
  // A real read resolves the file's storage and replaces the transient
  // implementation a bare OpenFile installs. Warm both /main files before the
  // launch reads the implementation pointer (16:49: the second open alone did
  // not upgrade it; the post-launch opens were the final FileStorage class).
  // Use the FS handle path (like file-capture): the domain path returns a
  // domain object id, not a session handle, so s.ipc cannot read it.
  if (command === 'file-warm') {
    const name = request.name || 'main', source = request.source || 'code';
    let handle;
    if (source === 'code') {
      const code = state.codeFileSystems?.[0];
      check(code?.domainRoot > 0 && s.handles.has(code.handle),
        'Warm file requires the retained CodeFS domain');
      handle = code.handle;
    } else {
      const donor = state.donor;
      check(donor?.ready && donor.root > 0 && s.handles.has(donor.handle),
        'Warm file requires the converted donor filesystem');
      handle = donor.handle;
    }
    const filename = Buffer.alloc(0x301); filename.write('/' + name);
    await s.write(s.base + 0x2000, filename);
    const input = Buffer.alloc(4); input.writeUInt32LE(1);
    const opened = await domain.send(s, 'RO warm: open ' + source + ' /' + name, handle,
      pathRequest(8, input, s.base + 0x2000));
    check(!opened.result, 'Warm file did not open in ' + source + ': ' + opened.canonicalResult);
    const child = domain.oneHandle(opened);
    let size = 0;
    try {
      const reply = await s.ipc('RO warm: file size', child, 4);
      check(!reply.result, 'Warm file size failed');
      size = Number(reply.data.readBigUInt64LE());
      const length = Math.min(size, 0x100);
      if (length > 0) {
        const args = Buffer.alloc(24);
        args.writeBigUInt64LE(0n, 8); args.writeBigUInt64LE(BigInt(length), 16);
        const read = await s.ipc('RO warm: read', child, 0, args,
          {receive: [{address: s.base + 0x4000, size: length, mode: 1}]});
        check(!read.result, 'Warm file read failed');
      }
    } finally { await s.close(child); }
    const entry = {at: new Date().toISOString(), operation: command, name, source, size, warmed: true};
    (state.calls ||= []).push(entry); await save();
    return entry;
  }
  if (command === 'file-capture') {
    const handle = Number(request.handle), name = request.name;
    const code = state.codeFileSystems?.find(item => item.handle === handle);
    check(code && s.handles.has(handle) && (['main', 'main.npdm', 'rtld', 'sdk'].includes(name) ||
      code.listing?.entries.some(entry => entry.type === 1 && entry.name === name)),
      'Capture requires an owned CodeFS and a code filename');
    const filename = Buffer.alloc(0x301); filename.write('/' + name);
    await s.write(s.base + 0x2000, filename);
    const input = Buffer.alloc(4); input.writeUInt32LE(1);
    const opened = await domain.send(s, 'RO pivot: open /' + name, handle,
      pathRequest(8, input, s.base + 0x2000));
    check(!opened.result, 'Code file did not open: ' + opened.canonicalResult);
    const child = domain.oneHandle(opened);
    let safeToClose = false;
    try {
      const sizeReply = await s.ipc('RO pivot: code file size', child, 4);
      safeToClose = true;
      check(!sizeReply.result, 'Code file size failed');
      const size = Number(sizeReply.data.readBigUInt64LE());
      check(Number.isSafeInteger(size) && size > 0 && size <= 256 * 1024 * 1024, 'Unexpected code-file size');
      const length = request.limit === undefined ? size : Math.min(size, Number(request.limit));
      check(Number.isInteger(length) && length > 0, 'Invalid capture limit');
      const output = s.base + 0x4000;
      const capacity = Math.min(0x10000, s.bytes - 0x4000);
      const file = path.join(code.directory, name + (length === size ? '' : '.sample'));
      const temporary = file + '.partial';
      // A crashed earlier run can leave both the partial and the final capture
      // behind; they belong to this scratch directory, so replace them.
      await fs.rm(temporary, {force: true});
      const out = await fs.open(temporary, 'wx', 0o600);
      const digest = crypto.createHash('sha256');
      let header = Buffer.alloc(0), captured = 0;
      try {
        for (let offset = 0; offset < length;) {
          const n = Math.min(capacity, length - offset), data = Buffer.alloc(24);
          data.writeBigUInt64LE(BigInt(offset), 8); data.writeBigUInt64LE(BigInt(n), 16);
          safeToClose = false;
          const reply = await s.ipc('RO pivot: read code file', child, 0, data,
            {receive: [{address: output, size: n, mode: 1}]});
          if (reply.result) safeToClose = true;
          check(!reply.result && reply.data.readBigUInt64LE() === BigInt(n), 'Code file read was short or failed');
          const bytes = await s.readOwned(output, n);
          safeToClose = true;
          const written = await out.write(bytes, 0, bytes.length, offset);
          check(written.bytesWritten === bytes.length, 'Local code-file write was short');
          digest.update(bytes);
          if (header.length < 0x100) header = Buffer.concat([header, bytes]).subarray(0, 0x100);
          offset += n; captured = offset;
        }
        await out.sync();
      } finally {await out.close();}
      check(captured === length, 'Code-file capture stopped early');
      await fs.rm(file, {force: true}); // stale capture from a crashed run
      await fs.link(temporary, file);
      await fs.unlink(temporary);
      const entry = {at: new Date().toISOString(), name, file, size, captured: length,
        sha256: digest.digest('hex'),
        header: header.toString('hex')};
      (code.files ||= []).push(entry); await save();
      return entry;
    } finally { if (safeToClose) await s.close(child); }
  }
  throw Error('Unknown native file operation');
}

module.exports = {dispatch, pathRequest};
