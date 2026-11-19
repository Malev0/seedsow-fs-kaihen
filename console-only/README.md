# Console-only (semi-untethered) save

This folder is the standalone on-console Lua port from
[rushinz/seedsow-semi-untethered](https://github.com/rushinz/seedsow-semi-untethered),
adapted to the kit's launcher save. Once the save is uploaded, the whole chain
runs inside the Seedsow launcher; no PC is needed after the upload.

> **Brick warning:** this runs the FS exploit from the game process and can
> brick the console. Read the disclaimer in the top-level `README.md` first.

## Recommended save backup

Before uploading, use a save editor (for example alula's launcher save editor)
to copy the launcher save to **another profile**. Upload the console-only save
to that second profile, and keep your main profile's save clean for the PC
version. The console-only upload writes the `save:/` tree and commits it; it
does not modify `save:/core.lua`, `save:/inject.iet`, `save:/inject.lua`, or
`save:/http.lua`.

## Upload

1. Switch the console to the second profile, launch Seedsow Lullaby, and press
   **Y** at the launcher to start its HTTP server on port 8080.
2. In the kit's controller, press **Upload Console-Only Save**.
3. Wait for the uploader to print the per-file checks, upload the 14 modules,
   create the A aliases, clean `/hole`, and report `commit_rc=0x0`.
4. Relaunch Seedsow Lullaby.

The uploader verifies each file's source size (32,000 bytes) and wire size
(32,768 bytes, the kit's `http.lua` cap) before writing. It uses the same
`PUT /save` and commit sequence as the reference.

## Run

1. Launch Seedsow Lullaby.
2. Press **A** at the launcher (`exploita2.lua` → `s2_main.lua`).
3. Wait for:

   ```text
   KH: === READY! Close Seedsow Lullaby and hold R while launching a game ===
   ```

4. Close Seedsow Lullaby and hold **R** while launching a game to open hbmenu.

Holding **MINUS** before **Y** still starts the stock HTTP server; the stock
save files are untouched.

## PC version still works

The launcher update keeps **Y : HTTP server (port 8080)**. With the
console-only save installed, the normal PC flow is unchanged:

1. Launch Seedsow and press **Y**.
2. Use the kit's **Start** (or `node ns2-run.cjs`).

The PC setup uploads `n2h_rpc.lua` / `n2h_pump.lua` and drives the same
launcher save. It does not remove the console-only files.

## Prepare SD

The console-only chain needs the kaiHEN release on the SD card. In the
controller, press **Prepare SD**, then choose the SD card's root folder. The
kit downloads the latest kaiHEN release into its local `kaihen/` folder if it
is missing, then copies:

```text
<SD>/hbmenu.nro
<SD>/kaihen/bin/bootstrap.bin
<SD>/kaihen/bin/ro/main
<SD>/kaihen/bin/hen/main
<SD>/kaihen/bin/game/main
<SD>/switch/*.nro
<SD>/kaihen/...              (mirror of the local kaihen folder)
```

Existing files with the same names are replaced.

## Files

```text
lua/                the 14 reference modules (unmodified except the launcher
                    menu's cpypwn text)
upload.cjs          uploader / size verifier for the launcher HTTP server
LICENSE             GPL v2.0 (reference project)
LICENSE-CivSwitchFS CivSwitchFS MIT notice
```
