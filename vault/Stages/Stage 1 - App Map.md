---
tags: [stage]
---

# Stage 1 - App Map

**File:** `engine/switch2/app/map.cjs`
**Goal:** know where everything is in the app process.

## What it does

1. Asks the console for its memory regions (address, size, type, permissions).
2. Finds the **SDK base** and **main module base**.
3. Reads the app's mount table so later stages know which mounts exist.
4. Records the addresses in `connection.json` / `app/memory-map.json`.

## Why it matters

Every later address is relative to one of these bases. For example:

- `memcpy` = SDK base + `0x5224e0`
- `SendSyncRequestWithUserBuffer` = SDK base + `0x168c54`
- `GetServiceHandle` = SDK base + `0x14cc90`

If the app is relaunched, the bases change. That is why `resume.ps1` refreshes the map on
every boot and why a stale map produces `mounts sdk mismatch`.

## What can go wrong

- The app was relaunched after the map was taken → `mounts sdk mismatch`.
- The launcher HTTP server is not up (Y not pressed) → the map cannot be read.

## Related

- [[Offsets and Addresses]]
- [[How to Run a Boot]]
