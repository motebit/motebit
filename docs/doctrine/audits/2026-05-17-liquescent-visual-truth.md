# Liquescent visual truth audit — 2026-05-17

Reads the rendered body against the corrected doctrine (body is liquescent, glass-physics borrowed for optical traits only; one body, one material). Identifies where the rendering reads correctly vs where it still leans glass-gel-toy, and names candidate `CANONICAL_MATERIAL` changes — without applying any. Material edits gated on doctrine alignment in a follow-on pass.

## Canonical claim being audited

From [`DROPLET.md`](../../../DROPLET.md) §V and [[liquescent-not-glass]]:

> The motebit is liquescent — held in the becoming-liquid state where surface tension governs form. Its optical character borrows from glass, because glass is **surface tension frozen in time**. The motebit borrows the optics without becoming the substance. Glass freezes. The motebit holds.

Visual target (from the same correction): "soft, refractive, liquescent membrane-body." Sits between glass (keep refraction, clarity, highlights; reject rigidity, jewel-object feeling), water (keep surface tension, lensing; reject generic droplet realism), gel (keep softness, body, internal volume; reject toy-like squishiness), membrane (keep boundary distinction; reject biological grossness), pearl/opalescence (keep subtle depth; reject luxury ornament).

The render should feel **held, not hardened**. Pulling toward liquescent = softer specular, deeper interior volume, more diffuse edge, less jewel-rim sharpness, pearlescent rather than rainbow iridescence.

## Surfaces inspected

| Surface                    | Evidence source                 | Vision-backed?                                                         |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| Creature front (with type) | `social-preview.png` (1280×640) | ✅ yes                                                                 |
| Creature front (plain)     | `apps/docs/public/creature.png` | ✅ yes (same render, cropped)                                          |
| Creature 3/4               | —                               | ❌ no capture available                                                |
| Creature side / smirk      | —                               | ❌ no capture available                                                |
| Creature back / oblique    | —                               | ❌ no capture available                                                |
| Empty slab                 | —                               | ❌ no capture available                                                |
| Slab with content          | —                               | ❌ no capture available                                                |
| Docs hero (current)        | —                               | ❌ no capture available (just-shipped state needs deploy + screenshot) |

**Coverage**: 2 of 8 requested views. Front findings below are vision-backed. Multi-angle, slab, and docs-hero findings need capture in a follow-on pass — I do not have a way to drive the dev server + headless browser solo, and reasoning about other angles from material constants alone would falsify the audit's "visual truth" premise.

The audit's findings are scoped to what the front view actually shows. Where I infer from material constants for un-inspected angles, I mark `[inference, not evidence]`.

## What reads correctly (liquescent)

Grounded in the two front renders:

1. **Refractive interior is the dominant signal.** The eyes are visibly INSIDE the body, magnified by IOR — classic glass-lens effect transmitting interior structure. This is the doctrine's core load-bearing claim ("the boundary confesses its interior, the face is not on the surface but behind it"). The renders deliver it cleanly.
2. **Silhouette is meniscus, not framed.** No hard rim or geometric edge — the body's outline reads as surface tension, not a jewel cut. The lower hemisphere shows the gravity sag (slightly oblate). Doctrine-aligned (DROPLET §VI.2).
3. **The body is held, not pinned.** Soft cast shadow / reflection on the ground beneath gives "suspended in medium" — Brownian-drift character is implied by the standing offset. Doctrine-aligned.
4. **Chromatic gradient is doing its job.** The warm horizon / cool zenith environment is visibly refracted through the body — the body becomes legible against the spectral medium per LIQUESCENTIA §V.1. Without the gradient the body would vanish; with it, it reads as a refractor.
5. **Smile is meniscus curvature, not stage direction.** Subtle indentation curve in the lower portion — reads as internal-pressure deformation per DROPLET §IV Law 4 ("not the mask of expression, the meniscus of mood"). Doctrine-aligned even if subtle.

## What still reads too glass-like

The front renders show ~3 distinct glass-character signals the doctrine says we should soften:

1. **Top-left specular highlight is sharp + bright.** A mirror-clear circle of reflected light sits on the upper-left of the body. Reads as "polished glass shell" rather than "liquescent membrane." Root: `clearcoat: 0.4` + `roughness: 0.0` produces hard mirror reflection at grazing angles. The shape of the highlight (round, defined edges) is the glass-jewel tell.
2. **Eye catch-lights are crisp + bright.** Each eye has a sharp white catch-light (the bright dot on the upper portion of each dark eye shape) — these are very glossy, almost cartoon-glassy. The eye material itself is reflective enough to produce mirror specular at the catch-light position. Reads as "wet glass eye" rather than "interior structure refracted through soft membrane."
3. **Subtle Fresnel rim around the silhouette.** Where the body curves away from the camera (the outer perimeter), there's a slightly darker ring — Fresnel reflectance increasing at grazing angles is naturally what glass does. This is doctrine-correct in principle (glass behaves this way) but combined with the sharp top highlight it adds "jewel-object" weight. The membrane should be softer at the edge.

