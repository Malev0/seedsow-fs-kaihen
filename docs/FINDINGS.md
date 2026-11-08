# Findings - stage 2/4 and 3/4 (seedsow-fs-exploit)

Everything here was learned on *Seedsow Lullaby Demo* (Artemis, platform 2) with the PC
driving the console. File references use the repo layout (`ns2jb-main/ns2jb-main/engine/...`).
The dated running log (`HANDOFF.md`) is kept locally and is not part of the repository;
this file is the distilled version.

---

## 0. Two transport facts that colour everything else

1. **The console serves exactly one RPC client at a time.** The fast path is a binary TCP
   protocol on `:39380`, but the *serve loop itself lives inside one launcher `/eval`
   request*. While the loop runs, the launcher's HTTP handler is parked, so `/eval` and
   `/save` do not answer.
2. **Therefore never kill the bridge abruptly.** `rpc-tool.cjs stop-all` first asks the
   bridge to shut the loop down (`rpc-shutdown` → console cmd 11) and only then kills the
   bridge. Killing the bridge first leaves the loop waiting for a frame that never comes,
   and the HTTP handler stays parked for its idle deadline (~90 s). If you then probe
   `/eval` you get `WinError 10054` / timeouts, which looks like "console not reachable"
   even though `:8080` still accepts TCP (the kernel backlog accepts; nothing `accept()`s).

If `/eval` stays dead for more than ~2 minutes, the app itself is wedged: relaunch it.

---

## 1. Stage 2/4 — acquisition probe

Goal: corrupt the FS service's cache so that one of its own reads becomes an attacker-
controlled read/write into FS memory, then **verify** it, ending in `memoryControl.ready`
("memory-ready").

### 1.1 It is a three-window lottery

The probe has to make three independent, microsecond-scale orderings line up on the same
boot. Each is a separate gate, and each depends on the FS heap/cache layout of that boot:

| gate | what must happen | failure signature |
|---|---|---|
| canary overwrite (`positive`) | a hole request's receive still pending when the copy lands, so the canary path changes | `Overwrite missed the qualified canary; retain resources for recovery` |
| clean cache alias (`cache-combined-leak-*`) | the alias must return the same bytes as the control read with no poisoned output | `Field copy did not qualify within its attempt limit` |
| link change (`changedLink`) | a released block's free-list link word must change while its 16 KiB tail stays identical | `No changedLink candidate on this boot` |

Observed distribution over 14 consecutive boots (this machine, one session):

| outcome | count |
|---|---|
| memory-ready | 2 |
| no changedLink candidate | 7 |
| canary overwrite missed | 2 |
| general-heap changed while retained | 1 |
| field-copy attempt limit | 1 |
| aborted after 2 waves | 1 |

They cluster: after the wave-settle tuning there were runs of 2 successes in 3 boots.
Treat it as a coin flip, not a deterministic failure.

### 1.2 `changedLink` is currently the only plan that works

Correlation across boots:

| report | selected candidate | result |
|---|---|---|
| `1793719323904` | `changedLink:true`, target `0x18bb938000` | memory-ready |
| `1793674925105` | `changedLink:true`, target `0x80b7bc000` | memory-ready |
| `1793724084023` | `zeroTail:true`, target `0x13f800000` | bounded send hung |
| two stable-only boots | `stableLink` | hung |

`memory/probe-reserved-gap-seedsow.cjs` therefore requires `changedLink`
(`linkSelection.strong`) and rejects a boot **before the address matrix**:

```
No changedLink candidate on this boot (N zeroTail/zeroAfter32 and M stableLink only;
those plans wedge the FS service); relaunch and retry
```

The reason to reject early: a wrong plan doesn't just fail, it leaves the FS service
blocked inside the first operation, which used to hang the whole RPC thread.

### 1.3 Timing / settle

The "settle" is a delay before the 13 parked workers are released, giving the FS service
idle time first. The original slow path (PC-built frames, ~1 s per wave of host work) hit
the canary window; the fast path alone did not. So:

- `NS2_WAVE_SETTLE_MS=1000` is the working value.
- It now applies to **retries only** (first attempt of each phase runs without it), which
  keeps the effect but removes most of the cost. `NS2_WAVE_SETTLE_ALWAYS=1` restores the
  blanket delay.
- Repeated first attempts without a settle can miss the canary, but the retry then gets the
  settle, so the cost is one wave rather than a lost boot.
- **Positive-wave cap:** the positive canary wave is fast (<1 s) on boots that pass 2/4 and
  slow on failures (the join waits on workers that never finish). The whole positive retry
  series is capped at 10 s (`NS2_POSITIVE_WAVE_MS`, default 10000), and the join timeout is
  10 s for that phase (`native.joinAll`; `n2h_rpc.lua` `JOIN_WAIT_MS`), so a bad boot fails
  promptly and the GUI's pre-3/4 auto-retry relaunches.

