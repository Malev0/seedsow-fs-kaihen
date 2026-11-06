---
tags: [concept, launch]
---

# Launch Flags

`pm:shell` `LaunchProgram` takes a flags word. Two values matter to us.

## `0x10` — StartSuspended

PM creates the process, but the Loader does **no filesystem work**. The image is not
mounted or read. The process sits suspended.

- Launch returns quickly → our control path stays free.
- The load is deferred to `pm:dmnt` id 1 (start).
- Calling that start on a manipulated FS **blocks and aborts the app**.

Our `ro/launch` default is `0x10`.

## `0` — normal launch

The Loader loads inside the launch request.

- The load is synchronous with the `LaunchProgram` send.
- Our control path is blocked for the whole load.
- A flags-0 run survived 120 s (`up:true`) but every memory read was blocked
  (`direct:false`).

## The trade-off

```
flags 0x10:  launch fast  -> control path free -> but mount deferred to a fatal start
flags 0:     launch blocks -> control path blocked -> but mount happens inside the launch
```

Neither gives us “mount happens while we can act”. That is the core design problem. See
[[The Control Path and Why It Blocks]].

## Setting it

`NS2_LAUNCH_FLAGS` selects the value. The proof records it (`flags: 16` or `flags: 0`).

## Related

- [[Stage 3 - The Launch]]
- [[PM and the Loader]]
- [[Environment Variables]]
