---
"@motebit/relay": patch
---

Land drift gate `check-admin-route-auth` (invariant #61) — every `/api/v1/admin/*` route registered in `services/relay/src/` MUST be covered by a matching `app.use("...", bearerAuth({ token: apiToken }))` registration in `middleware.ts`.

The 2026-04-28 post-mortem on commit `63fa2199` (which produced gate #60, response-shape inspection) surfaced a sibling shape on the same wave: `GET /api/v1/admin/transparency` had been registered as a route in `transparency.ts` since 2026-04-14 with a JSDoc claim that it was "audience-bound at the auth layer (admin:query)" — but no `app.use(...)` for that path existed in `middleware.ts`. The endpoint shipped wide open. Manual audit in commit `2560472b` added the missing `bearerAuth` registration; a parallel manual audit confirmed all 13 other `/api/v1/admin/*` routes had matching middleware coverage at that point. Manual audits expire; gates don't.

Gate walks every TS file in `services/relay/src/` (excluding `middleware.ts` itself, tests, generated) for `app.<method>("/api/v1/admin/...")` registrations. Walks `middleware.ts` for `app.use("/api/v1/admin/...", bearerAuth(...))` patterns. Matches: trailing-`*` patterns are prefix-match; route params (`:foo`) match any single segment on either side. Routes whose middleware uses a non-`bearerAuth` function (`dualAuth`, audience-bound checks) are NOT counted as covered — admin-surface convention is static master bearer, the gate enforces that convention.

Baseline at landing: 13 routes covered by 11 patterns, all clean. Effectiveness probe in `check-gates-effective.ts` plants a fixture admin route in `services/relay/src/` with no matching middleware; gate fires.

Cancels the scheduled remote agent `trig_019aErMHCDs5bvBAY3TrnEcY` (2026-05-12, "Land check-admin-route-auth drift gate") — the work it would have done is done. Inventory: 60 → 61 invariants, 51 → 52 hard CI gates.