### 1.4 Address-plan verification

`memory/probe-reserved-gap-seedsow.cjs`:

1. poison the receive buffer, read through the alias, require a real copy (`readStorage`);
2. `readVerified` — poison **and** content controls both pass;
3. write a 16-byte marker, read it back, `writeVerified` — neighbouring bytes must match.

Only then is the plan promoted to `memoryControl.ready`. A verified plan looks like
`target 0x80b7bc000`, `readOffset 0x3fe8000`, header `signed-one-shot`.

### 1.5 Bounded sends

The FS IPC path is blocking from the console's point of view. `Session.setBoundedRegion` /
`setBoundedSend` (`NS2_BOUNDED_SEND_MS`, default 20 s) bound the *address plan* reads and
writes so a bad plan cannot freeze the single RPC thread. On timeout the probe fails with
`Bounded FS send timed out ... the worker is still owned` and the **app stays closable** —
that is the intended behaviour; relaunch before trying again.

### 1.6 Measured cost and the optimisations that actually helped

`report.timings` in the probe report accumulates per wave: `totalMs`, `workersMs`,
`joinMs`, `settleMs`, `requests`. Note `metrics.elapsedMs` is only the sum of RPC
durations, **not** wall time.

Last measured good-ish boot (49 waves): wall 161 s = RPC 104 s (workers 16.3 s, join 10.7 s
inside that), settle 29.2 s, host-side ~28 s.

Applied, in order of payoff:

1. **Ethernet instead of Wi-Fi.** Wi-Fi ping jittered 6–118 ms; wired is 0–1 ms. Per-request
   cost 33.9 → 28.5 ms. Not a huge win because the console, not the wire, dominates, but it
   removes the multi-second stalls.
2. **Batched joins.** `transport.joinWorkers()` already accepts a list and the shim joins a
   whole group in one request; `joinAll` used to call it once per worker. 0.218 → 0.058 s
   per wave.
3. **Batched starts.** `restartAll` sends one `workers-start` for all 13 workers.
4. **Settle only on retries** (see 1.3).

Net: 3.30 → ~2.4 s per wave; a 49-wave boot ≈ 120 s.

### 1.7 Levers not yet tried

- `cacheAlias.aliasOffset` is hardcoded (`0x1400000`). Every attempt on a boot therefore
  over-reads the *same* block. Varying it per attempt (aligned to the bucket period) could
  turn a "no changedLink" boot into a usable one. This is the most promising remaining idea.
- Same-boot probe retries do change the candidate set (44 → 216 → 44 stable pointers) but
  never produced a `changedLink` in the cases tried; a fresh boot was needed.

---

## 2. Stage 3/4 — retained + RO

Order: `retained/find-metadata` → `ro/install-retained` → `FS layout` → `Owned FS root` →
`Owned FS notifier` → `ro/test-sm` → `ro/copy-loader-root` → `ro/prepare-workers` →
`RO payload and current console policy` → `ro/bind-sessions` → `ro/prepare-event` →
`ro/test-gate` → `ro/launch` → `Start RO payload` → `RO instruction challenges` →
`Restore Loader session`.

Stages confirmed working on Seedsow: everything up to and including `ro/prepare-event`.
`ro/test-gate` is the current frontier (see 2.4).

### 2.1 `retained/find-metadata` and the "no native links" failure

It reads a 5 MiB window at the verified plan target (`memory.read(socket, info.plan.target,
0x500000)`) and needs pointer-like allocator links in it to anchor the native pool. A plan
can verify perfectly yet point at a window with **no** links (for example our own scratch
file bytes) → `The pool capture has no native links`.

`find-metadata.cjs` now scans neighbouring windows (`±0x190000`, `±0x320000`, whole bucket
periods so the bootstrap alignment still holds) and records each attempt in
`evidence.poolAlternatives`. If all are empty, the boot is a bad-plan boot: relaunch.

### 2.2 Seedsow vs SmileBASIC offsets — the SVC veneer table

The RO/retained code was written against SmileBASIC offsets. Those addresses are simply
wrong on Seedsow and produce things like `OpenThread failed: 61441` or
`The native event syscall wrapper is not unique`.

Verified on Seedsow (byte-checked at runtime, re-derivable with `research/find_svc.py`
and `research/dis_svc_region.py`):

| wrapper | SVC | Seedsow offset | bytes |
|---|---|---|---|
| SignalEvent | 0x11 | `0x168bac` | `210200d4c0035fd6` |
| ClearEvent | 0x12 | `0x168bb4` | `410200d4c0035fd6` |
| CancelSynchronization | 0x19 | `0x168c0c` | `210300d4c0035fd6` |
| WaitSynchronization | 0x18 | `0x168bf4` | `e00f1ff8010300d4…` |
| GetThreadId | 0x25 | `0x168c74` | `e00f1ff8a10400d4…` |
| GetInfo | 0x29 | `0x168ca4` | `e00f1ff8210500d4…` |

