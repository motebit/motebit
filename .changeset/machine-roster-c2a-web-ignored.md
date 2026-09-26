---
"@motebit/surface-kit": minor
"@motebit/web": minor
---

Machine roster C-2a: the kit additions every phone, desktop and browser shares, and the browser's Machines section (`docs/proposals/machine-roster-surfaces-v1.md`, §1B then §1A over §1).

**Kit.** `classifyHeldKey` decides, after resolution, whether the key a C-2 surface holds is the identity key: a rooted chain, a refusal whose evidence names the held key, or, for legacy ids only, the relay naming it. There is no local custody rung (#797): a key transfer can hand over a device-only key. A device key is reported only on positive evidence. Everything else is `unconfirmed` (`legacy-unproven` or `unrooted`), which suppresses counts (`held_key_unconfirmed`) and refuses every act.

`MachineRoster.gated` refuses retire, enroll, present, omission repair and the rotation hook unless the class is identity. An ungated roster (the CLI) keeps its types and behaviour.

New options:

- `selfIsHost: false`: enroll of this device's own id takes the R17 refusals and records no own mint.
- `repairOmissions`: only the presenting surface repairs.
- `presentationHeld`: a pending Retry-After holds every presentation, an act's own included.

`knownDeviceKeys` now excludes the chain's own keys. A 429 with `Retry-After` stops a presentation.

`createMachineRosterSection` is the shared Settings state holder. `rotationLinkReplica` serves the rotation-commit path. `presentationDue`, `nextPresentationRecord` and `replicaDigest` are the presentation cadence.

**Web.** An IndexedDB database, `motebit-roster`, keyed per motebit_id. Each save is one readwrite transaction (get, set aside if corrupt, merge, put), so two tabs never lose each other's retirement. The open is bounded: a blocked open or a timeout skips the roster and never hangs its caller. Web Locks guard the mint decision; without them the browser reads but refuses writes. One tab at a time holds `motebit-roster-present` and presents: at most every ten minutes unless the replica changed, and never while a `Retry-After` is pending. A rotation commit appends its link to the replica. The Settings → Identity tab gains a Machines card.
