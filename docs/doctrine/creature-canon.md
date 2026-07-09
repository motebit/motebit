# The creature canon

**The creature is the show. Every frame is a product shot.**

The motebit body is the first claim a stranger evaluates — before any receipt, any proof, any doctrine. It is registered trade dress ([`TRADEMARK.md`](../../TRADEMARK.md), "Trade Dress — The Liquescent Droplet Creature"). Render fidelity is therefore a trust surface: a seam in the sky or a dead eye at an oblique angle quietly argues against "this thing can hold your money." This memo fixes the canon — what is frozen, what is choreographed, what is toleranced, and how the rendered body proves itself.

The discipline is the icon discipline: **material honesty** (the body derives from droplet physics — done, see [`DROPLET.md`](../../DROPLET.md) §II–§VI), **choreographed states** (every state the body can be in is named and rehearsed), **a spec with tolerances** (constants are pinned _and_ operating envelopes are closed), and **rehearsed proof** (the full state × angle tour renders deterministically, and every frame is shippable).

## Where the numbers live

This memo holds the rules. The numbers live in exactly one place: the canonical constants in [`packages/render-engine/src/spec.ts`](../../packages/render-engine/src/spec.ts) (`CANONICAL_CAMERA`, `CANONICAL_PERFORMANCES`) and the material/geometry constants in [`packages/render-engine/src/creature.ts`](../../packages/render-engine/src/creature.ts). Prose never restates a tunable number — restating creates a second copy that drifts. The doc describes; the constants specify; the proof contract enforces.

## What is frozen — the identity layer

The 2026-05-17 visual-truth audit ([`docs/doctrine/audits/2026-05-17-liquescent-visual-truth.md`](audits/2026-05-17-liquescent-visual-truth.md)) closed the identity layer. Its preserve list is canon: body transmission and IOR (the face-magnification signature), eye size / color / roughness (held-interior presence), the catch-light concept (aliveness), smile geometry (produces the emergent Motebit Smirk), interior eye placement, and the Rayleigh breathing eigenmode. Proposals against these are evaluated under [`attention-is-directional.md`](attention-is-directional.md)'s three questions and rejected if they flatten attention, animate the back, or remove the emergent oblique character.

Frozen means _frozen at the identity layer_. Composition, lighting integration, state choreography, and framing are the craft layer — legitimately tunable, on evidence, through the proof contract below.

## Canonical camera poses

Six named poses, defined once in `CANONICAL_CAMERA` and consumed by every surface — no surface re-encodes camera literals:

| Pose            | Role                                                             |
| --------------- | ---------------------------------------------------------------- |
| `front`         | The identity view — the default framing every surface boots into |
| `three_quarter` | Depth view — magnification gradient across the curvature         |
| `oblique`       | The Motebit Smirk view — the emergent in-between expression      |
| `profile`       | Shell view — the body as boundary                                |
| `back`          | The quiet view — correctly faceless; the being faces elsewhere   |
| `hero`          | The product shot — marketing, docs hero, social preview          |

Between poses there are no dead frames: the far eye keeps its catch-light through the arc, and the transitional regimes read as composed, not accidental.

## Named performances

Six named performances, defined once in `CANONICAL_PERFORMANCES` as pinned cue values + trust mode + pinned scene time. A performance is a rehearsed signature, not a parameter range:

| Performance | Signature                                                            |
| ----------- | -------------------------------------------------------------------- |
| `resting`   | The calm default — the state most of life is lived in                |
| `tending`   | Interior consolidation — slightly inward, dimmed, unhurried          |
| `listening` | The recording light — subtle iridescence oscillation, attentive eyes |
| `thinking`  | Interior luminosity — the volume fills with light; eyes lift         |
| `speaking`  | Breath and mouth in motion — energy without agitation                |
| `guarded`   | Trust made visible — desaturated, dimmed, thicker boundary           |

Cue formulas in `packages/behavior-engine` may drive the body continuously between these signatures at runtime; the named performances are the choreographed reference points the body is judged against. The audit's open question — compound cue over-amplification — is answered here structurally: any proposed cap or smoothing is A/B'd against these performances, never tuned by heuristic preference.

## The framing envelope

The IOR magnification of the face **is** the liquescent signature (audit pass 3) — but magnification has an operating envelope. **At every canonical pose, the magnified eyes hold clear margin inside the body's silhouette.** When a magnified eye touches the rim, the depth cue is lost and the percept flips from "interior structure held inside" to "dark marking painted on the surface" — the exact inversion [`attention-is-directional.md`](attention-is-directional.md) exists to prevent. Framing (camera distance, FOV) is chosen to keep the envelope closed; if a surface needs a tighter shot, the shot changes, never the doctrine.

## One light, one language