Used by `ro/control.cjs` (`event-signal`, `event-clear`, `thread-id`, `wait-zero`,
`process-info`) and `ro/worker-control.cjs` (cancel).

### 2.3 There is no OpenThread syscall — and why that matters

A full scan of `sdk.text` shows SVC sites for 0x01–0x52 plus debug 0x70/0x72, **but no
OpenThread**. 0x33 is `GetThreadContext3`, 0x34 is `WaitForAddress` (the old
`root-native-open-thread` helper was calling 0x34 and returning `0xF001`).

Consequences:

- No app-side `KThread` handles for the 7 FS API threads → `svcCancelSynchronization`
  is impossible from the app.
- Exporting an FS **KThread** through the notifier makes the FS service abort (it treats
  the handle as an event), so that route is out too.
- `ro/prepare-workers` therefore binds the 7 verified threads **handle-free** (address /
  thread id / entry from the thread ring) and `root-native-worker-cancel` returns
  `{skipped:true, result:0}`. The skip is recorded in `nativeRo.cancelSkipped`.

### 2.4 The gate needs cancellation (current wall)

`retained/retained-memory.cjs` → `inject-holder` writes the session's waiter pointer,
writes the fake waiter into FS memory, and then **immediately** calls
`control.cancelWorkers(context)` — the comment in the code is explicit: *"cancellation must
immediately follow this unverified store"*. Without it the kernel keeps our selection and
`ro/gate.cjs:step()` spins its 30 attempts and throws:

```
One-shot request did not settle; inspect the saved step before retrying
```

(the `finally` in `ro/test-gate.cjs` then reports the misleading
`A selection remains pending`).

Mitigation in place: the handle-free cancel waits `NS2_CANCEL_SETTLE_MS` (default 200 ms)
before returning, so the retry loop spans seconds instead of microseconds and the FS worker
has a chance to re-arm on its own. Not yet proven to be enough.

**2026-11-03 23:11 run: the whole chain reached this wall.** Everything up to and
including `ro/prepare-event` passed (event clear → wait timeout `0xEA01` → signal → wait 0 →
clear → timeout), then `ro/test-gate` parked the session, injected the fake holder (`id 142`,
`corruptionCount 38`) and recorded **seven skipped cancellations**. The selection never
settled: 30 loop iterations at ~1.4 s each (44 s), then
`One-shot request did not settle`, then `restore()` threw `A selection remains pending`.

**2026-11-03 23:59 run (wake = notifier): the rebuild settled, then the console froze.**
`parkSession` → `wake()` (2 signals accepted, `wakeLog` all zero) → the empty step rebuilt
the wait array in 4.5 s (`rebuilt: {parent, epoch, receiveResult: 3}`, header restored).
So the wake mechanism is right for the *empty* case. Then `root-native-worker-release`
succeeded, the readiness event was set, and **250 ms later the console closed the RPC
socket and the app's HTTP (8080) was gone** — and the console itself froze (no input, only
holding the power button recovers it; this is not an app crash). The PC then waited
the full 60 s for `root-native-worker-state`, and `restore()` reported
`Another memory request is active`. Both are symptoms of the dead console, not the cause.
Conclusion: the parked session does not ignore the delivered request — the readiness event
(or the fake waiter left in the thread slot) resolves the wait and the FS client dies while
handling it. `worker-state` must not be called before the step anyway:
`pthread_tryjoin` on a worker blocked in its IPC send blocks until the request is consumed.

**2026-11-04 00:47: the retained alias cannot leave the FS heap.** `ro/probe-fs-image`
pointed the candidate-file descriptor at the API-thread entry: `setPointer` succeeded (the
pointer write was read back), but the following candidate-file read at offset `0x4000`
never returned (60 s timeout; `retainedMemory.nativeRequest = {operation:"read",
offset:16384, length:64}` with no `finished`). The console stayed alive; the retained
endpoint is wedged for that boot. The module base geometry is confirmed on two boots —
entry = 2 MiB-aligned base + `0xACD4` (`0x7919E0ACD4` from `0x7919E00000`, and
`0x567780ACD4` from `0x5677800000`) — so if the other port's capture uses base
`0x292000000`, the entry should be `0x2920ACD4`. FS text needs another read primitive;
heap fields remain writable through the same descriptor.

Current experiment (in `ro/gate.cjs`, env-gated): since the parked session waits on our
**notifier**, signal that event after each injection and once after parking, so the kernel
is forced to return from the wait and re-evaluate the waiter array we rewrote.

