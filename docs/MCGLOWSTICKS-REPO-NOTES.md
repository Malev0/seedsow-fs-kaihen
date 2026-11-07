# Notes from McGlowSticks' `remote-lua-sw2-windows` repo

Source: `C:\Users\ianef\Downloads\remote-lua-sw2-windows-main-main\remote-lua-sw2-windows-main-main`
(README credits **McGlowSticks** for the positive-canary offset; the repo is the
`remote-lua-sw2` lineage our `ns2jb-main` fork also descends from).

Status of that tree: launcher + native RPC + ns2jb pipeline, but **stage 2 is not
solved there** (`docs/STATUS.md`: cache alias never produced). Our tree is well
ahead, so most of it is already incorporated. What follows is only what is *new
or worth re-adopting*, with credit.

---

## 1. Upstream `ro/launch.cjs` — break after the swap, then restore the gate

This is the most useful item. Their launch loop is the original upstream flow:

1. prepare the `pm-launch` worker (`flags 0x10`),
2. park the Loader session,
3. release the worker,
4. loop one request at a time with `gate.step()`,
5. **on the mount whose `added[0].metadata === donor.metadata`, write the swap and
   `break` immediately** (no further serving),
6. `finally { await gate.restore() }` — write the real wait handle back and
   signal the event,
7. wait for the worker, join it, record `result`/`pid`/`imageAccepted`,
8. `ro/runtime.cjs` `activate()` requires `launch.restored` and then issues
   `pm:dmnt` id 1 to start the process.

Why it matters: they never inject or serve the Loader's `OpenFile`/`GetSize`/
`Read`/`close` requests at all. After the swap the FS's **normal** server loop
serves them, including the NPDM and `/main` closes. Their `runtime.handoff()`
then expects the Loader session to be back at its original idle receive
(`state 1`, parent in `waiters`, `+0x30 == row.receive`).

This lines up with what we just found in `fs.elf` (`CmifServerDomain::
UnregisterObject` at `+0x219EA0` returns a null object — and therefore the close
replies success without releasing anything — when the entry's owning domain
does not match). So "break after the swap and restore" is safe and removes the
gate from the close path entirely.

**Candidate follow-up if the current `close-served target:"freed"` run still
fails:** in `ro/launch.cjs`, after `proof.swapped = true`, `break` out of the
loop and let the `finally` restore. Also relax the `finally`'s stale-close
guard (`proof.staleCloses`/`heldClose` skip restore) because a queued close on
a freed slot is harmless. Keep our save-FS swap target; only the control flow
changes.

Credit: McGlowSticks / `remote-lua-sw2` upstream `ro/launch.cjs` + `ro/gate.cjs`.

## 2. `ro/sd.cjs` — full microSD access (we do not have this file)

`ns2jb-engine/engine/switch2/ro/sd.cjs` (19 KB) is a complete SD-card
implementation on the privileged promoted `pid=1` root session:

- `OpenSdCardFileSystem` (`IFileSystemProxy` command **18**, no input),
- accessibility probe (`631` = `IsSdCardAccessible`) before mounting,
- both session-handle and CMIF-domain-object framings; the mount reply is
  probed with command 10 and the first candidate that answers is used,
- `stat` (7), `list` (OpenDirectory 9 + ReadDirectory 0, 16 × 0x310 entries),
- `open` (8, append bit 2 so writes extend), `size` (4), `read` (0, 24-byte
  input `(0, offset, length)`), `write` (1),
- `create`, `mkdir`, `truncate`, `rmdir`, `rename`, `delete`, `commit`,
- dispatch on `root-native-sd-*`, `module.exports = {dispatch, mountCard}`.

Our `ro/` has no `sd.cjs` and no `root-native-sd-*` commands. This is a
drop-in for the post-launch SD stage once the RO image starts. It needs the
promoted root we already produce (`tools/fs-root-pid.cjs`).

Credit: McGlowSticks / `remote-lua-sw2` `ro/sd.cjs`.

## 3. Marker sweep tooling (stage-2 boot lottery)

- `tools/brute-marker.cjs` — runs exactly one positive acquisition with the
  next marker offset and appends a scored row to `runs/brute-marker.json`.
- `tools/marker-selection.cjs` — candidate list `0x1343 ± 24` (step 2) plus
  `0x2340`, and a scoring function (`full success` > `promising canaryType=0` >
  `markerSelected` > `markerReproduced` > `qualifiedReadSize` > `cleanedUp` >
  `exit 0`) to pick the best offset across boots.

We have the acquisition knobs but **no marker-sweep driver**. Their candidate
range is tuned for their unit (our unit clears at `0x2340`, see
`docs/FINDINGS.md` §3.4), so port the *driver + scoring*, not the offsets, if
we want to attack the ~18% `changedLink` lottery from the marker side.

Credit: McGlowSticks / `remote-lua-sw2` `tools/brute-marker.cjs`,
`tools/marker-selection.cjs`.

## 4. Offset-resolution tooling

`tools/nso.py`, `tools/symbols.py`, `tools/resolve_ns2jb.py` and
`config/ns2jb-port.json` document a repeatable way to map upstream ns2jb SDK
offsets onto this build (byte-prefix match + exported-symbol delta +
`confidence: identical|semantic|check-size|todo`). Our `docs/reference/
sdk_exports.json` + `research/*.py` cover the same ground; useful only if we
need to re-resolve a batch of offsets for another build.

Credit: McGlowSticks / `remote-lua-sw2` `tools/*.py`, `config/ns2jb-port.json`.

## 5. Already in our tree (checked, no action)

`ro/bind-sessions.cjs`, `ro/copy-loader-root.cjs`, `ro/layout.cjs`,
`ro/objects.cjs`, `ro/install-retained.cjs`, `ro/export-handle.cjs`,
`ro/prepare-event.cjs`, `ro/test-sm.cjs`, `ro/probe.cjs`, `ro/ncm.cjs`,
`process/fs-execute.cjs` are byte-identical to ours. Their acquisition findings
(`NS2_COMMIT_MB=8`, `NS2_PIN_BYTES=7440`, `NS2_OVERLAP_RELAX`,
`NS2_SKIP_REPRO`, `NS2_SKIP_EXTENT_REQUAL`, fixed schedule, priority 5,
`SleepThread` 1.63× scaling, tagged `pthread_t`, `call4` slot `+112`) are
already in `docs/FINDINGS.md` and the vault.

`ro/files.cjs` / `ro/control.cjs` differ only because ours add `file-spare`,
`donor-prepare`, retained bootstrap, etc.

Their `payloads/rpc.lua` (ns2jb protocol on `:39380` backed by `n2h`, with an
`svcQueryMemory` address guard) is the ancestor of our console shim; no action.

---

*Credits: pepsipu (ns2jb), Kurumuz (fork), McGlowSticks (canary offset, this
repo), plus the existing project credits.*
