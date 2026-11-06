---
tags: [reference, offsets]
---

# Offsets and Addresses

> [!warning] Two kinds of numbers
> **Offsets** (relative to the SDK or main base) are fixed for this build. **Addresses**
> (the bases, the domain table, the session pool) change every boot. Never hardcode a base.

## SDK offsets (this build)

| Function | Offset |
|---|---:|
| `memcpy` | `0x5224e0` |
| `memset` | `0x522af0` |
| `QueryMemory` | `0x168b0c` |
| `SendSyncRequest` (svc 0x21) | `0x168c4c` |
| `SendSyncRequestWithUserBuffer` (svc 0x22) | `0x168c54` |
| `CloseHandle` (svc 0x16) | `0x168be4` |
| `GetServiceHandle` | `0x14cc90` |
| `svcWaitForAddress` (svc 0x34) | `0x168d1c` |
| `svcSignalToAddress` (svc 0x35) | `0x168d24` |
| `CancelSynchronization` veneer (svc 0x19) | `0x168c0c` (`21 03 00 d4 c0 03 5f d6`) |
| `pthread_create` | `0x142180` |
| `pthread_join` | `0x142480` |
| `pthread_exit` | `0x142410` |

## SDK globals

| Thing | Address |
|---|---:|
| Mount table singleton | `sdk + 0xb35870` |
| FS dispatcher (observed) | `0x21b700` |

## Session object (0x88 bytes)

| Offset | Field |
|---|---|
| `+0x00` | vtable / type tag |
| `+0x28` | parent (pool thread) |
| `+0x30` | wait handle |
| `+0x38` | tag (1) |
| `+0x40` | state (1 = idle) |
| `+0x44` | receiveResult (1 = ok, 3 = timeout) |
| `+0x48` | receive handle |
| `+0x60` | request buffer |
| `+0x68` | capacity (0x100) |
| `+0x70` | domain |
| `+0x78` | metadata |

## Domain entry (0x30 bytes)

| Offset | Field |
|---|---|
| `+0x00` | next |
| `+0x08` | prev |
| `+0x18` | owner domain |
| `+0x20` | object pointer |
| `+0x28` | metadata |

## Per-boot addresses

Written to `seedsow-layout.json` and `seedsow-bound-sessions.json`:

- `table` — domain table base,
- `count` — table capacity (16384 entries on this unit),
- `slots` — session pool base (0x10000 bytes),
- `waiters` — seven contiguous wait objects (0x110 apart),
- `target.domain`, `target.entry`.

## Unit-specific constants

| Constant | Value here | Note |
|---|---:|---|
| marker offset | `~0x2340` | other units use `0x1343`/`0x1351`; per unit, not per build |
| pin allocation | `7440` | `NS2_PIN_BYTES` |
| RO title | `0x0400000000000037` | |

## Related

- [[Stage 1 - App Map]]
- [[Stage 3 - Retained Memory]]
- [[Glossary]]
