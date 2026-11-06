---
tags: [stage, hardest, wall]
---

# Stage 3 - The Gate

**Files:** `ro/gate.cjs`, `ro/test-gate.cjs`, `retained/retained-memory.cjs`
(`inject-holder`), `ro/worker-control.cjs` (`cancelWorkers`)

**Goal:** control *when* the FS serves a request, so we can swap a filesystem object before
the Loader reads it.

This is the conceptual heart of the exploit, and the place we are currently stuck.

## Why a gate at all

The Loader asks the FS to mount the program's CodeFS. The FS creates a **CodeFS object** and
stores a pointer to it in a **domain entry**. Then the Loader reads the image through that
object.

If we could replace that pointer with the **donor** object (our payload) *before* the read,
the Loader would load our bytes. The window is tiny, so we need to **hold** the FS at the
mount request, do the swap, then let it continue.

## The wait array (the mechanism we abuse)

An FS pool thread does not wait on one thing. It waits on an **array of handles** with a
syscall like `WaitSynchronization` / `ReplyAndReceive`. When one object becomes ready, the
kernel:

1. returns which index was selected,
2. writes the ready object into a **selected slot** in the thread's wait bookkeeping.

The session object stores the handle used to build that array at `+0x30` (the **wait
handle**). The handle used by the reply/receive path is at `+0x48` (the **receive handle**).
They usually start equal, which is why `bind-sessions` records `wait === receive`.

## Parking

To **park** a session:

1. Write our **notifier** handle into the session's `+0x30`.
2. Wake the notifier so the thread leaves its old wait and re-arms using `+0x30`.

Now the thread is waiting on *our* event. The session's queued request is not served.

To **unpark**, write the real handle back and wake again. The thread re-arms on the real
session.

## The step

A **step** is one controlled delivery:

1. The session is parked; a request is queued.
2. We inject a **holder** so the kernel selects the session.
3. We swap the object we care about.
4. We release the session; it serves the request with the swapped object in place.

There are two ways to inject:

### `inject-holder` (hold the reply)

`retained-inject-holder` writes the session address into the pool thread's **selected**
slot (`parent + 0x10`). The kernel then treats the session as the ready object and delivers
the request.

The comment in the code is explicit: cancellation must follow immediately, because otherwise
the kernel keeps our selection.

**On this build this path is fatal.** When a real request is delivered, the console
hard-freezes or aborts. The fake selected pointer is dereferenced by the FS dispatch and the
system goes down. We do not use it.

### `unpark-first` / `serve` (let the FS serve normally)

Instead of holding the reply, we:

1. park the session,
2. unpark it (real handle back),
3. wake the notifier once,
4. settle,
5. then send the real request.

The FS serves the request normally. No fake holder, no injection, no freeze.

The trade-off: we cannot hold the reply, so the swap must happen while the request is being
served, which is a very small window.

`NS2_GATE_STEP_MODE=unpark-first` selects this mode. `NS2_GATE_WAKE=park` is the only wake
mode that works; `both` and `receive` try to signal a read-only export and are dead ends.

## The cancellation wall

The original design cancels the injected wait with
`svcCancelSynchronization(KThreadHandle)`. That needs a handle to the **FS's** thread, which
we do not have:

- `thread + 0x1b0` holds an FS-table handle, not ours. Calling cancel with it returns
  `0xE401` (invalid handle).
- There is no `OpenThread` syscall on 23.0.1 (`sdk+0x168d1c` is `svcWaitForAddress`).
- The app's seven API workers have no app-side KThread handles.

So cancellation is skipped, the selection persists, and `step()` eventually throws
`One-shot request did not settle`.

## What we learned from the failures

- The **empty rebuild** (park, wake, no request) settles. The wake mechanism is correct for
  the empty case.
- Delivering a **real** request through the injected holder freezes the system.
- The parked request blocks the same FS that serves our memory endpoint, so the retained
  read stalls too.

## The current mode

`ro/test-gate` now certifies only the re-armed wait word (no worker by default).
`ro/launch` uses the same gate in `serve` mode: park, unpark, wake, settle, release the
launch worker, then poll.

## Related

- [[The Wait Array and Parking]]
- [[The Control Path and Why It Blocks]]
- [[Stage 3 - The Launch]]
- [[Glossary]]
