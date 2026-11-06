---
tags: [stage, unreached]
---

# Stage 4 - Start and Verify

**Files:** `ro/runtime.cjs`, `ro/probe.cjs`, `process/bind-notifier.cjs`,
`process/qualify.cjs`, `process/fs-execute.cjs`, `firmware-dump.cjs`

> [!warning] Never reached
> Stage 4 has never run. Everything here describes the intended design, not a proven
> result. The pipeline only reaches it if `ro/launch` returns `imageAccepted: true`.

## 1. `runtime.activate`

Called only when the launch proof says the image was accepted and the gate restored.

1. Re-open the retained endpoint and check the launch proof.
2. Read the original `ro` pid from the `pm:shell` proof.
3. Confirm the replacement pid is different.
4. Call `pm:dmnt` id 1 to start the replacement (only for `flags 0x10`).
5. Call `pm:shell` id 1 to terminate the original `ro`.
6. Record the activation proof.

If the swap did not happen, the replacement runs the **real** `ro` and the original still
holds its services; that is why the pipeline refuses to continue without `imageAccepted`.

## 2. `RO instruction challenges`

`ro/probe.cjs` sends small native requests to the new `ro` process and checks that it
answers with the expected identity and challenge values. This is how we know our payload is
running rather than the real program.

## 3. `Restore Loader session`

`runtime.handoff` checks that the Loader's session returned to its original idle state
(`state 1`, real wait handle, original parent). If not, the boot is not clean.

## 4. `process/bind-notifier` and `process/qualify`

- bind the notifier the payload uses,
- map the payload into the FS process and verify the mapping,
- clean up the mapping.

## 5. `process/fs-execute`

Runs code **inside the FS process** and verifies the result, then restores the original
bytes. This is the actual “code execution in the FS sysmodule” milestone.

## 6. Optional firmware dump

`firmware-dump.cjs` enumerates installed system programs and captures their CodeFS
(read-only). This is the “what can we do with it” payoff, not part of the exploit chain.

## What could go wrong

- The replacement runs but the original still holds `ro:1` → duplicate services.
- The payload's native RPC does not answer → wrong image or wrong mapping.
- The FS process is left with a modified session → the boot must be power-cycled.

## Related

- [[PM and the Loader]]
- [[Worker Frames and ROP]]
- [[Current Status]]
