#!/usr/bin/env node
'use strict';
// POST a Lua file to the console's /eval and print what it printed.
//   node tools/post-eval.cjs console/test_eval.lua
const {evalFile} = require('./console-http.cjs');

const file = process.argv[2];
if (!file) { console.error('usage: node tools/post-eval.cjs <file.lua>'); process.exit(2); }
evalFile(file).then(text => console.log(text)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
