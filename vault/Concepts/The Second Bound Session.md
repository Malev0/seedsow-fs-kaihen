---
tags: [concept, launch, wall, corrected]
---

# The Second Bound Session

> [!warning] Corrected 2026-11-05
> This note used to claim the second bound session held the Loader's
> `ConvertToDomain`. It does not. The second row is the **app's own** domain, and the
> buffered request is a stale `CopyObject` from stage 1. See below.

## What it is

`ro/bind-sessions` binds **two** sessions:

| row | domain | role |
|---|---|---|
| 1 | `targetDomain` | the Loader root domain |
| 2 | `ownDomain` | the app's own fsp-srv domain |

For most of the project we only armed row 1.

## The misread

Manupera's `remote-lua-sw2` (`docs/STATUS.md` §10) reported a "control 1" request on the
second bound session with `receiveResult 3`. Our 22:15 run saw the same bytes:

```
otherTimeline: header 5, state 1, receiveResult 3
requestInfo:   {kind:'control', command:1}
```

We labelled that `ConvertToDomain`. It is not. In this CMIF build:

| control | command |
|---|---|
| 0 | `ConvertToDomain` (`app/domain.cjs:29`) |
| 1 | `CopyObject` (`app/domain.cjs:45`, `app/mounted-save.cjs:38`) |

The input object id is `0x8b` (139), the app's save filesystem. So the buffer is the
stage-1 `cloneMountedFilesystem` copy, left over from before the launch. The second row's
domain is `root.ownDomain` (`399405807192`), not the Loader's clone.

## What the 23:05 burst proved

The full burst (`NS2_LAUNCH_KICK_WAKES=8`) did what it was designed to do:

```
wakes:            [true x8]
after.parent:     399405587016   (was 399405586472)
after.state:      1
after.receiveResult: 3
```

The parent pointer moved, so a pool thread woke and the session re-armed. `receiveResult`
stayed `3` because the receive **timed out with no request pending**. That is exactly what
a stale buffer looks like. The kick is harmless; it is just not evidence of the Loader.

## Why it matters

The late-46 theory ("the Loader waits for this reply, so the mount never appears") is not
supported. The mount is absent for a simpler reason: with `flags 0x10` the Loader does no
FS work until `pm:dmnt` id 1. The launch poll is the wrong phase.

## What to do instead

- Do **not** treat the `otherTimeline` buffer as the Loader frontier.
- Scan **every** fsp-srv session's request buffer during a load, not only the two rows
  bound at boot. The Loader's clone (if it exists) is one of the ~47 unbound sessions.
- Look for control **0** or an `SFCI` file/mount request, not control 1.

## Related

- [[Stage 3 - The Launch]]
- [[The Wait Array and Parking]]
- [[Current Status]]
- [[Glossary]]
