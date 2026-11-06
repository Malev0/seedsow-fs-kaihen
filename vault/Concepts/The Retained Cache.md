---
tags: [concept, memory]
---

# The Retained Cache

## The idea

We cannot read or write FS memory directly. But the FS can. If we corrupt one of its cache
descriptors so that its **data pointer** points at an address we choose, then the FS's own
read/write becomes *our* read/write.

That corrupted descriptor is the **retained cache** (or **retained endpoint**).

## The descriptor

A cache block descriptor is roughly:

```
+0x00  data pointer      -> the bytes
+0x08  length             (0x4000 = 16 KiB)
+0x10  flags              (1,1,1)
+0x20  data pointer       (the one we retarget)
+0x28  block size
```

`setPointer(context, state, address)` changes the `+0x20` pointer and verifies the readback.
`logicalRead` / `logicalWrite` then read/write `state.dataOffset` in the bucket, which now
maps to `address`.

## The two buckets

The endpoint keeps two buckets:

- **control bucket** — holds the descriptor we retarget,
- **data bucket** — the 16 KiB window we read/write through.

This lets us change the target without losing the descriptor itself.

## The reserved gap

How do we corrupt the descriptor in the first place? We make the FS write a payload that
overlaps it, using a hole in its heap that we can influence. That is the **reserved gap**
technique from stage 2.

## What “retained” means

The endpoint persists after stage 2. Later stages use it like ordinary memory:

```js
const memory = await connect();
await memory.read(address, length);
await memory.write(address, bytes);
await memory.u32(address);
```

Every one of those calls is really:

```
host -> FS IPC -> FS reads/writes its own memory -> reply -> host
```

So the endpoint is only as available as the FS itself. If the FS is busy or blocked, the
endpoint stalls. That is a recurring theme in the stage-3 failures.

## Verification

The endpoint refuses to operate unless it can prove its state:

- `readVerified` — poison and content controls both pass,
- `writeVerified` — a write reads back and the neighbours are intact,
- `corruptionCount` — must not change after setup.

If verification fails, the boot is not usable.

## Related

- [[Stage 2 - FS Memory Acquisition]]
- [[The Control Path and Why It Blocks]]
- [[Glossary]]
