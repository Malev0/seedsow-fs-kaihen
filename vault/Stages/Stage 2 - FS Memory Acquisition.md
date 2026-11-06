---
tags: [stage, hardest]
---

# Stage 2 - FS Memory Acquisition

**File:** `engine/switch2/memory/probe-reserved-gap-seedsow.cjs`
**Goal:** obtain a **verified read/write into FS memory**, ending in `memoryControl.ready`.

This is the hardest and most stochastic part of the whole project. Read
[[Stage 2 - The Three Windows]] after this note.

## The problem

We are in the app. The FS is another process. We cannot just `memcpy` its memory.

But the FS has a **cache**. When the game reads a file, the FS may keep the data in a cache
block and later serve it from there. A cache block is described by a small descriptor:

```
+-------------------+
| data pointer      | ---> the cached bytes
| length            |
| block size        |
| flags             |
+-------------------+
```

If we can corrupt one descriptor's **data pointer**, then the next time the FS reads that
block it will read from an address we choose. The FS is doing the read — in its own address
space, with its own permissions. That is the primitive we want.

## Why we cannot just write the descriptor

The descriptor is in FS memory, and we cannot write FS memory yet. Chicken and egg.

The trick is to make the FS **overwrite the descriptor itself** as part of a legitimate
cache operation, using a **reserved gap**:

1. The FS heap has a hole (a freed region) we can place data into indirectly.
2. We make the FS write a payload that overlaps the descriptor.
3. The write is a normal dirty-page commit; the FS does it for us.

This is why the technique is called **reserved gap** and why it is timing-sensitive: the
overlap only happens if the allocator reuses the hole at the right moment.

## The wave

One attempt is called a **wave**. A wave:

1. parks a set of native worker threads ([[Worker Frames and ROP]]),
2. opens a file and dirties a large amount of data (the **commit**),
3. releases the workers at carefully timed offsets,
4. watches whether the canary path changes and whether the cache alias selects.

The workers are real `pthread`s created inside the app. Their calls are ROP chains that
invoke SDK functions. Timing is everything: the whole point is to have a “hole request”
still pending when the copy lands.

## The canary

In this project, **canary** does **not** mean the compiler's stack canary. It is a **marker
file/path** whose cached entry we overwrite to prove that our write landed in the cache.

If the canary changes (`canaryType: 0`), the overwrite worked. If it stays `1`, we missed
the window.

The marker lands at a per-unit offset inside the cache block. On our console that offset is
around `0x2340`; other developers' units use `0x1343` / `0x1351`. Do not copy another
unit's number. See [[Offsets and Addresses]].

## The alias

After the overwrite we need the FS to expose the corrupted block at a **known address** so
we can read and write through it. That is the **cache alias**. The probe:

1. poisons a buffer,
2. reads through the alias,
3. requires the read to return the poisoned bytes (a real copy, not a coincidence),
4. writes a 16-byte marker and reads it back,
5. checks the neighbouring bytes.

Only when both `readVerified` and `writeVerified` are true is the plan promoted to
`memoryControl.ready`.

## The three windows

A boot only works if three independent orderings line up:

| window | what must happen | failure text |
|---|---|---|
| canary overwrite | the hole request is still pending when the copy lands | `Overwrite missed the qualified canary` |
| clean alias | the alias returns the control bytes with no poisoned output | `Field copy did not qualify` |
| link change | a freed block's free-list link word changes while its 16 KiB tail stays identical | `No changedLink candidate on this boot` |

On our unit the success rate is about **18%** (10 of 55 boots in one session). The dominant
failure is the missing `changedLink` candidate.

## Why `changedLink` is required

The probe can classify candidate blocks as `changedLink`, `zeroTail`, or `stableLink`.
Only `changedLink` produced a working plan. `zeroTail` and `stableLink` plans do not just
fail; they leave the FS blocked inside the first operation, which used to wedge the whole
RPC thread. So the probe **refuses** a boot without a `changedLink` candidate, before the
address matrix.

That refusal is deliberate. It is why a bad boot fails in ~50 s instead of hanging.

## The address plan

The plan is a set of numbers that say:

- which block to alias,
- where in the block the marker lands,
- how long the copy payload is,
- which offset the copy tail sits at.

The plan is verified with the poison/read/write cycle above. A verified plan looks like:

```
target 0x80b7bc000, readOffset 0x3fe8000, header signed-one-shot
```

## What you see in the log

```
[2/4] Acquiring FS memory (probe)
FS read, write and restoration
...
memory-ready
```

or a fast rejection:

```
No changedLink candidate on this boot (... zeroTail ... stableLink ...);
those plans wedge the FS service; relaunch and retry
```

## Related

- [[Stage 2 - The Three Windows]]
- [[The Retained Cache]]
- [[Worker Frames and ROP]]
- [[Glossary]]
