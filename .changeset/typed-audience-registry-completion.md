---
"@motebit/protocol": minor
---

Complete the `TokenAudience` registry against relay enforcement reality: register five audiences the relay already verifies but the closed registry omitted — `task:query`, `task:result` (task poll/result routes), `market:listing`, `credentials`, `credentials:present` (agent-registry dynamic per-path middleware). New named constants `TASK_QUERY_AUDIENCE`, `TASK_RESULT_AUDIENCE`, `MARKET_LISTING_AUDIENCE`, `CREDENTIALS_AUDIENCE`, `CREDENTIALS_PRESENT_AUDIENCE`. Additive only — no existing value changes meaning. Discovered by typing the relay's `verifySignedTokenForDevice`/`dualAuth` `expectedAudience` parameter as `TokenAudience` (structural enforcement where the line-based `check-audience-canonical` gate is blind: positional args and variable-assigned audiences).
