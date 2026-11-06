# ns2jb repo analysis — complete (2026-10-31)

Porting target: replace the **PC Node.js orchestrator + SmileBASIC .bas** with **on-console Lua** running in
the Artemis engine's Lua 5.1 VM (Seedsow save foothold). This document summarizes how ns2jb works end-to-end
and what the Lua port must implement. Sources: direct reading + three subagent reports.

---

## 1. Architecture overview

Two cooperating halves:

**Console (SmileBASIC 4.4.9 app process, Switch 2 / Horizon):**
`bootstrap.bas` = the native-call primitive. A SmileBASIC program whose data pointers alias process memory.
It builds a fake closure ("call structure"), executes arbitrary 4-arg native calls, opens a TCP socket
(port from PC), and runs a blocking RPC loop. Everything the PC sends is executed natively.

**PC (Node.js, `run.cjs` + `engine/`):**
TCP server on port **39380**. The console connects out (`V=START(port,ip octets...)`). The PC then
orchestrates a 4-stage pipeline (`pipeline.cjs`): app map → FS memory acquisition → RO payload launch →
FS demo. Each stage makes native calls via the RPC (0x8080-byte packets) and keeps JSON reports in the
run folder. All the "exploit logic" lives on the PC; the console is a dumb executor.

**The port**: Lua VM replaces the PC *driver* (the pipeline logic) and the .bas *executor*. The Lua VM's
corruption primitive gives the same 4-arg native-call capability, then the Lua code implements the entire
pipeline in-process (no RPC round-trips at all — which removes the timing jitter that the PC compensates
for with retries).

---

## 2. The SmileBASIC bootstrap primitive (bootstrap.bas)

### Heap corruption
`RUN` then, from Direct mode: `REMOVE NSR,&H60000000,&H3FFFFFFF` → **Out of memory** (expected).
`REMOVE` on the array `NSR` (4 strings) frees its data area while keeping the array headers, so the
strings' data pointers alias SmileBASIC's VM structures. Effect: `COPY NSR[n],off,...` reads/writes
process memory. The `.` bas program then re-derives all addresses (addresses are rediscovered at boot,
not hardcoded).

### Addressing (crucial)
SmileBASIC 4 strings are arrays of **16-bit chars**. All `COPY`/`W$`/`P$` offsets are in **chars**,
and the console maps `NSR[1]@X chars` → `S#+2X bytes` (S# = the 0x80000-byte scratch string area,
found via the HELLO handshake). `P$`/`U#` pack/unpack a **u64** as 4 16-bit limbs.

| NSR[1] char offset | S# byte offset | Role |
|---|---|---|
| 1036 | 2072 | function pointer (u64) |
| 127004 | 254008 | arg 1 (u64) |
| 127120 | 254240 | arg 2 (u64) |
| 127128 | 254256 | arg 3 (u64) |
| 127132 | 254264 | arg 4 (u64) |
| 8216 | 16432 (0x4030) | result 1 |
| 8220 | 16440 (0x4038) | result 2 |
| 126976 | 253952 (0x3E000) | 592-byte fake closure QF$ |
| 0x20000 | 0x40000 | RPC recv buffer (0x8080 bytes) |
| 0x2900 | 0x5200 | connect() sockaddr |
| 0x2A00 | 0x5400 | HELLO packet (128 bytes) |

The `PUT` list in BOOT() writes the *function pointer table* into the fake closure (memmove at 2072,
the result slots, and several SDK function pointers used by later stages).

### Native call (RAW#)
`RAW#(V$)` writes 40 bytes into the fake closure: function address (u64) at 1036 chars, then
arg1..arg4 (u64 each) at 127004/127120/127128/127132 chars, then triggers the call via the aliased
`G#`/`CP$` string-cache hook, and reads back a u64 result at 8216 chars. `CALL#(F,A#,B#,C#,E#)` =
`RAW#(P$(D#+F) + 4×P$(arg))` — D# = the SmileBASIC SDK code base (found via a permissions-5 scan with
a 0x9DB49C marker, CRC 3925528160).

