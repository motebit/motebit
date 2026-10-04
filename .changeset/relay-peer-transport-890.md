---
"@motebit/relay": patch
---

Peer-relay HTTP (discover fan-out and re-forward, task forward, result delivery, settlement forward and retries, heartbeats, dispute votes, horizon witnesses) goes through one injectable transport, `SyncRelayConfig.federationPeerFetch` (default: the global `fetch`). Tests inject an in-process peer network through `TEST_RELAY_NETWORK`, so a relay test whose peer is a registry row at a fake endpoint never dials it — the #890 suites composed with the relay network guard (#1006) are green again.
