---
"@motebit/relay": patch
---

A federation peer can no longer change the key or the revocation state of an identity this relay is the home of.

`processIncomingRevocations` verified a peer's signature and then applied `agent_revoked` and `key_rotated` to `agent_registry` for whatever `motebit_id` the event named. The signature was never a trust boundary there: peering is not an authorization — `/federation/v1/peer/propose` followed by `/federation/v1/peer/confirm` are two unauthenticated calls that admit a peer on nothing but a signature over a nonce it was just handed, and `autoAcceptPeers` is not consulted by either. So the peer and the author of the events are the same party, and any caller who could reach the relay could produce a feed that verified.

The invariant now stated at that door: **a peer signature establishes authorship of a statement, never authority over the identity it names.** Every row in `agent_registry` was admitted by a door that proved possession of that identity's own key, so this door writes nothing there (`services/relay/CLAUDE.md` rule 21, which required exactly this door to answer the rule or say what roots its authority instead — it did neither).

Refusing costs no working behaviour. `agent_registry` holds only identities registered here, and the outbound feed is only ever minted about this relay's own identities, so an inbound event could match a local row only by naming an identity that is not the sender's. Nothing emits that; migration departure deliberately does not. An event about an identity this relay does not hold is still processed, so an honest peer's feed is unchanged and its logs stay quiet.

`credential_revoked` is deliberately untouched: its table is federation-native by construction and the write denies a credential rather than moving identity authority. Its scope is still unbounded — any peer may name any credential id — and that stays with the federation wire work rather than being silently changed here. The unsigned `new_public_key` field is likewise still unsigned; the field binding is a wire change, and it is not what makes this safe.

A cross-authority attempt is now counted and logged (`federation.revocation.refused`) with the peer that sent it, rather than being absorbed silently.
