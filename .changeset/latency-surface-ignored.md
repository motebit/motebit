---
"@motebit/runtime": patch
"@motebit/panels": patch
"@motebit/relay": patch
"@motebit/desktop": patch
"@motebit/web": patch
"@motebit/mobile": patch
---

Latency surface ship — runtime projection + relay enricher + per-surface render. Closes the latency half of the doctrine breach in `docs/doctrine/self-attesting-system.md`: latency factors into peer ranking via `agent-graph.ts` but was never visible to the user. Sibling extension to the HA badge — same five-step pattern (protocol types → runtime projection → relay enricher → per-surface render → drift gate extension), same projection-not-persistence shape.

`@motebit/runtime` — new module `latency-stats-projection.ts` mirrors `hardware-attestation-projection.ts`. Pure read function: `readLatencyStats(store, motebitId, record)` returns `{ avg_ms, p95_ms, sample_count }` from the local `LatencyStatsStore`, or `null` for zero-sample windows / store errors (best-effort, never breaks the trust path). `MotebitRuntime.listTrustedAgents()` now projects both HA and latency in one pass, composing via `Promise.all` over the spread pattern.

`@motebit/panels` — adds `AgentLatencyStats` interface (inlined per the panels CLAUDE.md zero-dep rule) on `AgentRecord` and `DiscoveredAgent`. Adds `formatLatency(stats)` helper next to `formatHardwarePlatform`: returns `"342ms"` standalone, or `"342ms · p95 1.2s"` when p95 diverges meaningfully (>20% above avg). Switches to seconds with one decimal at >=1000ms. `avg_ms === 0` collapses to `"—"` defensively.

`@motebit/relay` — `enrichWithLatencyStats` sibling to `enrichWithHardwareAttestation` in `services/relay/src/agents.ts`. Reads from `relay_latency_stats` (the same pool `task-routing.ts` queries for routing weights), takes the most-recent 100 samples per worker via window function, computes avg+p95+count, attaches to each agent. Federation merge passes through unchanged — peer-provided latency wins for cross-relay agents (their store is more authoritative for agents we've never directly routed to). Wired into both `/api/v1/agents/discover` callsites + the federation `/federation/v1/discover` handler in `services/relay/src/federation.ts`.

`@motebit/desktop`, `@motebit/web`, `@motebit/mobile` — render the latency readout after the freshness dot on Discover, after the HA badge on Known. Calm-software doctrine: muted color, monospace, render-only-when-present. Tooltip / `accessibilityLabel` carries sample count for confidence judgement.

`scripts/check-trust-score-display.ts` — drift gate extended to enforce that every Agents-panel renderer references both `latency_stats` AND `formatLatency` (sibling to the existing `hardware_attestation` + `formatHardwarePlatform` pair). `scripts/check-gates-effective.ts` adds an adversarial probe stripping `formatLatency` from the web renderer and asserting the gate fires.

`docs/drift-defenses.md` row 64 updated to cover both routing-input arms (HA + latency); the gate's invariants are now four (HA field + HA formatter + latency field + latency formatter).

Tests: 5 runtime cases for the projection (no-samples, multi-sample avg, pair-scoping, store-error, sample-count-zero), 4 relay cases for the enricher (samples present, no-samples, federation passthrough, end-to-end through `/api/v1/agents/discover`), 5 panels cases for `formatLatency` (avg-only, with-p95, seconds-switch, defensive-zero, integer-rounding). All passing. `pnpm check-gates-effective` reports 58/58 (was 57/57).

Wire-format extension on `AgentTrustRecord` ships in the sibling `latency-surface.md` changeset (`@motebit/protocol` minor).
