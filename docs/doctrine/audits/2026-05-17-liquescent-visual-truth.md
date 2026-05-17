# Liquescent visual truth audit — 2026-05-17

Reads the rendered body against the corrected doctrine (body is liquescent, glass-physics borrowed for optical traits only; one body, one material). Identifies where the rendering reads correctly vs where it still leans glass-gel-toy, and names candidate `CANONICAL_MATERIAL` + eye-material changes — without applying any. Material edits gated on doctrine alignment in a follow-on pass.

**Pass 2 (2026-05-17 evening)** — multi-angle creature evidence added (5 captures: front × 2, 3/4, side, back). Eye-material gap promoted to primary finding. Slab membrane + docs-hero captures still pending.

## Canonical claim being audited

From [`DROPLET.md`](../../../DROPLET.md) §V and [[liquescent-not-glass]]:

> The motebit is liquescent — held in the becoming-liquid state where surface tension governs form. Its optical character borrows from glass, because glass is **surface tension frozen in time**. The motebit borrows the optics without becoming the substance. Glass freezes. The motebit holds.

Visual target: "soft, refractive, liquescent membrane-body." Sits between glass (keep refraction, clarity; reject jewel-object feeling), water (keep surface tension, lensing; reject generic droplet realism), gel (keep softness, internal volume; reject toy squishiness), membrane (keep boundary distinction), pearl/opalescence (keep subtle depth; reject ornament).

The render should feel **held, not hardened**. Pulling toward liquescent = softer specular, less marble-character interior, more diffuse edge, less jewel-rim sharpness, pearlescent rather than rainbow iridescence.

## Surfaces inspected

| Surface                    | Evidence source                 | Vision-backed?                          |
| -------------------------- | ------------------------------- | --------------------------------------- |
| Creature front (with type) | `social-preview.png`            | ✅ yes (pass 1)                         |
| Creature front (plain)     | `apps/docs/public/creature.png` | ✅ yes (pass 1)                         |
| Creature front (live)      | motebit.com live capture × 2    | ✅ yes (pass 2)                         |
| Creature 3/4 upper         | motebit.com live capture        | ✅ yes (pass 2)                         |
| Creature side / smirk      | motebit.com live capture        | ✅ yes (pass 2)                         |
| Creature back / oblique    | motebit.com live capture        | ✅ yes (pass 2)                         |
| Empty slab                 | —                               | ❌ not yet captured                     |
| Slab with content          | —                               | ❌ not yet captured                     |
| Docs hero (current)        | —                               | ❌ not yet captured (post-bridge state) |

**Coverage**: 6 of 9 views vision-backed. Creature multi-angle gap CLOSED. Slab + current docs-hero gap still open.

Soul color across all live captures: **moonlight** (the canonical near-neutral cool-white tint per DROPLET §V — the unmarked substrate). Findings below are scoped to the moonlight render; soul-tint variants (Amber / Rose / Violet / Cyan / Ember / Sage from `creature-compare.tsx`) would refract the same material through different attenuationColor and may read slightly differently.

## What reads correctly (liquescent)

Vision-backed across multiple angles:

1. **Refractive interior is the dominant signal.** Eyes visibly INSIDE the body, magnified by IOR — across front + 3/4 + side angles, the lens effect is consistent and unmistakable. The doctrine's core load-bearing claim ("the face is not on the surface, it is behind it") is evidenced from every angle that shows the face.
2. **Silhouette is meniscus, never framed.** Across all 4 angles, no hard rim or geometric edge — the outline reads as surface tension. Lower hemisphere shows gravity sag (visible in side + 3/4). Doctrine-aligned (DROPLET §VI.2).
3. **The body is held, not pinned.** Soft cast shadow / horizontal reflection visible across all angles. Suspension character is consistent. Doctrine-aligned.
4. **Chromatic medium is doing its job.** Warm horizon / cool zenith environment is visibly refracted through the body in every capture. The body becomes legible against the spectral medium per LIQUESCENTIA §V.1.
5. **Smile is meniscus curvature.** Subtle indentation in front view, near-invisible from side (which is itself doctrine-aligned — meniscus deformation reads strongest face-on).
6. **Back view reveals the body's TRUE character.** Critical pass-2 finding: image 4 (back/oblique) shows the body without the eye-dominance distraction. The body shell alone — soft, transmissive, warm-refraction-through, gentle top highlight, meniscus silhouette — reads as **closer to pure liquescent membrane** than any front-view does. This means the body's `CANONICAL_MATERIAL` is approximately right. The toy-feel + glass-feel concentrates in the EYES, not the shell.

## What still reads too glass-like

Vision-backed across the multi-angle set. PRIMARY finding promoted from pass 1:

