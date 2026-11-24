# Console-only (semi-untethered) save

This folder is the standalone on-console Lua port from
[rushinz/seedsow-semi-untethered](https://gitlab.com/rushinz/seedsow-semi-untethered),
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
(under 28,600 bytes, below the stock launcher `http.lua` 28,672-byte body
cap) before writing. Larger modules have their comments and indentation
stripped on the wire; line numbers are preserved. It uses the same `PUT /save`
and commit sequence as the reference.

### Command line

The same upload works without the controller:

```text
node console-only/upload.cjs --host <console-ip>
node console-only/upload.cjs --ip <console-ip>      (alias)
node console-only/upload.cjs --check                (verify files only)
```

Without `--host`/`--ip`, the address comes from `NS2_CONSOLE` or
`tools/console-host.txt`. `--host` also saves the address to
`tools/console-host.txt` for later runs. Press **Y** at the launcher first.

## Run

1. Launch Seedsow Lullaby.
2. Press **A** at the launcher (`exploita2.lua` → `s2_main.lua`).
3. Wait for:

   ```text
   KH: === READY! Close Seedsow Lullaby and hold R while launching a game ===
   ```

4. Close Seedsow Lullaby and hold **R** while launching a game to open hbmenu.

> **Seedsow Lua Editor saves:** load the launcher slot, close the game, reopen
> it, load the slot again, and only then press **A**. Pressing **A** on the
> first launch can freeze.
>
> If the log says `STOP: ... restart the Switch`, power-cycle the console
> before trying again. That message means the attempt cleanup could not verify
> that a retry is safe.

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

The console-only chain needs kaiHEN on the SD card. In the controller, press
**Prepare SD**, then choose the SD card's root folder. The kit downloads the
latest kaiHEN release into its local `kaihen/` folder if it is missing.

kaiHEN **20261123** and newer ship an `sdcard/` folder that mirrors the card.
The kit copies its contents to the SD root, then adds the two files the
console-only port reads from `/kaihen/bin`:

```text
<SD>/hbmenu.nro
<SD>/kaihen/bin/hen/main
<SD>/kaihen/bin/game/main
<SD>/kaihen/lib/*.so*          (libounce, libstdc++, Vulkan, OpenGL)
<SD>/switch/ounceshell.nro
<SD>/kaihen/bin/ro/main        (from the release root)
<SD>/kaihen/bin/bootstrap.bin  (from the release root)
<SD>/kaihen/licenses/...
```

Older flat kaiHEN releases are still copied to the older layout. Existing
files with the same names are replaced.

If you set up the card by hand, extract the release ZIP to the SD card root
(the console-only port moves `ro/`, `bootstrap.bin` and the contents of
`sdcard/` into place on the first run), or copy the contents of `sdcard/` to
the root and put `ro/main` and `bootstrap.bin` in `/kaihen/bin/`.

The shared libraries in `kaihen/lib` are required by dynamically linked
homebrew. The kit stages the release's `sdcard/` folder itself, so the PC flow
does not need a separate ns2jb checkout; the bundled engine already handles
the retained FS staging. If you update kaiHEN by hand, copy the release's
`sdcard/` folder to the card root as well as `ro/main` and `bootstrap.bin` to
`/kaihen/bin/`.

If a program does not start, kaiHEN shows a number:

- `2346-0200` – the program needs a newer kaiHEN; update kaiHEN.
- `2346-0201` – a shared library is missing; copy the release's `sdcard/` folder.
- `2346-0202` … `2346-0204` – a library does not match the program; copy `sdcard/` again.
- `2346-0205` – a library in `sdmc:/kaihen/preload` could not be loaded; remove it.

## Files

```text
lua/                the 14 reference modules (latest rushinz port; s2_kaihen.lua
                    is updated for the kaiHEN 20261123 sdcard/ layout)
upload.cjs          uploader / size verifier for the launcher HTTP server
LICENSE             GPL v2.0 (reference project)
LICENSE-CivSwitchFS CivSwitchFS MIT notice
```
