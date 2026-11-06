---
tags: [stage, timing]
---

# Stage 2 - The Three Windows

This note goes one level deeper than [[Stage 2 - FS Memory Acquisition]]. It explains *why*
the probe is a lottery.

## The shape of a wave

A wave is a short, choreographed burst. The exact schedule is in the probe, but the roles
are always the same:

| role | what it does |
|---|---|
| **commit** | dirties a large amount of file data so the FS flushes it |
| **hole** | frees/releases a block, creating a hole the allocator will reuse |
| **tail / filler** | keeps the allocator busy so the hole is reused at the right time |
| **canary** | looks up the marker path; this is the thing we want to corrupt |
| **trigger** | sends the request whose receive must still be pending when the copy lands |
| **guards** | sample “has the hole completed?” to decide whether the window is valid |

The wave is a race between several FS worker threads. The PC cannot schedule them directly;
it can only release them at chosen times and hope the order is right.

## Window 1 — the canary overwrite

We want the canary's lookup to resolve **after** the corrupted block has been freed and
reused, but **before** the request is drained. In the reference run the canary finishes at
11–24 ms while the commit ends at 26 ms: they interleave.

On our unit the canary often finishes **before** the commit ends, so it never walks into the
freed hole. The result is `canaryType: 1` (unchanged) and `changedPaths: []`.

Levers that moved the ordering:

- `NS2_COMMIT_MB=8` instead of 16 — a shorter commit, so the canary can resolve earlier.
- the trigger fires at the hole end (`--trigger-skip-hole` / delay variants).

## Window 2 — the clean alias

After the overwrite we need a stable alias. A **field copy** leaks the qwords needed to
build it. The copy payload must be exactly `fieldOffset + tail + 1` bytes with the qwords at
the end and a NUL immediately after them. Padding it moves the qwords and breaks the leak.

The probe retries the copy up to a limit. If it never qualifies:
`Field copy did not qualify within its attempt limit`.

## Window 3 — the link change

When a block is freed, the allocator writes free-list links into it. A useful candidate is
one where:

- the link word **changes** while the block is retained (`changedLink`), and
- the 16 KiB tail stays identical (`zeroTail` is a weaker, dangerous class).

Only `changedLink` installs a working plan on this build.

## Why timing is so fragile

- **Event wake latency is 2–5 ms and varies per run.** That is huge compared with the
  windows.
- **`SleepThread` runs 1.63× too long** on this SDK (it converts nanoseconds with the wrong
  clock). The worker builder scales sleeps by `19200000 / 31250000`; `NS2_SLEEP_RAW=1`
  disables that.
- **Priority range is 5–35.** Priority 5 is the highest accepted and makes wakeups more
  prompt (`NS2_WORKER_PRIO=5`).
- **Affinity after creation is unavailable.** It must be set at creation
  (`NS2_WORKER_AFFINITY=1`, core 0 excluded).

The port converged on a **fixed schedule**: every role sleeps a fixed offset from the
commit start, and abort decisions are sampled at wake. That removed the variable wake
latency from the wave.

## The practical result

> [!tip] Fast-fail cap (2026-11-06)
> The positive canary wave is fast (<1 s) on boots that pass 2/4 and slow on failures
> (the join waits on workers that never finish). `NS2_POSITIVE_WAVE_MS=10000` caps the
> whole positive retry series, and the join timeout is 10 s for that phase, so a bad boot
> fails promptly instead of paying the join wait on every attempt.

- `NS2_WAVE_ATTEMPTS=6..8` keeps a bad boot short.
- `NS2_SKIP_REPRO=1` accepts one confirmed marker instead of demanding a genuine repeat
  (a real second hit is rare).
- `NS2_SKIP_EXTENT_REQUAL=1` skips the post-marker requalification that often wedges the FS.
- `NS2_PIN_BYTES=7440` on this unit (the pin allocation is a per-unit property).

## Related

- [[Environment Variables]]
- [[Failure Signatures]]
- [[Worker Frames and ROP]]
