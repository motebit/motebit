---
"@motebit/relay": patch
---

Close #853: the identity an auth check binds is the identity the handler acts on.

The `/sync/*` device auth verified its token against the RAW path segment while every sync handler read Hono's DECODED `:motebitId` param. An attacker bootstrapped an identity whose id was a percent-encoding of a victim's id (`%37f3…` for `7f3…`), minted its own `sync` token, and read and wrote the victim's events and conversations under `/sync/%37f3…/*`. Production held no non-canonical id, so the hole was never used.

Two layers, each tested with the other in place:

- **Canonical ids at every door that writes one.** `refuseInvalidIds` (`id-bounds.ts`) now also refuses a `motebit_id` or `device_id` outside `[0-9A-Za-z_-]` (`ID_NOT_CANONICAL`) at bootstrap, register-self (`reason: "id_not_canonical"`), `/agents/register` (recorded in `relay_auth_events`), `/device/register`, pairing approve, push-token and accept-migration. Such an id is its own URI encoding, so no two readers of a path can disagree about it. Every id a client mints is inside the set; a `did:key:` motebit_id is not admitted at these doors.
- **Guards that read an identity from the raw path refuse a segment that is not literal.** `pathIdentity` (`id-bounds.ts`): the `/sync/*` middleware refuses a `%` in the identity segment with 400 and records `path_id_not_literal` naming the presenter; the x402 pricing gate refuses one too, rather than pricing a different agent than the handler serves.

Found in the audit: `/agent/*/task` skipped authentication whenever the raw URL — query string included — contained `/result`, so `POST /agent/:id/task?x=/result` submitted a task with no credentials. The skip now matches only the routed `/agent/:id/task/:taskId/result` path.
