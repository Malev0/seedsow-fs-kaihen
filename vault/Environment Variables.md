---
tags: [reference, env]
---

# Environment Variables

The GUI reads `gui/env.txt` on every Start and logs the applied overrides:

```
[gui] env overrides: NS2_GATE_WAKE=park ...
```

## Core

| Name | Meaning |
|---|---|
| `NS2_CONSOLE` | console IP (overrides `tools/console-host.txt`) |
| `NS2_FAST` | `1` = binary TCP RPC + console-side worker builder (default in the GUI) |
| `NS2_TRANSPORT=eval` | fall back to the slow `/eval` transport |

## Stage 2 (acquisition)

| Name | Meaning |
|---|---|
| `NS2_COMMIT_MB` | dirty-commit size (default 16; `8` makes the canary interleave here) |
| `NS2_SKIP_REPRO=1` | accept one confirmed marker instead of a genuine repeat |
| `NS2_SKIP_EXTENT_REQUAL=1` | keep the proven extent instead of requalifying after each marker |
| `NS2_FIELD_OFFSET` | copy-tail offset inside the wave payload |
| `NS2_PIN_BYTES` | expected pin allocation (`7440` on this unit) |
| `NS2_WAVE_SETTLE_MS` | per-retry settle before releasing a wave (default 1000 here) |
| `NS2_WAVE_SETTLE_ALWAYS=1` | apply the settle to first attempts too |
| `NS2_WAVE_ATTEMPTS` | cap the retry series (keep low so a miss ends the boot) |
| `NS2_POSITIVE_WAVE_MS` | deadline for the positive canary retry series (default 10000) |
| `NS2_SLEEP_RAW=1` | disable the 19.2/31.25 MHz sleep scaling |
| `NS2_WORKER_PRIO` | worker priority 5–35 (5 = highest accepted) |
| `NS2_WORKER_AFFINITY=1` | pin workers at creation, core 0 excluded |

## Stage 3 (gate + launch)

| Name | Meaning |
|---|---|
| `NS2_GATE_WAKE` | wake target: `park` (only working), `both`, `receive`, `0` |
| `NS2_GATE_WAKE_MS` | settle between signal and clear (default 25 ms) |
| `NS2_GATE_STEP_MODE` | `unpark-first` (serve), `wake`, `prime` |
| `NS2_GATE_UNPARK_SETTLE_MS` | settle after unpark (default 300 ms) |
| `NS2_LAUNCH_MODE` | `serve` (park/unpark/wake, no injection) |
| `NS2_LAUNCH_FLAGS` | `0x10` = StartSuspended, `0` = normal launch |
| `NS2_LAUNCH_WAIT_ONLY` | `1` = flags-0 diagnostic: release, wait host-side, then dump sessions/table |
| `NS2_LAUNCH_WAIT_MS` | host-side wait before the post-load dump (default 90 s) |
| `NS2_LAUNCH_INSPECT_MS` | budget for the post-load dump (default 120 s) |
| `NS2_DUMP_HOST` | PC LAN IPv4 the slot-2 worker sends the table window to |
| `NS2_DUMP_PORT` | TCP port for the worker dump (default 39401) |
| `NS2_LAUNCH_POLL_MS` | poll interval for the target domain (default 20 ms) |
| `NS2_LAUNCH_KICK_OTHER` | park/unpark/wake the second bound session (default on) |
| `NS2_LAUNCH_KICK_WAKES` | burst signals for the second session |
| `NS2_LAUNCH_WAKE_BURST` | burst signals during the poll |
| `NS2_LAUNCH_TABLE_SCAN` | scan the whole domain table |
| `NS2_LAUNCH_DOMAIN_POLL_MS` | domain-scan interval |
| `NS2_LAUNCH_TABLE_POLL_MS` | table-scan interval |
| `NS2_LAUNCH_WAKE_MS` | periodic wake interval during the poll |
| `NS2_LAUNCH_LIVENESS_MS` | host-only TCP liveness sampling duration |
| `NS2_LAUNCH_START_PROBE` | **dangerous** start probe; needs `NS2_ALLOW_CONSOLE_FREEZE=1` |
| `NS2_ALLOW_CONSOLE_FREEZE` | second gate for the start probe |
| `NS2_MEMORY_TIMEOUT_MS` | retained/controller request deadline (default 60 s) |

## Diagnostics

| Name | Meaning |
|---|---|
| `NS2_GATE_QUIET_MS` | how long `test-gate` watches the app port after a step |
| `NS2_FS_PROBE=1` | read the FS module image (known to wedge; leave off) |
| `NS2_FS_PROBE_ONLY=1` | stop after the probe |
| `NS2_CANCEL_SETTLE_MS` | delay from the no-op worker cancel |
| `NS2_ACQUIRE_TIMEOUT_MS` / `NS2_ACQUIRE_ATTEMPTS` | probe supervision |
| `NS2_QUALIFY=1` | force `app/qualify` |

## Related

- [[How to Run a Boot]]
- [[Failure Signatures]]
