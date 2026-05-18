---
"@motebit/relay": patch
---

Bridge Path-3 off-ramp wired in production. Two-commit arc that closed the gap between the off-ramp adapter existing in code and being reachable from a user surface.

**Commit 1 — env-var decoupling (`d5a93c68`).** `services/relay/src/server.ts` previously required BOTH `BRIDGE_API_KEY` AND `BRIDGE_CUSTOMER_ID` to construct any Bridge surface. That coupling was historical residue from when `BridgeSettlementRail.withdraw()` existed and the rail and the off-ramp adapter both depended on the operator's customer ID. Arc 1 Commit 2 of the off-ramp arc (`e18f1ba3`) deleted `withdraw()`; the two surfaces have since had distinct scopes:

- `BridgeOfframpAdapter` (Path-3, user-initiated) — user is the KYC'd customer (per-request `bridge_customer_id`). Needs only `apiKey`.
- `BridgeSettlementRail` (treasury) — registered for the future `convertOwnAccount` method that consumes the operator customer ID.

`server.ts` now gates only on `BRIDGE_API_KEY`; `index.ts` additionally gates the rail registration block on `bridgeConfig?.customerId`. The `customerId` field on `SyncRelayConfig.bridge` is now optional. Type narrowing on `BridgeSettlementRail`'s `customerId` (required by the rail config) is done via a local `operatorCustomerId` const inside the new `if (bridgeConfig?.customerId)` guard.

**Commit 2 — auth allowlist sibling fix (`3eb62781`).** The catch-all `/api/v1/*` `bearerAuth` middleware (`middleware.ts:455`) allowlists every public route by design — `agents/*`, `onramp/`, `stripe/`, `bridge/` (webhooks), `skills/` (signed envelopes), etc. The off-ramp session route (`offramp.ts:233` — `POST /api/v1/offramp/session`) was added without being added to this allowlist, so it returned 401 in production regardless of intent. Sibling-boundary fix: allowlist `/api/v1/offramp/` mirroring the symmetric `/api/v1/onramp/` entry. Per the Path-3 doctrine, the off-ramp session is user-initiated and the user is Bridge's customer, not motebit's; a relay-issued master bearer token doesn't model the trust relationship.

**Production state after deploy.** `motebit-sync` deployed both commits 2026-05-18. `BRIDGE_API_KEY` activated from staged. `POST /api/v1/offramp/session` with empty body now returns 400 `motebit_id is required` (route reachable, adapter non-null, body validation working). Rails manifest reads `["stripe", "x402"]` — `bridge` correctly absent since `BRIDGE_CUSTOMER_ID` isn't set yet. Subsequently `BRIDGE_CUSTOMER_ID=63e8e6ba-2a26-4a5d-a5a1-020393638002` (the operator customer record on file since 2026-05-05) was added and the rail joined the manifest at `["stripe", "x402", "bridge"]`. The rail's `isAvailable()` health check verified against Bridge's `/transfers?limit=1` returns 200 OK.

**What is NOT enabled by this arc.** No user-fund transmission via the relay (still structurally impossible — `BridgeSettlementRail.withdraw()` does not exist on the class). No fiat-funded virtual accounts at scale (still pending counsel per the `bridge_product_compliance_counsel_pending` memory). No `convertOwnAccount` treasury method (still unbuilt — registering the rail today gives a real `isAvailable()` + no-op `attachProof()` surface, nothing more).

Doctrine: `docs/doctrine/off-ramp-as-user-action.md`. Composes with the prior off-ramp arc's six-shape Layer-1 enforcement library (`architecture_disjointness_by_construction` memory).
