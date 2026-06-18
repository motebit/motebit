---
"@motebit/protocol": minor
"@motebit/crypto": minor
"@motebit/verifier": minor
---

standing-delegation@1.1: generic `subject_binding` on `StandingDelegation`

A `StandingDelegation` can now carry an optional, generic `subject_binding`
(`SubjectBindingV1`) that digest-binds a detached, vertically-typed subject-scope
artifact. Because it rides in the signed body, the delegator's single signature
reaches the EXACT resolved subjects the authority covers — closing the gap where
an interpreter (not the delegator) chose the identities an agent acts on. The
detached artifact needs no second signature (collision resistance binds it to the
signed digest, the `SignedRequestEnvelope.payload_digest` pattern).

- `@motebit/protocol`: new `SubjectBindingV1` type + optional `subject_binding` on
  `StandingDelegation`. Additive — @1.0 grants verify unchanged.
- `@motebit/crypto`: `subjectBindingDigest(artifact)` (`hex(SHA-256(canonicalJson))`)
  and `verifySubjectBinding(binding, artifact)` (fail-closed: digest method,
  declared `artifact_schema`, digest match). Unsigned artifact ⇒ no signed-artifact
  verifier entry; authority is the grant's signature over the binding.
- `@motebit/verifier`: re-exports both helpers + the type.

`digest_method` is a HASH method (`jcs-sha256-hex`), deliberately NOT a signature
`suite`. Subject _completeness_ (`attempted == signed`) is a monitor receipt-profile
rule on top, never a property of this generic binding. Higher-assurance consumers
MUST fail closed when `subject_binding` is absent.
