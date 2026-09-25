---
"@motebit/crypto": minor
---

`resolveRosterKeyChain({ motebitId, held, records, guardianKey? })` — the key chain a consumer hands `verifyHostRoster` (machine roster part C, increment C-0).

It walks backward from the key the client holds, by linkage: at each key, the succession records whose `new_public_key` is that key, each verified with `verifyKeySuccession` (a guardian-recovery link against a pinned guardian key), deduplicated by `(old, new)` only after verification. Timestamps are never read, so two rotations recorded out of order (#706) resolve. `records` is the union of every source the client has (its cache, the relay's `/succession`, local `motebit.md` files) in any order, duplicates allowed; unrelated or malformed records are ignored.

Ancestry problems are disclosed, never refused, because the roster's active set does not depend on them (spec §6 property 7): `ancestry` is `rooted` (the key binds to a sovereign-shaped id; the genesis ends the walk and its predecessors are listed, not walked), `unrooted`, `forked_below`, or `recovery_limited`. Sibling branches below the held key are listed in `branches`; a guardian-verified one sets `suppress_universal_claims`.

Exactly three refusals come from record content: `duplicate_key` (a key repeats, including a rotation back to an earlier key, #775; checked first), `fork_at_held`, and `held_key_superseded` (a verified record rotates the held key away). Each carries the verified records that caused it. A malformed call (not the records) returns `malformed_input`.
