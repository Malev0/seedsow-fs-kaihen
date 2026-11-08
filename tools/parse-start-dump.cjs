#!/usr/bin/env node
// Parse the slot-2 pm-start-dump pages written by tools/dump-listener.cjs.
//
// The pm-start-dump worker sends two 0x100-byte CMIF reply pages:
//   page 0: pm:dmnt cmd 1 (start) reply, result 0 when the start returned;
//   page 1: pm:dmnt cmd 7 (GetProgramId) reply for the started pid.
// A 0x100-byte file means the app was suspended before the liveness query.
const fs = require('node:fs');
const path = require('node:path');
const {response} = require('../ns2jb-main/ns2jb-main/engine/shared/ipc.cjs');

const file = process.argv[2] || path.join(__dirname, '..', 'start-dump.bin');
const bytes = fs.readFileSync(file);
const pages = [];
for (let offset = 0; offset + 0x100 <= bytes.length; offset += 0x100) {
  const page = bytes.subarray(offset, offset + 0x100);
  const entry = {page: pages.length, offset, length: page.length, raw: page.toString('hex')};
  try {
    const reply = response(page);
    entry.result = reply.result;
    entry.canonicalResult = reply.canonicalResult;
    entry.data = reply.data.toString('hex');
    // Page 0 is the start reply (its data is empty); page 1 is the
    // GetProgramId reply, whose first qword is the program id.
    if (pages.length > 0 && reply.result === 0 && reply.data.length >= 8)
      entry.value = '0x' + reply.data.readBigUInt64LE().toString(16);
  } catch (error) { entry.error = error.message; }
  pages.push(entry);
}
console.log(JSON.stringify({file, bytes: bytes.length, pages}, null, 2));
if (bytes.length === 0x100)
  console.log('only the start page arrived: the app was suspended before the 50 ms liveness query');
