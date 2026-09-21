---
"@motebit/relay": patch
---

A federation peer can no longer write identity state — its key, its revocation flag, or a credential's revocation — for an identity this relay serves.

`processIncomingRevocations` verified a peer's signature and then applied every event branch. The signature was never a boundary there: peering is not an authorization — `/federation/v1/peer/propose` followed by `/federation/v1/peer/confirm` are two unauthenticated calls that admit a peer on a signature over a nonce it was just handed, signed by the key it supplied, and `autoAcceptPeers` is consulted by neither. The peer and the author of the events are the same party, so any caller able to reach the relay could produce a feed that verified.

The invariant now stated at that door: **a peer signature establishes authorship of a statement, never authority over what the statement names.** Each door that writes `agent_registry` has a named authorized principal — the identity itself for registration, bootstrap and `/rotate-key`; the identity's designated guardian for recovery; the operator, under a signed append-only `relay_agent_revocations` record, for moderation; a verified migration token plus a credential bundle for a migration accept. The invariant is authorization, not current-key possession, and a peer is none of those principals.

`credential_revoked` is refused on the same ground. This relay already states and enforces an authority model for that act — `POST /api/v1/agents/:motebitId/revoke-credential` answers 403 "Only the credential subject or issuer can revoke" — and a peer is neither, `credential_id` is not covered by the signature, and the table has no foreign key, so an unrefused event could deny an identifier before it was ever issued. The consumers that would have honoured it are the hardware-attestation projection in `agents.ts` and the credential-submission check in `credentials.ts`.

The cost, stated plainly: a credential legitimately revoked on a peer no longer becomes revoked here, so this direction now fails OPEN on honest revocations in exchange for closing an unauthorized write. With all three branches grounded, the inbound feed can act with authority on nothing the current wire format carries. Restoring any of it requires the naming identity's OWN signed artifact carried in the event and verified against its key — the same shape as the still-unsigned `new_public_key` field, and one federation wire increment.

The scoping precedent was already in the same file: `/federation/v1/horizon/witness` refuses a request whose `cert_body.subject` is not the soliciting `issuer_id`, and `/horizon/dispute` refuses a cert this relay did not issue. A peer may speak about itself. This door had drifted from a rule its siblings kept.

A refused attempt is counted and logged with the peer that sent it. Three existing tests asserted the removed behaviour and are inverted rather than deleted.
