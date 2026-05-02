---
"motebit": patch
---

`motebit smoke x402` principal-engineer review fix: the settlement-polling step at `assertSettlementLanded` was minting tokens with `aud: "admin:query"` (the bootstrap-time fallback) and re-using them for `GET /agent/:id/task/:taskId` polls. That endpoint requires `aud: "task:query"` (services/relay/src/tasks.ts:2147) — every poll would have 401-failed against a real relay and the smoke would have produced a misleading "settlement did not land within 60s" timeout instead of the audience-mismatch error.

Fixed by minting a fresh per-call-site token for each audience boundary instead of pre-minting and re-using a single bootstrap-time token. Removed the unused `signedToken` field from the internal `BootstrappedMotebit` shape, since per-audience minting is now uniform across listing/task-submit/task-result/task-query.

Also captures the last non-2xx HTTP body in the polling timeout error so future failures distinguish auth issues from settlement-pipeline stalls.

No surface-level CLI change; pure correctness fix on the wire-format contract with the relay.
