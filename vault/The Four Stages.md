---
tags: [overview, pipeline]
---

# The Four Stages

`pipeline.cjs` prints `[n/4]`. The four numbers are coarse progress markers; the real work
is many small stages inside them.

| Stage | Name | What it does | Success marker |
|---|---|---|---|
| 1/4 | `app/map` | map the app's memory and mounts, find SDK/main bases | `app/map` complete |
| 2/4 | acquisition probe | corrupt the FS cache to get a verified read/write into FS memory | `memoryControl.ready` (`memory-ready`) |
| 3/4 | retained + RO | install the retained endpoint, capture the donor, bind sessions, arm the gate, launch a replacement `ro` | `imageAccepted: true` |
| 4/4 | process | map the payload into FS, verify execution, restore | `execution.verified` |

## Stage 1 — `app/map`

Reads the app's memory map (regions, permissions, mounts), finds the SDK and main module
bases, and resolves the services we need (`pm:shell`, `pm:dmnt`, `fsp-srv`, …).

This is deterministic and fast. See [[Stage 1 - App Map]].

## Stage 2 — acquisition

The hard, stochastic stage. We make the FS's cache alias a block so that the FS reads/writes
memory at an address we choose. It has to line up **three independent microsecond windows**
on the same boot. Roughly **18%** of boots succeed.

Failure signature you will see most often:
`No changedLink candidate on this boot`.

See [[Stage 2 - FS Memory Acquisition]] and [[Stage 2 - The Three Windows]].

## Stage 3 — retained + RO

Once stage 2 has a verified plan:

1. `retained/find-metadata` — find the metadata link that makes the cache descriptor
   retargetable.
2. `ro/install-retained` — install the persistent memory endpoint.
3. `FS layout` — locate the domain table, session pool, waiters.
4. `Owned FS root` / `Owned FS notifier` — open the FS root and a notifier event we can
   signal.
5. `ro/test-sm` — prove we can talk to `pm:shell`.
6. `ro/copy-loader-root` — copy the Loader's root domain.
7. `ro/prepare-workers` — prepare native worker frames.
8. `RO payload and current console policy` — capture the real `ro` files (`main`,
   `main.npdm`) as the **donor**.
9. `ro/bind-sessions` — bind the two sessions whose domains are the target and our own.
10. `ro/prepare-event` — export a writable event from the owned notifier.
11. `ro/test-gate` — qualify the gate mechanism.
12. `ro/launch` — arm the gate, launch a replacement `ro`, and try to swap the mount.

See [[Stage 3 - Retained Memory]], [[Stage 3 - The Gate]], [[Stage 3 - The Launch]].

## Stage 4 — process

Only after `imageAccepted`:

1. `runtime.activate` — start the replacement, terminate the original `ro`.
2. `RO instruction challenges` — prove the payload is running (native RPC).
3. `process/bind-notifier`, `process/qualify` — map the payload into FS.
4. `process/fs-execute` — run FS-side code and restore.
5. Optional firmware dump.

See [[Stage 4 - Start and Verify]].

## The rule that shapes everything

**One acquisition per boot.** Stage 2 leaves the FS in a modified state. If a stage-3+ run
fails, you power-cycle; you do not retry in the same boot. That is why every experiment is
expensive and why the notes talk about “boots” rather than “runs”.

## Related

- [[How to Run a Boot]]
- [[Current Status]]
- [[Glossary]]