| env | behaviour |
|---|---|
| `NS2_GATE_WAKE` unset / `park` | signal the notifier event after a skipped cancel and after each injection (default) |
| `NS2_GATE_WAKE=both` | also signal the exported readiness/receive event (`serverCopy`) — **dead end**: that export is read-only, so the signal is rejected (recorded in `wakeLog`) |
| `NS2_GATE_WAKE=receive` | only the readiness event (same dead end) |
| `NS2_GATE_WAKE=0` | old behaviour (no wake) |
| `NS2_GATE_WAKE_MS` | settle between signal and clear (default 25 ms) |

`ro/test-gate.cjs` records `wakes` and `wakeMode` in its JSON so a run shows whether the
wake path was exercised. If neither mode settles the selection, the only remaining route is
cancellation **inside the FS process** (see below).

**2026-11-04: the `fs.elf` dump answers the wait/receive split.** The other port's
`fs.elf` (ELF64, 3 `PT_LOAD`, text `0x292000000+0x24e000`) has the syscall veneer
table at text `0x1150..0x1428`:

| svc | text offset | meaning |
|---|---|---|
| `0x18` | `0x1228` | `WaitSynchronization` |
| `0x19` | `0x1240` | `CancelSynchronization` |
| `0x43` | `0x13b8` | `ReplyAndReceive` |
| `0x44` | `0x13d0` | `ReplyAndReceiveWithUserBuffer` |

The API-thread entry `base+0xACD4` is a `b` thunk in a dispatch table
(`0xAC80..0xAD5C`) that lands on `0xD810`, whose wrapper calls the server main
loop at `0x11640`.

Session split (both fields start equal, which is why `bind-sessions` sees
`wait === receive`):

- `+0x30` **wait handle**: returned by the getter at text `0x214AC0`
  (`ldr w8,[x0,#0x30]; mov w0,#1; str w8,[x1]; ret`) and used to build the
  `MultiWait` handle array (`0x2143E0`).
- `+0x48` **receive handle**: used by the session reply/receive path at `0x21D0F0`
  (`ldr w8,[x19,#0x48]` then `ReplyAndReceive(&idx, &handle, 1, 0, 0)` with
  **timeout 0**, i.e. non-blocking). On success it sets `+0x44`=1 and `+0x40`=2;
  on `0xEA01` timeout it sets `+0x44`=3 and `+0x40`=2. The dispatcher at `0x21B700`
  then copies the `0x100`-byte request into `+0x60` and processes it.

So the gate parks only the **wait** handle; the receive path still uses the real
handle. Two consequences:

1. `pending()` is not a reliable probe. `root-native-wait-zero` waits on an
   exported copy of the session handle, and the 04:09 rows read `pending:false`
   while the FS's own `receiveResult` was 1 (receive succeeded), so the two
   signals disagree. Treat the session fields as the source of truth.
2. The ordering in every earlier run was wrong: the worker was released **before**
   the unpark, so the thread was still waiting on the notifier. The wait array is
   built once per `MultiWait` call (`0x2143E0`) and reused across the inner retry
   loop (`0x214520`), so a signal that returns as cancel/timeout re-runs the stale
   array and never re-reads `+0x30`. Correct order: park → unpark → one wake to
   retire the notifier wait → settle → **then** send the request.

`NS2_GATE_STEP_MODE=unpark-first` implements that order and reads only the session
fields (`+0x40`, `+0x44`, `+0x60`) plus both domain counts; no `pending()` calls.

If it isn't, cancellation has to move **inside FS** — i.e. code running in the FS process
(which owns the thread handles) does the `CancelSynchronization`. The RO payload
(`ro/payload/*`) and `process/fs-execute.cjs` are the natural places, but the gate is used
by `ro/launch` *before* the payload runs, so this is a genuine chicken-and-egg that needs a
smaller pre-launch primitive (patch an FS function that a worker will call, or find a
handle source through `pm:dmnt`).

#### Joining the clone worker wedges the endpoint

The 23:49 success never joined its worker, so it did not test `pthread_join`. The
00:21 run did: `root-native-worker-join` calls `TryWaitThread` first, and that call
blocks even after every chain result cell is stored (both clone sends had returned
`0`). The console RPC loop is single-threaded, so the memory endpoint's `busy` flag
stays set and every later request is answered `Another memory request is active`
until the stage fails.

`TryWaitThread` is therefore not a non-blocking predicate on this build: it takes the
thread object's own mutex, and the exiting thread holds that mutex while it is inside
`pthread_exit`. Practical rules:

- Never join a worker whose chain ended in a gate/clone send.
- `root-native-worker-settle` parses the reply pages and drops the bookkeeping
  without calling `TryWaitThread` or `pthread_join`; use it once every result cell
  is stored.
- `ro/test-gate` no longer starts the control-test worker by default
  (`NS2_GATE_WORKER=1` restores the probe). Its certificate is the re-armed wait
  word (`+0x30` back to `row.wait`, state 1); `ro/launch` releases its own worker.

