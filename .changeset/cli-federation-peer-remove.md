---
"motebit": minor
"@motebit/relay": minor
---

`motebit federation peer-remove <peer-url>` — packaged un-peering primitive.

Sibling to `motebit federation peer <url>`. Closes the operator-onboarding gap where un-peering required ssh into the source relay, sqlite3 against `relay_identity` to extract the private key, ad-hoc Ed25519 sign of the raw `relay_motebit_id` bytes, then a curl POST to the target's `/peer/remove` — the HTTP-with-DB-keys recipe `cli_peer_remove_followup` flagged.

Two HTTP calls under the hood:

```text
1. Admin-authed GET to OUR relay's signing oracle:
   GET /api/v1/admin/federation/peer-removal-signature
   → { relay_id, signature }   (our relay signs its own relay_motebit_id raw bytes)

2. Unauth'd POST to the PEER's /federation/v1/peer/remove with that
   { relay_id, signature } — the signature itself is the auth.
```

The new oracle endpoint is admin-authed, NOT a public self-mode (mirror of `/peer/propose` self-mode). That call was deliberate: `/peer/propose` self-mode is safe because the existing handler already signs `(relay_id, nonce)` for any unauth'd caller — self-mode adds no new oracle. `/peer/remove` takes a signature over the BARE `relay_id` (no nonce, no suite-binding), so a public self-mode would create a replayable artifact: any HTTP caller could fetch this and POST it to every known peer, federation-DoS'ing the relay. Auth required.

Wire-format `/federation/v1/peer/remove` is unchanged; only the operator-side affordance is new.
