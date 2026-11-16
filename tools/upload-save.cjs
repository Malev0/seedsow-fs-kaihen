#!/usr/bin/env node
'use strict';
// PUT one file into the console's save.
//   node tools/upload-save.cjs console/n2h_rpc.lua n2h_rpc.lua
const {uploadSave} = require('./console-http.cjs');

const [file, name] = process.argv.slice(2);
if (!file || !name) {
  console.error('usage: node tools/upload-save.cjs <local file> <save name>');
  process.exit(2);
}
uploadSave(file, name).then(text => console.log(text.trim())).catch(error => {
  console.error('UPLOAD ERROR: ' + error.message);
  process.exit(1);
});
