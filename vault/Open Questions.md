---
tags: [project, research]
---

# Open Questions

The questions that decide whether this port can reach 4/4.

## 1. Which session does the Loader actually use?

The second bound row is `ownDomain`; its `control 1` buffer is a stale stage-1
`CopyObject`, not the Loader's `ConvertToDomain` (control 0). The Loader's session is
probably one of the ~47 unbound fsp-srv sessions found by the pool scan. We have never read
their request buffers. The next diagnostic should dump every session's `+0x30`, `+0x40`,
`+0x44`, `+0x48` and request header during a load.

## 2. Can we act during a synchronous load?

The control path blocks while a worker's send is pending (`direct:false`). Options:

- a **native retained-read/write worker** that uses the SDK `send` from its own pthread,
  not the shim call path (most promising),
- a worker frame that does not hold the call machinery (unproven),
- a gate that holds the reply without us acting (`inject-holder`, currently fatal).

## 3. Is there a safe reply-hold?

`inject-holder` writes the session address into the selected slot. The kernel dereferences
it and the system dies when a real request is delivered. We do not know the exact object
type the kernel expects.

## 4. Is the FS heap layout the real limit?

Stage 2 is a lottery because the marker offset and pin allocation are per-boot/per-unit.
Could we measure and adapt instead of guessing?

## 5. Where does the mount entry land?

With `flags 0x10` the mount happens at `pm:dmnt` id 1, not during the launch. We need a
post-load inspection (or a native watcher) to see whether the entry is in the target
domain, a new Loader domain, or the whole table.

## 6. What is the actual FS wait/timeout path?

A live FS text dump would let us read the `ReplyAndReceive`/wait code and stop guessing.
The retained alias cannot leave the FS heap, so this needs another primitive.

## Related

- [[Current Status]]
- [[The Control Path and Why It Blocks]]
- [[Stage 3 - The Gate]]
- [[The Second Bound Session]]
