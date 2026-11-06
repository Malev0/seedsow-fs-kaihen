# Credits

seedsow-fs-exploit builds on ns2jb and on two parallel Seedsow ports. Anything taken from
another author is marked in the file header as well.

## ns2jb (upstream)

- Original exploit design and the `probe-reserved-gap` / retained-cache
  technique, the `ro/` stage layout, and the worker-frame approach.
- Vendored reference tree: `ns2jb-main/` (see its own notices).

## Manupera - `remote-lua-sw2`

Repository: `remote-lua-sw2` (Seedsow launcher, native RPC, ns2jb engine).

Used in this tree:

- `ns2jb-main/s2jb-main/engine/switch2/ro/launch.cjs`
  - multi-session scan of the session pool for same-class fsp-srv sessions,
  - `otherRow` / second bound-session handling and the
    `NS2_LAUNCH_KICK_OTHER` park/unpark/wake rebuild,
  - whole-domain and whole-table mount polling
    (`NS2_LAUNCH_TABLE_SCAN`, `NS2_LAUNCH_DOMAIN_POLL_MS`),
  - per-session request timelines and the periodic `gate.wake()` during the
    launch poll.
  - Source: `docs/STATUS.md` section 10 ("State at 2026-11-05, Malev engine
    port") and their vendored `vendor/ns2jbstuff/.../ro/launch.cjs`.
- Analysis adopted into `docs/FINDINGS.md` / `HANDOFF.md`:
  - the Loader's `ConvertToDomain` (control 1) can sit queued on the second
    bound session with `receiveResult 3`,
  - the parked-session bootstrap cycle in their `docs/RESEARCH.md`,
  - the `ro/test-gate` cancellation wall in their `docs/NS2JBSTUFF.md`.

## wifi-savekit / seedsow-fs-escalation (via Manupera's notes)

- Timing work (`local-release.cjs`, arm-gate trigger, host-quiet release) and
  the marker/pin-allocation calibration notes that Manupera consolidated.

If you reuse code from this tree, keep these credits with it.
