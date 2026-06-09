---
"@motebit/relay": minor
"@motebit/core-identity": minor
"@motebit/operator": patch
---

The durable intake ledger — Phase 0 of the sovereign funnel's counting foundation. motebit Inc now has a durable, monotonic acquisition count of self-certifying sovereign identities.

A freshly-minted motebit announces itself to the relay so the relay has a durable record of acquisition, independent of whether that motebit ever serves delegations.

- **`@motebit/core-identity`** gains `announceMotebit()` (browser-safe, best-effort, typed result). It discovers the target relay's `relay_id` from `/.well-known/motebit.json`, signs an announcement bound to it (`signMotebitAnnouncement` from `@motebit/crypto`, re-exported via `@motebit/encryption`), and POSTs it. Every failure is a typed result, never a throw — a first-launch motebit works fully locally whether or not the relay is reachable, and the caller retries on the next launch.
- **`@motebit/relay`** gains migration v32 (`relay_motebit_intake`, append-only, one row per `motebit_id`, never reaped) and `POST /api/v1/motebits/announce` (auth-less — the signature is the auth; `audience` must be this relay's id; the `motebit_id` must be the sovereign commitment to the signing key via `verifySovereignBinding`, so an id can't be forged or squatted; per-IP rate-limited). The health summary's acquisition metric is re-pointed off `agent_registry.registered_at` onto this ledger and gains `total_announced`: `agent_registry` records _serving_ agents and is garbage-collected 90 days after a motebit stops heartbeating, so a count there can drop and conflates "minted" with "serving." The intake count is durable and monotonic; it is not sybil-proof (free permissionless minting can inflate it), so read it as "self-certifying identities onboarded," not "distinct humans" — sybil-resistance lives in the first-person trust graph.
- **`@motebit/operator`** renders an Acquisition block on the Health panel — `total_announced` plus `new_24h` / `new_7d` / `new_30d` — alongside the serving-liveness block.

Counting foundation only; the web onboarding moment that drives announcements ships next.
