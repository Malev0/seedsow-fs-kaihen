---
tags: [reference, credits]
---

# Credits

seedsow-fs-exploit is a port. Most of the ideas are not ours.

## ns2jb (upstream)

The original exploit design, the `probe-reserved-gap` / retained-cache technique, the `ro/`
stage layout, and the worker-frame approach. Vendored under `ns2jb-main/`.

## Manupera — `remote-lua-sw2`

A parallel Seedsow port (launcher + native RPC + ns2jb engine).

Used in this tree:

- `ro/launch.cjs`:
  - multi-session scan of the session pool for same-class fsp-srv sessions,
  - second bound-session handling and `NS2_LAUNCH_KICK_OTHER`,
  - whole-domain and whole-table mount polling,
  - per-session request timelines and periodic gate wakes.
  - Source: their `docs/STATUS.md` §10 and their vendored `ro/launch.cjs`.
- Analysis adopted into `docs/FINDINGS.md` and `HANDOFF.md`:
  - the `ConvertToDomain` queue on the second bound session,
  - the parked-session bootstrap cycle (`docs/RESEARCH.md`),
  - the `ro/test-gate` cancellation wall (`docs/NS2JBSTUFF.md`).

## wifi-savekit / seedsow-fs-escalation

- Timing work (`local-release.cjs`, arm-gate trigger, host-quiet release).
- Marker/pin-allocation calibration notes consolidated by Manupera.

## The launcher

`switch-artemis-launcher` (norahax / seedsowhax / hamihax) provides the Lua foothold,
`_G.n2h`, and the HTTP `/eval` server. It is the entry point, not the exploit.

## Keep the credits

If you redistribute this tree or the vault, keep `CREDITS.md` and this note.
