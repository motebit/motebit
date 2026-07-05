---
"@motebit/protocol": minor
---

`SpendCeilingV1` + `StandingDelegation.spend_ceiling` (standing-delegation@1.2) — the delegator's signed autonomous-spend ceiling on the wire, closing the money-execution checkpoint's D3 axis (`docs/proposals/standing-delegation-execution-checkpoint.md`). The ceiling rides in the grant's signed body (spec §3.3; committed schemas `spend-ceiling-v1.json` + regenerated `standing-delegation-v1.json`), making the HOW-MUCH a cryptographic commitment rather than local config. Absence is fail-closed by construction: a @1.0/@1.1 grant verifies unchanged and authorizes NO autonomous money (`ceiling_absent`). Limits are integer micro-units, USD-denominated (pinned by spec prose; a future asset model is a new `schema` literal — an agility-axis append). No crypto changes — JCS signing already covers the new field, proven by tamper/strip/graft tests.