#### Launch reached PM; the mount never appeared (00:52 run)

`NS2_LAUNCH_MODE=serve` cleared the gate: test-gate certified the re-armed wait
word, the pm-launch worker's send returned `0`, and PM replied `result: 0` with
pid `213`. The launch was **served**, not held.

The swap still did not happen: `mounts: 0` and `requests: []` over the full
120 s poll, with the bound Loader domain (`root.targetDomain`) holding 1 entry
before and after. `imageAccepted` is `swapped && reply.result === 0`, so the
pipeline reported "PM did not accept the payload" even though PM had accepted
the launch. The unmodified-process cleanup (`pm:shell` id 1) returned `0xFA01`.

The 01:43 run reproduced it with the full-table diagnostics: `tableNew: 0`
across every domain entry (all types), `sessionsNew: 0`, and the bound
session's request header never changed. PM still created the right title
(`programId 0x0400000000000037`). So the launch performs **no FS work at all**;
the "the entry is in another domain" explanations are ruled out.

`flags 0x10` is `StartSuspended`: PM creates the process, but the Loader loads
nothing until `pm:dmnt` id 1 (start), which `runtime.activate` calls after the
launch. The `imageAccepted` gate therefore checks the wrong phase.

The 02:06 run confirmed the same launch result (pid 212) and that the direct
start probe (`pm:dmnt` id 1 through `root-native-ipc`) **hangs**: the request
never returned and the stage timed out after 60 s. A blocked start is exactly
what a deferred mount looks like.

The 02:23 run sent the start from a worker (`pm-start`, `areaOffset 0x80000`)
so the host could read the bound session and the domain table while the send
was blocked. The first post-release read never returned and the console
**aborted to the fatal error screen** ("press the power button to restart").
The network stack still answered ping, so this is a fatal abort, not a silent
hang. Delivering the Loader's mount into the FS state we had parked is fatal on
this build, the same failure seen at 23:59. The error code on that screen is
the missing diagnostic. The display is `2000 + module` (switchbrew): `2162-0002`
is module 162 (`Err`), description 2 = `SystemModuleAborted`; raw `0x4A2` is
`svcBreak` (Komet-CL). That is a **system module** asserting (FS, Loader, or the
launched RO), not the app. `2168-0002` is module 168 (`Creport`), i.e. an
application error.

The 02:58 run used `NS2_LAUNCH_FLAGS=0` (load inside the launch request) and hit
the same wall: the first poll read timed out, so the load is synchronous with
the launch send too and the control path is unavailable for its duration.

The start probe is now double-gated behind `NS2_ALLOW_CONSOLE_FREEZE=1` and is
off by default. Note that the local bridge `status` is a host-side flag, not a
live console check; use ping/TCP to decide whether the console survived.

The deferred-load phase still has to be gated without calling `pm:dmnt` id 1 on
a manipulated FS, and `flags 0` does not help. The remaining lever is a
chain-free actor: `n2h` exposes `peek`/`poke`, which are pure-Lua table
primitives and do not use the `call_deep` machinery that blocks during the
send. That needs a new binary-RPC command and a careful swap that restores the
destructive read's tag write.

#### Correction (2026-11-05): control 1 is CopyObject, not ConvertToDomain

In this CMIF build `wire.control(0)` is `ConvertToDomain` and `wire.control(1)` is
`CopyObject` (`app/domain.cjs`). The "control 1" request observed in the second
bound session is the stage-1 `CopyObject` of the app's save filesystem (object id
139, `app/mounted-save.cjs`), not a Loader request. The second bound row is
`ownDomain`, not the Loader's clone. The 23:05 burst woke that session's parent
(the `+0x28` pointer moved) but `receiveResult` stayed `3` because no request was
pending; the buffer was stale. Do not use the `otherTimeline` buffer as evidence
of the Loader frontier. To find the Loader, scan every fsp-srv session's request
buffer during a load, not just the two rows bound at boot.

#### Diagnostic mode (2026-11-05)

`NS2_LAUNCH_WAIT_ONLY=1` with `NS2_LAUNCH_FLAGS=0` releases the launch worker and
then waits host-side without any console RPC (`NS2_LAUNCH_WAIT_MS`, default 90 s).
After the wait it records `waitOnly.up` (TCP connect to `:8080`), then dumps every
fsp-srv session (`postSessions`) and the whole table (`postTableAdded` /
`postTableMatches`). This distinguishes "the load completed" from "the load is
still stuck". If the first read times out, the shim is still held and the native
retained-read/write worker is required.

