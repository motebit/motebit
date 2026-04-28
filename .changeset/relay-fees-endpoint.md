---
"@motebit/relay": minor
---

Add `GET /api/v1/admin/fees` — operator-console aggregation of the 5% platform fee collected on relay-mediated settlements. Returns total + by-rail (settlement_mode: relay vs p2p) + by-period (UTC daily buckets) + the configured `fee_rate`, all in micro-units. `window_days` query param (default 30, clamped to [1, 365]) controls the sample window.

Master-token gated via `bearerAuth({ token: apiToken })` (canonical `/api/v1/admin/*` pattern). Wired into the `expensiveLimiter` rate-limit tier alongside settlements/disputes/credential-anchoring.

Closes the only endpoint gap the operator console had — `apps/operator/src/components/FeesPanel.tsx` will render real data on next page load. The `fetchFees` helper retains its 404 fallback so the panel degrades cleanly if the endpoint is ever toggled off.
