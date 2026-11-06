---
tags: [concept, filesystem]
---

# The Mount Table and CodeFS

## Mounts

A **mount** attaches a filesystem to a name. Seedsow sees names like `save:`, `game:` and
`empty:`. The SDK keeps a global **mount table**:

```
MountTable singleton   sdk + 0xb35870
list node              accessor + 8   (prev +8, next +0x10)
mount name             accessor + 0x18 (16 bytes)
IFileSystem *          accessor + 0x28
```

`inspect-mounts.cjs` walks it. This is how we learned which mounts the demo exposes.

## CodeFS

A **CodeFS** is the filesystem object for a program's code (its NCA/ROM contents). When the
Loader loads a program it:

1. asks PM/Loader for the program,
2. asks fsp-srv to mount the program's CodeFS,
3. opens `main.npdm` and `main`,
4. maps and starts the process.

The CodeFS mount is a **domain entry** with a filesystem-type **metadata** tag. If we can
replace that entry's **object pointer** with a donor object that points at our files, the
Loader reads our bytes.

## The donor

The **donor** is a captured filesystem object built from the real `ro` files:

- `main.npdm` — program metadata,
- `main` — the executable.

`RO payload and current console policy` captures them. The payload is built so its hashes
match what the Loader expects, so the swap is not detected.

The exchange in `ro/launch.cjs`:

```
newEntry.object  = donor.object      // Loader now reads the donor
donorEntry.object = code.object      // keep the reference counts consistent
```

The second write is for bookkeeping. The first is the one that changes what the Loader
sees.

## Why the swap is hard

The entry only exists **after** the FS has processed the mount request. The Loader reads the
image **after** the mount reply. So the swap must happen in the tiny window between:

- the FS creating the entry, and
- the Loader opening `main`.

The gate exists to widen that window by holding the FS at the mount request.

## Related

- [[Domains]]
- [[Stage 3 - The Gate]]
- [[Stage 3 - The Launch]]
- [[PM and the Loader]]
