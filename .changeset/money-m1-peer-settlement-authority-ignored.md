---
"@motebit/runtime": patch
"@motebit/relay": patch
---

**M1 — a federation peer's assertion is never settlement authority.** The relay's discover merge drops a peer entry under any id this relay hosts (on the discovery shelf and not revoked), drops a direct (`hop_distance: 1`) peer answer whose `source_relay` is not the peer that returned it or names this relay, strips the pay-to address (and any peer-supplied `source_relay_public_key`) from entries whose host is not an active direct peer, and task routing's federated candidates apply the same local-shadow rule. The `p2p-eligibility` pre-flight returns the worker's own registered `settlement_address`. `resolveP2pPaymentRequest` treats a candidate as LOCAL only on the origin's `hop_distance: 0` mark (absent = an older relay, unchanged), never on a missing peer key; refuses a peer-listed candidate it cannot bind (`worker_settlement_unbound`); and refuses a local candidate whose discovered address differs from the one the relay's registry confirms.
