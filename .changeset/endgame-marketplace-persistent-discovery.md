---
"@motebit/api": minor
---

Endgame marketplace: decouple discoverability from runtime availability. Service agents stay discoverable while asleep — a motebit's identity, listing, and reputation are durable signed artifacts that don't need a running Fly.io machine to exist.

The relay's `agent_registry.expires_at` becomes a 90-day janitor lease (was 15 minutes). Every read path (`/api/v1/agents/discover`, `/api/v1/agents/:id`, `/federation/v1/task/forward`, `queryLocalAgents`, `buildCandidateProfiles`) drops the `WHERE expires_at > now` visibility filter. `revoked = 0` remains the correct "don't show this agent" filter.

Discovery response gains a `freshness` field — a computed render hint driven by `last_heartbeat` age, with four bands: `awake` (< 6 min), `recently_seen` (< 30 min), `dormant` (< 24 h), `cold` (≥ 24 h). Additive to the response shape, backward compatible.

`forwardTaskViaMcp` gets a wake-on-delegation hook: a 5-second GET to the agent's `/health` before MCP init, triggering Fly's auto-start for machines suspended under `auto_stop_machines = "stop"`. Fail-open — MCP init's 30-second timeout still absorbs residual cold-start latency.

Routing behavior: `buildCandidateProfiles` now computes `is_online` from freshness (awake or recently_seen), not `expires_at`. Dormant and cold candidates remain rankable, not excluded — wake-on-delegation makes them reachable.

Closes the visibility deadlock that caused motebit.com's Discover panel to show "No agents on the network yet" despite 5 deployed service agents (sleeping services invisible → no delegation → no wake → still invisible).

Client apps (web, desktop, mobile) render a 6px freshness dot next to the existing "seen X ago" text, matching the calm-software `goal-status-dot` palette. No spatial changes — marketplace scene is tracked separately.
