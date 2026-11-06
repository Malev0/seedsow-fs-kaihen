---
tags: [stage, wall]
---

# Stage 3 - The Launch

**File:** `ro/launch.cjs`
**Goal:** make PM/Loader mount **our donor** instead of the real CodeFS, then report
`imageAccepted: true`.

This is where we are stuck today.

## The intended flow

1. Prepare a `pm:shell` `LaunchProgram` request for title `0x0400000000000037`.
2. Arm the gate on the Loader's session.
3. Release the launch worker; PM creates the process and the Loader asks the FS to mount the
   CodeFS.
4. While the mount is in flight, swap the CodeFS object for the donor object.
5. PM returns `result: 0` and a pid; `imageAccepted = swapped && result === 0`.

## The launch flags

`pm:shell` `LaunchProgram` takes a flags word:

| flags | meaning | effect |
|---|---|---|
| `0x10` | **StartSuspended** | PM creates the process but the Loader does no FS work until a separate start call |
| `0` | normal launch | the Loader loads inside the launch request |

See [[Launch Flags]].

With `0x10`, the launch returns quickly (good: the control path stays free), but the mount is
deferred to `pm:dmnt` id 1. Calling that start on a manipulated FS blocks and aborts the app
(`2162-0002` / `2168-0002`).

With `0`, the load is synchronous with the launch request: the control path blocks for the
whole load.

## The two sessions

`ro/bind-sessions` binds two sessions:

- **row 1** — the target domain (the Loader root),
- **row 2** — the other bound session (the app's own domain, `ownDomain`).

For a long time we only armed row 1. Manupera's `remote-lua-sw2` reported a "control 1"
request on the second row with `receiveResult 3`. We read that as the Loader's
`ConvertToDomain`.

> [!warning] Corrected 2026-11-05
> In this build control **0** is `ConvertToDomain`; control **1** is `CopyObject`. The
> buffered request is the app's stage-1 save-filesystem `CopyObject` (object 139), not a
> Loader request. The second row is `ownDomain`, not the Loader's clone. The 23:05 burst
> woke its parent but the request was stale. See [[The Second Bound Session]].

## What the launch does now

Ported from Manupera (credited in `CREDITS.md`):

1. Park the target session.
2. Restore the second session's `+0x30` if it is stale.
3. Kick the second session: park, unpark, burst the notifier.
4. Wake the target session and settle.
5. Release the launch worker.
6. Poll:
   - the target domain for new entries,
   - every known domain (session scan),
   - optionally the whole domain table (`NS2_LAUNCH_TABLE_SCAN=1`),
   - both sessions' request timelines,
   - periodic notifier wakes.
7. When a new entry with the donor metadata appears, swap:
   - `newEntry.object = donor.object`,
   - `donorEntry.object = code.object`.
8. Save `imageAccepted`.

## Why the mount never appears

There are two independent reasons, and the second is the important one.

1. **The buffered request is stale.** The `otherTimeline` `control 1` is the app's own
   `CopyObject`, not the Loader. The burst woke the session's parent (the `+0x28` pointer
   moved) but `receiveResult` stayed `3` because no request was pending.
2. **The launch poll is the wrong phase.** With `flags 0x10` (`StartSuspended`) the Loader
   does no FS work during `LaunchProgram`. The mount happens only at `pm:dmnt` id 1, which
   `runtime.activate` calls after the launch. So no mount can appear in this 120 s poll, no
   matter how many sessions or domains we watch.

`imageAccepted = swapped && result === 0` therefore can never be true for a `0x10` launch:
the swap would have to happen at the deferred start, which runs after the gate.

## What success will look like

At the **start** phase, not the launch phase:

- a session (one of the ~47 unbound fsp-srv sessions, or the target) shows a control **0**
  or an `SFCI` mount/open request,
- the domain table or the target domain gains an entry with the donor metadata,
- `filesystem-exchanged` fires with `imageAccepted: true`.

## Related

- [[Stage 3 - The Gate]]
- [[The Second Bound Session]]
- [[Launch Flags]]
- [[PM and the Loader]]
- [[The Mount Table and CodeFS]]