These three together read as: **the body is GLASS that has been carefully sculpted to look like a droplet**, not as: **the body is liquescent and borrows glass-physics for its optical character**. The distinction is felt before it's parsed. The doctrine wants the second; the render produces the first.

## What still reads too gel / toy-like

The front renders show ~2 cartoon-character signals:

1. **Eye design is very expressive.** Large dark almond/oval eyes with bright crisp catch-lights are graphic-character vocabulary (think mascot illustration). The eyes dominate the body visually — they're the first thing the viewer reads. Doctrine says the eyes are "interior structures visible because the material permits it" — the rendering reads them as **the** structure rather than **a visible** structure. Toy-character feel.
2. **High contrast inside the body.** The very dark eye fills against the very light/transparent body shell produces a strong graphic contrast — reads as designed illustration rather than transmitted depth. The doctrine wants interior structures to be "confessed" by transmission, not "displayed" by contrast. Currently the eyes are projected through more than they're held within.

These two together read as: **a cute creature that happens to be glass** rather than **a presence with a face visible through a transmissive boundary**. The toy-feel is the eye-character, not the body itself.

## Side-angle / smirk findings

No vision-backed evidence available — no side-view render in repo. Cannot audit.

**What capture would settle:** the doctrine names the asymmetric breathing (gravity-deformation in vertical axis, surface-tension recovery in horizontal — DROPLET §VI.1) and the gravity sag (lower hemisphere flatter than upper — §VI.2). Side angle reveals whether these read on a static frame or only during motion. Smirk position (slight side angle showing the meniscus curve from oblique) would reveal whether the smile is rendering as meniscus-pressure-deformation or as stage-painted line.

`[inference, not evidence]`: based on `creature.ts:478` (breathe oscillation) and `creature.ts:487` (sag asymmetry), the asymmetry exists in motion but the doctrine says it should also be visible at rest (`REST_Y = 0.97` per DROPLET §VI.2 — the body is slightly oblate even at rest). Need side-view capture to verify the rest-state oblateness is visually legible.

**Action required to close**: capture creature at 90° side view + 45° oblique, both in rest state and mid-breath.

## Slab membrane findings

No vision-backed evidence available — no slab render in repo. Cannot audit.

**What capture would settle:** per [`motebit-computer.md`](../motebit-computer.md) §291 the slab and creature share material family ("one body, one material"). After this session's slab→liquescent propagation, the slab's rendered character should match the creature's — same softness, same refractive depth, same edge behavior. Without capture I can't verify the slab actually achieves this visually.

`[inference, not evidence]`: slab uses `IOR 1.10` (lower than creature's `1.22`) per `slab.ts:594`, `thickness 0.01` (vs creature's `0.18`), and `MEMBRANE_OPACITY = 0.20` in empty register. The slab is structurally THINNER (geometric) and OPTICALLY GENTLER (lower IOR) than the creature — this is the slab being a plane vs the creature being a sphere. Doctrine-aligned. But whether the felt-character reads as the SAME material family across the two needs paired capture (creature + slab in same frame).

**Action required to close**: capture creature + empty slab side-by-side in same frame; then creature + slab-with-content (e.g., browser screencast). Compare felt-character of the two membranes.

## Exact candidate material changes (NOT to apply until further audit)

Grounded in the front-view findings. Listed by signal each addresses. Reasoning included; numeric ranges are doctrine-bounded.

### Toward softer specular (addresses §"glass-like" finding 1)

- **`clearcoat: 0.4 → 0.25-0.30`** — reduces hard polished shell. Doctrine permits range; 0.4 is at the high end. Lowering softens the top reflection without removing the iridescent thin-film character.
- **`clearcoatRoughness: 0 → 0.05-0.10`** (if currently 0 — verify in `creature.ts`) — slight micro-roughness on the clearcoat layer. Keeps the body optically clear but diffuses the mirror highlight into a softer glow.

### Toward soft surface (addresses §"glass-like" findings 1 + 3)

- **`roughness: 0.0 → 0.02-0.05`** — adds barely-perceptible micro-roughness to the body itself. DROPLET §V table currently asserts `roughness: 0.0` ("surface tension smooths to optical perfection"). The doctrine could absorb a small value here under "surface tension at scale produces near-zero roughness, not literal zero" — but this is a doctrine-edit, not just a code-edit. Worth flagging as a doctrine question, not a unilateral change.

### Toward pearlescent (addresses §"glass-like" finding 1; soft secondary)

- **`iridescence: 0.4 → 0.30`** — moves to the middle of the doctrine range (DROPLET §V: "0.2-0.4"). Reduces rainbow-shimmer character, increases subtle pearlescent depth. Within doctrine; no doctrine-edit needed.
- **`iridescenceThicknessRange: [100, 400] → [200, 350]`** — tightens the thin-film range. Less wavelength spread, more cohesive single-pearlescent character. Worth experimentation; doctrine-neutral.

