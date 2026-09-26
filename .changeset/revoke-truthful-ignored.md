---
"@motebit/relay": patch
---

`/revoke` answers from what it recorded, for every identity the relay authenticates (#787).

- `POST /api/v1/agents/:motebitId/revoke` records the revocation in `relay_identity_revocations` (migration v45: `motebit_id`, `revoked_at`, `revoked_under`) for every identity the relay knows (a registry row, a device row, an `identities` row or a key holder), and answers 404 for an id it has never seen. Before this, the revocation lived only as `agent_registry.revoked = 1`, so an identity registered only through register-self got a 200 `{revoked: true}` while its tokens kept verifying and its sockets stayed open. Refusals are recorded as auth events: 404 for an unknown id, 403 for another identity's token.
- `isAgentRevoked` runs on every authenticated HTTP and WebSocket request, and reads the record OR the registry mark. The identity's sockets close with code 4011 when the record is written, not only when a registry row is marked.
- No record is terminal. Two builds made some records terminal and were withdrawn (#794, #796): terminality derived from the revoking key let a stranger lock the owner out for good. There were three ways to do that: a first-come register-self squat, a squat that also wrote the registry key, or a thief holding a retired genesis key. A verified migration arrival lifts the record, and so does the operator's `restore-listing` (with or without a registry row). The master-token `/agents/register` refuses a revoked identity with 409 and never lifts the record.
- `restore-listing` refuses (409) while a migration departure is still in effect. That closes #788's departure half. #788's other half stays open: an operator reinstate can still reverse an identity's own `/revoke`.
- The transparency declaration and `PRIVACY.md` name the new retained table.
