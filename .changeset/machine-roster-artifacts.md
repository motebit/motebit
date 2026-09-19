---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

The machine roster's two artifacts and the reduction over them: `HostEnrollment`, `HostRetirement`, `verifyHostRoster`.

"Every machine" is a statement about a set, and until now nothing owned the set — a relay inferred a motebit's machines from whichever sockets were live, so an offline machine was simply not a machine, and two attempts to make a verb reach every machine (#681, #687) were withdrawn for reporting against a set they had guessed. Membership is now something the sovereign signs and a relay only transports. Doctrine: `docs/doctrine/machine-roster.md`. Spec: `spec/machine-roster-v1.md` (`motebit/machine-roster@1.0`, the thirty-fifth).

`@motebit/protocol`: the two wire types, `HOST_ROSTER_SPEC_ID`, the domain tags `HOST_ENROLLMENT_TYPE` / `HOST_RETIREMENT_TYPE`, and the shape guards `isHostEnrollment` / `isHostRetirement`.

`@motebit/crypto`: `signHostEnrollment` / `verifyHostEnrollment`, `signHostRetirement` / `verifyHostRetirement`, `hostEnrollmentId` / `hostRetirementId`, `verifyHostRoster`, `MAX_SIGNATURE_COPIES_TRIED`. Still verifies standalone: the import from `@motebit/protocol` is type-only and the shape checks are restated locally, pinned to protocol's by a parity table.

**The law**

- **A set, not a chain.** Every machine of a motebit holds the same key and nothing coordinates them, so concurrent writers are the normal case. A 2P-set per entry, an observed-remove set per machine, merged by union.
- **An entry's id is the SHA-256 of its signed body — never the whole artifact.** A signature's spelling is the one part of an artifact nothing signs. The first draft hashed it, and review showed with a probe that anyone holding a copy, with no key, could re-spell a _retired_ enrolment into a new id that still verified.
- **The unit is the machine, not the entry.** A machine is `active` while any enrolment at its highest epoch stands, and the verdict lists exactly those, so a surface can retire all of them.
- **A signed domain tag, and a frozen body.** Without `type`, this and a device self-registration are one suite over the same fields but one name. The body is frozen for major 1 — an id is a hash of it and validators are strict, so an added field would silently drop a producer's machines from every existing consumer's roster. Evolution is by new artifact types that reference an enrolment by id.
- **As strict as the wire schema, even for authentic bytes** — exact keys, the literal suite and tag, lowercase hex, integer unix ms, 86 characters of unpadded base64url.

**Rotation — the part that failed review twice, and why it is different now**

The first draft took two _unordered_ sets of keys, "trusted" and "superseded". Round one: rotating un-retired everything. Round two: a _second_ rotation un-retired a machine. Both were patched as special cases, and the second patch is what made it obvious the model was wrong: a key history is an **ordered chain**, and a verdict that depends on where "today" cuts it is not a verdict about the machine. The reduction now takes `keyChain`, oldest → newest, and two rules replace the special cases:

- **Rule A — authority flows forward only.** A retirement ends an enrolment iff it was signed at the same epoch or a later one. A stolen old key can never strike a current machine, _and_ a retirement signed before a rotation keeps ending what it ended.
- **Rule B — a machine's status is a function of its highest-epoch enrolments only.** So the verdict is monotone under rotation: appending a key can turn `active` into `superseded`, and nothing else.

That design was reviewed adversarially _before_ it was coded, which the first draft's was not. The review found the two rules sound and seven problems around them, all taken: an empty or repeated-key chain now yields **no roster** rather than an empty one ("a halt reached every machine" over zero machines is vacuously true); the verdict carries the **chain head** it was computed under, because a consumer with a stale chain computes a confident wrong roster and nothing can make that fail-safe, only attributable; and each machine carries `authenticated` — **only a status at the current epoch is**. Below it, a holder of an old key can flip `superseded` ↔ `retired` and mint ghost lines, because there is no trusted clock; what it can never do is touch an `active` line, and quantified statements run over those. The spec says so rather than promising a durability it does not have.

**How it is tested.** The first draft passed sixteen example tests while wrong in seven ways, so the universal claims are now ten **property tests** over an authentically signed pool spanning a four-key chain and a stranger — partition, whole-result order/multiplicity invariance, monotonicity under rotation, no backward authority, re-spelling invariance, monotonicity under union, suffix invariance of the active set, relative-order-only, and unusable-chain refusal. Both of the first draft's real rotation bugs, re-introduced, turn them red. Every defect either review found is also a named scenario. Thirty-four rules were tamper-checked; four tests did not bite at first and were fixed — three because they _edited_ a signed artifact, so the signature broke before the rule under test was reached.
