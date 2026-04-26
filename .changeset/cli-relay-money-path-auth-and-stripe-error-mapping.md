---
"motebit": patch
---

Fix two production bugs surfaced by a live golden-path run.

## 1. CLI signed money-path requests with the wrong audience

`apps/cli/src/subcommands/market.ts` — `handleBalance`, `handleFund`, `handleWithdraw` all called `getRelayAuthHeaders(config)` which defaults the signed-token audience to `"admin:query"`. The relay's `dualAuth` middleware (`services/api/src/middleware.ts:631-645`) requires per-route audiences:

```text
GET  /api/v1/agents/:id/balance     → account:balance
POST /api/v1/agents/:id/checkout    → account:checkout
POST /api/v1/agents/:id/withdraw    → account:withdraw
```

Result: **every `motebit balance / fund / withdraw` since 1.0.0 has failed with `401 AUTH_INVALID_TOKEN` against any relay running the dual-auth middleware**. The bug was invisible to `motebit doctor` (which doesn't call these routes) and to the published-package CI (which has no live-relay smoke). Caught only when running the full economic flow against a real relay.

Fix: each call site pins its own aud. `handleFund` mints two tokens (one for `/checkout`, one for the balance-poll loop on `/balance`) since a signed token can only carry one aud.

## 2. Relay `/checkout` returned opaque 500 on Stripe errors

`services/api/src/budget.ts:662` had zero error handling around the Stripe SDK call. Any thrown `StripeError` became `{"error":"Internal server error","status":500}` from Hono's default uncaught-exception handler — the actual Stripe message ("Your account cannot currently make live charges", "Your card was declined", etc.) only existed in fly.io logs. Operators of every motebit relay had to dig logs to debug their own users' fund flows.

Fix: new `mapStripeError(c, ...)` helper (in `budget.ts`, top of file) catches Stripe SDK exceptions and returns a structured 502:

```json
{
  "error": "STRIPE_ACCOUNT_NOT_ACTIVATED",
  "message": "Your account cannot currently make live charges.",
  "stripe_type": "StripeInvalidRequestError",
  "stripe_code": null,
  "status": 502
}
```

The motebit-shaped `error` code is mapped from common Stripe error patterns:

```text
"cannot currently make live charges" → STRIPE_ACCOUNT_NOT_ACTIVATED
StripeAuthenticationError             → STRIPE_API_KEY_INVALID
StripeRateLimitError                  → STRIPE_RATE_LIMITED
StripeConnectionError                 → STRIPE_CONNECTION_FAILED
(everything else)                     → STRIPE_<TYPE>
```

Per `services/api/CLAUDE.md` rule 14 — external medium plumbing speaks motebit vocabulary. Provider-shaped errors (Stripe's deep nested raw object) collapse here into a closed motebit shape. Server-side logs still capture the full Stripe response (request ID, headers) for operator debugging; the client never sees raw Stripe internals.

The CLI side (`market.ts handleFund`) parses the new structured shape and prints both the motebit code and Stripe's human message. For `STRIPE_ACCOUNT_NOT_ACTIVATED` specifically, it adds a one-line pointer at the Stripe onboarding URL — the most common path to recovery.

## What this leaves on the table

A drift defense that catches the audience-mismatch class of bug at lint time would be valuable — `check-aud-binding` could grep middleware aud strings, grep CLI aud strings, and require any motebit-signed POST to a route in the middleware list to use the matching aud. Filed as a follow-up; not in this commit because it requires walking Hono middleware definitions, which is non-trivial.