- **One world.** Environment presets are the same physical world at different times of day, not unrelated moods. The spectral gradient is continuous everywhere — a pixel discontinuity in the medium is a defect by definition ([`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) §V.1: the medium carries the chromatic field).
- **One highlight language in the eyes.** The two painted catch-lights are the aliveness signal (audit-preserved) and they are the _primary_ highlight language; environment specular on the eye material is subordinated so the eyes never speak two languages at once — mixed painted-plus-real highlights that disagree read as cheap and asymmetric.
- **Interior glow is an interior structure.** [`DROPLET.md`](../../DROPLET.md) §6.4: interior luminosity fills the volume and is visible through the boundary. A surface emissive wash on the transmissive shell is the anti-pattern — it flattens depth exactly when the body should look most alive. The glow is built the way the eyes are built: a structure inside the body that the boundary transmits.

## Dark environment acceptance criterion

The body is ~94% transmissive: **it is made of its environment.** A dark environment with no luminance structure gives the body nothing to transmit or reflect, and the creature reads dead — this is guaranteed by the material, not a tuning miss. Therefore:

- A dark preset ships only as a **designed night** — dark sky with a real key light (moon), cool horizon glow, enough structure for transmission and speculars to carry the body.
- Acceptance is proof, not preference: the dark preset's golden frames must show the face, the material character, and the breathing legibly.
- If no dark preset passes, surfaces pin the light environment. A live creature in a slightly-wrong-temperature world beats a dead creature in a matching one.

**Status (2026-07-07): passed.** `ENV_DARK` was redesigned in place as the designed night (moon key panel, moonlit horizon band, cool fill) and its golden frames (`front-resting-dark`, `front-thinking-dark`) show the face, catch-lights, material character, and interior glow legibly. The web surface's environment now follows the UI theme; mobile already switched via settings. The original near-black `ENV_DARK` was the proof of the criterion — the body read dead in it, exactly as the material predicts.

## The Motebit Smirk

At in-between angles the smile's meniscus curvature interacts with the body's refraction to produce an expression that is not visible straight-on and is not coded anywhere — it is what the geometry and the material do together. The mouth itself is a symmetric meniscus arc (DROPLET §IV Law 4, "the meniscus of mood"); the smirk's asymmetry exists only in projection, at oblique view. This is the face's emergent eigenmode, the same shape as the breathing mode (DROPLET §VI): the physics produces the behavior without being instructed. Preserve-listed: do not flatten it, do not make it visible from every angle, do not replace it with a coded expression.

**Naming (deliberated and affirmed 2026-07-07).** Two alternatives were tried against live renders the same day and retired: "the Meniscus Smile" (over-claims — the oblique percept is not a smile) and "the Sidelong" (abstains — names the viewing condition and teaches nothing). "Motebit Smirk" won on percept honesty (the render reads wry, knowing, private — colloquially a smirk), on ownability (a proper-noun compound carrying the brand; the quirk users discover and name to each other), and because the register risk lives in the render, not the word. The pinned reading is canon: **knowing, never smug — the look of an entity holding something for you, never a look at your expense.** If a render ever drifts toward contempt, that is a golden-frame regression to fix at the state layer, not a reason to rename. User-facing prose for the front expression stays "subtle curved smile" (the trade-dress language in [`TRADEMARK.md`](../../TRADEMARK.md)); "the Motebit Smirk" names the oblique emergent character specifically.

## Artifact zero

Calm software applied to pixels: **nothing snags the eye that wasn't intended.** Hard discontinuities in the medium, highlight asymmetries with no physical cause, dead-black eyes at supported angles, state transitions that pop — all are defects at the highest severity, because the body's coherence is the claim. The bar is not "no bugs"; it is "every frame of the canonical tour is a frame you would put on the homepage."

## The proof contract

The quality bar is executable, in two layers:

1. **Golden frames (test-enforced).** A deterministic harness renders the canonical pose × performance matrix — pinned time, blink disabled, pinned environment, pinned viewport — and diffs every build against committed reference frames in CI. "One body, one material" graduates from architecture claim to proven claim: every regression in the rendered body fails a build. Reference frames update only through the sanctioned refresh path, as a reviewed diff.
2. **Static canon gate (hard CI).** A drift gate verifies the canon constants exist, that every render surface consumes `CANONICAL_CAMERA` rather than re-encoding literals (the drift class that already produced a tone-mapping divergence on mobile), and that every canonical pose and performance appears in the golden matrix — a new performance cannot be added without golden coverage.

Together: the doctrine cannot silently rot ("citation-protection") and the pixels cannot silently rot (frame diff). The body self-verifies — the same move the release witness made for the npm package, extended from bytes to pixels.

## Cross-references

- [`attention-is-directional.md`](attention-is-directional.md) — the face's directionality rule this canon composes with
- [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) — the medium; the chromatic field the environment presets instantiate
- [`DROPLET.md`](../../DROPLET.md) — §IV Law 4 (presence, meniscus of mood), §V (material as character), §VI (animation as eigenmode)
- [`docs/doctrine/audits/2026-05-17-liquescent-visual-truth.md`](audits/2026-05-17-liquescent-visual-truth.md) — the audit that froze the identity layer and named the tuning surface
- [`TRADEMARK.md`](../../TRADEMARK.md) — the trade-dress description this canon must stay consistent with ("subtle curved smile")
- [[liquescent-not-glass]] — the body's ontology; glass optics borrowed, never glass being

## Drift defense

Two-layer, per the proof contract: the golden-frame harness (test-enforced defense — runs in the CI e2e job, too heavy for the check suite) and the static canon gate (hard CI, in the check suite). Both land with the harness increment of the 2026-07 creature-endgame arc; until the gate line exists in the drift-defenses inventory, this memo is the citation-protection.
