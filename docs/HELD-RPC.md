# Held RPC after stage 4

The GUI now starts `pipeline.cjs --hold-rpc` instead of `--dump-firmware`.
When the stage-4 FS instruction challenges pass, the pipeline cleans up the RO
donor files, then **does not exit**: it keeps the FS memory endpoint and the
console RPC alive and waits for a release. The GUI shows phase `held` and the
console keeps running the RO payload.

This is the same shape as ns2jb's `--rpc` mode: after 4/4 you can send more
commands without another boot.

## Release

- GUI: press **Release RPC**.
- API: `POST http://127.0.0.1:31338/api/release`.
- Stop run while held sends the same release first, then the pipeline runs
  `acquisition.retire()`, restores the FS state, and exits.

A hard `Stop run` (or killing the pipeline) leaves the FS cache unretired; use
Release when you want the console left clean.

## Console RPC (bridge, `127.0.0.1:31337`)

The bridge process stays up. It accepts JSON POST requests, for example:

```powershell
curl.exe -s -X POST http://127.0.0.1:31337 -H "content-type: application/json" -d '{\"command\":\"status\"}'
```

Commands in `tools/seedsow-bridge.cjs` `dispatch`:

- `status`
- `call` (`offset`, `args`)
- `call-address` (`address`, `args`)
- `pair` (`calls`)
- `read` (`address`, `length`)
- `write` (`address`, `data` base64)
- `query` (`address`)
- `verify-function` (`address`, `hex`)
- `workers-start` / `workers-join`
- `rpc-stats`
- `rpc-debug` (`cmd`, `a0`..`a4`, `hex`)
- `rpc-run` (`source` Lua)
- `prepare-worker`

`rpc-run` and `rpc-debug` need the fast TCP RPC (`NS2_FAST=1`, which the GUI
sets).

## FS memory endpoint

`current-acquisition.json` names the report and the endpoint socket
(`memoryControl.socketPath`). A separate process can use
`ns2jb-main/ns2jb-main/engine/switch2/tools/fs-memory.cjs` `connect()` and send
the `root-native-*` commands:

- `root-native-info`
- `root-native-ipc` (`handle`, `id`, `hex`)
- `root-native-sm-service` (`handle`, `name`)
- `root-native-code-open` (`handle`, `title`)
- `root-native-file-capture` (`handle`, `name`)
- `root-native-worker-*` (`worker-prepare`, `worker-release`, `worker-state`,
  `worker-join`, `worker-values`, `worker-output`, ...)
- `root-native-donor-*` / `code-*` / `file-*` helpers in `ro/control.cjs`

The endpoint is retired when the GUI sends `release`.

## Payload services

The replacement RO payload is running and has registered `ro:1` and
`ro:dmnt`. Its process commands (`0x524f0010`–`0x524f0016`) are reachable
through the owned RO service handle, e.g. `ro/worker-control.cjs`
(`kind: 'ro-process'`) or `ro/runtime.cjs` `probe`. This is how a new program
can be mapped/patched/tested without relaunching.
