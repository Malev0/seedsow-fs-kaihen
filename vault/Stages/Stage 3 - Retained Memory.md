---
tags: [stage]
---

# Stage 3 - Retained Memory

**Files:** `retained/find-metadata.cjs`, `ro/install-retained.cjs`, `ro/layout.cjs`,
`ro/objects.cjs`, `ro/test-sm.cjs`, `ro/copy-loader-root.cjs`, `ro/prepare-workers.cjs`

**Goal:** turn the stage-2 primitive into a stable, reusable memory endpoint, and prepare
all the native objects the launch will need.

## 1. `retained/find-metadata`

Stage 2 gives us an alias but not yet a *retargetable* descriptor. This stage finds the
metadata link that lets us change the descriptor's data pointer on demand. If it cannot find
a reproducible link, it fails with:

```
No candidate reproduced the external allocator link
```

## 2. `ro/install-retained`

Installs the **retained endpoint**: a persistent service that reads and writes FS memory by
retargeting the cache descriptor. From this point on, `memory.read` / `memory.write` are
available to every later stage.

The endpoint has two “buckets” (a control bucket and a data bucket). The control bucket
holds the descriptor; the data bucket is the 16 KiB window we read/write through.

## 3. `FS layout`

Finds the addresses we will need:

- the **domain table** (where mount entries live),
- the **session pool** (0x10000 bytes of session objects),
- the **waiters** (seven contiguous wait objects),
- the **holder vptr** (the type tag that identifies a session object).

These are written to `seedsow-layout.json`.

## 4. `Owned FS root` and `Owned FS notifier`

- **root**: a handle to the FS root object, used to open storages.
- **notifier**: an event the FS owns that we can signal. This becomes the **park** handle
  used by the gate. `ro/prepare-event` exports a writable copy of it.

## 5. `ro/test-sm`

Proves we can open `pm:shell` through the service manager and get a valid handle. If this
fails, nothing later can launch anything.

## 6. `ro/copy-loader-root`

Copies the Loader's root domain object. This gives us a domain whose entry table we can
inspect and, later, swap.

## 7. `ro/prepare-workers`

Creates the native worker threads used by the gate and the launch. See
[[Worker Frames and ROP]].

## 8. Donor capture

`RO payload and current console policy` opens the real `ro` CodeFS and captures:

- `main.npdm` (program metadata),
- `main` (the executable).

These become the **donor** object: a filesystem object that points at the real `ro` files.
The payload is built to match the donor's hashes, so the swap is invisible to the Loader's
checks. See [[The Mount Table and CodeFS]].

## 9. `ro/bind-sessions`

Finds the **two** sessions whose domains are:

- `targetDomain` — the Loader root domain,
- `ownDomain` — the app's own domain.

It records each session's `wait`, `receive`, `parent`, `state`, `receiveResult`, `request`
buffer and metadata. This file is what the gate and launch read.

> [!important] Two sessions, not one
> The Loader uses the **second** session for `ConvertToDomain`. Missing it was a major
> blind spot. See [[The Second Bound Session]].

## 10. `ro/prepare-event`

Exports a writable event from the owned notifier and verifies the signal/clear/wait
sequence:

```
clear -> wait times out (0xEA01) -> signal -> wait succeeds -> clear -> timeout
```

That event is the **park** handle the gate writes into the session.

## What can go wrong

| failure | meaning |
|---|---|
| `No candidate reproduced the external allocator link` | the metadata link was not reproducible on this boot |
| `General-heap allocation changed while the cache was retained` | the FS heap moved under us |
| `A domain object ID must be within the verified table` | layout is stale or wrong |
| `The endpoint does not confirm the retained two-cache interface` | install failed |

## Related

- [[The Retained Cache]]
- [[The Wait Array and Parking]]
- [[The Mount Table and CodeFS]]
