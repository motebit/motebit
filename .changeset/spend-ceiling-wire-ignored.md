---
"@motebit/wire-schemas": minor
"@motebit/policy": minor
---

standing-delegation@1.2 `spend_ceiling` siblings: `@motebit/wire-schemas` gains `SpendCeilingV1Schema` (+ optional `spend_ceiling` on `StandingDelegationSchema`, parity block, `spend-ceiling-v1.json` emitter); `@motebit/policy` gains `spendCeilingFromGrant`, the only sanctioned wire→enforcer mapping (spec §3.3 rule 2: the enforcer's ceiling MUST come from a VERIFIED grant, never local config).
