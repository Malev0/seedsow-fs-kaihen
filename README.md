# seedsow-fs-exploit - Seedsow (Artemis) FS sysmodule exploit, PC-driven

A port of [ns2jb](https://github.com/)'s filesystem/`fs` sysmodule exploit to the
*Seedsow Lullaby Demo* Artemis app, with all planning done on the PC and a small Lua
shim executing native calls on the console.

```
    PC (Node)                      Switch
 ┌──────────────────┐   TCP 39380  ┌──────────────────────────────────────┐
 │ plan / frames /  │◄────────────►│ n2h_rpc.lua  (loaded from the save)  │
 │ address maths    │   HTTP 8080  │   └─ _G.n2h  → sdk/main calls        │
 │ seedsow-bridge   │◄────────────►│ Seedsow launcher HTTP server (/eval) │
 └──────────────────┘              │   └─ FS sysmodule corruption          │
        ▲                          │        └─ retained FS memory, RO      │
        │ optional                 └──────────────────────────────────────┘
 ┌──────┴───────┐   Wi-Fi
 │ Pico W bridge│──────────────► Switch dock (wired Pro Controller)
 └──────────────┘
```

Everything that requires thought (address planning, ROP frames, syntax checks, hashing,
state analysis) happens in Node on the PC. The console only runs native calls, reads and
writes memory, and ships bytes back.

## Requirements

- Windows PC (the tooling uses PowerShell + Node + Python).
- Node.js 20+ (tested on 26), Python 3.11+ (tested on 3.14). No pip packages are needed
  for the normal workflow; `tests/test_build_frame.py` needs `lupa`.
- A Switch running the Seedsow Artemis app with its launcher HTTP server enabled
  (**press Y in the app**).
- Optional: a Raspberry Pi Pico W for controller input (see *Controller input* below).

## Layout

| Path | Contents |
|---|---|
| `console/` | Lua that runs **on the console**: `n2h_rpc.lua` (the RPC shim), `n2h_accessor.lua` (per-boot mount discovery), `reload_rpc.lua`, `test_eval.lua`, `verify-svc.lua` |
| `tools/` | PC side: `seedsow-bridge.cjs` (console RPC bridge, JSON API on `:31337`), `console-rpc.cjs` (frame client), `rpc-tool.cjs`, `save-list.cjs`, `console-host.cjs`, `post_eval.py` / `upload_save.py` / `refresh_mounts.py` (launcher HTTP helpers) |
| `gui/` | Manual controller app: `ns2-gui.cjs` (local server on `:31338`), `ns2-gui.html`, `start-gui.ps1` launcher |
| `ns2jb-main/` | Vendored upstream engine (`ns2jb-main/ns2jb-main/engine/...`): acquisition probe, retained/RO stages, process/FS-execute, firmware dump |
| `tests/` | `test_build_frame.py` (Lua worker builder vs Node builder), `test-progress.cjs` |
| `docs/` | `FINDINGS.md` (**read this** — stage 2 and stage 3 specifics), `ns2jb-analysis.md`, `reference/` (SDK symbols, core dump, SVC map) |
| `research/` | Seedsow dump (`sdk.text` etc.), the source `.nsp`, keys, `nstool`, reference projects used for prior art (the dumps themselves stay local; they are gitignored) |

## First-time setup

1. Create `tools/console-host.txt` with the console's LAN address (one line, e.g. `192.168.1.50`);
   copy `tools/console-host.example.txt` to start. Or just type it into the **IP box in the
   controller header** and press **Set IP** — that writes the same file and probes `:8080`
   immediately (press Start afterwards so the bridge restarts on the new address).
   Every helper resolves the host as `NS2_CONSOLE` → `console-host.txt` → a default.
2. Start Seedsow on the console and **press Y** (the launcher HTTP server on `:8080`).
3. Start the controller:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\start-gui.ps1
   ```

   It starts `gui/ns2-gui.cjs` (if needed) and opens a chromeless app window at
   `http://127.0.0.1:31338`. A desktop shortcut works the same way.

## Running a boot

1. Launch Seedsow, press **Y**.
2. In the controller press **Start on this boot**. It runs, in order:
   - `resume.ps1` — stop any old bridge/console loop, upload + reload `console/n2h_rpc.lua`,
     refresh the per-boot mounts (`tools/refresh_mounts.py`), start the bridge, verify
     `mounts.sdk == connection.sdk`;
   - `save-list.cjs --clean` (frees the 16 MiB scratch left by a failed run);
   - `node pipeline.cjs --dump-firmware` in `ns2jb-main/ns2jb-main/engine/switch2`.

The manual equivalent, from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\resume.ps1
node tools\save-list.cjs --clean
cd ns2jb-main\ns2jb-main\engine\switch2
$env:NS2_FAST='1'; $env:NS2_WAVE_SETTLE_MS='1000'
$env:NS2_ACQUIRE_TIMEOUT_MS='2700000'; $env:NS2_ACQUIRE_ATTEMPTS='1'
$env:NS2_PROBE='memory\probe-reserved-gap-seedsow.cjs'
node pipeline.cjs --dump-firmware
```

Progress is mirrored to `engine/switch2/status.txt` (`[n/4] <stage>`), and the GUI shows a
per-stage percentage (stage 2 comes from the probe's own checkpoints).

**Auto retry** (the `auto [6] tries` toggle next to Start) relaunches the app and starts
another boot when a run fails **before 3/4** — that is the per-boot stage-2 lottery. It uses
the same controller sequence as *Restart Game* (including the `Y delay`), keeps the previous
attempt's log, and stops after the configured number of tries (1–20). Measured on this unit:
~18% of boots yield a usable acquisition (the rest fail as “No changedLink candidate on this
boot”, which the probe refuses on purpose because stable-only plans wedge the FS), so 10–20
tries is the practical setting. After three bad boots in a row the log says so — a console
restart changes the FS cache layout more than the app relaunch the retries do. It
deliberately does **not** retry a stage-3 failure: the FS is in native state there and needs
a power-cycle.

### The four stages

| Stage | What it does |
|---|---|
| 1/4 | `app/map` — locate the app's mounts and SDK addresses |
| 2/4 | acquisition probe — corrupt the FS cache to obtain a verified read/write into FS memory ("`memory-ready`") |
| 3/4 | retained + RO — retarget FS objects, install the loader root, prepare the RO payload and launch it |
| 4/4 | process — map the payload into FS, execute, restore, and (optionally) dump firmware |

## Controller input (optional, Pico W)

The `Restart Game` button and the manual controller pad need the Pico W bridge (an
external project, not vendored here):

1. Build/flash `seedsow_pico_wifi.uf2`, plug the Pico into the dock, enable
   *Pro Controller Wired Communication* on the console.
2. Start `START PICO BRIDGE.cmd` and wait for `Pico: Switch ready`.
3. The GUI reads `tools/seedsow-connection.json` on every request (override the path
   with `NS2_PICO_CONN`).

`Restart Game` = stop the run + relaunch the app via controller input
(`HOME → X → A → A×N → Y`, with an `A ×2` toggle).

The pad also has **L+R pair** (holds both for 1.2 s — this is what the console's
*Change Grip/Order* screen waits for), **Hold A**, and a tap/hold-length selector. Every
press reports whether the Pico confirmed it (it answers `MARK` once the press ran) and any
button the firmware rejected is printed in the log. The state chip shows
`Pico: connected` after the console's wired-Pro handshake and appends `· P<n>` once the
console has registered it as a player. **Release all** really drops the queue and releases
every button (the bridge reconnects by itself).

**Y delay** (ms, next to `A ×2`) controls how long `Restart Game` waits after the last A
before pressing Y; raise it if a slow boot swallows the Y press and the game comes back
without the HTTP server. It is remembered across reloads, and the log prints the value
used.

## Environment variables

| Name | Meaning |
|---|---|
| `NS2_CONSOLE` | console IP (overrides `tools/console-host.txt`) |
| `NS2_FAST` | `1` = binary TCP RPC + console-side worker builder (default in the GUI) |
| `NS2_TRANSPORT=eval` | fall back to the slow `/eval` transport |
| `NS2_WAVE_SETTLE_MS` | per-retry settle before releasing a probe wave (default 1000 here) |
| `NS2_WAVE_SETTLE_ALWAYS=1` | apply the settle to first attempts too |
| `NS2_COMMIT_MB` | dirty-commit size for the acquisition wave (default 16; 8 makes the canary interleave on this build) |
| `NS2_SKIP_REPRO=1` | accept one confirmed marker instead of demanding a genuine repeat |
| `NS2_SKIP_EXTENT_REQUAL=1` | keep the proven input extent instead of requalifying after each marker write |
| `NS2_FIELD_OFFSET` | offset of the copy tail inside the wave payload (default = marker offset) |
| `NS2_PIN_BYTES` | expected pin allocation (7440 on this unit) |
| `NS2_SLEEP_RAW=1` | disable the 19.2/31.25 MHz sleep scaling |
| `NS2_WORKER_PRIO` | worker priority (5–35; 5 = highest accepted) |
| `NS2_WORKER_AFFINITY=1` | pin workers at creation, round-robin, core 0 excluded |
| `NS2_GATE_WAKE` | wake the parked FS session instead of a no-op cancel: `park` (default), `both`, `receive`, `0` |
| `NS2_GATE_WAKE_MS` | settle between waking and clearing the event (default 25 ms) |
| `NS2_MEMORY_TIMEOUT_MS` | ordinary retained/controller request deadline (default 60 s; `ro/test-gate` uses 15 s) |
| `NS2_GATE_QUIET_MS` | how long `ro/test-gate` watches the app's HTTP port after a step (default 5000) |
| `NS2_FS_PROBE=1` | after `ro/prepare-workers`, read at the API-thread entry — **known limitation**: the alias cannot leave the FS heap, so this blocks and wedges the endpoint; see `docs/FINDINGS.md` |
| `NS2_FS_PROBE_BYTES` / `NS2_FS_PROBE_START` | first read size/address (default 0x40 at the entry) |
| `NS2_FS_DUMP_BYTES` / `NS2_FS_DUMP_START` | also dump a range (default start = 2 MiB-aligned module base) |
| `NS2_FS_PROBE_ONLY=1` | stop the pipeline after the probe instead of running the gate |
| `NS2_CANCEL_SETTLE_MS` | delay returned by the no-op worker-cancel (see FINDINGS §3) |
| `NS2_ACQUIRE_TIMEOUT_MS` / `NS2_ACQUIRE_ATTEMPTS` | probe supervision |
| `NS2_BOUNDED_SEND_MS` | timeout for bounded FS sends |
| `NS2_QUALIFY=1` | force `app/qualify` (skipped for Seedsow) |
| `NS2_PICO_CONN` | path to the Pico bridge connection file |

## When something goes wrong

- **Stage 2 rejects in ~50 s with "No changedLink candidate"** — that boot cannot produce a
  usable address plan. Relaunch the game and try again. This is expected roughly half the time.
- **`/eval` stops answering** — the console's launcher HTTP handler is parked/wedged. The
  tooling retries for ~60 s; if it stays down, restart the app.
- **App becomes unclosable** — a blocking native call is holding the FS service. The GUI now
  retries the failure-path retire and presses HOME twice; if `:8080` disappears the boot is
  marked fresh. If the console still ignores HOME, hold the power button: the FS thread is
  stuck inside the sysmodule and nothing on the PC can release it.
- **Start is refused with "This boot was already used"** — that is the one-acquisition-per-boot
  guard. Relaunch Seedsow (or press Restart Game / App crashed / relaunched), then Start.
- **Free space is 16 MiB instead of ~33 MiB** — a failed run left `NS2_GAP_*/commit_data`;
  run `node tools\save-list.cjs --clean`.
- **`mounts sdk mismatch`** — the game was relaunched; re-run `resume.ps1` (or just press Start).

## Packaging this folder for someone else

Run the copier; it applies the include/exclude rules below and writes a
`SHARE-MANIFEST.txt` listing what was left behind:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\share-copy.ps1
# or: -Destination D:\share\ns2jb -ExcludeResearch
```

The default copy is ~25 MB (from a ~3.1 GB working tree): the demo `.nsp`,
the extracted dump, every `*.bin` capture, the per-run JSON reports, logs and
`docs/history/` are skipped. `-IncludeGameDumps` keeps the demo data and
`-MaxFileMB 0` disables the per-file cap.

**Include:** `console/`, `tools/`, `gui/`, `tests/`, `ns2jb-main/`, `README.md`,
`docs/FINDINGS.md` (and `docs/reference/` if you want them to have the SDK symbol table and
core dumps), plus the three root `.ps1` files.

**Exclude:**

- `research/` (~1.8 GB). It holds `prod.keys` / `title.keys` (console-unique key material)
  and the copyrighted demo `.nsp` plus its extracted dump. Nothing at runtime reads from it;
  the recipient needs their own copy of the demo (the offsets used by the engine are already
  hardcoded). Keep it locally.
- `docs/history/` if you want a clean handover - it is superseded logs with stale addresses.
- generated run artifacts: `ns2jb-main/**/*.bin`, `**/*.jsonl`, `**/*.log`,
  `memory/reserved-gap-*.json`, `retained/seedsow-metadata-*.json`, `ro/seedsow-*.json`,
  `ro/seedsow-code-*/`, and the root `*.log` / `*.err`. They are per-run and large
  (a single in-flight probe writes 5 MiB captures).
- `tools/console-host.txt` contains *your* console's LAN address - set it to theirs or leave
  it for them to edit (the README says so).

There are no passwords, API tokens or usernames in the shipped tree; the only Pico token
lives in the separate `espcon` project.

## Study vault

`vault/` is an Obsidian vault that explains the exploit from scratch: the big picture, each
stage, the concepts (sessions, domains, the gate, the retained cache), a full glossary, and
the current status. Open the folder as a vault in Obsidian and start at
`00 Start Here.md`. It is written for someone who codes but has never seen this exploit.

## Credits

This is a port built on ns2jb, with code and analysis from **Manupera's
`remote-lua-sw2` Seedsow port** (multi-session launch scan, second bound-session
kick, whole-table mount polling). See
[`CREDITS.md`](CREDITS.md) for the exact files and findings. Keep those credits
if you redistribute this tree.

## Safety

This writes to FS sysmodule memory. Expect occasional hard resets, and do not run it with
unsaved game progress you care about. Nothing here touches the SD card's save data beyond a
scratch directory that the tools clean up.
