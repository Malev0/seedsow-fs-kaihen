---
tags: [overview, foothold]
---

# The Foothold

Before any FS exploit, we need code execution **inside the game**. That is what the launcher
provides.

## The launcher save

`switch-artemis-launcher` (norahax / seedsowhax / hamihax) is a save file for the Seedsow
demo. When the game loads it, the save's Lua runs inside the Artemis engine. It gives us:

- a Lua interpreter with the game's own APIs,
- `_G.n2h` — native primitives,
- an HTTP server on `:8080` with `POST /eval`, `PUT /save`, `DELETE /delete`.

The README calls it “a convenient one-click launch of any upcoming exploit”. It is the
entry point, **not** the FS exploit.

## `n2h`

`n2h` is a Lua library that turns a Lua sandbox escape into useful primitives:

| primitive | what it does |
|---|---|
| `n2h.call_deep(fn, a0..a4)` | call an SDK function through a ROP chain |
| `n2h.peek(addr)` | read 8 bytes (destructive: writes a tag at `addr+8`) |
| `n2h.poke(addr, value)` | write 8 bytes |
| `n2h.alloc(size)` | allocate a block |
| `n2h.str_addr(s)` | address of a Lua string's data |
| `n2h.run_chain(fn)` | run a custom ROP chain |

`poke` is pure Lua and does not use the ROP chain. `peek` is pure Lua too but destructive.
`call_deep` uses the chain, so it blocks while a worker's send is pending.

## Two transports

- **`/eval`** — HTTP POST a Lua chunk, get its `print` output. Used to bootstrap.
- **binary RPC (`N2HR`, `:39380`)** — persistent, typed commands (`read`, `write`, `call`,
  `workers-start`, …). Used for everything fast.

The binary serve loop lives inside one `/eval` request, so while it runs the `/eval`
endpoint is parked.

## What the foothold is not

It does not give us:

- FS sysmodule memory (that is stage 2),
- the ability to mount a filesystem,
- a way to replace a system program.

Those are the exploit we are building.

## Related

- [[The Console Landscape]]
- [[IPC and Sessions]]
- [[Credits]]
