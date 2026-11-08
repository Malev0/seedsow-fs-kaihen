---
tags: [glossary, terminology]
---

# Glossary

Every term we use, in the sense this project uses it. Links go to the longer notes.

> [!tip] How to read a definition
> The first sentence is the plain-English meaning. The second is the technical detail.

## A

**Address plan** — the set of numbers that describe how to reach a chosen block through the
retained cache (target, read offset, header encoding). Verified in stage 2. See
[[Stage 2 - FS Memory Acquisition]].

**Alias / cache alias** — a corrupted cache block that the FS exposes at an address we
choose. Reading the alias reads our chosen address. See [[The Retained Cache]].

**Artemis** — the visual-novel engine Seedsow runs on. The exploit target is the Artemis
demo `010042d022aea000`.

**Auto-retry** — the GUI option that relaunches the app and starts another boot when a run
fails **before 3/4** (the stage-2 lottery). It never retries a stage-3+ failure.

## B

**Boot lottery** — the fact that stage 2 succeeds only when the per-boot FS heap layout
happens to satisfy several timing conditions. Roughly 18% of boots on this unit.

**Bridge** — the PC-side process that serializes console RPC. The engine bridge speaks the
`DST1` protocol; the fast bridge speaks `N2HR` on `:39380`.

## C

**Cache / cache block** — the FS's in-memory copy of file data, described by a descriptor
(data pointer, length, flags). Corrupting the descriptor gives us the memory primitive.

**Canary** — **not** the compiler stack canary. A marker path/file whose cached entry we
overwrite to prove the stage-2 write landed. Success is `canaryType: 0`.

**changedLink** — the only address-plan class that produces a working plan on this build. A
released block's free-list link word changes while its 16 KiB tail stays identical.

**call_deep** — `n2h.call_deep(fn, a0..a4)`: call an SDK function through a ROP chain. Uses
the shim's call machinery, so it blocks while a worker's send is pending.

**CodeFS** — the filesystem object for a program's code (NCA/ROM). The Loader mounts it
before reading `main`. See [[The Mount Table and CodeFS]].

**Commit / dirty commit** — a large dirty write that makes the FS flush cached data. Its
duration controls the stage-2 ordering (`NS2_COMMIT_MB`).

**Control request** — an IPC request of type 5/7, used for domain operations such as
`ConvertToDomain`.

**ConvertToDomain** — control command **0**. Turns a plain session into a
[[Domains|domain]] so the client can ask for objects by id. Do not confuse it with
**CopyObject**, which is control **1** (`app/domain.cjs`).

**CopyObject** — control command **1**. Asks a domain to copy one of its objects into the
caller's domain. The app's stage-1 save clone uses this; a stale `control 1` buffer is not
a Loader `ConvertToDomain`.

## D

**Donor** — the captured filesystem object built from the real `ro` files (`main`,
`main.npdm`). The swap points the mount entry at the donor. See
[[The Mount Table and CodeFS]].

**Domain** — a session that multiplexes many objects by id. See [[Domains]].

**Domain table** — the FS array of 0x30-byte domain entries. A mount adds an entry here.

**Domain entry** — one 0x30-byte record: next, prev, owner domain, object pointer, metadata.

## E

**Endpoint / retained endpoint** — the persistent memory service installed after stage 2.
`memory.read` / `memory.write` go through it.

**Extent** — a contiguous range of cached data. The probe “qualifies” an input extent before
using it.

## F

**fsp-srv** — the filesystem sysmodule. Owns the cache, mounts, session pool and IPC
handlers. The process we are trying to control.

**Field copy** — a stage-2 step that leaks qwords to build the alias. The payload must be
exactly `fieldOffset + tail + 1` bytes.

## G

**Gate** — the mechanism that parks an FS session and controls when it serves a request. See
[[Stage 3 - The Gate]].

## H

**Handle** — a per-process integer indexing that process's object table. Handles are not
portable between processes.

**Holder / inject-holder** — writing the session address into the pool thread's selected
slot to force the kernel to select the session. Fatal on this build with a real request.

**Hole** — a freed block the allocator will reuse. The stage-2 race is about having a “hole
request” still pending when the copy lands.

## I

**IPC** — inter-process communication over sessions. See [[IPC and Sessions]].

