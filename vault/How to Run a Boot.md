---
tags: [project, operations]
---

# How to Run a Boot

A **boot** is one power-cycle of the console plus one run of the pipeline. Stage 2 leaves the
FS modified, so you get **one acquisition per boot**.

## Before you start

1. Power-cycle the console if the previous run failed at stage 3 or later.
2. Launch Seedsow and press **Y** to bring up the launcher HTTP server (`:8080`).
3. Make sure `tools/console-host.txt` (or the GUI IP box) has the console's LAN address.

## Start the controller

```powershell
powershell -ExecutionPolicy Bypass -File .\start-gui.ps1
```

Open `http://127.0.0.1:31338` (the script does it). The header shows the console IP and
whether `:8080` is up.

## Press Start

The GUI runs, in order:

1. `resume.ps1` — stop old bridges, upload/reload `console/n2h_rpc.lua`, refresh mounts,
   start the bridge, verify the SDK matches.
2. `save-list.cjs --clean` — free the scratch left by a failed run.
3. `pipeline.cjs --dump-firmware` — stages 1–4.

Progress is mirrored to `engine/switch2/status.txt` and the GUI log.

## Reading the result

- **Stage 2 fails in ~50 s** with `No changedLink candidate` → relaunch and retry. This is
  normal, not a bug.
- **Stage 3 fails at `ro/launch`** → inspect the newest
  `ro/seedsow-launch-*.json` and `launch-*.log`.
- **The console shows an error code** → note it (see [[Error Codes]]) and power-cycle.
- **The app is unclosable** → hold the power button; the FS is stuck.

## Current diagnostic (wait-only)

`gui/env.txt` currently sets `NS2_LAUNCH_FLAGS=0` and `NS2_LAUNCH_WAIT_ONLY=1`. The
launch releases the worker and waits 90 s **without touching the console**, then records:

- `waitOnly.up` — is the app port still open?
- `postSessions` — every fsp-srv session's request buffer and `receiveResult`.
- `postTableAdded` / `postTableMatches` — new domain-table entries, and those whose
  metadata matches the donor.

If `postTargetError` or `postSessionScanError` is a timeout, the load is still holding the
shim; that is the signal to move to the native retained-read/write worker.

## Environment overrides

Edit `gui/env.txt` (one `KEY=VALUE` per line). The GUI logs the applied set:

```
[gui] env overrides: NS2_GATE_WAKE=park ...
```

## Auto-retry

The `auto [n] tries` toggle relaunches the app and starts another boot when a run fails
**before 3/4**. It never retries a stage-3+ failure.

## Related

- [[Environment Variables]]
- [[Failure Signatures]]
- [[Current Status]]
