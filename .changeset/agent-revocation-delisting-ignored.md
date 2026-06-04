---
"@motebit/wire-schemas": minor
"@motebit/relay": minor
---

Agent-revocation producer + wire schemas (ignored-package half of the `motebit/agent-revocation@1.0` arc; the published `@motebit/protocol` + `@motebit/state-export-client` half is in the sibling changeset).

- `@motebit/relay`: `POST /api/v1/agents/:motebitId/revoke-listing` + `/restore-listing` (operator/master-token-only) flip `agent_registry.revoked` and append a signed `AgentRevocationRecord`; the public `GET /api/v1/agents/revocations` feed serves the signed append-only history (`relay_agent_revocations`, migration v31). De-list, not de-identify — distinct route from the existing identity `/revoke`. Transparency declaration + `PRIVACY.md` updated to name the new retained table.
- `@motebit/wire-schemas`: `AgentRevocationRecordSchema` / `AgentRevocationFeedSchema` (parity-locked) + committed JSON Schemas under `spec/schemas/`.
