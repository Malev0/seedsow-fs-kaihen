# seedsow-fs-exploit - vault index
tags: [moc, index]
---

# ns2jb on Seedsow — vault index

This vault explains the FS sysmodule exploit we are porting to **Seedsow Lullaby Demo**
(Artemis engine, Switch 2, system 23.0.1). It is written for someone who can read code but
has never seen this exploit before.

> [!warning] Current status
> The exploit is **not finished**. Stages 1–2 work (stage 2 is a per-boot lottery).
> Stage 3 reaches `ro/launch`, where the Loader's `ConvertToDomain` queues on a second
> bound session and no CodeFS mount entry is ever created. Stage 4 has never run.
> See [[Current Status]].

## Read in this order

1. [[Big Picture]] — what we are trying to do and why it is hard.
2. [[The Foothold]] — how we get Lua + native calls inside the game.
3. [[The Console Landscape]] — the processes and kernel objects involved.
3. [[The Four Stages]] — the pipeline at a glance.
4. [[Stage 2 - FS Memory Acquisition]] — how we get read/write into the FS.
5. [[Stage 3 - The Gate]] and [[Stage 3 - The Launch]] — where we are stuck.
6. [[Glossary]] — every term, A–Z.

## Map of content

### Overview
- [[Big Picture]]
- [[The Foothold]]
- [[The Console Landscape]]
- [[The Four Stages]]
- [[How to Run a Boot]]

### Stages
- [[Stage 1 - App Map]]
- [[Stage 2 - FS Memory Acquisition]]
- [[Stage 2 - The Three Windows]]
- [[Stage 3 - Retained Memory]]
- [[Stage 3 - The Gate]]
- [[Stage 3 - The Launch]]
- [[Stage 4 - Start and Verify]]

### Concepts
- [[IPC and Sessions]]
- [[Domains]]
- [[The Mount Table and CodeFS]]
- [[The Retained Cache]]
- [[Worker Frames and ROP]]
- [[The Wait Array and Parking]]
- [[PM and the Loader]]
- [[Launch Flags]]
- [[The Second Bound Session]]
- [[The Control Path and Why It Blocks]]

### Reference
- [[Glossary]]
- [[Environment Variables]]
- [[Failure Signatures]]
- [[Offsets and Addresses]]
- [[Error Codes]]
- [[Credits]]

### Project
- [[Current Status]]
- [[Open Questions]]

## Conventions in this vault

- **Code names** are written as they appear in the repo, e.g. `ro/launch.cjs`,
  `NS2_GATE_WAKE`.
- **Addresses** are written in hex, e.g. `0x5224e0`.
- A **“session”** always means an IPC session, not a game session or an Obsidian session.
- A **“wave”** always means one acquisition attempt, not a radio wave.

> [!tip] If a term is unfamiliar
> Open [[Glossary]] first. Every concept note links back to it.
