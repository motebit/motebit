---
"@motebit/relay": patch
---

`/revoke` answers from what it recorded, for every identity the relay authenticates (#787), and restore-listing reverses only the operator's own hold (#788).

- `POST /api/v1/agents/:motebitId/revoke` records the identity's own revocation in `relay_identity_revocations` (migration v45) for every identity the relay knows (a registry row, a device row, an `identities` row or a key holder), and answers 404 for an id it has never seen. Before, the revocation lived only as `agent_registry.revoked = 1`, so an identity registered only through register-self got a 200 `{revoked: true}` while its tokens kept verifying and its sockets stayed open.
- `isAgentRevoked` (every authenticated HTTP and WebSocket request) reads the record OR the registry mark; the identity's sockets close 4011 on the record, not on a marked registry row.
- Terminality follows authority the relay can verify (#794). The record names the key the revoking token verified under (or `operator`) and whether that revoker was authoritative: the operator, or the identity's proven key (the holder, else a key the id sovereign-binds to, else the registry key). An authoritative record is terminal: the master-token `/agents/register` and accept-migration refuse it (403), and `restore-listing` refuses it (409). A record made under an unproven, first-come device key (register-self for an id with no key on file) takes effect at once but is liftable. A verified migration arrival or the operator's `restore-listing` lifts it, so a stranger who squats an id can no longer end its owner forever. `/agents/register` refuses such a record (409) rather than lifting it.
- `restore-listing` also refuses (409) an identity whose migration departure is still in effect (#788).
- Transparency declaration and `PRIVACY.md` name the new retained table.
