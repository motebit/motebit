---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Narrow the `suite` field of the last 3 straggler signed-artifact types from the
wide `SuiteId` union to the single `z.literal` each artifact's wire schema (and
its committed JSON Schema `$id`) already pins — bringing them in line with the
~20 other signed artifacts that already pin a literal:

- `@motebit/protocol`: `SignedTransparencyDeclaration.suite` and
  `RetentionManifest.suite` → `motebit-jcs-ed25519-hex-v1`;
  `HorizonWitnessRequestBody.suite`, the four DeletionCertificate signature
  envelopes (`SubjectSignature` / `OperatorSignature` / `DelegateSignature` /
  `GuardianSignature`), the `append_only_horizon` cert arm, and
  `SkillManifestMotebit.signature.suite` → `motebit-jcs-ed25519-b64-v1`. The
  `TRANSPARENCY_SUITE` const is correspondingly narrowed (`as const`).
- `@motebit/crypto`: `DELETION_CERTIFICATE_SUITE` narrowed (`as const`) to match.

Each artifact emits exactly one suite (per its spec signing recipe); cryptosuite
agility happens through a new artifact version with a new schema pin, never by
widening to `SuiteId`. A single literal is assignable into any `SuiteId`-typed
position, so this is breaking only for an external consumer that assigned a
non-literal `SuiteId` value to one of these specific fields — which no producer
does (the suite is per-artifact). Aligns the TS type with the published JSON
Schema. No runtime or wire change.
