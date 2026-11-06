---
tags: [concept, ipc]
---

# IPC and Sessions

## The idea

Processes on the Switch do not call each other's functions. They send **messages** over
**sessions**. This is IPC (inter-process communication).

A session is a two-ended channel:

```
client process                         server process
+-----------+    request buffer   +-----------+
| KClient   | ------------------> | KServer   |
| Session   | <------------------ | Session   |
+-----------+    reply buffer     +-----------+
```

The client calls `SendSyncRequest(handle, request)`. The kernel copies the request into the
server's session buffer, marks the session ready, and blocks the client until the server
replies. The server calls `ReplyAndReceive`, which replies to the previous request and then
waits for the next one on a set of handles.

## Handles

A **handle** is a small integer that indexes a process's handle table. Handles are
**per-process**: a handle value that means “FS session” in the FS process means something
else (or nothing) in the app. This is why an FS-side thread handle cannot be used from the
app (`0xE401` invalid handle).

## What a session object contains (this build)

The FS session object is 0x88 bytes. The fields we use:

| offset | field |
|---|---|
| `+0x00` | vtable / type tag |
| `+0x28` | **parent** (the pool thread that owns it) |
| `+0x30` | **wait handle** (used to build the wait array) |
| `+0x38` | tag (1) |
| `+0x40` | **state** (1 = idle/ready) |
| `+0x44` | **receiveResult** (1 = success, 3 = timeout) |
| `+0x48` | **receive handle** (used by reply/receive) |
| `+0x60` | **request buffer** pointer (0x100 bytes) |
| `+0x68` | request capacity (0x100) |
| `+0x70` | **domain** pointer |
| `+0x78` | **metadata** pointer (filesystem type) |

`bind-sessions` records these for the two sessions the launch uses.

## The request header

The first word of the request buffer is a header. For a control request it looks like
`(length << 16) | 5`; for a normal request, `| 4`. The payload starts at a fixed offset and
begins with the ASCII magic `SFCI` (for a domain request) or `SFCO` (for a control/close
message). That is how `requestInfo()` decides what a queued request is.

## Why this matters to the exploit

- The mount we want to intercept is an IPC request on a session.
- The gate works by controlling when the server **receives** that request.
- Our memory endpoint also uses IPC (the FS performs reads/writes on our behalf).

## Related

- [[Domains]]
- [[The Wait Array and Parking]]
- [[Glossary]]