The 23:37 flags-0 run went further: a system module aborted during the load
(`2162-0002` = Err/SystemModuleAborted; the error screen then suspends the app,
so its HTTP/Lua side dies), `waitOnly.up` was false, but `gate.restore()` still
succeeded. The FS session survives, but the endpoint is blocked (see the 23:50
run below). The post-load dump must therefore run even
when `up` is false (fixed in `5981391`); `up` is informational, and a dead
endpoint appears as a read error.

The 23:50 run showed the other half: `up: true`, but the retained read timed out
and the endpoint then answered `Another memory request is active`. The launch
send holds the launcher shim, so the retained endpoint is unusable during the
load; `restored: true` is a no-op in serve mode, not proof the endpoint worked.
The only reader is a **second native worker** (slot 2), which uses its own SDK
`send` on the candidate handle. `ro/launch` now prepares a slot-2 `retained-read`
worker that snapshots the target sentinel and the first free table window during
the load.

The 00:11 run prepared and released that worker, but the host's `worker-output`
read still timed out: it uses the same shim as the launch send. The slot-2
worker now has a `retained-dump` variant that reads the window and sends it to
the PC over TCP from its own thread (`socket/connect/send`, `tools/dump-listener.cjs`,
default port 39401). That channel is independent of the shim.

The 19:52 run then failed in the prepare itself: the GUI sets `NS2_FAST=1`, so
`n2h_rpc.lua` builds the worker frame, and that Lua builder only understands
numeric args and `{u32}` dynamics. The socket fd needed the new `{result:n}`
dynamic, the bridge turned the missing arg into `BigInt(undefined)`, and
`shared/rpc.cjs` returned "Cannot convert undefined to a BigInt". The
`retained-dump` worker now forces the host `seed-rop-chain.cjs` builder
(`native-worker.start` `forceHost`), which supports `{result}`; every other
worker keeps the fast console builder.

The 20:11 run got the prepare/release through, but the app faulted and the host
read timed out. The worker read `address - addressBias`, an arbitrary storage
offset; the retained cache maps a **fixed plan readOffset** to the plan target,
so that read returned storage file data, not FS memory. Fix: after the target
snapshot, retarget the cache to the window (`memory.read(windowAddress)`), pass
`plan(windowAddress, storageSize, cycle).readOffset` to the worker, and have it
read that exact storage offset.

### 2.5 `ro/prepare-event`

Exports the notifier's writable event via `GetEventHandle` (`ro/export-handle.cjs`), then
uses the Seedsow wrappers to check that `WaitSynchronization` on it times out (`0xea01`)
and that signal/clear round-trip. This stage only started passing after the offset fix in
2.2 — if you fork this, re-verify those offsets on your build first.

### 2.6 Donor capture (RO payload policy)

`pm:dmnt` is opened from the exported SM service, the RO CodeFS is opened
(`title 0x0400000000000037`), and `main.npdm` + `main` are captured. Two practical notes:

- The capture uses `<name>.partial` + a hard link and refuses to replace an existing file.
  A crashed run leaves both behind and the next run dies with `EEXIST`. `ro/files.cjs` now
  removes the stale `.partial` and destination first.
- The captured `main` hash is compared against `ro/payload/main`, so rebuild the payload
  if you edit `ro/payload/*.c`.

---

## 3. Cross-checks from a parallel Seedsow port (`remote-lua-sw2`, Nov 2026)

A second implementation for the same demo (`010042d022aea000`, system 23.0.1) and the
same SDK (memcpy `0x5224e0`, SendSyncRequestWithUserBuffer `0x168c54`, CloseHandle
`0x168be4`, GetServiceHandle `0x14cc90`) reached our acquisition stage but never produced
a usable alias. Its measurements are still useful, and three have been adopted here.

### 3.1 `SleepThread` sleeps 1.63x too long — confirmed on *our* console

Its nanosleep conversion uses a 31.25 MHz constant while the system tick counts at
19.2 MHz. That is directly visible in our own probe report: the wave asks for delays of
300/350/450/550/650/1700/2000/2150/2800 µs and the workers started at
490/573/738/902/1067/2781/3271/3517/4576 µs — a 1.63x stretch on every role.

The probe now scales every worker `sleep` argument by `19200000/31250000`
(`NS2_SLEEP_RAW=1` restores raw nanoseconds). This is the only change that puts the wave
on the reference wall-clock timeline instead of 1.63x behind it. Note that a *uniform*
stretch preserves the ordering; what it distorts is the relationship between the sleep
roles and the event-gated roles (`groupReleased`, `guardLaunched`, `holeDone`), whose
wake latency is 2–5 ms and unscaled.

### 3.2 Thread tuning this libc only accepts at creation

- Priority range is **5–35**; 5 is the highest accepted and makes most wakeups prompt.
  (`NS2_WORKER_PRIO=5`)
