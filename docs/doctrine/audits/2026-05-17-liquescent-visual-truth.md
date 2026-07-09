# Liquescent visual truth audit — 2026-05-17

> **Naming note (2026-07-07):** the name "the Motebit Smirk" was re-examined against live renders ("the Meniscus Smile" and "the Sidelong" were tried and retired the same day) and **affirmed as canon** — the deliberation and the pinned reading (knowing, never smug) live in [`creature-canon.md`](../creature-canon.md).

Reads the rendered body against the corrected doctrine (body is liquescent, glass-physics borrowed for optical traits only; one body, one material). Three passes — the framing inverts at pass 3.

**Pass evolution:**

- **Pass 1** (front-only evidence): named "eyes read as 3D marbles" as primary glass-character gap. Wrong-target framing — applied "liquescent = soft membrane" heuristic.
- **Pass 2** (multi-angle creature evidence): elevated eye-marble finding, proposed eye-material softening, called back-view "body's TRUE character." Doubled down on wrong-target framing.
- **Pass 3** (this pass — user-corrected): **inversion.** The front-face magnification IS the doctrine signature. Retracts eye-material candidates. Promotes Motebit Smirk to feature. Adds state-diff investigation for busy-vs-calm character (the legitimate remaining question after retraction).

The audit's evolution itself is the lesson: applying wrong target framing produces confident-but-inverted findings. The user's lived doctrine ("melting/merging held by surface tension") is the right target; the audit's "soft empty membrane" was a category drift.

## The corrected doctrine target

From DROPLET §V + §IV Law 4 + [[liquescent-not-glass]] + user's reframe:

> The body is liquescent — the interior face MELTED-AND-HELD through the boundary. The IOR magnification of the face IS the liquescent effect; the eyes are interior structures the body transmits because the material permits it; surface tension keeps them inside while making them visible from outside.

The visual target is **"powerful + cute + approachable + solves uncanny"**, NOT "soft empty membrane."

| View  | Doctrine role                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------- |
| Front | Doctrine WIN — face melted-and-held visible through liquescent body; primary identity                     |
| 3/4   | Doctrine WIN — face partially transmitted, magnification gradient across the curvature                    |
| Side  | Emergent **Motebit Smirk** — meniscus character produced by refraction at in-between angle                |
| Back  | Body shell alone (no interior on this side to transmit) — correctly empty-of-face; diagnostic, not target |

## Surfaces inspected

| Surface                   | Evidence source                 | Vision-backed?  |
| ------------------------- | ------------------------------- | --------------- |
| Creature front            | `social-preview.png` + live × 4 | ✅ yes          |
| Creature 3/4              | live capture                    | ✅ yes          |
| Creature side / smirk     | live capture                    | ✅ yes          |
| Creature back / oblique   | live capture                    | ✅ yes          |
| Creature front (cyan max) | live capture × 2                | ✅ yes (pass 3) |
| Empty slab                | —                               | ❌ not captured |
| Slab with content         | —                               | ❌ not captured |
| Docs hero (current)       | —                               | ❌ not captured |

The cyan-max-vibrancy renders are the load-bearing pass-3 evidence: soul color extends through the body, the face is held inside the colored volume, the IOR magnification interacts with the chromatic depth. This is the doctrine doing its job visibly.

## Features (promoted from "drift" or "incidental observation")

### Feature 1: Front-face IOR magnification

**What it does**: the body's IOR 1.22 + transmission 0.94 magnifies the eyes through the refractive boundary. The face reads as melted/merged into the body sides, held by surface tension. The catch-lights produce aliveness.

**Why pass 1+2 misread it**: applied "liquescent = soft membrane" target. Read magnification as "glass marble" character. Wrong target — magnification IS the doctrine.

**Doctrine roots**: DROPLET §V.1 ("Glass does not hide what is inside — it transmits it"), §IV Law 4 ("the eyes are not on the surface, they are inside it; interiority made legible"). The magnification + held-inside character literally IS this doctrine rendered.

**Status**: load-bearing. Do not soften.

### Feature 2: The Motebit Smirk

**What it does**: at in-between angles between full-front and full-side, the smile + body curvature produce a SMIRK character that's not visible from straight-on. The smirk emerges from optics; it's not coded.

**Mechanism**: smile's meniscus curvature + body's IOR refraction at oblique view + viewing-angle-dependent specular = emergent expressive character.

