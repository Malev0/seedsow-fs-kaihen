#!/usr/bin/env node
'use strict';
// Prepare an SD card for the console-only (semi-untethered) chain.
//
// Downloads the latest kaiHEN release into <repo>/kaihen if it is missing, asks
// for the SD card root with the native folder picker, then copies the release
// there, replacing files with the same names.
//
// kaiHEN 20261123+ ships an sdcard/ folder that mirrors the card:
//   <SD>/hbmenu.nro
//   <SD>/kaihen/bin/hen/main
//   <SD>/kaihen/bin/game/main
//   <SD>/kaihen/lib/*.so*
//   <SD>/switch/ounceshell.nro
//   <SD>/kaihen/bin/ro/main        (from the release root)
//   <SD>/kaihen/bin/bootstrap.bin  (from the release root)
//   <SD>/kaihen/licenses/...
//
// Older flat releases are copied to the older layout:
//   <SD>/hbmenu.nro
//   <SD>/kaihen/bin/{bootstrap.bin,ro/main,hen/main,game/main}
//   <SD>/switch/*.nro
//   <SD>/kaihen/...                (mirror of <repo>/kaihen)
//
// Usage:
//   node tools/prepare-sd.cjs                 (native folder picker)
//   node tools/prepare-sd.cjs --target E:\    (no picker; useful for tests)

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {hasRelease, updateFromLatest} = require('./kaihen-release.cjs');

const ROOT = path.resolve(__dirname, '..');
const KAIHEN = path.join(ROOT, 'kaihen');

function log(message) { console.log(message); }

function pickFolder() {
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$owner.ShowInTaskbar = $false',
      "$owner.FormBorderStyle = 'None'",
      '$owner.Width = 1; $owner.Height = 1',
      "$owner.StartPosition = 'CenterScreen'",
      '$owner.Opacity = 0.01',
      '$owner.Show()',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$d.Description = 'Select the SD card root (the folder containing Nintendo/switch)'",
      "$d.ShowNewFolderButton = $false",
      "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
      '$owner.Close()',
    ].join('; ');
    const out = execFileSync('powershell',
      ['-NoProfile', '-STA', '-WindowStyle', 'Normal', '-Command', script],
      {encoding: 'utf8', windowsHide: false});
    return out.trim();
  }
  if (process.platform === 'darwin') {
    const out = execFileSync('osascript',
      ['-e', 'POSIX path of (choose folder with prompt "Select the SD card root")'],
      {encoding: 'utf8'});
    return out.trim();
  }
  for (const [command, args] of [
    ['zenity', ['--file-selection', '--directory', '--title=Select the SD card root']],
    ['kdialog', ['--getexistingdirectory', '.', '--title', 'Select the SD card root']],
  ]) {
    try {
      const out = execFileSync(command, args, {encoding: 'utf8'});
      if (out.trim()) return out.trim();
    } catch { /* try the next picker */ }
  }
  throw Error('no folder picker available; pass --target <SD root>');
}

function copyFile(source, target) {
  if (!fs.existsSync(source)) return false;
  const parent = path.dirname(target);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, {recursive: true});
  fs.copyFileSync(source, target);
  log('  ' + target);
  return true;
}

function copyTree(source, target) {
  if (!fs.existsSync(source)) return;
  if (!fs.existsSync(target)) fs.mkdirSync(target, {recursive: true});
  for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
    if (entry.name.startsWith('.')) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFile(from, to);
  }
}

function copyRelease(target) {
  log('Copying kaiHEN to ' + target + ' ...');
  // kaiHEN 20261123+ ships sdcard/ already laid out as the card: the menu,
  // kaiHEN, the game loader, the shared libraries and the programs.
  const sdcard = path.join(KAIHEN, 'sdcard');
  if (fs.existsSync(sdcard)) {
    copyTree(sdcard, target);
    // The console-only port reads these two from /kaihen/bin.
    copyFile(path.join(KAIHEN, 'ro', 'main'), path.join(target, 'kaihen', 'bin', 'ro', 'main'));
    copyFile(path.join(KAIHEN, 'bootstrap.bin'), path.join(target, 'kaihen', 'bin', 'bootstrap.bin'));
    copyTree(path.join(KAIHEN, 'licenses'), path.join(target, 'kaihen', 'licenses'));
    return;
  }
  // Older flat release: mirror the local kaihen folder, then place the
  // documented SD layout too.
  copyTree(KAIHEN, path.join(target, 'kaihen'));
  copyFile(path.join(KAIHEN, 'hbmenu.nro'), path.join(target, 'hbmenu.nro'));
  for (const relative of ['bootstrap.bin', 'ro/main', 'hen/main', 'game/main'])
    copyFile(path.join(KAIHEN, relative), path.join(target, 'kaihen', 'bin', relative));

  const programs = path.join(KAIHEN, 'programs');
  if (fs.existsSync(programs)) {
    for (const entry of fs.readdirSync(programs, {withFileTypes: true})) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.nro')) continue;
      copyFile(path.join(programs, entry.name), path.join(target, 'switch', entry.name));
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let target = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') {
      target = argv[++i];
      if (!target) throw Error('--target needs a folder');
    } else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('usage: node tools/prepare-sd.cjs [--target <SD root>]');
      return;
    } else throw Error('unknown argument: ' + argv[i]);
  }

  if (!hasRelease(KAIHEN)) {
    log('kaiHEN is not downloaded; downloading the latest release ...');
    const result = await updateFromLatest();
    log('Downloaded kaiHEN ' + result.tag + ' (' + result.count + ' files).');
  }

  const picked = target || pickFolder();
  if (!picked) throw Error('no folder selected');
  target = path.resolve(picked);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory())
    throw Error('SD card folder not found: ' + target);

  copyRelease(target);
  log('SD card prepared at ' + target);
}

main().catch(error => {
  console.error('ERROR: ' + error.message);
  process.exitCode = 1;
});
