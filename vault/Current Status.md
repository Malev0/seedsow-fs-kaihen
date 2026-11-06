---
tags: [project, status]
---

# Current Status

> [!warning] Not a working exploit yet
> Stages 1–2 work. Stage 3 stops at `ro/launch`. Stage 4 has never run.

## What works

| Area | State |
|---|---|
| Launcher foothold (`n2h`, `/eval`, binary RPC) | works |
| Stage 1 `app/map` | works |
| Stage 2 acquisition | works ~18% of boots; dominant failure `No changedLink candidate` |
| Stage 3 up to `ro/prepare-event` | works |
| `ro/launch` reaches PM | yes: `result: 0`, correct `programId`, a pid |
| Mount swap | **never** (`mounts: 0`, `imageAccepted: false`) |
| Stage 4 | **never run** |

## The wall, precisely

1. `ro/launch` with `flags 0x10` returns quickly and PM creates the process.
2. With `0x10` (`StartSuspended`) the Loader does **no FS work** during the launch; the
   mount is deferred to `pm:dmnt` id 1, which `runtime.activate` calls after the launch.
3. Therefore the 120 s launch poll can never see a mount. `imageAccepted = swapped &&
   result === 0` can never be true for a `0x10` launch.
4. The second bound session is `ownDomain`; its `control 1` buffer is a stale
   `CopyObject` from stage 1, not the Loader's `ConvertToDomain` (control 0). The 23:05
   burst woke its parent but there was no request to serve.
5. The real question is how to act during the **deferred load** (start or `flags 0`).

## The control-path wall

While a worker's `send` is pending, the launcher shim cannot answer native calls
(`direct:false`). So we cannot poll or swap during a synchronous load. Flags `0` and `0x10`
both hit this from different sides.

## The last experiment (23:05, negative)

Burst the shared notifier so every FS pool thread wakes:

```
NS2_LAUNCH_KICK_WAKES=8
NS2_LAUNCH_WAKE_BURST=8
```

All eight wakes returned true and the second session's parent re-armed (`+0x28` moved),
but `receiveResult` stayed `3`. The buffer was stale. No donor-matching entry appeared.

## What is not solved

- Finding the Loader's actual session (likely one of the ~47 unbound fsp-srv sessions).
- Acting during the deferred load without the shim (native retained-read/write worker).
- The safe reply-hold (`inject-holder` is fatal with a real request).
- Stage 4 entirely.

## The next experiment (armed, 2026-11-05)

`NS2_LAUNCH_WAIT_ONLY=1` + `NS2_LAUNCH_FLAGS=0` in `gui/env.txt`:

1. Release the launch worker (flags 0, load inside the send).
2. Wait 90 s host-side with **no console RPC**.
3. Record `waitOnly.up` (TCP to `:8080`).
4. Dump every fsp-srv session and the whole table **regardless of `up`**.

The first two runs settled the control-path question:

- 23:37: app faulted (`2162-0002`), `up: false`; `restored: true` was a no-op.
- 23:50: `up: true`, but the retained read timed out and the endpoint then
  answered `Another memory request is active`. The launch send holds the shim;
  the retained endpoint is unusable during the load.
- 00:11: the slot-2 `retained-read` worker was prepared and released, but the
  host's `worker-output` read still timed out for the same reason.
- 19:52: the `retained-dump` prepare itself failed with
  `Cannot convert undefined to a BigInt`. The GUI's `NS2_FAST=1` builds worker
  frames in `n2h_rpc.lua`, which does not understand the new `{result}` dynamic.
  The `retained-dump` worker now forces the host `seed-rop-chain` builder; the
  listener was fine, but no worker was created.
- 20:11: the host builder worked (`watch.prepare`/`release` saved), but the
  worker read `address - bias` — an arbitrary storage offset — instead of the
  retained plan's fixed `readOffset`. The read returned storage file data, the
  app faulted, and the host read timed out. Fixed by pre-retargeting the cache
  to the window and passing `plan(...).readOffset` to the worker.

The fix under test is a **worker-side TCP dump**. `ro/launch` prepares a slot-2
`retained-dump` worker; it reads the first free table window and then calls
`socket/connect/send` from its own thread, sending the raw window to the PC.
That channel is independent of the shim. Start the listener first:

```powershell
node tools/dump-listener.cjs
```

`gui/env.txt` sets `NS2_DUMP_HOST` to this PC's LAN address and `NS2_DUMP_PORT=39401`.
Allow the Windows firewall prompt if it appears.

## Related

- [[Open Questions]]
- [[Stage 3 - The Launch]]
- [[The Second Bound Session]]
- [[The Control Path and Why It Blocks]]
