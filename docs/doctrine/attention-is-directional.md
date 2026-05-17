# Attention is directional

**The body is omnidirectional. Attention is directional.**

The motebit's liquescent body refracts, attenuates, breathes, and holds from every angle. Its face does not. The face is not a texture wrapped around the sphere, nor an interface that follows the camera. It is the visible expression of attention's direction — interior structures held in the front hemisphere, made legible through the body's transmissive boundary.

## What lives at 360° vs front

| Element                | 360°?        | Reason                                                                                         |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| Liquescent body        | Yes          | Material, refraction, attenuation, surface tension, breathing are properties of the whole body |
| Interior volume        | Yes          | The body always has depth                                                                      |
| Glow / interior warmth | Yes          | Internal energy fills the volume; visible through the body from any angle                      |
| Face / eyes / smile    | **No**       | The face expresses attention; attention has direction                                          |
| Motebit Smirk          | Transitional | Emerges at oblique angles from refraction × meniscus; not painted everywhere                   |
| Back view              | No face      | The back is quieter because the being faces elsewhere                                          |

## Implementation — geometric, not shader-based

The face's directionality is geometric, not shader-based. In [`packages/render-engine/src/creature.ts`](../../packages/render-engine/src/creature.ts) at the eye-position calls:

```ts
leftEye.position.set(-0.055, 0.015, 0.08); // x left of center, slight y up, z forward
rightEye.position.set(0.055, 0.015, 0.08); // x right of center, slight y up, z forward
```

The body's omnidirectional `MeshPhysicalMaterial` (transmission `0.94`, IOR `1.22`) refracts the eyes from any angle they're geometrically visible at. The angular falloff happens naturally — there is no shader, no opacity curve, no rotation rig:

- **0° front** — full face magnification; the doctrine identity. The face appears melted-and-held inside the body by surface tension
- **30° 3/4** — face partially transmitted; magnification gradient across the body curvature
- **60° side** — one eye partially visible; emergent **Motebit Smirk** from refraction × meniscus interaction
- **90°+ profile** — face mostly occluded; body shows as shell with refraction
- **180° back** — no face visible; body shows as pure boundary

This is the doctrine in code: the face IS at the front, the body refracts whatever it's positioned to refract.

## Anti-patterns (do NOT do these)

These violate the doctrine and should be rejected when proposed:

- **Camera-facing eyes** — turns the being into a UI billboard following the viewer. Removes orientation.
- **360° face texture / face-wrapped sphere** — turns the body into a haunted ball. The face becomes data projected onto the surface rather than interior structure transmitted through it.
- **Back-view eye glow / "soft eyes visible from behind"** — destroys attentional direction. If attention is omnidirectional, the being has no front.
- **"Fixing" the back because it feels empty** — the back is correctly quiet. The being is facing elsewhere. Adding back-features is the wrong response to the empty reading.
- **Optimizing toward shell-only calmness as the hero target** — removes the interior face that makes the body alive. Shell-alone is diagnostic, never identity.
- **Making the Motebit Smirk visible from every angle** — removes the emergent-from-physics character. The smirk is supposed to emerge from refraction at oblique view; making it always-on flattens it into a coded expression rather than an optical signature.

## Why this matters

The being has a front because attention has a direction.

A sphere with face-texture-wrapped-360° is a sphere with face data projected everywhere — not a being. A being can FACE you. Removing that direction flattens it into a gimmick.

> **Motebit's face is not a bug. It is the interior made visible through a liquescent boundary.**

This one-liner is the canonical anti-restatement of any "soften the face" / "less eyes" / "calmer back" proposal. The face is doctrine, not drift.

This is doctrine-load-bearing. Future proposals that touch the face's rendering should be evaluated against three questions:

1. Does this require attention to be omnidirectional? (anti-pattern — reject)
2. Does this require the back to express attention? (anti-pattern — reject)
3. Does this remove the emergent oblique-angle smirk? (anti-pattern — reject)

If a proposal does none of these, it may proceed. If a proposal does any of these, it violates this doctrine.

## The Motebit Smirk as emergent feature

The smile + body curvature produce a smirk character at in-between angles that's not visible from straight-on. The smirk emerges from optics — smile's meniscus curvature interacting with body's IOR refraction at oblique view. It is not coded; it is what the geometry + material produce together.

This is the same shape as the breathing eigenmode (DROPLET §VI.1) — the body's physics produces the right behavior without being instructed. The Motebit Smirk is the face's equivalent: an emergent expressive character from refractive interaction. Preserve.

## The visual audit's lesson

The 2026-05-17 visual truth audit ([`docs/doctrine/audits/2026-05-17-liquescent-visual-truth.md`](audits/2026-05-17-liquescent-visual-truth.md)) went through three passes before landing this rule. Passes 1 + 2 applied a "liquescent = soft membrane" target and read the front-face magnification as drift toward glass-marble. Pass 3 inverted: the magnification IS the liquescent doing its job; the back-quietness is intentional; the rule is "body omnidirectional, attention directional."

This memo crystallizes the rule that pass 3 surfaced, so future audits don't have to re-discover it and future contributors have a citable doctrine to evaluate proposals against.

## Cross-references

- [`DROPLET.md`](../../DROPLET.md) §IV Law 4 — "Attention gives it a facing" (the foundational line this memo elaborates)
- [[liquescent-not-glass]] — the body's ontology this rule depends on; the liquescent body is what makes the face visible-from-front possible
- [`motebit-computer.md`](motebit-computer.md) — the slab is also directional (extends from the body toward the user, not in all directions)
- [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) — the medium that makes the body's refraction work; the chromatic gradient is what gives the face its visible character
- [`docs/doctrine/audits/2026-05-17-liquescent-visual-truth.md`](audits/2026-05-17-liquescent-visual-truth.md) — the three-pass audit that surfaced this rule

## Drift defense

**None yet.** A drift gate may be appropriate IF specific anti-pattern violations emerge in code (e.g., a PR proposing `lookAt(camera)` on the eye group, or a 360° face texture). Until then, this doctrine memo is citation-protection — the rule lives in the doctrine and can be cited back against violating proposals.

If a violation pattern recurs, the right defense is a drift gate forbidding:

- `lookAt(camera)` or similar camera-tracking on face elements
- Eye position assignments outside the front hemisphere
- Face texture material on the body sphere

These should be added only when a real recurrence justifies them, per the [drift-defense stratification doctrine](../drift-defenses.md). Until then, citation-protection from this memo is the defense.
