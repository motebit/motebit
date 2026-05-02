---
"@motebit/relay": minor
---

`GET /api/v1/admin/federation/peer-removal-signature` — admin-authed signing oracle that returns this relay's Ed25519 signature over its own `relay_motebit_id` raw UTF-8 bytes, the artifact `POST /federation/v1/peer/remove` requires.

Consumed by the new `motebit federation peer-remove <peer-url>` CLI primitive (sibling changeset `cli-federation-peer-remove.md`); see that changeset for the operator-facing rationale and the architectural call NOT to ship this as a public `/peer/remove` self-mode.

Behind master-token admin auth (`services/relay/CLAUDE.md` rule 5); covered by drift gate `check-admin-route-auth` (#61). Wire-format `/federation/v1/peer/remove` itself is unchanged.
