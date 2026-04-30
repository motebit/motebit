---
"@motebit/protocol": minor
---

Surface observed latency as a routing-input on `AgentTrustRecord`.

Adds an optional `latency_stats?: { avg_ms; p95_ms; sample_count }` field to `AgentTrustRecord`. The field is **never persisted** on the `agent_trust` row — it's projected at read time from the local `LatencyStatsStore` (or the relay's `relay_latency_stats` view). The store is the authoritative source; caching avg/p95 on the trust row would invite drift on every new delegation.

This closes the latency arm of the doctrine breach in `docs/doctrine/self-attesting-system.md`: latency factors into peer ranking via `agent-graph.ts`'s latency map (default 3000ms when stats are absent) but was previously invisible in the Agents-panel renderer. Sibling extension to the `hardware_attestation` field added in the HA badge ship — same shape, same projection-not-persistence pattern, same self-attesting-system doctrine.

Backwards-compatible. Consumers that don't read the new field are unaffected. The field is optional and absent for peers with zero samples in the store.

Field-name choice: `latency_stats` matches existing wire vocabulary (`task-routing.ts:387`, `listings.ts:180`) rather than introducing `latency_ms`. Object members (`avg_ms`, `p95_ms`, `sample_count`) match the `LatencyStatsStoreAdapter.getStats` return shape exactly.

Runtime projection (`@motebit/runtime`), relay enricher (`@motebit/relay`), and per-surface rendering (`@motebit/{desktop,web,mobile}`) ship in the sibling `latency-surface-ignored.md` changeset.
