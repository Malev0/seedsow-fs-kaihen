---
tags: [overview]
---

# Big Picture

## The goal

Get **our own code** running inside the Switch's **filesystem sysmodule** (`fsp-srv`), or at
least make the system load **our payload** instead of the real read-only system program
(`ro`). Once code runs in a sysmodule, the usual sandbox limits on the app no longer apply.

We do not have a kernel exploit and we do not have a signed payload. What we have is:

- a **Lua foothold** in the game (the launcher gives us `_G.n2h`),
- **arbitrary memory read/write** inside the game process,
- **native calls** (we can call SDK functions from a worker thread),
- and a **bug in how the filesystem caches and mounts program code**.

The exploit abuses that bug to make the filesystem give the Loader **our** file where it
expects the real system program.

## The two halves

```
   PC (Node, this repo)                      Console (Seedsow app)
   -------------------                       ---------------------
   plans addresses, builds frames  <---->    _G.n2h  +  n2h_rpc.lua
   hashes, verifies, decides                 arbitrary R/W, native calls
        |                                          |
        |                                          v
        |                                   FS sysmodule (fsp-srv)
        |                                   cache, mounts, sessions
        |                                          ^
        +------------------------------------------+
             we read/write FS memory through a
             corrupted cache descriptor
```

The PC does all the thinking. The console only executes primitive operations and ships
bytes back. This matters because the console-side environment is tiny and fragile; the PC
can retry, log, and compute.

## Why it is hard

1. **We start outside the FS.** The game is a normal application. The FS is a separate
   system process. We cannot simply call its functions.
2. **The FS is the thing that serves memory.** To read or write FS memory we first have to
   corrupt the FS's own cache so that one of *its* reads becomes *our* read. That is a
   timing race against its allocator (`Stage 2`).
3. **The interesting operation is a mount.** When the Loader loads a program, the FS
   creates a **CodeFS** object and puts it in a domain table. We want to swap that object
   for our payload. The window is microseconds, and the FS is busy while it happens.
4. **Our control channel lives in the same app.** While the app is blocked inside an IPC
   send, the launcher's native call path is blocked too. So “just poll during the load”
   does not work (`The Control Path and Why It Blocks`).

## The exploit in one paragraph

Corrupt the FS cache until the FS itself performs a read/write at an address we choose.
Use that to install a **retained** memory endpoint and to capture the real `ro` program
files. Then arm a **gate** on the FS session the Loader will use, ask the process manager
to launch a replacement `ro`, and while the Loader's mount request is held, **swap the
target CodeFS object for the captured donor object** that points at our payload. Release
the gate; the Loader reads our bytes; our code runs.

## What “success” looks like

- `imageAccepted: true` in `ro/launch` — the mount was swapped and PM accepted the launch.
- `runtime.activate` starts the replacement and terminates the original `ro`.
- Stage 4 maps the payload into FS and verifies execution.

We have not reached that yet. Today the launch returns `result: 0` and a pid, but
`mounts: 0` and `imageAccepted: false`.

## Where to go next

- How we got inside the game: [[The Foothold]].
- New to the terms: [[Glossary]].
- Want the pipeline: [[The Four Stages]].
- Want the current wall: [[Current Status]].
