---
tags: [reference, failures]
---

# Failure Signatures

What the error text means and what to do. The full table is in `docs/FINDINGS.md` §4; this
is the practical subset.

## Stage 2

| Text | Meaning | Action |
|---|---|---|
| `No changedLink candidate on this boot` | the boot's heap cannot produce a working plan | relaunch / retry (expected ~half the time) |
| `Overwrite missed the qualified canary` | the canary window was missed | retry / new boot |
| `Field copy did not qualify within its attempt limit` | the alias leak did not converge | retry / new boot |
| `General-heap allocation changed while the cache was retained` | the FS heap moved under us | new boot |
| `Pinned allocation cost changed` | `NS2_PIN_BYTES` does not match this unit | set the measured value (`7440` here) |
| `No candidate reproduced the external allocator link` | metadata link not reproducible | new boot |

## Stage 3

| Text | Meaning | Action |
|---|---|---|
| `One-shot request did not settle` | the injected selection persisted | this is the gate wall; new boot |
| `A selection remains pending` | the `finally` reporting the same wall | new boot |
| `The native request gate did not qualify` | `ro/test-gate` failed | new boot |
| `PM did not accept the payload` | `imageAccepted` was false (no swap) | inspect `ro/launch` proof |
| `Memory request timed out; it was not replayed` | the retained/shim path blocked | the console is wedged; power-cycle |
| `Another memory request is active` | a request is still in flight | wait or power-cycle |
| `Cannot find module ...` | a code bug, not a console failure | fix and re-run |

## Console / app

| Symptom | Meaning |
|---|---|
| app shows `2162-0002` | a **system module** aborted (`Err`, `0x4A2` = `svcBreak`): the FS, Loader, or launched RO asserted; the app may be suspended by the error screen |
| app shows `2168-0002` | the **application** (Seedsow) faulted (`Creport`); system survived; power-button restart |
| no ping, no `:8080` | the console itself is down; power-cycle |
| `:8080` accepts TCP but never replies | the launcher's HTTP handler is parked by the `R.serve` loop, or the app is wedged |
| app will not close | a blocking native call holds the FS; power-cycle |

## The two liveness signals

- **ping / TCP `:8080`** — is the console/app alive at all?
- **`direct` read** — does the launcher shim answer native calls?

`up:true, direct:false` means “alive but the control path is blocked”. That is the current
stage-3 state.

## Related

- [[Error Codes]]
- [[Current Status]]
- [[Environment Variables]]
