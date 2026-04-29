---
"@motebit/desktop": patch
"@motebit/web": patch
"@motebit/mobile": patch
---

Hardware-attestation badge ship 3 of 3 — render the badge on every surface and lock the contract with `check-trust-score-display`.

Closes the doctrine breach documented in `ha_surface_badge_agents_panel_gap` project memory: routing factors hardware attestation via `HardwareAttestationSemiring` (`packages/semiring/src/hardware-attestation.ts`) but the user couldn't see WHICH peer was hardware-attested or by what verifier. Ship 1 (`756a38c3`) added the panel-controller types + helpers; ship 2 (`c8c6312d`) lit up the runtime + relay data flow; this ship renders the badge on desktop / web / mobile and adds the drift gate so a fourth surface or a regression on this one re-trips the same boundary.

**Render shape:** verbatim "hardware-attested" badge text — never "secure" or "verified" (those collide with the skills provenance vocabulary in `spec/skills-v1.md` §7.1). Tooltip on desktop + web (HTML `title`), `accessibilityLabel` on mobile (RN has no hover-tooltip primitive) carries the verifier name (via `formatHardwarePlatform`) and score for the doctrine-completeness probe — "why did motebit prefer that peer?" Render-only-when-present: rows without the field stay visually unchanged.

**Drift gate `check-trust-score-display` (#64):** every Agents-panel renderer file (apps/desktop/src/ui/agents.ts, apps/web/src/ui/gated-panels.ts, apps/mobile/src/components/AgentsPanel.tsx) MUST reference the `hardware_attestation` field AND import/use `formatHardwarePlatform` from `@motebit/panels`. Both conditions must hold — a renderer that reads the field but skips the verifier name leaves a partial surface (user sees the field exists but can't see which verifier attested it).

No public API changes — all three surface packages are workspace-private. Panels package and protocol unchanged.
