---
"motebit": minor
---

`motebit federation peer`, `mesh` and `peer-remove` speak relay-federation@1.5. A relay's handshake confirm is now minted by its own operator (self-propose is refused by 1.5 relays), so `peer` mints our confirm with our token and, when `MOTEBIT_PEER_API_TOKEN` holds the peer's master token, the peer's too; without it the peer holds us active and its operator runs `motebit federation peer <our-url>` for the other half. `mesh` takes one token per URL from `MOTEBIT_MESH_TOKENS` (comma-separated, in order), else the configured relay token for all. `peer-remove` reads the peer's relay id and asks our relay for a v2 `peer-remove` message bound to that one peer. Needs relays on relay-federation@1.5 (sibling changeset `relay-federation-v2-heartbeat-remove-ignored.md`).
