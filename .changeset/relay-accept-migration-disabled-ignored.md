---
"@motebit/relay": patch
---

P0 containment: `POST /api/v1/agents/accept-migration` refuses every arrival with 503 ("Migration arrivals are temporarily disabled on this relay") before body parsing, any database read or write, and any outbound fetch. On main the route allowed identity takeover (a retired genesis key re-accepted after a rotation; a forged guardian named inside the presented identity file accepted as a recovery), reachable with an ordinary device token and an attacker-run source relay. The gate is a single constant, `MIGRATION_ARRIVALS_ENABLED` in `migration.ts`, to be flipped back only with the permanent fix. Other migration routes are unchanged.
