---
"motebit": minor
---

`motebit run` and `motebit serve` enrol the machine in the motebit's machine roster, and `motebit machines` reads it.

A process that announces it hosts unattended work now passes through the roster's mint step after it registers with the relay: the first start signs a `HostEnrollment` for this machine and presents it; later starts re-present the bytes they hold and mint nothing. A machine that was retired from the roster never re-enrols on its own; it says so once and keeps running. A failed relay read, a relay that keeps omitting entries this machine holds, or an unreadable local copy means nothing is minted that start. None of it ever blocks the daemon.

`motebit machines [--json]` reduces the roster on this machine, under a key chain it resolved itself, and prints each machine with what the relay observed of it. A count is printed only when nothing suppressed it, and the chain head is cited by key. `motebit machines retire <device_id>` signs a retirement for every standing entry of a machine; `motebit machines enroll <device_id> [--force]` undoes one, and refuses ids that could never answer unless forced.

`motebit rotate` now runs the roster's rotation hook after the local commit: if this machine was an active host before the rotation, it enrols under the new key.

The replica lives at `~/.motebit/machine-roster.json` (owner-only, written atomically under a lock; an unreadable one is moved aside with its bytes kept). Every roster request is authenticated by this machine's own device key, never the operator's master token.
