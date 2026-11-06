---
tags: [concept, native]
---

# Worker Frames and ROP

## Why we need native threads

`n2h.call_deep` lets the Lua side call an SDK function. But the Lua side is single-threaded
and the call machinery is fragile. For timing-sensitive work (waves, the gate) we need
**real threads** running native code concurrently.

A **worker** is a `pthread` we create from a crafted memory frame.

## The frame

The frame is a block of memory containing:

1. a **forged `jmp_buf`** — `longjmp` restores registers from it and jumps to a gadget,
2. **call regions** — for each call, three small frames `V`, `B`, `S`,
3. **result cells** — where each call's `x0` is stored,
4. **job records** — the target function and arguments.

The first gadget is `vcall8_restore` (loads `x0..x7`, `x29`, `x30`, returns). Each call goes
through `g_call2` (loads the target and `x0`/`x1`, `blr`s it) and `g_store_x0_x19` (stores
the result and continues).

This is a **ROP chain** (return-oriented programming): we are not writing new machine code,
we are stitching together existing gadgets and SDK functions.

## Why ROP instead of writing code

Changing heap page permissions to execute our own code ends the process on this build. ROP
uses existing executable pages, so no permission change is needed.

## `pthread_t` is tagged

On this build `pthread_create` returns values like `0x32cab74007`. They are not
pointer-aligned. Every `pthread_*` call must receive the exact tagged value. The old
`% 8 == 0` check was wrong.

## Joining is dangerous

`pthread_join` / `TryWaitThread` can block **inside `pthread_exit`** even after the chain has
stored every result. On this build that wedges the endpoint. The safe alternative is
`root-native-worker-settle`: read the result cells and release the bookkeeping without
waiting.

## The chain types we use

| kind | what it sends |
|---|---|
| `pm-launch` | `pm:shell` cmd 0 `LaunchProgram` |
| `pm-start` | `pm:dmnt` cmd 1 (start; dangerous) |
| `cmif-control` | a domain control request |
| `ro-process` | a request to the RO payload |
| `notifier-probe` | a batch of candidate handles |

## Related

- [[Stage 2 - FS Memory Acquisition]]
- [[The Control Path and Why It Blocks]]
- [[Offsets and Addresses]]
