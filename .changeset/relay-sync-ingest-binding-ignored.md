---
"@motebit/relay": patch
---

Bind every door that writes an identity's rows to the identity the request proved (#846).

The relay now has one place where a request's principal is compared to the identity it writes: `identity-binding.ts`. The result of that comparison is a `BoundIdentity` type, and the per-identity write helpers require it, so a door that skips the binding does not compile. Doors closed:

- **Sync pushes.** The WebSocket `push`, `push_conversations` and `push_messages` frames, and `POST /sync/:motebitId/{push,conversations,messages,plans,plan-steps}`. Each entry was filed under its own `motebit_id`, so a device authenticated as A wrote into B's store. B's devices pulled those rows as their own, and A's other devices received them in the fan-out. The whole batch is now refused before any write, and the refusal is recorded (`sync:foreign_motebit_id`). The conversation, plan and plan-step upserts no longer rewrite or replace a row another identity owns.
- **Subscription cancel and resubscribe.** These had no authentication: `/api/v1/subscriptions/` is carved out of the master-token catch-all, so an unauthenticated POST cancelled any identity's Stripe subscription. They now take the identity's own `account:checkout` token (or the master token). The web, desktop and mobile billing panels mint that token.
- **Migration routes.** `migrate/cancel`, `migrate/depart`, `migration/attestation` and `migration/export` read a token's `mid` and never compared it to the path. Any identity's `admin:query` token cancelled B's migration, exported B's credentials, or departed B, which revoked B here and closed B's sockets.
- **Approvals.** `POST /api/v1/agents/:id/approvals` filed approval requests, with the caller's own quorum, under any identity.
- **Dispute resolution.** `POST /api/v1/disputes/:id/resolve` took the operator's verdict (resolution, fund action, split ratio) from any caller. It is now master-token only.
- **Proposal step results.** A participant could overwrite another participant's step result. That is now refused with 409 and recorded.
- **Subscription status.** `GET /api/v1/subscriptions/:id/status` no longer creates an account row for whatever id it is asked about.

Every refusal is recorded under the presenter (rule 6). `check-identity-authority-writers` now covers INSERT, INSERT OR REPLACE / REPLACE, UPDATE and DELETE against every table with an identity column, derived from the schema. It refuses any UPDATE that re-files a row under another identity, and registers every binding mint, every branded helper and every event-store append.

Residual, not fixed: every client-chosen primary key can be pre-claimed by another identity. That covers `event_id`, `message_id`, `conversation_id`, `plan_id`, `step_id`, `approval_id`, `dispute_id`, `proposal_id` and a proposal `step_id`. If A writes the id first, B's later write of the same id is ignored (for the owner-scoped upserts) or refused with 409, and B's row never lands. That takes knowing, or guessing, B's future id. Scoping those keys per identity is a schema change in `@motebit/persistence` and the relay migrations.
