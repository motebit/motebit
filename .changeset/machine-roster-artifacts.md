---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

The machine roster's two artifacts: `HostEnrollment` and `HostRetirement`.

"Every machine" is a statement about a set, and until now nothing owned the set — a relay inferred a motebit's machines from whichever sockets were live, so an offline machine was simply not a machine, and two attempts to make a verb reach every machine (#681, #687) were withdrawn for reporting against a set they had guessed. Membership is now something the sovereign signs and a relay only transports. Doctrine: `docs/doctrine/machine-roster.md`.

`@motebit/protocol`: the two wire types, `HOST_ROSTER_SPEC_ID`, and the shape guards `isHostEnrollment` / `isHostRetirement`. Each body carries only what stays true for the life of a membership — no capability list (it changes; it is announced on the socket), no display name (it would be served verbatim forever). Both name the `public_key` that signed them, so a verifier knows _which_ key after a rotation.

`@motebit/crypto`: `signHostEnrollment` / `verifyHostEnrollment`, `signHostRetirement` / `verifyHostRetirement`, `hostEnrollmentId` / `hostRetirementId`, and `verifyHostRoster`.

- **A set, not a chain.** Every machine of a motebit holds the same key and nothing coordinates them, so concurrent writers are the normal case. An entry's id is the SHA-256 of its canonical bytes; the roster is every enrolment no retirement names; merging two copies is set union. `verifyHostRoster` gives the same answer for any order and any duplication of its inputs.
- **Remove wins, and is terminal.** A retirement names an enrolment by hash, so a replayed copy stays retired — and a retirement that arrives before its enrolment is kept as a tombstone rather than discarded.
- **One id for the same bytes.** Ed25519 is deterministic, so a daemon re-presenting its enrolment on every start adds nothing.
- **Verified against keys the consumer trusts, never the key an entry brings.** `verifyHostEnrollment` is integrity only; an entry that is perfectly self-consistent under a stranger's key is exactly what a hostile relay would serve. `verifyHostRoster` takes `trustedKeys` from the caller, and with none, trusts nothing. Everything refused is reported with a reason, never silently dropped.
- **Rotation is a membership epoch.** Keys passed as `supersededKeys` can neither add nor remove a machine — a stolen laptop must not be able to strike the sovereign's other machines out of "every machine" before a halt — but an old-key line with no current-key line for the same machine is reported as `superseded`: that is precisely the machine that was cut off, and rotating a key does not stop it running.

The open spec is `spec/machine-roster-v1.md` (`motebit/machine-roster@1.0`, the thirty-fifth): the two wire formats, the entry id, and the roster reduction as foundation law — including what it is _not_ (an admission gate, a store-authored fact, a device list, a lease). Its routes land with the relay increment, so the spec never promises an endpoint nothing serves.

`@motebit/crypto` still verifies standalone: the import from `@motebit/protocol` is type-only and the shape checks are restated locally.

Each of the nine rules in the reducer was tamper-checked — disabled one at a time and a test confirmed red. One did not bite at first: the unknown-suite test edited `suite` _after_ signing, so the signature broke before the suite check was ever reached. It now signs validly over an unknown suite, which is the case cryptosuite agility is actually about.
