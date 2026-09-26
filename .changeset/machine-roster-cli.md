---
"motebit": minor
---

`motebit run` and `motebit serve` enrol the machine in the motebit's machine roster, and `motebit machines` reads it.

A process that announces it hosts unattended work now passes through the roster's mint step after it registers with the relay: the first start signs a `HostEnrollment` for this machine and presents it; later starts re-present the bytes they hold and mint nothing. A `run` and a `serve` starting together on one machine mint one enrolment between them (the mint is taken under `~/.motebit/machine-roster.json.mint.lock`). A machine that was retired from the roster never re-enrols on its own; it says so once and keeps running. Nothing is minted automatically unless both the relay's key chain and its roster were read that start, and never while this machine has lines its key chain cannot place (a lost local copy after a rotation reads as that, not as "no line"). A failed relay read, a relay that keeps omitting entries this machine holds, or an unreadable local copy means nothing is minted that start. None of it ever blocks the daemon.

`motebit machines [--json]` reduces the roster on this machine, under a key chain it resolved itself, and prints each machine with what the relay observed of it. A count is printed only when nothing suppressed it, and the chain head is cited by key. `motebit machines retire <device_id>` signs a retirement for every standing entry of a machine; `motebit machines enroll <device_id> [--force]` undoes one, and refuses ids that could never answer unless forced.

`motebit rotate` records this machine's roster status under the old key before it sends the rotation, and after the local commit enrols the machine under the new key only if that record says it was an active host — never from what the relay holds after the rotation was recorded. A rotation resumed later uses the record its first attempt took. Only a line this machine enrolled itself is carried across a rotation; a machine enrolled from another surface needs `motebit machines enroll` again after rotating.

The replica lives at `~/.motebit/machine-roster.json` (owner-only, written atomically under a lock; an unreadable one is moved aside with its bytes kept). Every roster request is authenticated by this machine's own device key, never the operator's master token.

`motebit machines retire` and `enroll` say plainly when the relay did not take the act, or refused it for good because its roster is full. No count is printed while this machine's own copy of the roster could not be read and has not since been re-confirmed from the relay.
