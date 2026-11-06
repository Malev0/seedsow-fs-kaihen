---
tags: [concept, system]
---

# PM and the Loader

## PM

The **process manager** exposes two services we use:

- `pm:shell` — the shell interface.
  - cmd **0** = `LaunchProgram(flags, titleId, storageId)`
  - cmd **1** = `TerminateProcess(pid)`
- `pm:dmnt` — the debug monitor.
  - cmd **7** = `GetProgramId(pid)` (we use this to confirm the title)
  - cmd **1** = start a suspended process (believed; it blocks on a manipulated FS)

## The Loader (`ldr`)

The Loader is the system module that actually loads a program. The sequence:

1. PM asks the Loader to load the program.
2. The Loader asks fsp-srv to mount the program's CodeFS.
3. The Loader opens `main.npdm` and `main`.
4. The Loader maps the image and starts the process.

Step 2 is the mount we intercept.

## StartSuspended

`LaunchProgram` with flags `0x10` creates the process **without loading it**. The load is
deferred until `pm:dmnt` id 1. This is useful because the launch returns quickly, keeping
our control path free. But the deferred start is the dangerous call: on a manipulated FS it
blocks and the app aborts.

With flags `0`, the load happens inside `LaunchProgram`. The launch call then blocks for the
whole load, so our control path is blocked for that time.

## Why “result: 0” is not success

`LaunchProgram` returning `0` only means PM accepted the request and created the process. It
does **not** mean the image was swapped. Our proof separates:

- `result: 0` — PM accepted,
- `pid` — a process exists,
- `programId 0x0400000000000037` — it is the right title,
- `mounts` / `swapped` / `imageAccepted` — **the exploit actually worked**.

We have had `result: 0` and the right program id many times with `mounts: 0`.

## Related

- [[Stage 3 - The Launch]]
- [[Launch Flags]]
- [[The Mount Table and CodeFS]]