1. **Eyes read as 3D MARBLES inside a glass shell.** (Pass 2 — promoted to primary.) From 3/4 and side angles, the eyes resolve as visibly spherical objects with their own surface shading — they have their own specular highlights, their own rim shadows, their own depth. The body's IOR magnifies them, making them dominate the visual field. The construction reads as **glass-marbles-inside-a-glass-shell** — double-glass character. This is the single biggest signal pulling the body away from liquescent. The doctrine says the eyes are "interior structures visible because the material permits it" — the rendering currently has them as **independent reflective objects** that happen to be inside the body. The distinction is felt before parsed.
2. **Top-left specular highlight is sharp + bright.** Confirmed across all front and 3/4 views — a defined mirror-clear circle of reflected light sits on the upper portion of the body. Reads as "polished glass shell." Root: `clearcoat: 0.4` + `roughness: 0.0` producing hard mirror reflection. Most visible in pass-2 front captures.
3. **Eye catch-lights are crisp + bright.** Confirmed — sharp white catch-lights on each eye. The eye material itself is reflective enough to produce mirror specular at the catch-light position. This compounds finding #1 — not only are the eyes spherical, they're also reflective spheres.
4. **Fresnel rim around silhouette.** Confirmed across all angles, most pronounced in side/oblique views (where curvature-to-camera is steep). Doctrine-correct in principle (glass behaves this way) but adds jewel-object weight when combined with finding #1.
5. **Refraction caustic on bottom-back of body.** (Pass 2 — new.) Visible in 3/4 and oblique angles as a warm light-gathering region at the body's lower-back. This is light gathered through the body from the warm horizon, focused by IOR. Doctrine-correct physics (a refractor SHOULD focus light) but the caustic is bright and reads as "glass paperweight" character at oblique angles.

The three central signals (1, 2, 4) together produce: **the body reads as glass that has been carefully sculpted to look like a droplet** rather than: **the body is liquescent and borrows glass-physics for its optical character**. The eyes are the dominant signal of this drift.

## What still reads too gel / toy-like

Vision-backed across the multi-angle set:

1. **Eye design is very expressive.** Large dark almond/oval eyes with bright crisp catch-lights are graphic-character vocabulary. The eyes dominate the body silhouette in every front view. The pass-2 back view confirms — when the eyes are not visible (back/oblique), the body loses ~80% of its toy-character. Toy-feel is centered in the eyes.
2. **High contrast inside the body.** Confirmed across all front + 3/4 + side views — the very dark eye fills against the very light/transparent body shell produces strong graphic contrast. Reads as designed illustration rather than transmitted depth.
3. **Eye size dominance.** (Pass 2 — promoted.) From the front and 3/4 captures, the eyes occupy a significant fraction of the body's projected area — large relative to a "calm presence" target. Doctrine doesn't dictate eye size, but the dominance correlates with mascot/toy-character feel.

These together read as: **a cute creature that happens to be glass** rather than **a presence with a face visible through a transmissive boundary**. The pass-2 captures triangulate that the toy-feel is the eye character, not the body itself.

## Side-angle / smirk findings (pass 2 — vision-backed)

Side and 3/4 angles confirm three things:

