---
"@motebit/relay": minor
---

The relay's half of the machine roster: it stores and observes, and it never reduces. Part B of `docs/doctrine/machine-roster.md`, built as `docs/proposals/machine-roster-relay-v1.md` v3.1 describes; the law landed in #697.

**Membership.** `POST` / `GET /api/v1/agents/:motebitId/roster` (`spec/machine-roster-v1.md` §11). Entries are held verbatim, keyed by the law's id, as an idempotent union with no freshness window. Ingest checks integrity only (strict guard and wire schema, the path motebit, and the signature under the key the entry names, verified before it is held), with no `untrusted_key` check: the relay has no trusted key chain for most identities and must hold entries under rotated-away keys. Caps are partitioned by signer key. The caller's own key has its own bucket (512 enrolments, 2048 retirements) that only its holders can fill, and every other key shares one foreign bucket (256). A thief of an old key can fill only that key's bucket, and an active line is never lost that way. A partial presentation is a 422 and a malformed field is a 400.

**Liveness.** There is one overwritten `last_seen_at` per `(motebit_id, device_id, bound_under)`. `bound_under` is the key the socket's token verified under. It is captured at verification through a new additive `onVerified` callback on `verifySignedTokenForDevice`, and never re-read, because a rotation rewrites device rows and closes no sockets. A value is persisted only for verified sockets that announce `unattended_runtime`, and it is written at bind, at close, on a five-minute flush and at shutdown. `sockets_open` is computed at GET and never persisted. A 90-day TTL applies, which skips rows with a live bound socket. GET serves `observed_by`, `retention_days` and `observing_since` beside the signed set, and carries no count or quantifier over machines.

**First-person, with the caller present and equal.** Both routes require a device token of that motebit (audience `device:auth`). The operator master token and service-mode tokens get 403. No relay code calls `verifyHostRoster`, and a test holds it to that.

**Declared.** `DECLARATION_CONTENT.retention.machine_roster` states that entries are held indefinitely with no removal path, and that liveness is kept for hosts only under a 90-day TTL. `PRIVACY.md` is re-rendered, and the retention manifest carries a `different_mechanism` honest gap. Migration v43.