- `pthread_setaffinity_np` on a live thread returns `EINVAL`. Pinning must happen through
  `pthread_attr_init` + `pthread_attr_setaffinity_np` + `pthread_create`, round-robin over
  the allowed cores, core 0 excluded (it carries the game/main thread and the RPC loop).
  (`NS2_WORKER_AFFINITY=1`)
- `pthread_t` is **tagged** (`0x32cab74007` style) and must be passed back exactly; do not
  require 8-byte alignment.
- Verified Seedsow offsets: `pthread_attr_init` `0x1426c0`, `attr_setaffinity_np`
  `0x1428f0`, `attr_destroy` `0x142700`, `pthread_setschedprio` `0x141d80`,
  `GetThreadAvailableCoreMask` `0x1371e0`, `GetCurrentThread` `0x137050`,
  `SleepThread` `0x137100`, `GetSystemTick` `0x137240`, `GetSystemTickFrequency`
  `0x137270`, `WaitForAddress` `0x168d1c`, `SignalToAddress` `0x168d24`.

Both knobs travel in the `workers-start` spec (now a 48-byte record: priority at `+40`,
flags at `+44`, bit 0 = pin at creation) and are **off by default**, so the existing
timing is untouched unless requested.

### 3.3 Acquisition knobs now exposed

Every default reproduces the numbers that already reached `memory-ready` here.

| env | default | effect |
|---|---|---|
| `NS2_COMMIT_MB` | 16 | dirty-commit size. On this build 16 MiB drains the canary lookup at the commit end; 8 MiB lets it interleave and walk into the freed entry. |
| `NS2_SKIP_REPRO` | off | accept one confirmed marker instead of demanding a genuine second positive. |
| `NS2_SKIP_EXTENT_REQUAL` | off | keep the extent already proven instead of requalifying after every marker write. |
| `NS2_FIELD_OFFSET` | `markerOffset` | where the copy tail/qwords are placed. The payload must stay inside the five-`0x800`-piece window `(0x2000, 0x2800]`. |
| `NS2_PIN_BYTES` | 7440 | measured `newPersistentBytes` on this unit (the pin/candidate cost checks). |
| `NS2_SLEEP_RAW` | off | 1 = raw nanoseconds instead of the 19.2/31.25 scaling. |

Evidence for `NS2_SKIP_REPRO`: in that port's 73-run dataset on this same build, every
recorded `markerReproduced` came from a skip path — a genuine second positive never
appeared. Our default demands one, which costs an extra positive wave, two
requalifications and two hard failure points (`Repeated overwrite missed the canary`,
`The interleaved input extent did not requalify`). Turn it on when the boot is being
retired anyway; the alias content check is independent proof that the marker landed.

**Boot lottery, measured 2026-11-04.** Across the 55 recorded probes on this unit (all at
`NS2_COMMIT_MB=16`): **10 reached `memory-ready` (~18%)**; 29 failed with
`No changedLink candidate on this boot` at ~60 s each; the rest failed earlier setup checks.
A usable boot needs at least one `changedLink` cache candidate. The probe refuses
`zeroTail`/`stableLink`-only plans on purpose: those install a plan whose first FS operation
blocks inside the sysmodule (recorded on earlier boots), so failing cleanly is the correct
behaviour. The practical budget is therefore 10–20 app relaunches per Start; after three
consecutive `No changedLink` boots, a console restart changes the FS cache layout more than
the relaunch does. Network transport is not the bottleneck: a failed probe is ~1550 RPCs at
~28 ms each, and Ethernet saves only ~5 ms per request.

### 3.4 The marker offset is a per-unit property — do not copy theirs

Their relation `markerOffset = round(0x2340 * pinAllocation / 13616)` yields `0x1343` for
a 7440-byte pin, and their unit needs `0x1343`/`0x1351`. **Our unit reports the same 7440
pin and clears the canary at `0x2340`** (verified end to end: alias attempt 0 selected,
retained memory ready). So the offset is a property to measure per boot/unit, not a
constant to port. Our sweep evidence is 2 good boots at `0x2340`; theirs is 0/8 at the
same value on their console.

Note the knob mismatch when comparing configs: our probe hardcodes
`markerOffset = 0x2340` in `memory/probe-reserved-gap-seedsow.cjs` and only reads
`NS2_FIELD_OFFSET` (defaulting to the same value). It does **not** read
`NS2_MARKER_OFFSET`, so their `NS2_MARKER_OFFSET=0x1343` / `0x1351` runs are not
directly reproducible here without a code change. Their marker/field split (a marker
that lands but misses the selected-directory slot) is the same distinction our
`fieldOffset` covers.

### 3.5 Confirmed operational rules

- One acquisition per boot, and a *clean* probe exit still consumes the boot: a second
  run in the same process disconnects during the next wave.
- Opening a storage before the wave perturbs the FS heap and can stop the overwrite from
  changing the canary at all. Our GUI's pre-run `save-list --clean` therefore opens the
  save mount immediately before the probe — if a boot fails unusually early, try a boot
  where the save is already clean and the clean step is skipped.
