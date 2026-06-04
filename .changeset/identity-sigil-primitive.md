---
"@motebit/sdk": minor
---

Add the identity-sigil primitive — `deriveAgentSigil`, `oklchToRgb`, `shortFingerprint`, and `wordFingerprint` (with `AgentSigil`, `OklchColor`, `SigilSymmetry` types). Doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md` §4.

A pure, synchronous, deterministic function from an agent's stable identity string (its `motebit_id` — itself `SHA-256(pubkey)`-derived — or a public key) to perceptually-spread visual parameters (OKLCH primary + harmonic accent, symmetry, element count, density, rotation, stroke, and a 32-bit `geometrySeed`). This is the Ring-1 _param_ half of "the face is the identity"; each surface renders the params natively (Ring 3) — web/SVG, mobile/`StyleSheet`, CLI glyph, and the spatial droplet from the same `geometrySeed`. The module never emits pixels. (Callers should pass the `motebit_id`: it is present at every display site, so the same agent shows the same face everywhere, where a raw pubkey isn't reliably client-side.)

Deliberately non-cryptographic: the sigil is a glance-level recognition aid, never identity proof — `shortFingerprint` (or the full key / signed receipts) stays the authority for any trust-bearing decision. Distinctness is spread across many orthogonal axes (not hue alone — lightness and the geometric axes stay discriminable under color-vision deficiency), per the doctrine's distinctness-budget bound. Distinct from the _chosen_ creature aesthetic in `color-presets.ts`: a peer's sigil is _derived_ and cannot be chosen.

`wordFingerprint` is the human-comparable recognition aid (the doctrine's "word-pair"), rendering the key as BIP-39 words via the canonical, SHA-256-verified English wordlist (adopted, not minted — the metabolic principle) so the mapping never drifts. Like `shortFingerprint` it is a recognition aid, never identity proof.

Additive (new exports only); no behavior change to existing surface. Cross-surface renderers and panel wiring are intentionally not included — they ship when a consumer (the live demo or a builder) needs them (a single unwired reference SVG renderer lives in `apps/web`, not the SDK).
