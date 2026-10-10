---
"@motebit/relay": minor
---

relay-federation@1.5 (`spec/relay-federation-v1.md`; docs/design/identity-authority-writers.md Inc 1b, decision D4). **Deploy both relays of a federated pair together** — there is no dual-stack window.

- `POST /federation/v1/peer/heartbeat` and `POST /federation/v1/peer/remove` take a v2 signed message (§3.5, `signFederationMessage` / `verifyFederationMessage` in `@motebit/crypto` — sibling changeset `crypto-federation-message-v2.md`): kind, sender, the ONE recipient, timestamp and single-use nonce under the signature, body bound by digest. The nonce is recorded in `relay_federation_nonces` in the same transaction as the write it authorizes. The v1 forms (`{relay_id}|{timestamp}|{suite}`; a signature over the bare `relay_id`) are refused with 400 by name and change nothing — a replayed v1 heartbeat had moved a suspended peer to active and spent the peer's rate limit. The per-peer limit now counts only requests whose v2 signature verified.
- The heartbeat answer is a signed `heartbeat-ack` committing to the request's nonce, and the sender counts a heartbeat delivered only when the ack verifies under the peer's stored key (the v1 response was never verified).
- Self-propose (`peer/propose` naming the receiving relay's own id) is refused with 400: its answer was this relay's signature over the step-3 confirm bytes for a caller-chosen nonce. The confirm is minted by the operator on the new master-token `POST /api/v1/admin/federation/peer-confirm-signature`.
- `GET /api/v1/admin/federation/peer-removal-signature` now requires `?recipient=<relay_motebit_id>` and returns `{ relay_id, message }` (a v2 `peer-remove` for that one peer) instead of a bare signature.