- Same wedge signature: `/eval` stops answering, even though `:8080` still accepts TCP.

### 3.6 What did not transfer

- Their alias never selected (that is their current gate). Our `changedLink` gate and
  alias path are already past it.
- Their `retained/find-metadata` never ran; our failure
  (`The pool capture has no native links`) has no counterpart there.
- No cancellation/OpenThread material: their tree verifies `CancelSynchronization` in
  `retained-memory.cjs`/`worker-control.cjs` exactly like ours and has no RO gate
  implementation, so the wall in 2.4 stands.

Re-checked their 2026-11-04 snapshot (`remote-lua-sw2-main (1)`):

- Their vendored copy of this tree predates the wake/prime/unpark work, so their
  `test-gate` evidence is the original inject path only.
- They added `NS2_SKIP_REBUILD=1` in `gate.cjs` (skip the empty idle rebuild). Their
  comment says the idle injection is the only step that needs cancellation; the real
  `step()` still injects, and every injection here has frozen the console. Ported as a
  default-off option; not a fix.
- Their two new dead ends are the ones we already recorded: `cancelSourceHandle` from
  the app is `0xE401` for all seven workers, and `root-native-open-thread`
  (`sdk+0x168d1c`) is `svcWaitForAddress` (`0xF001`). FS text is still unreadable
  through the retained alias.
- They have the RO payload source (`ro/payload/main.c`, `process.c`) but no way to load
  it before the gate; their own note calls it a bootstrap cycle. The partial `fs.elf`
  lives in their separate `seedsow-fs-escalation-20261104` package, not this tree,
  and covers only the `IFile`/`IStorage` dispatchers.
- Practical leftovers: their `runtime.cjs` retries a `SyntaxError` (probe rewrites its
  report) - ported; their engine carries the wifi-savekit `local-release.cjs` 40 ms
  arm-gate release for last-gen probes, which would have to be re-derived for the
  Seedsow probe before it can lift our canary rate.

### 3.7 Emulators do not reproduce this wall

Switch 2 emulation is HLE: `fsp-srv`, the kernel wait objects (`waiters`/`selected`/
epoch) and the FS thread pool live inside the emulator's own data structures, not in
guest memory we can reach with `n2h`. The cache alias in stage 2 depends on the real
FS heap layout and the game's boot lottery; an emulator has neither. An emulator is
fine for payload syntax and HTTP framing, useless for the gate.

---

## 4. Quick failure-signature table

| message | stage | meaning / action |
|---|---|---|
| `No changedLink candidate on this boot` | 2 | bad boot geometry; relaunch |
| `Overwrite missed the qualified canary` | 2 | placement miss; relaunch |
| `Field copy did not qualify within its attempt limit` | 2 | same, after many retries; relaunch |
| `Bounded FS send timed out` | 2 | bad plan; app still closable; relaunch |
| `The pool capture has no native links` | 3 | plan landed on linkless bytes; relaunch (multi-window fallback already tried) |
| `One-shot request did not settle` | 3 | gate without cancellation (2.4) |
| `Another memory request is active` | 3 | a console call is still running (`TryWaitThread`/join); the endpoint is wedged, power-cycle (2.4) |
| `PM did not accept the payload` | 3 | PM replied (`result: 0`, pid) but no mount entry was swapped; inspect `mounts`/`requests` in the launch proof (2.4) |
| `PM did not answer after the filesystem exchange` | 3 | FS served but PM never replied; inspect the launch proof's poll records |
| `The native event syscall wrapper ...` | 3 | Seedsow SVC offsets (2.2) |
| `Field copy length ... outside the five-piece window` | 2 | `NS2_FIELD_OFFSET` below `0x2000`; use `0x2340` or shrink `extent` |
| `Pinning allocation cost changed` | 2 | `newPersistentBytes` differs from `NS2_PIN_BYTES` (7440 here) |
| `mounts sdk mismatch` | setup | game relaunched; re-run `resume.ps1` |
| `/eval` resets while `:8080` accepts | setup | parked/killed serve loop (section 0); wait ~90 s or relaunch |

---

## 5. If you fork this for your own target

1. Re-derive the SVC veneer table for *your* SDK build before anything else
   (`research/find_svc.py` scans `sdk.text` for `svc #imm; ret` and prints offsets).
2. Expect the acquisition gates to be target-specific; do not assume `changedLink` exists
   on yours. Log every candidate's flags and correlate with outcomes before tightening a
   gate.
3. Keep the single-client rule in mind: every tool must go through the bridge, and any
   cleanup must shut the loop down gracefully.
4. Make the probe fail *cleanly* (bounded sends, early rejects). A wedged console costs a
   relaunch, and a relaunch is the expensive part of every iteration.
