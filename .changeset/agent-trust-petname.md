---
"@motebit/protocol": minor
---

Add an optional first-person `petname` field to `AgentTrustRecord` — a local-only nickname for a peer agent (what _I_ call them, in my own namespace), never on the wire and never sent to a peer or the relay. Naming is first-person, the petname resolution to Zooko's triangle (doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md` §3), distinct from a peer's squattable self-asserted listing name. Additive and optional; absent ⇒ no petname.

Persisted by the SQLite trust store (migration v39 adds a nullable `agent_trust.petname` column; in-memory and IndexedDB stores carry it for free via whole-record upsert), settable via `runtime.setAgentPetname(remoteMotebitId, petname)` (display-only — not a routing input, so it does not invalidate the agent graph). The panel UI and any auto-suggestion remain held behind the §5 fork.

Note: regenerating `etc/protocol.api.md` for this change also reconciled a pre-existing baseline drift — federation P2P symbols (`SovereignP2pPaymentRequest`, `computeFederatedFeeSplit`, `FederatedFeeSplit`) added 2026-06-02 whose baseline update was missed and masked by a turbo build-cache hit on `@motebit/protocol`. The baseline now matches source.
