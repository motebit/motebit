---
"@motebit/relay": patch
---

`/revoke` answers from what it recorded, for every identity the relay authenticates (#787), and restore-listing reverses only the operator's own hold (#788).

- `POST /api/v1/agents/:motebitId/revoke` records the identity's own revocation in `relay_identity_revocations` (migration v45) for every identity the relay knows (a registry row, a device row, an `identities` row or a key holder), and answers 404 for an id it has never seen. Before, the revocation lived only as `agent_registry.revoked = 1`, so an identity registered only through register-self got a 200 `{revoked: true}` while its tokens kept verifying and its sockets stayed open.
- `isAgentRevoked` (every authenticated HTTP and WebSocket request) reads the record OR the registry mark; the identity's sockets close 4011 on the record, not on a marked registry row.
- The record is terminal. The master-token `/agents/register` and accept-migration refuse (403) a self-revoked identity, and `restore-listing` refuses (409) a self-revoked identity or one whose migration departure is still in effect.
- Transparency declaration and `PRIVACY.md` name the new retained table.