### RPC loop
`RPC()`:
- `recv(fd, S#+0x40000, 0x8080, 0x40)` — request packet = 0x8080 bytes:
  - [0..40) call record 1, [40..80) call record 2, [0x80..0x8080) = 0x8000 bytes of write data.
  - 40-byte call record = 5 u64s (function address + 4 args), 20 chars each.
- executes both calls via RAW#; restores the first call's result into the second slot.
- `send(fd, S#+0x4030, 0x8010, 0)` — reply = 0x8010 bytes:
  - [0..16) = 2 u64 results (bytes 8–15 = call 1's result, bytes 0–7 = call 2's result),
  - [0x10..0x8010) = the output buffer contents (S#+0x4040, 0x8000 bytes).
- `shutdown` = a zeroed 40-byte call record.

### HELLO handshake
`HELLO$` = 16 u64s = 128 bytes:
`magic "DS21" (0x31545344), protocol 1, console type 2, scratch, scratchBytes (0x80000), main (M#),
sdk (D#), got (G#), backing (MM#), controller (B#), C# (C#+16), 0,0,0,0, sdkCrc32 (3925528160)`.
The PC parses these in `lib/connection.cjs:69-90`; fixed offsets (memmove = sdk+0x5872F0 etc.) are validated.

---

## 3. The PC-side native client (engine/lib/native.cjs)

Wraps the RPC into primitives:
- **call(offset,...args)** — 1 call + no-op memcpy; result = bytes 8–15.
- **query(address)** — SDK `0x158314` = svc QueryMemory wrapper → MemoryInfo (permissions/type/size).
- **read(address, length)** — memcpy(dst=output, src=addr, len); output = the 0x8000-byte reply buffer
  (0x8000 bytes per round trip). `guard()` walks QueryMemory regions to ensure no IPC/device refs.
- **write(address, bytes)** — memcpy(dst=addr, src=scratch+0x40080, len); data rides in the request packet.
- **verifyFunction(address, expected)** — pins the bytes at an address (used for the SDK function table).
- `callAddress(address, ...args)` — the same, but with an absolute address instead of a SDK offset.

SDK functions (from `shared/sdk-functions.json`, offsets in the SmileBASIC SDK code):
| name | offset | bytes |
|---|---|---|
| allocate | 0x577310 | 0x5e1000-SDK alloc wrapper |
| free | 0x55B020 | e48c0114 |
| getService | 0x140510 | fd7bbea9... |
| send | 0x15823C | svc 0x22 + ret |
| close | 0x1581EC | svc 0x16 + ret |
| memset | 0x588C60 | 620600b4... |
| socket | 0x140960 | 6c121214 |
| connect | 0x140870 | 6c121214 |
| closeSocket | 0x1409B0 | 6c121214 |
| fcntl | 0x140AA0 | ff8303d1... |
| poll | 0x1409F0 | 6c121214 |
| errno | 0x140CD0 | 00121214 |
| memcpy | 0x586FB0 | (verified separately in code) |
| crc32 | 0x71310 | |
| queryMemory | 0x158314 | |

**Horizon svc numbering on Switch 2 is identical to Switch 1**: `svc #0x16 CloseHandle`,
`svc #0x21 SendSyncRequest`, `svc #0x22 SendSyncRequestWithUserBuffer`, `svc #0x1f ConnectToPort`,
`svc #0x1b SleepThread`, `svc #0x18 WaitSynchronization`, `svc #0x43 ReplyAndReceive`,
`svc #0x41 AcceptSession`, `svc #0x24 GetProcessId`, `svc #0x25 GetThreadId`, `svc #0x29 GetInfo`,
`svc #0x76 QueryProcessMemory`, `svc #0x74 MapProcessMemory`, `svc #0x77 MapProcessCodeMemory`,
`svc #0x73 SetProcessMemoryPermission`, `svc #0x6 QueryMemory`, `svc #0x0b SleepThread`,
`svc #0x1e GetSystemTick` (from `ro/payload/start.S`). svc 0x22 = SendSyncRequestWithUserBuffer (that's the
`send` SDK function — `410400d4`), svc 0x16 = CloseHandle (`c10200d4`).

---

## 4. The pipeline stages (PC side)

### Stage 1/4 — app map / inspect-mounts / qualify
`app/map.cjs`: enumerates the whole 39-bit address space via QueryMemory (≤4096 regions) → `memory-map.json`.
`app/timing.cjs`: finds the native compatibility module uniquely (permissions==5, size==45989888 = 0x2BD8000).
`app/inspect-mounts.cjs`: walks the SDK mount table (`mounts.json`, head = sdk+layout.mountTableOffset,
entries accessor@−8, name@24, implementation@40, service@40.., manager objectId) → `mounts.json`.
`app/qualify.cjs`: allocates a 0x80000-byte Session, verifies worker code + events + timing
(31250000 Hz), multipart transfer, `pthread_current`/core-mask/affinity (pinAll), a 0x10002-byte
random read/write round trip, and verifies SDK bytes vs `shared/sdk-layout.json`.
`app/affinity.cjs`: pins the core mask (used by the wave timing).

### Stage 2/4 — acquire FS memory
`memory/probe-reserved-gap.cjs` (814 lines, the actual FS exploit) + `session.cjs`, `wave-overlap.cjs`,
`native-links.cjs`, `signed-cache-plan.cjs`, `capture-workers.cjs`, `fs-memory-control.cjs`.
The primitive: **the app's own save-data storage cache aliasing, read via the FS domain objects**.
Steps:
1. `s.base` = 36 MiB (0x2400000) owned allocation in the app process.
2. Clone the app's mounts (`save` IFileSystem) twice; `fsp-srv` Initialize (command 1 + PID descriptor)
   gives an owned root IFileSystem.
3. Clone the root with CMIF control 2 (CloneCurrentObject) → **"gap client"** domain objects.
4. Reserve a **"gap"** in the FS general heap: 59 × **domain-manager reservation** requests (command 1200),
   each 208 bytes; the reservations are batched by workers (59 pages, SendSyncRequest per page).
5. The "wave": 13 native workers running in the app process, driving a **timing-controlled IPC storm**
   (up to 30 attempts) with `receiveOrderMarginUs >= 300` — the wave releases the gap group mid-flight
   and the *FS* reallocates the freed hole, creating a **clean alias** between an app-owned storage
   buffer and an FS-internal heap buffer. The **"combined leak"** writes a 7-copy prefix into the
   storage cache entry, so the FS alias cache entry is widened to the full cache read size, and
   `ReadFile` then returns FS-internal memory (the "clean alias") through the app-owned storage.
6. The widened read leaks an FS-internal pointer; the host then **writes** into FS heap through the
   alias cache (the write primitive) and installs a **"retained"** endpoint — a socket service on the
   PC (fs-memory-control.cjs) that keeps FS heap access live across the rest of the pipeline, with
   `root-native-*` commands (close-handle, file-capture, donor-prepare, ipc, sm-service, code-open...).
7. After the wave the host *promotes* the retained endpoint: the FS process can now be read/written
   via the retained workers, and the FS process's `GetEventHandle` method is reached (the notifier).

`memory/fs-memory-control.cjs` (steady-state server): the socketPath is acquired, and the rest of the
pipeline (ro/, process/) talks to it via `tools/fs-memory.cjs` `connect()` → `request({command, ...})`.
The FS process's own PID is 0400000000000000 (asserted in process/fs-execute.cjs:32).

### Stage 3/4 — RO payload launch
`ro/` + `ro/payload/`:
1. `ro/install-retained.cjs` → `ro/find-metadata` (retained) → `ro/layout.cjs` — the FS heap layout
   (manager table, `holderVptr = rootVptr − 0x16c0`, `slots = manager + 0xd48`, the 7-contiguous waiter
   array, `table + (id−1)*0x30` per domain entry → owner@0x18, object@0x20).
2. `ro/objects.cjs` — builds an **owned FS root** (`root-open`) and the **owned notifier**
   (FS SystemDataUpdateEventNotifier), both verified by clone-count challenges (`E` = object,
   `B` = E+8 backend/event-list, handle field at `B+0x24`, vptr `layout.rootVptr − 0x16c0`).
3. `ro/test-sm.cjs` — a **borrowed SM client** from the FS process (candidate address = layout.sdk+0x12a0);
   used for pm:shell GetProgramInfo (cmd 12) and pm:shell LaunchProgram (cmd 1) with title `0x0400000000000037`
   (the native RO program id) and flags 0x10 — a *new process* is launched by the FS process.
4. `ro/copy-loader-root.cjs` — the loader's own root object (fs process `0x0400000000000037` code-open);
   `loader.copy` is used to open CodeFS for the payload.
5. `ro/prepare-workers.cjs` — builds the *worker call-chain* (frames.cjs): a dispatch table + stack
   region in the app process (each worker = 0x140 stack bytes, dispatch table + 0x100, sentinel
   0xfedcba9876543210, chain built from verified SDK functions; `loadTable`/`call4`/`saveResult64`/`exit`).
6. `ro/prepare-event.cjs` — the **read-event** handle is exported through the notifier's handle field
   (`export-handle.cjs` swaps the backend handle at B+0x24) so the host can receive events from the FS
   process (the parked session is also set up here: `wait == receive`, capacity 256).
7. `ro/test-gate.cjs` — the "gate": park the target FS session row (write the wait word at row+0x30),
   cancel the 7 foreign FS threads, then rebuild the wait array. Verified/restored.
8. `ro/launch.cjs` — the payload launch: the FS process worker opens `pm:shell`, issues
   `LaunchProgram(title 0x0400000000000037, flags 0x10)`; the Loader mounts CodeFS for that title, and
   the domain table entry is **swapped** with the donor save-mount clone (files.cjs `donor prepare`).
   The donor save contains `/main` and `/main.npdm` (the payload binary, 4757 bytes, sha256-verified).
   The launch then returns the payload's PID.
9. `runtime.cjs` — `activate(proof)` → the payload registers `ro:1` (space 2, application space) and
   `ro:dmnt` (space 1, system space) via `sm:` and serves the IPC request loop (main.c).
10. `ro/probe.cjs` — the challenge: the host sends `0x524f0001` (with an 8-byte nonce) and the payload
    answers with `NS2ROEXE` magic, the nonce XORed 0x9d7c3a51, its PID, TID, tick, registration result.
    `ro/handoff.cjs` — restores the Loader session's 0x88-byte struct and the 7 waiters.

### The payload itself (ro/payload/main.c + process.c + start.S)
A ~4.7 KiB no-runtime ARM64 program (Zig-built, `layout.ld`, module header MOD0 + "NS2ROEXE").
- `main()` loop: `connect_port("sm:")` → registers `ro:1` (space 2) and `ro:dmnt` (space 1) →
  `reply_receive` (svc 0x43) waiting on 2 ports + 4 sessions.
- `respond()` parses the incoming IPC request (`0x01000004` special header + one copied handle +
  an optional kernel PID + one *receive map-alias buffer*, used only for bulk reads) and validates
  `p[at] == 0x49434653` ("SFCI" little-endian "IFCS"? actually 'SFCI' bytes = 0x49434653 = "SFCI"). The
  command dispatch:
  - `0x524f0001` — identity challenge (magic/nonce/pid/tid/tick/registration_result).
  - `0x524f0010` — probe info (pid, program, memory info at a given address, free address).
  - `0x524f0011` — **process memory read** via `map_process` (svc 0x74) + copy ≤4 MiB, unmap.
  - `0x524f0012` — **process memory write**: one aligned instruction block, exact expected bytes +
    readback (map_process + write + publish_code with `dc cvau`/`ic ivau`, unmap).
  - `0x524f0013` — **process memory write code**: MapProcessCodeMemory path (map_code/unmap_code,
    svc 0x77/0x78) with process_permission (svc 0x73) for RX/RW toggling.
  - `0x524f0014` — **read/write toggle**: process_permission (svc 0x73) on the target's code region
    (address/size ≤ 0x4000000, permission 4↔5 = RX↔RW).
  - `0x524f0015` — **FS code region R/W toggle** for program `0x0400000000000000` (the FS system program).
  - `0x524f0016` — **bulk read** through a *kernel-validated receive map-alias buffer* (the request's
    receive buffer) — this is how the host reads other processes' memory without an extra copy.
  The reply always includes a 16-byte `Reply` (result, value) plus the out bytes; the receive buffer
  is only used by 0x16. All the *memory read/write of other processes* happens inside this payload
  (svc 0x74/0x73/0x77/0x78 with the process handle transferred by IPC).
- `process.c`'s `process_request()` also rejects non-process handles (GetInfo type 18) and clamps
  all addresses/sizes; the mapped region is a `0x1000`-page-aligned alias in the payload's own space.

### Stage 4/4 — the FS demo (process/fs-execute.cjs)
The proof of code execution in the FS system process (program 0400000000000000):
1. `process/bind-notifier.cjs` + `process/qualify.cjs` — the notifier's parked 0x88-byte session row
   in the FS heap (`layout.slots` ring), verified idle (`wait == receive`, capacity 256).
2. `process/client.cjs` — `fsProcess()` (pm:shell GetProgramInfo cmd 12 / GetProcessId), `info()`,
   `read()`, `patch()` — all through the payload (`0x524f0010/0011/0012/0014/0016`).
3. `fs-execute.cjs`:
   - `table = m.pointer(notifier.E)`; `target = m.pointer(table + 4*8)` — the 5th vtable method
     (GetEventHandle) of the notifier's vtable in the FS process's **execute-only mapping** (type 3,
     permissions 4). The 16-byte instruction block at target is verified:
     `7f2303d5 ff8300d1 fd7b01a9 fd430091`.
   - Baseline `notifierCall(handle)` — the original method returns its event handle (1 copy).
   - **Trial**: replaces the 16 bytes with a generated stub:
     `d503245f` (paciasp? no — `d503245f` = `paciasp`), `w0 = nonce<<5 | 0x1fe` (nonce in bits 9..13),
     `0x72a00000 | (value>>>16)<<5`, `ret` — the patched method returns the nonce as a
     `Result`-shaped value, proving the FS process executes the fresh instruction.
   - `restore` — writes the original 16 bytes back, verified by readback + `notifierCall` re-verified.
   - The whole trial runs twice (2 nonces), then `restore` and the original behavior is re-verified.

### Optional firmware dump (`firmware-dump.cjs`)
After the FS demo, `--dump-firmware` enumerates the installed system-code CodeFS entries and captures
them (through the payload's 0x16 bulk-read) — a read-only system-program CodeFS dump.

---

## 5. What the port must implement (on-console Lua)

### 5.1 The primitive — replace the .bas
- The Artemis VM's Lua 5.1 must accept `\x1bLuaQ` bytecode chunks (`loadstring`). **Open question**
  (the seedsow repo doesn't test it; the remote_lua_loader exploit *is* the bytecode path, so it must
  work on PS5's Artemis; the Switch 2 Artemis build is the same engine, very likely the same).
- Adapt the remote_lua_loader primitives: `fakeobj` + `write_upval` (hand-crafted 5.1 bytecode) →
  fake string read, fake upvalue write, fake CClosure `fcall` (4 args, 64-bit). All fixed bytecode
  data; only the *VM structure offsets* (TValue, TString, CClosure, upvalue) and the *SDK function
  addresses* differ per game binary.
- The Artemis game's SDK is its own binary — the SmileBASIC SDK offsets (D#+...) do **not** apply. The
  port must find the equivalent functions in the Seedsow game binary (socket/connect/send/close, memcpy,
  memset, getService/SM, svc wrappers, crc32, queryMemory wrapper...). The remote_lua_loader's
  `eboot_addrofs` mechanism is the same idea but for the PS5 eboot; for the Switch 2 Artemis build the
  offsets must be rediscovered (either by scanning at runtime, or by a one-time PC-side analysis of the
  Seedsow game binary).
- The seedsow engine also has `httpget`/`httppost` engine tags (stub-restricted) — those could be an
  alternative to a raw socket, but the pipeline needs `socket`/`connect`/`send`/`recv` semantics, so a
  native SDK socket call is preferred (the RPC loop only needs the 4-arg call primitive, and the Lua
  driver does not need to run a TCP loop at all — see 5.2).

### 5.2 The driver — replace the PC Node.js
On-console Lua must do the full pipeline in-process, which is actually **easier** than the PC version:
- No RPC round-trips: every native call is direct (`fcall(4 args)`). The waves' timing jitter
  (the RPC round-trips + `receiveOrderMarginUs >= 300` + 30 attempts) becomes a deterministic
  in-process sequence of sleeps — **the on-console version should be much more reliable**.
- No JSON reports / socket server / hashing bookkeeping (the console can compute SHA-256 natively if
  needed; the SDK has a native SHA-256 at SDK+0x4CC0).
- What must be kept: the *console-side state* — owned handles, worker threads, the retained memory
  (the 4d8000-byte capture), the parked session row, the notifier's cloned handle, the loader root.
- The pipeline in Lua:
  1. Map the app's address space (QueryMemory in a loop) — find the SDK region, the mounts, and the
     scratch 0x2400000 (36 MiB) allocation.
  2. Qualify the app (SDK functions + worker chains — the Lua VM's fcall can build the same frames).
  3. The FS memory acquisition: the alias-cache exploit (IPC storm + 59 reservation + 13 workers) —
     all in Lua, issuing native calls directly. This is the biggest, most timing-sensitive piece.
  4. The retained endpoint (fs-memory-control.cjs) — replaced by in-process state; the PC's socket
     server just becomes a Lua table.
  5. The RO payload launch (pm:shell LaunchProgram + CodeFS swap + loader root).
  6. The payload's `0x524f0010-0016` command set — already native code, but the *driver* is the PC
     (the host sends the IPC requests from the game process via the payload's `ro:1`/`ro:dmnt` ports).
     In Lua: the game process connects to `ro:1` (space 2) and sends the IPC requests directly.
  7. The FS demo (fs-execute.cjs) — patch the FS process's `GetEventHandle` via the payload's
     `0x524f0012` and verify the nonce, then restore.

### 5.3 The payload — unchanged
`ro/payload/main` (4757 bytes) is already the on-console native helper; the Lua port must:
- Keep the Zig build (`build-payload.cjs --zig`), or re-embed the binary.
- The payload's IPC command set is the *portable* piece: it is a standalone service. The Lua code
  must be able to (a) `pm:shell LaunchProgram` the payload (through the FS process's borrowed SM client),
  (b) `code-open` the payload's title (`0x0400000000000037`) and swap the CodeFS entry, and
  (c) connect to `ro:1`/`ro:dmnt` and issue the `0x524f0010-0016` IPC commands from the game process.

### 5.4 PC-side-only bookkeeping (dropped by the port)
JSON reports, SHA-256 proofs, the fs-memory socket server, the run folder, the RPC transport,
the `guard()`/QueryMemory walk for every read/write (in-process the Lua code can maintain its own
map from the mapping enumeration), the wave retry logic (deterministic in-process).

### 5.5 What must be discovered / decided
1. **Bytecode acceptance** in the Artemis VM (`loadstring` of `\x1bLuaQ` chunks) — test first in-game.
2. **The Artemis VM's structure offsets** — for the fakeobj/fake-string/fake-CClosure primitives
   (the PS5 remote_lua_loader offsets are a starting point but not the same binary).
3. **The Seedsow game binary's SDK offsets** — the SmileBASIC offsets are a *template*: the port needs
   the same *set* of functions (memcpy, memset, getService/SM, send/svc 0x22, socket, close,
   QueryMemory, CRC32, allocate/free) at the Seedsow game's offsets, plus the same svc wrappers
   (the payload's start.S proves the svc numbering is the same).
4. **The seedsow engine's IO surface**: the `engine:file`/`e:file` stub restricts to `save:/` but the
   game's IO API is unrestricted — for the final FS access, the Lua code will likely read/write via
   the payload's process-memory commands (0x16 bulk read) or via the FS process's fsp-srv handles.
5. **The Seedsow save**: the seedsow editor's `config.run_slot` boots a Lua script from the save
   (`ssNNN.asb` → `sscodeNNN.lua`); the on-console Lua driver would be installed as a save entry,
   booted by the editor's bootstrap chain (the same chain used today for the editor itself).

---

## 5. Local validation of the Lua primitives (session notes)

Performed locally with `lupa` (stock Lua 5.1) on the PC — files `test_primitives.py`, `debug_str.py`,
`luac51.py`, `bc_disassembly.txt` in the working folder.

**Result: both evil bytecode chunks are valid, loadable Lua 5.1 bytecode in a stock 64-bit VM.**

- `fakeobj_lclosure_bc` (418 bytes) and `write_upval_bc` (436 bytes) both have the standard Lua 5.1
  precompiled-chunk header: magic `\x1bLuaQ`, version 0x51, format 0, **little-endian, sizeof(int)=4,
  sizeof(size_t)=8, sizeof(Instruction)=4, sizeof(lua_Number)=8, integral=0** (i.e. a 64-bit build).
  Source name `@bcgen.lua`. `loadstring` accepts both in stock Lua 5.1 — the engine-side question
  ("does the in-game `loadstring` accept bytecode?") is the remaining variable, not the chunk format.
- Decoded with `luac51.py` (Python Lua 5.1 chunk parser; full output in `bc_disassembly.txt`):
  - `fakeobj_lclosure_bc`: outer proto (1 param, 7 instructions, 1 constant) + 2 nested protos
    (2 upvalues each). Constants include the numbers 1337.0 and 42.0 (the fake-string length check and
    a marker value).
  - `write_upval_bc`: outer proto (2 params, 6 instructions) + 2 nested protos.
- `lua.addrof_trivial` relies on `tostring(x):match("^%a+:? 0?x?%(?(%x+)%)?$")` — in stock Lua this
  resolves tables as `table: 0000028A219D8E10` (no `0x` prefix on MSVC builds, which the pattern accepts).
- Caveat found locally: the `create_str_hacky` allocator-reuse loop (`collectgarbage()` + alternating
  table/string allocation, expecting table addresses to repeat) did **not** reproduce in `lupa` — the
  allocator did not recycle table addresses across GC cycles the way the PS5 build apparently does.
  This is an environment quirk, not evidence against the target VM; the port must re-derive a
  known-address string allocation for the Seedsow VM (or rely on the bytecode's `fakeobj` path with a
  differently-obtained address).

**Lua 5.1 TString layout assumed by the primitives**: 24-byte header
(`next`(8) + `tt`/`marked` + padding/hash + `len`(8)) with string data at `+24`
(`lua.create_str` returns `addr+24`), which matches a standard 64-bit Lua 5.1 build.

---

## 6. Session status

- ns2jb repo analysis: **done** (this file).
- remote_lua_loader + seedsow analysis: done (previous session, see handoff.md §1-2).
- Next: bytecode acceptance test, then the Lua primitive adaptation, then the driver port.
