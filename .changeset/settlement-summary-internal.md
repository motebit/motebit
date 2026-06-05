---
"@motebit/relay": minor
"@motebit/panels": minor
---

Settlement-summary export — the money side of the first-person trust graph (ignored-package half; the published `@motebit/protocol` + `@motebit/state-export-client` half is in the sibling changeset). Doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md` §6.

- `@motebit/relay`: `GET /api/v1/agents/:motebitId/settlements` (`state-export.ts`) — signed `settlement-summary` export, aggregated per counterparty from `relay_settlements` (earned-from / paid-to / net / fee / p2p-count, micro-units). `account:balance` audience + own-id check (first-person by construction); unattributed bucket for null-`delegator_id` rows; self-settlements and failed-p2p-verification rows excluded. Relay-custody settlements now also record the payer's `delegator_id` (previously P2P-only), so per-peer attribution covers both modes going forward (inert for the p2p-verifier, which filters `settlement_mode='p2p'`).
- `@motebit/panels`: `AgentEconomicSummary` view-model + `economicForPeer` / `formatPeerEconomics` projection helpers + `AgentsFetchAdapter.listSettlementSummary` + `AgentsController.refreshEconomic`. Held separately from `AgentRecord` (never denormalized); fail-soft (a settlement-export failure leaves the trust row rendering). Wired on web, desktop, and mobile — the money line renders under each Known peer on all three surfaces.
