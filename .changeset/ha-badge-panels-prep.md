---
"@motebit/panels": minor
---

Prep slot for hardware-attestation badge per `docs/doctrine/self-attesting-system.md`.

Adds `AgentHardwareAttestation`, `AgentHardwarePlatform`, `scoreHardwareAttestation`, and `formatHardwarePlatform` to `@motebit/panels`. Extends `AgentRecord` and `DiscoveredAgent` with an optional `hardware_attestation` field. Surfaces that consume the controller can render a "hardware-attested" badge per row when the field is populated; surfaces that don't are unchanged.

**Why a separate ship from the surface render:** The doctrine gap is documented in the `ha_surface_badge_agents_panel_gap.md` project memory: hardware-attestation factors into routing scoring (`HardwareAttestationSemiring` in `@motebit/semiring`) but is invisible in the agents panel UI, which breaks self-attesting-system doctrine ("every claim is user-verifiable"). The fix has three layers: types/helpers (this ship), runtime + relay forwarding of the claim from `TrustCredential`'s `hardware_attestation` subject onto agent records (next ship), and per-surface badge rendering (final ship). Shipping the surface render before the data flow would produce a uniformly-empty badge slot — visually broken, low-trust UX.

Per `feedback_pre_push_audit_discipline` and the system prompt's "no half-finished implementations" rule: the panels addition is structurally complete (types export, helpers export, type-parity preserved, drift gates green), and no consumer is broken by the change since `hardware_attestation` is optional. Surfaces can adopt incrementally.

**What ships next (named follow-ups, not implied work):**

1. Extend `runtime.listTrustedAgents()` (or the agent_trust storage layer) to JOIN against issued credentials and populate `hardware_attestation` from the most recent verified `TrustCredential` per peer. Sibling change in the relay's `/api/v1/agents/discover` enrichment.
2. Render the badge on apps/desktop/src/ui/agents.ts. The render-only-when-present pattern means rows without HA stay visually unchanged; rows with HA gain a hardware-attested badge + verifier name + score (via `formatHardwarePlatform` for the verifier label, `scoreHardwareAttestation` for the tooltip score).
3. Mirror surfaces: apps/web/src/ui/gated-panels.ts (agents tab), apps/mobile/src/components/AgentsPanel.tsx. Web shows "—" for `platform: "play_integrity"` claims because the verifier package was removed 2026-05-03 (the platform string remains in the protocol union per wire-format invariant; credentials carrying it now hit the canonical dispatcher's fail-closed "verifier not wired" branch — see `play_integrity_real_fixture_structurally_blocked`).
4. Drift gate `check-trust-score-display` — every routing-input the runtime computes against (HA score, reputation, freshness, latency) MUST surface in the agents panel renderer. Lands once the rendering pattern is established across surfaces so the gate has something to enforce.

Naming convention pinned: "hardware-attested" verbatim in badge text. Never "secure" or "verified" — those collide with the skills provenance vocabulary (`spec/skills-v1.md` §7.1 uses `[verified]` / `[trusted-unsigned]`).

Backwards-compatible. No existing consumer breaks.
