---
tags: [concept, kernel, gate]
---

# The Wait Array and Parking

## Waiting on several things

An FS pool thread must be able to serve **any** of several sessions. It does that with a
wait on an **array of handles**:

```
WaitSynchronization(handles[], count, timeout)
  -> index of the ready handle
  -> the kernel writes the ready object into a "selected" slot
```

When a client sends a request, the kernel marks that session ready. The thread's wait
returns, the thread reads the selected slot, and it serves that session.

## The selected slot

The kernel keeps, per waiter, a small record. At `parent + 0x10` it writes the **selected
object** when the wait completes. The FS dispatch then uses that object.

`retained-inject-holder` writes the session address there directly, to force the kernel to
treat the session as selected. On this build, delivering a real request through that fake
selection is fatal.

## Parking

The session stores the handle used to build the wait array at `+0x30`.

**Park** = replace `+0x30` with our own notifier handle and wake the notifier so the thread
re-arms on our event instead of the session.

**Unpark** = put the real handle back and wake again.

```
before:  thread waits on [ ... session ... ]
park:    session+0x30 = notifier ; wake
after:   thread waits on [ ... notifier ... ]   (request not served)
unpark:  session+0x30 = real     ; wake
after:   thread waits on [ ... session ... ]    (request served)
```

## The wake

Waking is not just “signal the event”. The kernel must be forced to leave its current wait
and rebuild the array from `+0x30`. That is why the sequence is:

1. write the new handle,
2. signal the notifier,
3. settle,
4. clear the notifier.

`NS2_GATE_WAKE=park` is the only mode that works. `both` and `receive` try to signal a
read-only export and are rejected.

## The shared-notifier problem

All seven pool threads can wait on the same notifier. An **auto-reset** signal wakes **one**
waiter. So one `wake()` may wake the wrong thread. This is the current launch hypothesis:
the target session's parent woke, the second session's parent did not. The fix under test is
to burst one signal per waiter.

## Related

- [[Stage 3 - The Gate]]
- [[The Second Bound Session]]
- [[IPC and Sessions]]
