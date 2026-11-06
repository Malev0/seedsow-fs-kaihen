---
tags: [reference, errors]
---

# Error Codes

The Switch shows a fatal-error dialog with a code and “press the power button to restart”.
The code tells you **which layer** died.

## Observed on this project

| Code | Meaning | What we saw |
|---|---|---|
| `2162-0002` | application error (this app) | flags-0 launch / deferred start |
| `2168-0002` | application error (this app) | earlier flags-0 / start runs |
| no code, full freeze | system-level hang | the `inject-holder` delivered-request freeze |

> [!important] What it means for us
> An application-error screen means **our app faulted**, not the system. The FS and the
> console survived. A silent freeze with no code is worse: the system itself is stuck.

> [!note] 2162-0002 and the retained endpoint (2026-11-05)
> A `flags 0` load produced `2162-0002`, but `gate.restore()` still succeeded: the app's
> HTTP/Lua side died while the FS session and the retained endpoint stayed alive. So an
> error screen does **not** mean the boot's data is lost; a post-load dump can still work
> even when `:8080` is closed.

## Native result codes you will see in proofs

| Value | Meaning |
|---|---|
| `0` | success |
| `0xEA01` | wait timed out (expected in `prepare-event`) |
| `0xE401` | invalid handle (per-process handle tables) |
| `0xF001` | invalid argument / no such syscall path |
| `0xF601` | server closed the session |
| `0x202` | FS “not found” result seen in mount/path tests |

## How to tell “app crashed” from “console froze”

- **ping the console**: if ping works, the console is alive.
- **TCP `:8080`**: if it connects, the app's server is still listening (may still be wedged).
- **HTTP `/eval`**: if it accepts but never replies, the Lua loop is parked in `R.serve` or
  the app is wedged.

## Related

- [[Failure Signatures]]
- [[Current Status]]