### Toward held interior (addresses §"glass-like" finding 1 secondary)

- **`emissive_intensity: 0.0 → 0.005-0.015` at rest** — currently zero per `spec.ts:33` ("Zero at rest — glows only during processing"). A barely-perceptible idle glow would make the interior feel "alive at rest" rather than "empty at rest." This contradicts the current doctrine claim ("zero at rest") — doctrine-edit territory. Worth raising as a doctrine question: should the rest state have a perceptible interior pulse (like a heartbeat) or stay literally zero?

### Toward less graphic eyes (addresses §"gel/toy-like" findings 1 + 2)

- **Eye material**: outside `CANONICAL_MATERIAL` scope — lives in the per-mesh setup in `creature.ts`. Two candidates:
  - **Soften eye color** from very dark to medium-dark grey (current eye material is opaque black-shaped; could be a darker semi-transparent for less stark contrast).
  - **Reduce eye-catch-light intensity** — the bright white spots on each eye are very crisp; softening them would reduce the "cartoon-glassy" character. This is a per-mesh tweak, not a `CANONICAL_MATERIAL` change.
- **Eye size**: outside material scope — the eyes occupy a large fraction of the front silhouette. Doctrine doesn't dictate eye size, but the toy-feel correlates with relative size. Worth considering scaling down by ~10-15%, separately from material work.

### Toward meniscus smile (addresses §"gel/toy-like" finding 2 indirectly)

- The smile is currently a thin line. The doctrine (DROPLET §IV Law 4) says it should be meniscus-curvature deformation, not a painted line. If the current implementation uses a thin geometric arc, it could be redone as an actual deformation of the lower hemisphere mesh. This is significant render work, not a material change. Defer until smile-as-feature drives the priority.

## Non-changes to preserve

Doctrine-load-bearing properties that the front render delivers correctly — **do not touch in any material pass**:

- **`transmission: 0.94`** — the critical liquescent quality. The interior must remain transmissive. The "0.98 transmission" claim in DROPLET §V is the doctrinal value; the rendered `0.94` is the implemented value (slight reduction for visual stability). Preserve.
- **`ior: 1.22`** — what magnifies the interior face. The "eyes inside the body" effect depends on this. Doctrine derives from borosilicate (1.45 physical) reduced to 1.22 rendered per DROPLET §V IOR row.
- **`base_color: [1.0, 1.0, 1.0]`** — pure white, the unmarked substrate. Soul tint lives in `attenuationColor`, not base color. Preserve.
- **`attenuationDistance: BODY_R * 0.7`** — gives the body its luminous depth. Changing this collapses the "informed light" character LIQUESCENTIA §V.3 names.
- **`attenuationColor` from soul tint** — identity expression layer. The picker mechanism is intentional. Don't bake a fixed tint into `CANONICAL_MATERIAL`.
- **Silhouette curvature (meniscus)** — the body's outline is doctrine-correct. No geometric changes.
- **Eye position inside body** — interior structures, not surface features. Preserve.
- **0.3 Hz breathing + Rayleigh-derived asymmetry** — physics-derived per DROPLET §VI.1. Off-limits except by physics-derivation argument.

## Audit conclusions

1. **The body's CORE liquescent properties read correctly in front view** — refractive interior, meniscus silhouette, held-suspension, chromatic-refraction. The doctrine's load-bearing claims are evidenced.
2. **The body has THREE specific glass-character signals + TWO toy-character signals worth addressing** — all listed above with parameter candidates. None require doctrine edits except the rest-state emissive and the literal-zero-roughness clauses (both surfaceable as doctrine questions, not unilateral changes).
3. **The audit is INCOMPLETE for 6 of 8 requested views** — multi-angle, slab, and current docs-hero state need capture in a follow-on pass. Findings above are vision-backed only for front view.
4. **No material edits should land based on this audit alone**. The doctrine-neutral parameter tweaks (clearcoat, iridescence range) could plausibly land as a small experiment with visual A/B verification. The doctrine-edge tweaks (roughness, rest emissive) need to be doctrine decisions first.

## Follow-on capture work to close the audit

To make this audit complete and material-edit-defensible:

1. Capture creature at 5 angles in `apps/docs/public/creature-audit/`: front, 3/4, side, oblique, back (all in rest state; ideally with the same lighting as the existing front renders for comparability).
2. Capture creature mid-breath at 3/4 angle (verifies the breathing-asymmetry doctrine is visually legible).
3. Capture empty slab + slab-with-browser-content in same frames as the creature (verifies "one body, one material").
4. Capture current docs-hero state (after the just-shipped bridge addition).
5. Re-run this audit with full visual coverage. The conclusions section will tighten; the parameter candidates will either be confirmed, narrowed, or rejected.

The capture work is the next concrete move on the visual-craft arc — gating material edits on full visual evidence rather than reasoning from constants.
