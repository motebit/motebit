---
"@motebit/relay": minor
---

Free "first taste" cloud-inference credit — the activation engine (off by default).

A brand-new motebit has no provider, so its first message hits a setup wall (pay / bring an API key / download a model) — where most new users bounce, and why the funnel counts ~nobody. This grants a small one-time free balance so a fresh motebit can just talk on motebit cloud, then meets the normal upgrade prompt when it runs out. It reuses the entire existing economic loop: the grant is a `deposit` with a distinctive `free-credit:<motebit_id>` reference, so the proxy-token → balance → debit → 402 → upgrade path already handles everything downstream (and activates the dormant free-tier scaffolding in `services/proxy`).

Granted at `POST /api/v1/agents/:motebitId/proxy-token` — the moment a motebit first reaches for cloud inference.

**Spend is OFF by default.** The code ships complete but grants nothing (and costs nothing) until the operator sets `MOTEBIT_FREE_CREDIT_USD` > 0. Three caps then bound exposure:

- **one-time per motebit** (idempotent on the `free-credit:<id>` ledger reference),
- **per-IP per day** (`MOTEBIT_FREE_CREDIT_IP_DAILY_CAP`, default 10) — minting a fresh motebit is free, so the per-motebit grant alone is sybil-drainable; this is the casual-abuse cap (migration v33 `relay_free_grants`),
- **global daily budget** (`MOTEBIT_FREE_CREDIT_DAILY_BUDGET_USD`, default 25) — the hard backstop on total give-away per day regardless of IP rotation.

This is the relay-side engine. The web ignition (attempting the free cloud on the user's first message, on intent — never phoning home on boot) ships next; the feature is user-visible only once both land and a budget is configured.