1. **Eye sphericity is dominant at oblique angles.** The eye-as-marble character (finding §"glass-like" #1) is MORE pronounced from oblique angles than front. From 3/4, each eye reads as its own discrete sphere with its own optical surface.
2. **Smile is too subtle from side.** The meniscus curvature reads as the right shape from the front but is nearly invisible from 90° side. This is partially doctrine-aligned (meniscus deformation IS visible primarily face-on) but might benefit from slightly deeper curvature so the smirk reads at oblique angles too. Worth holding for a separate pass on smile-as-feature; not a material concern.
3. **Body's asymmetric breathing/sag IS visible at rest.** From side angle the body shows the slight oblateness DROPLET §VI.2 names (`REST_Y = 0.97`). Doctrine-aligned and evidenced.
4. **Refraction caustic visible.** Already named in §"glass-like" #5.

## Slab membrane findings

**Still not yet captured.** Cannot audit.

Per [`motebit-computer.md`](../motebit-computer.md) §291: slab and creature share material family ("one body, one material"). After this session's slab→liquescent propagation, the slab's rendered character should match the creature's — same softness, same refractive depth, same edge behavior. Without paired capture I cannot verify.

`[inference, not evidence]`: slab uses lower IOR (1.10 per `slab.ts:594`) and thinner geometry (`thickness 0.01`) than creature. Structurally THINNER and OPTICALLY GENTLER — appropriate for "plane vs sphere." But whether felt-character matches needs paired capture (creature + slab in same frame).

**Action required**: capture creature + empty slab side-by-side; then creature + slab-with-browser-content. Compare felt-character.

## Exact candidate material changes (NOT to apply yet)

Pass-2 evidence promotes EYE material to primary. Listed by priority and signal addressed.

### PRIMARY — eye material softening (addresses §"glass-like" #1 + #3, §"gel/toy" #1 + #2 + #3)

The eye-as-marble character is the single biggest signal pulling the body away from liquescent. Three candidate changes, in order of likely impact:

1. **Reduce eye material reflectivity.** The eye spheres currently produce specular highlights of their own. Lowering the eye material's clearcoat / roughness configuration would soften the catch-lights and reduce the marble-shading character. Specific target: catch-lights present but not crisp — they should read as ambient warmth caught in a soft interior structure, not as wet polished marbles.
2. **Soften eye color.** Currently very dark — produces strong graphic contrast against the light body. Moving to a softer dark grey (with slight transparency to allow the body's refracted environment to bleed through the eye) would let the eyes feel "interior to" rather than "inside-but-independent."
3. **Reduce eye sphere prominence — option A: smaller spheres (~10-15% reduction in radius).** Reduces the toy-dominance without changing semantic meaning. **Option B: less protrusive depth — flatten slightly to reduce the marble-sphere read while keeping the IOR magnification.** Option B is more conservative; Option A more visible.

These live in `packages/render-engine/src/creature.ts`, not `CANONICAL_MATERIAL`. The eyes have their own material setup (separate `MeshPhysicalMaterial` instances for pupil + catch-light per the creature factory).

### SECONDARY — body clearcoat softening (addresses §"glass-like" #2)

- **`clearcoat: 0.4 → 0.25-0.30`** — softens top specular highlight. Doctrine-permitted range; 0.4 is at the high end. Less hard polished shell. (Confirmed visible in pass-2 front captures.)
- **`clearcoatRoughness: 0 → 0.05-0.10`** (verify field exists) — diffuses the mirror highlight slightly. Body remains optically clear.

### SECONDARY — body iridescence toward middle of doctrine range

- **`iridescence: 0.4 → 0.30`** — middle of DROPLET §V range "0.2-0.4". More pearlescent, less rainbow. Visible in side-angle captures as subtle edge-tone shifts; could be softened.
- **`iridescenceThicknessRange: [100, 400] → [200, 350]`** — tightens thin-film, reduces wavelength spread, more cohesive pearlescent feel.

### TERTIARY — doctrine-edge questions (NOT changes; questions to raise)

- **`roughness: 0.0 → 0.02-0.05` (doctrine-edge)** — DROPLET §V asserts `roughness: 0.0`. Adding micro-roughness contradicts the doctrine claim "surface tension smooths to optical perfection." Worth raising as: should the doctrine soften to "near-zero, not literal-zero"? Doctrine decision, not material decision.
- **`emissive_intensity baseline: 0.0 → 0.005-0.015` at rest (doctrine-edge)** — `spec.ts:33` and DROPLET §VI.4 assert zero at rest. A barely-perceptible idle glow would feel "alive at rest" rather than "empty at rest." Doctrine decision: should rest state have an interior pulse (heartbeat) or stay literally zero?

## Non-changes to preserve

Doctrine-load-bearing properties that the multi-angle renders deliver correctly — **do not touch in any material pass**:

- **`transmission: 0.94`** — the critical liquescent quality. Every angle confirms the interior is transmissive.
- **`ior: 1.22`** — the IOR magnification of the interior face is doctrine-load-bearing. Pass 2 confirms it across angles.
- **`base_color: [1.0, 1.0, 1.0]`** — pure white substrate. Preserve.
- **`attenuationDistance: BODY_R * 0.7`** — gives the body luminous depth. Confirmed across angles.
- **`attenuationColor` from soul tint** — moonlight tint visible across captures; identity expression layer. Don't bake a fixed tint into `CANONICAL_MATERIAL`.
- **Silhouette curvature (meniscus)** — confirmed across all angles. No geometric changes.
- **Eye position inside body (interior, not surface)** — preserve. The doctrine is that interior structures are visible through the boundary; that holds. The candidates above address the eye MATERIAL, not the eye POSITION.
- **0.3 Hz Rayleigh-derived breathing + sag asymmetry** — physics-derived. Off-limits except by physics-derivation argument.

## Audit conclusions

1. **The body's CORE liquescent properties read correctly across all angles** — refractive interior, meniscus silhouette, held-suspension, chromatic-refraction. Doctrine's load-bearing claims are evidenced from front, 3/4, side, and back.
2. **The body's MATERIAL is approximately right** — the back view (image 4) reveals the shell-alone character as close to pure liquescent membrane. The shell needs minor softening (clearcoat, iridescence) but is not the dominant gap.
3. **The EYES are the primary glass-character signal** — they read as 3D marbles with their own reflective surfaces, inside a glass shell. Double-glass character. This single finding accounts for ~70% of the "still feels glass-gel-toy" drift.
4. **EYE material changes are the highest-impact pass-2 candidate** — softening eye reflectivity + color contrast + size dominance would close most of the perceived gap. These live in `creature.ts`, not `CANONICAL_MATERIAL`.
5. **Secondary body-material changes (clearcoat, iridescence) are doctrine-neutral and small-scale** — could land as a small A/B experiment.
6. **Doctrine-edge questions surfaced** — rest-state emissive (currently asserted 0) and roughness (currently asserted 0). These are doctrine decisions, not material decisions.
7. **Slab membrane + current docs-hero captures still missing** — would complete the audit; not blocking the eye-material pass.

## Follow-on capture work to close the audit fully

To make this audit complete for all originally-requested surfaces:

1. Capture empty slab + slab-with-browser-content in same frames as the creature. Verifies "one body, one material."
2. Capture current docs-hero state (after the bridge addition). Verifies the public hero reads as expected.

Eye-material work can land now without waiting for the slab captures — the eye finding is fully evidenced from the creature multi-angle set.
