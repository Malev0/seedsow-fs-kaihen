---
tags: [overview, architecture]
---

# The Console Landscape

The Switch is a multi-process system. Four kinds of process matter here.

```
+-------------------+        IPC        +---------------------------+
| Seedsow app       | <---------------> | fsp-srv  (filesystem)     |
| (our foothold)    |                   | cache, mounts, sessions   |
+-------------------+                   +---------------------------+
        |                                          ^
        | asks to launch a program                 | serves mount/open/read
        v                                          |
+-------------------+                   +---------------------------+
| pm:shell/pm:dmnt  | -----------------> | ldr (Loader)              |
| (process manager) |   start/load       | asks FS for the image     |
+-------------------+                   +---------------------------+
        |
        v
+-------------------+
| ro (read-only)    |  the system program we want to replace
| 0x0400...0037     |
+-------------------+
```

## The app (Seedsow)

A normal application running the Artemis visual-novel engine. The launcher save gives it a
Lua environment with `_G.n2h`:

- `n2h.call_deep(fn, a0..a4)` — call an SDK function with a ROP chain.
- `n2h.peek(addr)` / `n2h.poke(addr, value)` — 8-byte memory primitives.
- `n2h.alloc`, `n2h.str_addr`, `n2h.run_chain`.

This is our foothold. It is powerful but **not privileged**: the app still has the app's
own handle table and permissions.

## fsp-srv (the filesystem sysmodule)

A background system process. It owns:

- the **cache** (dirty pages, extents, free lists),
- the **mount table** (which filesystem is attached to `save:`, `game:`, …),
- the **session pool** (one server session per client connection),
- the **IPC handlers** for file, directory, storage and proxy operations.

Everything interesting goes through fsp-srv. If we can control its memory, we can control
what it returns to the Loader.

## pm:shell and pm:dmnt (process manager)

Services used to launch and inspect processes:

- `pm:shell` **cmd 0** = `LaunchProgram` (we pass flags, a title id, storage id).
- `pm:shell` **cmd 1** = `TerminateProcess`.
- `pm:dmnt` **cmd 7** = `GetProgramId` (returns the title id for a pid).
- `pm:dmnt` **cmd 1** = start a suspended process (we believe; calling it on a manipulated
  FS blocks and aborts the app).

## ldr (the Loader)

The system module that actually loads a program:

1. receives a load request from PM,
2. asks fsp-srv to **mount the program's CodeFS**,
3. opens `main` and `main.npdm`,
4. maps and starts the process.

Step 2 is the operation we want to intercept. See [[The Mount Table and CodeFS]].

## ro (the read-only system program)

Title `0x0400000000000037`. It validates and launches other programs. Replacing it is the
classic escalation target: it runs with system permissions.

## The kernel

The kernel owns the objects everything else refers to: processes, threads, sessions,
events, handles. Two kernel behaviours matter:

- **IPC is synchronous.** `SendSyncRequest` blocks the caller until the server replies.
- **Waiting is an array.** A thread waits on several handles at once; when one becomes
  ready the kernel writes the ready object into a “selected” slot.

Both are explained in [[The Wait Array and Parking]].

## Why the app can control the FS at all

It cannot, directly. It controls the FS **through a corrupted cache descriptor**: the FS is
made to read/write at an address we choose, on our behalf. That is [[The Retained Cache]].

## Related

- [[IPC and Sessions]]
- [[Domains]]
- [[PM and the Loader]]
