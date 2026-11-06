---
tags: [concept, wall]
---

# The Control Path and Why It Blocks

## The problem in one sentence

While one of our native workers is inside a blocking IPC `send`, the app's **control path**
cannot execute native calls, so we cannot read or write memory during the operation we are
trying to intercept.

## What the control path is

The PC talks to the console through:

```
PC  ->  local bridge  ->  launcher shim (native)  ->  SDK call
                                     or
PC  ->  binary RPC (N2HR) ->  n2h_rpc.lua (Lua) -> N.call_deep -> ROP chain -> SDK call
```

Memory reads (`retained-read`) and native calls both end up in that SDK call machinery.

## The experiment that proved it

`NS2_LAUNCH_DIRECT_ONLY=1` issues **no retained read** during the load and instead reads one
word of app memory through the launcher shim every 2 s:

```
before release   up:true   direct:true
during load      up:true   direct:false   (every sample)
```

- `up:true` — the app is alive (TCP port open).
- `direct:false` — the shim cannot answer a native call.

So the block is **not** the FS being busy. It is the shim's call path being held by the
worker's `send`.

## Why flags 0 did not help

With flags `0`, the load is synchronous with the launch send. The worker is inside `send`
for the whole load, so the control path is blocked for the whole load. With flags `0x10`,
the launch returns, but the mount is deferred to a start call that blocks the same way.

## Why this is fundamental to the port

The original exploit controls the FS from a channel **outside** the blocked app (the PC has
a separate connection to the FS process). Our port controls the FS **through the app**, and
the app is the process that is blocked in the send. That is the architectural difference.

## What would fix it

1. A control channel that does **not** use the shim's call machinery — e.g. a native thread
   in the app that serves raw `svc` reads/writes.
2. Or a way to make the worker's `send` not hold the call machinery (uncertain).
3. Or a gate that holds the reply without needing us to act during the send
   (`inject-holder`), which currently crashes.

## Related

- [[Stage 3 - The Gate]]
- [[Stage 3 - The Launch]]
- [[Worker Frames and ROP]]
- [[Open Questions]]