## K

**KThread / KProcess** — kernel objects for threads and processes. A KThread handle is what
`CancelSynchronization` needs; we do not have one for the FS threads.

## L

**Launcher** — the `switch-artemis-launcher` save that gives the game a Lua environment,
`_G.n2h`, and the HTTP `/eval` server. The foothold, not the exploit.

**Loader / ldr** — the system module that mounts the program's CodeFS and starts it. See
[[PM and the Loader]].

## M

**Marker / marker offset** — the byte offset inside the cache block where the stage-2 marker
lands. It is a per-unit property (`~0x2340` here; other units use `0x1343`/`0x1351`).

**memory-ready** — the stage-2 success state (`memoryControl.ready`).

**Mount / mount table** — attaching a filesystem to a name (`save:`, `game:`). The SDK keeps
a global mount table at `sdk + 0xb35870`.

## N

**n2h** — the Lua native library in the launcher: arbitrary read/write, `call_deep`, ROP
chains, `alloc`, `peek`/`poke`.

**NPDM** — the program metadata file (`main.npdm`) that describes a program. Captured as
part of the donor.

## O

**One acquisition per boot** — the rule that a boot can only be used once. Stage 2 modifies
the FS, so a stage-3+ failure needs a power-cycle.

## P

**Park** — replace a session's `+0x30` wait handle with our notifier so the FS stops serving
it. See [[The Wait Array and Parking]].

**Pin allocation** — the FS allocator's persistent allocation size. `7440` on this unit.

**PM** — the process manager (`pm:shell`, `pm:dmnt`). See [[PM and the Loader]].

**Poke / peek** — `n2h.poke(addr, value)` writes 8 bytes; `n2h.peek(addr)` reads 8 bytes but
is destructive (it writes a tag at `addr+8`). Both are pure Lua and do not use `call_deep`.

## R

**receiveResult** — the session's last receive result: `1` = success, `3` = timeout.

**Reserved gap** — a hole in the FS heap used to place the payload that corrupts the cache
descriptor.

**Retained cache** — see [[The Retained Cache]].

**RO** — the read-only system program `0x0400000000000037`. The replacement target.

**ROP chain** — return-oriented programming: a sequence of existing code gadgets and SDK
functions, used to run native calls without new executable code.

**RPC** — remote procedure call. The PC↔console protocol (`N2HR` on `:39380`, or `/eval`).

## S

**SDK base / main base** — the load addresses of the SDK and the app's main module. All
offsets are relative to these.

**Selected slot** — the kernel field (`parent + 0x10`) where the ready object of a wait is
written.

**Serve mode** — the gate mode that parks, unparks, wakes and lets the FS serve normally
(no fake holder).

**Session** — an IPC channel between a client and a server. See [[IPC and Sessions]].

**Settle** — a short delay after a wake, letting the kernel/FS re-arm before the next step.

**SFCI / SFCO** — ASCII magics at the start of a domain request payload (`SFCI`) and a
control/close message (`SFCO`).

**stableLink / zeroTail** — weaker address-plan classes. They do not work on this build and
can wedge the FS; the probe refuses them.

**sysmodule** — a background system process (e.g. `fsp-srv`, `ldr`, `pm`).

## T

**Title ID** — the 64-bit program identifier, e.g. `0x0400000000000037` for `ro`.

## U

**unpark** — put the real wait handle back and wake. See [[The Wait Array and Parking]].

## W

**Wait array** — the set of handles a thread waits on. The kernel returns which one is ready
and writes the selected object. See [[The Wait Array and Parking]].

**Wave** — one stage-2 attempt: park workers, dirty data, release, watch the canary/alias.

**Worker** — a native `pthread` created from a crafted frame, used for timed native calls.
See [[Worker Frames and ROP]].

## Numbers

**0x10 launch flags** — `StartSuspended`: PM creates the process but the Loader does no FS
work until a separate start. See [[Launch Flags]].

**2162-0002 / 2168-0002** — `2162-0002` is a **system module** abort (`Err`, `0x4A2` =
`svcBreak`): the FS, Loader, or launched RO asserted. `2168-0002` is an application error
(`Creport`): Seedsow itself faulted. See [[Error Codes]].
