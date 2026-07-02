---
"@motebit/protocol": minor
---

`AccountBalanceResult` + `AccountBalanceTransaction` — the wire format of the relay's virtual-account balance read (`GET /api/v1/agents/{motebitId}/balance`), specified as market-v1 §2.6/§2.7 with a committed JSON Schema (`spec/schemas/account-balance-result-v1.json`). This is the market-v1 §2 account state projected across the HTTP boundary: all monetary fields are decimal USD (the §2.3 conversion happens only at the producer), all fields required, `transactions[].type` a free string for additive evolution of the §2.2 vocabulary (whose table now includes the previously code-only `waiver` type). The reference relay's producer binds via `satisfies`; `@motebit/relay-client` validates responses against the schema; panels' previously drifted local copy is now an alias.
