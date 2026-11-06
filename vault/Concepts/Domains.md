---
tags: [concept, ipc]
---

# Domains

## The idea

A plain session talks to **one** object. A **domain** is a session that multiplexes
**many** objects: the client can ask the server for an object by id and then send commands
to that id.

Think of it as a session that carries a small object table:

```
domain
+----+----------------------+
| id | object               |
+----+----------------------+
| 1  | filesystem object    |
| 2  | directory object     |
| 3  | file object          |
+----+----------------------+
```

The FS uses domains for almost everything: a mount returns a domain, a directory returns
file objects inside it, and so on.

## ConvertToDomain

A client can turn a plain session into a domain with a **control request**:

- request type 5 (control),
- command **0** = `ConvertToDomain` (`command 1` is `CopyObject`).

After that the session carries an object table. This is why the Loader sends
`ConvertToDomain` after cloning the app's session: it needs a domain to ask for the mount
and the files.

## Domain entries

A domain's entries live in the FS's **domain table**. Each entry is 0x30 bytes:

| offset | field |
|---|---|
| `+0x00` | next |
| `+0x08` | prev |
| `+0x18` | owner domain |
| `+0x20` | **object pointer** |
| `+0x28` | **metadata** (filesystem type) |

The domain keeps a linked list of its entries. `entries()` in `ro/launch.cjs` walks that
list by following `+0x00`.

The **mount** we care about is a new entry whose `metadata` matches the donor's filesystem
type. If it appears, we swap its `object` pointer for the donor object.

## Why the launch watches many domains

A launch can create a **new** session and convert it to a domain, rather than reusing the
one bound at boot. So `ro/launch.cjs`:

- scans the session pool for sessions of the same class (same vtable),
- collects their domains,
- walks every domain looking for a new donor-matching entry,
- optionally scans the whole domain table.

## Related

- [[IPC and Sessions]]
- [[The Mount Table and CodeFS]]
- [[The Second Bound Session]]
