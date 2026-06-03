---
"@motebit/sdk": minor
---

Add the identity-sigil primitive — `deriveAgentSigil`, `oklchToRgb`, and `shortFingerprint` (with `AgentSigil`, `OklchColor`, `SigilSymmetry` types). Doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md` §4.

A pure, synchronous, deterministic function from an agent's 64-char hex Ed25519 public key to perceptually-spread visual parameters (OKLCH primary + harmonic accent, symmetry, element count, density, rotation, stroke, and a 32-bit `geometrySeed`). This is the Ring-1 _param_ half of "the face is the key"; each surface renders the params natively (Ring 3) — web/SVG, mobile/`StyleSheet`, CLI glyph, and the spatial droplet from the same `geometrySeed`. The module never emits pixels.

Deliberately non-cryptographic: the sigil is a glance-level recognition aid, never identity proof — `shortFingerprint` (or the full key / signed receipts) stays the authority for any trust-bearing decision. Distinctness is spread across many orthogonal axes (not hue alone — lightness and the geometric axes stay discriminable under color-vision deficiency), per the doctrine's distinctness-budget bound. Distinct from the _chosen_ creature aesthetic in `color-presets.ts`: a peer's sigil is _derived_ and cannot be chosen.

Additive (new exports only); no behavior change to existing surface. Renderers and panel wiring are intentionally not included — they ship when a consumer (the live demo or a builder) needs them.
