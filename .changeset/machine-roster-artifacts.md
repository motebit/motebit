---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

The machine roster's two artifacts: `HostEnrollment` and `HostRetirement`.

"Every machine" is a statement about a set, and until now nothing owned the set — a relay inferred a motebit's machines from whichever sockets were live, so an offline machine was simply not a machine, and two attempts to make a verb reach every machine (#681, #687) were withdrawn for reporting against a set they had guessed. Membership is now something the sovereign signs and a relay only transports. Doctrine: `docs/doctrine/machine-roster.md`.

`@motebit/protocol`: the two wire types, `HOST_ROSTER_SPEC_ID`, and the shape guards `isHostEnrollment` / `isHostRetirement`. Each body carries only what stays true for the life of a membership — no capability list (it changes; it is announced on the socket), no display name (it would be served verbatim forever). Both name the `public_key` that signed them, so a verifier knows _which_ key after a rotation.

`@motebit/crypto`: `signHostEnrollment` / `verifyHostEnrollment`, `signHostRetirement` / `verifyHostRetirement`, `hostEnrollmentId` / `hostRetirementId`, and `verifyHostRoster`.

- **A set, not a chain.** Every machine of a motebit holds the same key and nothing coordinates them, so concurrent writers are the normal case. The roster is every _machine_ with an enrolment no retirement ends; merging two copies is set union. The **whole** verdict — including what was refused — is independent of input order and multiplicity, and a property test holds it to that.
- **An entry's id is the SHA-256 of its signed body — never the whole artifact.** A signature's spelling is the one part of an artifact nothing signs, and base64 has many spellings of the same bytes. The first draft hashed it, and review showed (with a probe) that anyone holding a copy, with no key, could re-spell a _retired_ enrolment into a new id that still verified: the machine was back in "every machine". The signed body admits no such freedom, and the id no longer depends on the signer being deterministic.
- **The unit is the machine, not the entry.** A daemon that lost its cached artifact mints a second enrolment for the same `device_id`; counting entries counted that machine twice in every "N machines". A machine is `active` while any current-key enrolment stands, and the verdict lists exactly those, so a surface can retire all of them.
- **Remove wins, and is terminal.** A replayed copy stays retired, however its signature is spelled; a retirement that arrives before its enrolment is kept as a tombstone.
- **Verified against keys the consumer trusts, never the key an entry brings.** `verifyHostEnrollment` is integrity only; an entry that is perfectly self-consistent under a stranger's key is exactly what a hostile relay would serve. With no trusted key, nothing is trusted. Every refusal is reported once, with the entry id and the key it claimed.
- **Rotation is a membership epoch, and a superseded key's authority is scoped to its own.** It cannot add a machine that counts, and it cannot end a current-key enrolment — a stolen laptop must not strike the sovereign's other machines out of "every machine" before a halt. But a retirement it signed still ends an _old-epoch_ enrolment: the first draft honoured retirements only under a current key, so rotating silently un-retired every machine retired before it. Every machine lands in exactly one of `active` / `retired` / `superseded`; a machine retired under the new key no longer resurfaces as "cut off" through its old line.
- **As strict as the wire schema, even for authentic bytes.** Unknown fields, float or negative times, and any signature that is not unpadded base64url are refused by the guards in both packages. Every field but `signature` is signed, so an extra one _would_ verify — and a verifier laxer than the schema admits a machine a schema-validating store refuses.

`@motebit/crypto` still verifies standalone: the import from `@motebit/protocol` is type-only and the shape checks are restated locally.

Review found seven defects in the first draft of the reduction, all fixed here in one round; each is now a named test, and nineteen rules were tamper-checked — disabled one at a time, a test confirmed red. Two tests did not bite at first, for the same reason: they edited a signed artifact, so the signature broke before the rule under test was ever reached (the unknown-suite test, and the table pinning `@motebit/protocol`'s guards to `@motebit/crypto`'s restated copies). Both now sign authentically over the body they carry. For the retirement guard, that parity table is the only test that catches the two copies drifting.
