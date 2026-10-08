---
"motebit": patch
---

`motebit federation peer` and `motebit federation mesh` speak the v2 peering handshake (`motebit/relay-federation@1.5`): each direction's confirm is minted by the PROVING relay's operator-authenticated `POST /api/v1/admin/federation/peer-confirm-signature` (the operator token from `--sync-token` / `MOTEBIT_API_TOKEN`), never by a relay's public propose endpoint. `peer <url>` peers your relay onto the remote and, when the same token is the remote's operator token too, the remote onto yours; otherwise it reports the one direction done and names the command the remote's operator runs. `mesh` is one operator's act: the token must be accepted by every listed relay.