**Doctrine roots**: DROPLET §IV Law 4 (meniscus of mood) + §VI emergent eigenmodes (the body's physics producing the right behavior without being instructed). Pass 2 noted the smirk; pass 3 elevates it.

**Status**: load-bearing emergent feature. Do not flatten or "fix" by making smirk visible from all angles — that would remove the EMERGENT-from-physics character that makes it feel alive.

### Feature 3: Aliveness via catch-lights

**What it does**: two static white spheres per eye (per `creature.ts:308-326`) produce fixed bright catch-lights. They don't respond to lighting — they're MeshBasicMaterial unlit. They make the eyes feel ALIVE rather than dead-marble.

**Why pass 1+2 misread it**: read "crisp + bright" as glass-character. Wrong target — the crispness IS the aliveness signal.

**Status**: load-bearing. Do not soften as default. May be worth tuning IF specific state-busy combinations produce too-busy compound effects (see open QA below).

## State-diff investigation — busy-vs-calm character

User showed two moonlight renders, one busier (Image 1) and one calmer (Image 2). Pass-3 read `creature.ts:421-558` animation loop to identify what cues drive the difference.

### Cue → visual effect map

| Cue               | Effect on "busy" reading                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eye_dilation`    | **PRIMARY.** `baseEyeScale = 0.8 + eye_dilation × trustEyeMax`; Full trust caps eye scale at 1.2 (vs 0.92 at rest dilation 0.3) — bigger eyes carry bigger catch-lights (catch-lights are children of eye group, scale together) |
| `glow_intensity`  | **SECONDARY.** Triggers eye lift (+0.03 above threshold 0.4); bigger breath amplitude (`0.012 + glow_intensity × 0.008`); emissive flares above 0.4                                                                              |
| `audio.rms`       | Audio reactivity bumps breath amplitude up to 250%                                                                                                                                                                               |
| `audio.high`      | Iridescence shimmer (sibilants / transients)                                                                                                                                                                                     |
| `audio.low`       | Emissive glow bump                                                                                                                                                                                                               |
| `audio.mid`       | Drift bump                                                                                                                                                                                                                       |
| `listeningActive` | 1Hz iridescence oscillation (visual recording light)                                                                                                                                                                             |
| `smile_curvature` | Eye squint (subtracts from eyeScale by `max(0, smile) × 0.3`)                                                                                                                                                                    |
| `trustMode`       | Minimal caps eye dilation max at 0.2 (vs 0.4 Full/Guarded) + suppresses emissive glow entirely                                                                                                                                   |

### Key finding from code

**Catch-lights are STATIC.** `creature.ts:308-326` — they're `MeshBasicMaterial` unlit white spheres at fixed positions. They never scale or change material with state.

What APPEARS as "busier catch-lights" is actually **bigger eyes carrying same catch-lights**. The eye group scales with `eye_dilation`; the catch-lights (children of that group) scale with it. So "busy catch-lights" decomposes to "high eye_dilation."

This means **the catch-lights themselves are not the busy signal**. Eye SIZE (driven primarily by dilation, secondarily by smile squint) is.

### Default rest state (from `createCreatureState`)

```ts
smoothedCues: {
  hover_distance: 0.4,
  drift_amplitude: 0.02,
  glow_intensity: 0.3,    // ← below 0.4 threshold, no eye lift, no emissive
  eye_dilation: 0.3,      // ← baseEyeScale = 0.8 + 0.3 × 0.4 = 0.92
  smile_curvature: 0,
  speaking_activity: 0,
}
```

At rest the body sits at calm baseline: eye_dilation 0.3 (eye scale 92%), glow 0.3 (no emissive), no audio. The "calm" character (Image 2 territory) is the default.

The "busy" character (Image 1 territory) emerges when external state pushes cues higher — high curiosity (eye_dilation toward 1.0), processing (glow above 0.4), audio reactivity, listening, etc.

## Open visual QA questions (NOT changes — investigations)

These remain legitimate even after the inversion:

1. Do specific state combinations produce compound over-amplification? (e.g., high `eye_dilation` + high `glow_intensity` + audio reactive + listening active simultaneously)
2. Should there be a cap or smoothing on compound amplification, so individual cues can range freely but their joint effect doesn't overwhelm?
3. Are there UI/runtime paths that hold `eye_dilation` higher than the doctrine intends, by mistake (e.g., always-on attention)?
4. Does the iridescence audio-reactivity (`audioShimmer = audio.high * 0.35`) read as alive or as noise during music?

These are answered through A/B at known cue values, NOT through unilateral material changes.

## Retractions from pass 2

The following are retracted in full — pass 2 was applying wrong target:

| Pass-2 candidate                          | Status     | Reason                                                               |
| ----------------------------------------- | ---------- | -------------------------------------------------------------------- |
| Eye `roughness: 0.05 → 0.30`              | ❌ RETRACT | Would reduce held-interior magnification — kills the doctrine effect |
| Catch-light softening as default          | ❌ RETRACT | Would reduce aliveness — pushes toward ghost                         |
| Eye `color: 0x080808` → lifted            | ❌ RETRACT | Would reduce face presence — pushes toward ghost                     |
| Eye `EYE_R: 0.035 → 0.030` (smaller eyes) | ❌ RETRACT | Would reduce doctrine power                                          |
| "Back view reveals true character"        | ❌ RETRACT | Back is diagnostic-only; preferring it was empty-shell aesthetic     |
| "Body reads too glass-like (front views)" | ❌ RETRACT | What was called "too glass-like" IS the doctrine in action           |
| "70% of drift concentrates in eyes"       | ❌ RETRACT | Made up; no measurement basis                                        |

## Still on the table (lower priority, doctrine-uncertain)

| Pass-2 candidate                      | Status       | Why uncertain                                                 |
| ------------------------------------- | ------------ | ------------------------------------------------------------- |
| Body `clearcoat: 0.4 → 0.25-0.30`     | 🤷 UNCERTAIN | Pass-3 cyan renders show body specular as alive, not too hard |
| Body `iridescence: 0.4 → 0.30`        | 🤷 UNCERTAIN | Only signal was back-view "softness" which is anti-target     |
| Doctrine-edge: rest emissive nonzero  | 🤷 DOCTRINE  | Open doctrine question, not material decision                 |
| Doctrine-edge: literal-zero roughness | 🤷 DOCTRINE  | Open doctrine question, not material decision                 |

## Non-changes to preserve (expanded)

Pass 3 confirms + expands the preserve list:

- `transmission: 0.94` — critical liquescent
- `ior: 1.22` — the face magnification
- **Eye `roughness: 0.05`** (NEW PRESERVE) — produces alive eye character
- **Eye `color: 0x080808`** (NEW PRESERVE) — produces dark interior presence
- **Catch-light spheres** (NEW PRESERVE) — produce aliveness, solve uncanny
- **Eye sphere geometry `EYE_R: 0.035`** (NEW PRESERVE) — produces the melting-merging magnification
- `attenuationDistance + attenuationColor` from soul tint — luminous depth + identity expression
- Silhouette curvature (meniscus)
- Eye position inside body (interior, not surface)
- 0.3 Hz Rayleigh-derived breathing + sag asymmetry
- **Smile geometry as currently shipped** (NEW PRESERVE) — produces the emergent Motebit Smirk at oblique angles

## Audit conclusions (pass 3)

1. **Pass 2's eye-material candidate change list was applying wrong target.** Retracted in full.
2. **Front-face IOR magnification IS the doctrine signature.** Promoted to feature.
3. **The Motebit Smirk is an emergent doctrine feature** — visible at in-between angles via refraction × meniscus interaction. Promoted to feature.
4. **No material changes recommended** at the audit-evidenced level. The body, eye material, and catch-lights are doctrinally correct as rendered.
5. **Open question remains state-busyness** — whether specific compound cue combinations over-amplify. State-diff investigation identifies `eye_dilation` (primary) + `glow_intensity` (secondary) + audio cues + `listeningActive` as the busy-driving levers.
6. **If future tuning happens, it targets the STATE layer** (cue caps, compound smoothing) — NOT the material layer.

**Operating rule going forward**: protect the identity, then only tune state-specific excess if evidence shows it. The doctrine (identity layer) is canonical; state tuning (modulation layer) is permitted only on evidence, never on heuristic preference.

## Follow-on work

1. A/B capture with known cue values: low/med/high `eye_dilation` × low/med/high `glow_intensity` × audio on/off × listening on/off. Identify whether specific compound states produce over-busy reading.
2. Identify if any default-state code-paths in `apps/web` / `apps/desktop` / `apps/mobile` hold cues higher than the doctrine intends.
3. Capture empty slab + slab-with-content for the slab membrane finding.
4. Capture current docs-hero post-bridge to close that pending view.

Pass 3's framing — face is doctrine, smirk is feature, state is the only legitimate tuning surface — is the right starting point for any future visual-craft work.

## Doctrine crystallized — [`attention-is-directional.md`](../attention-is-directional.md)

The rule pass 3 surfaced has been crystallized as canonical doctrine at [`docs/doctrine/attention-is-directional.md`](../attention-is-directional.md): **the body is omnidirectional; attention is directional**. The face lives in the front hemisphere by geometry; the body's omnidirectional material refracts it from any angle it's visible at; angular falloff happens naturally. Anti-patterns explicitly forbidden (camera-facing eyes, 360° face texture, back-view eye glow, shell-only optimization). Cross-referenced from DROPLET §IV Law 4 and CLAUDE.md doctrine index. Future visual-craft work cites this memo as the rule it must respect.
