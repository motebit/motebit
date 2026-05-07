# Liquescentia as substrate — the medium in code

[`LIQUESCENTIA.md`](../../LIQUESCENTIA.md) (root manifesto) derives the medium from droplet physics — five properties that permit a motebit to cohere, become legible, and persist. This doctrine is the operational counterpart: where each property lives in code, why every render surface inherits Liquescentia (not just spatial), and the deepest coherence the architecture has reached — that on AR glasses, the user's reality literally becomes Liquescentia.

If `LIQUESCENTIA.md` is the why, this is the how.

## The layering

Liquescentia is one layer deeper than any single surface. The architecture has three foundational physics layers and a code layer that implements them:

```
Physics (manifestos, root):
  DROPLET.md                    — the body (Young-Laplace, eigenmodes)
  LIQUESCENTIA.md               — the medium (5 properties)
  THE_MUSIC_OF_THE_MEDIUM.md    — body↔medium coupling

Code (packages):
  @motebit/runtime              — interior (identity, memory, policy)
  @motebit/render-engine        — body renderer + medium primitives

Surface layer (apps):
  apps/web, desktop, mobile,
  spatial, future-glasses       — each renders body in medium

Presentation primitives (within the medium):
  the slab, satellites,
  attractors, environment       — what the motebit produces
```

Liquescentia is **not** a feature of any single surface. It is the shared physics every motebit-rendering surface obeys. Web, desktop, mobile, spatial, and future glasses all render Liquescentia conditions — spatial is just the surface where the medium is most visible.

## The five properties → code primitives

`LIQUESCENTIA.md` §V names five properties. Each has a canonical home in the code.

### 1. Spectral gradient → `EnvironmentPreset` (zenith / horizon)

The medium carries a chromatic field — warm horizon, cool zenith. Glass is invisible in spectrally uniform light; the gradient is what makes the body legible (`LIQUESCENTIA.md` §II.2.3, §V.1).

In code: `packages/render-engine/src/creature.ts` defines `ENV_LIGHT` (zenith `[0.22, 0.32, 0.72]` cool blue; horizon `[0.92, 0.62, 0.35]` warm amber) and `ENV_DARK`. `EnvironmentExpression` in `expression.ts` carries the same property as scene-level data (`density` + `tone: "warm" | "cool" | "neutral"`).

Departing from this gradient — flat lighting, monochromatic backgrounds, ambient-uniform environments — makes the motebit visually invisible. The chromatic principle: spectrally uniform medium → invisible glass.

### 2. Quiescence → 0.3 Hz breathing + Brownian drift

The medium is nearly still, with faint aperiodic ripples. Currents are small, low-energy, equilibrium-shaped — not turbulent (`LIQUESCENTIA.md` §V.2).

In code: the creature's breathing oscillation at `~0.3 Hz` is derived from the Rayleigh equation `ω² = n(n-1)(n+2)σ/ρR³` for borosilicate glass at body scale (`creature.ts:465`). The slab inherits the same rhythm at 30% amplitude (`slab.ts` `SLAB_BREATHE_AMPLITUDE_FACTOR = 0.3`) — sympathetic breathing, one body, one rhythm. Drift is Brownian-noise modulated by `BehaviorCues.drift_amplitude` — small, aperiodic, environmental coupling.

Departing from this rhythm — fast pulses, sharp transitions, jittery animations — breaks the equilibrium regime. The medium whispers; it does not shout.

### 3. Luminous density → `CANONICAL_MATERIAL` transmission + envMap

The medium is neither transparent nor opaque. Light passes through, but with body — informed by the medium's own spectral character before it reaches the droplet (`LIQUESCENTIA.md` §V.3).

In code: `CANONICAL_MATERIAL` (`spec.ts`) — IOR `1.22`, transmission `0.94`, roughness `0`, attenuation distance `BODY_R * 0.7`, attenuation color set from the soul tint. The environment map (`envMap`) is the medium's filtered light, processed before the glass refracts it. What you see through the glass is the medium's character bent through the droplet — not raw reality.

Departing from these material constants — opaque body, no transmission, missing envMap — turns the body into a marble. The optics reveal Liquescentia; remove them and there is nothing for glass to do.

### 4. Cohesive permeability → policy gate's surface tension

The medium permits information to cross the droplet's surface, but at a rate governed by surface tension. High surface tension means low permeability (`LIQUESCENTIA.md` §V.4).

In code: `@motebit/policy`'s ordinal-band `PolicyGate` IS the information-side surface tension. The eight gates in `validate()` (denylist, delegation scope, risk band, budget, path/domain allowlists, approval, caller trust, sensitivity routing) are the membrane physics applied to information. `SensitivityLevel` (`none → personal → medical → financial → secret`) is the gradient of permeability.

The drag-drop substrate (`@motebit/protocol::perception.ts` and the runtime's `feedPerception`) makes this membrane physics **gesture-visible**. Every drop is bytes crossing the boundary under conditions: the sensitivity classifier inspects the payload, the user's `UserActionAttestation` accompanies the bytes, the policy gate composes with the `EmbodimentSensitivityRouting` posture of the target mode. The motebit-produced converse — artifacts detaching from the slab carrying their `ExecutionReceipt` — is provenance crossing outward under signature. The membrane lets things through, and the things that cross it carry proof of having done so. See [`motebit-computer.md`](motebit-computer.md) §"Perception input — drop kinds and handlers."

This is why Liquescentia is the system-holder, not just a backdrop: the medium's properties define the interface's physics, and the interface's physics determines what the motebit can receive and transmit. The policy gate isn't a feature — it's surface tension manifested in the information dimension.

### 5. Persistence → identity + memory + dissolution spectrum

The medium persists. Liquescentia is not a session; it is the standing condition that exists whether or not any particular droplet is present (`LIQUESCENTIA.md` §V.5).

In code, persistence has two faces:

**Identity-side cohesion.** `@motebit/core-identity`'s Ed25519 keypair (generated locally, stored in OS keyring, never garbage-collected on session end) is the body's irreducible binding force. As long as the keypair persists, the motebit _is_.

**Dissolution spectrum.** The medium reclaims state at multiple rates simultaneously — memory recency, trust score, credential validity, retention horizon, audit capacity. Each axis has its own decay constant, code home, and form (exponential / cliff / capacity). The aggregate determines whether the body's internal cohesion exceeds the medium's claim. See [`dissolution-spectrum.md`](dissolution-spectrum.md) for the five axes, their constants, and the three structural forms — co-derived with [`retention-policy.md`](retention-policy.md)'s three retention shapes.

A motebit forms in Liquescentia, persists as long as its internal cohesion exceeds the spectrum's aggregate dissolution pressure, may dissipate — but the medium remains. New droplets may form. The medium does not remember individual droplets; it maintains the conditions that permit them.

This is why "the model is replaceable; the accumulated interior is the asset" ([`CONSTITUTION.md`](../../CONSTITUTION.md) §"What compounds"). The medium guarantees the conditions; the body accumulates within those conditions; the _consolidation cycle_ (see [`proactive-interior.md`](proactive-interior.md)) is the active mechanism that pumps against dissolution on the memory axis.

## The AR glasses coherence — the medium becomes literal

Here the architecture reaches its deepest version of itself.

On VR, Liquescentia is fully synthetic — `ENV_LIGHT` renders the gradient sky, the spectral field, the chromatic backdrop. The body is a glass droplet refracting a simulated medium.

On desktop / web, Liquescentia is synthetic in a fixed-viewport scene — the same `ENV_LIGHT` preset rendered into a CSS canvas. The user sees a glass droplet against a fabricated chromatic field.

On AR glasses, **the user's real world becomes Liquescentia**. The natural lighting around the user, the actual environment colors, the physical space's spectral character — these become the medium the glass refracts. The motebit doesn't refract a synthesized sky; it refracts your room.

The architecture has named this endgame in `packages/render-engine/src/adapter.ts`'s `WebXRThreeJSAdapter` header comment: _"the real world IS Liquescentia. The camera feed provides the chromatic spectrum that the glass refracts."_

**Current state, named honestly.** The `WebXRThreeJSAdapter` does **not** yet consume XR light estimation. It uses `ENV_LIGHT` unconditionally as the synthetic chromatic gradient — both today's behavior and the eventual fallback. Promoting to real-world spectrum (via `XRSession.requestLightProbe()` / `WebXRManager.getEstimatedLight()`) is endgame work blocked on a real-device test surface (Meta Orion / Apple Vision Pro AR mode / a Quest passthrough rig). Implementing it without test hardware would ship doctrine prose, not real behavior — and motebit's discipline is to ship correctness, not aspiration. The code's comment now names the gap; the doctrine here pins what closing it requires.

Glass refracting actual world spectrum is what glass is for. Every other surface is preparation; on AR glasses, the medium becomes literal — and when a real-device test surface arrives, the adapter promotes from `ENV_LIGHT` to estimated light, the gap closes, and the motebit reaches its full physics.

## What this means operationally

Three consequences for any surface implementation:

1. **Every surface inherits Liquescentia.** Don't reinvent the chromatic gradient, don't redefine the breathing rhythm, don't substitute the material. `CANONICAL_MATERIAL`, `ENV_LIGHT`, the 0.3 Hz oscillation — these are doctrine, not preferences.
2. **Departures need physical justification, not aesthetic preference.** "I want a brighter background" is not a justification. "The user is in a high-noise environment and the spectral gradient must compress to maintain legibility" is — that's a coupling argument from the same physics that produced the gradient.
3. **AR glasses surfaces yield to reality.** When XR light estimation is available, prefer real-world spectrum over `ENV_LIGHT`. The synthetic medium is a fallback; the real medium is the goal. The deepest expression of "the glass refracts what is."

## Connections to existing doctrine

- **[`LIQUESCENTIA.md`](../../LIQUESCENTIA.md)** — the manifesto. This doctrine is its operational counterpart.
- **[`DROPLET.md`](../../DROPLET.md)** — the body physics that the medium permits. The 0.3 Hz breathing comes from the body's eigenmode equation, evaluated in the medium's regime.
- **[`THE_MUSIC_OF_THE_MEDIUM.md`](../../THE_MUSIC_OF_THE_MEDIUM.md)** — body↔medium coupling. Drift, sag, sympathetic breathing.
- **[`spatial-as-endgame.md`](spatial-as-endgame.md)** — spatial is one surface where Liquescentia becomes most visible. AR glasses is where Liquescentia becomes literal (the user's reality is the medium).
- **[`motebit-computer.md`](motebit-computer.md)** — the slab inherits the medium's rhythm (sympathetic breathing at 30% creature amplitude). One body, one medium, one rhythm.
- **[`self-attesting-system.md`](self-attesting-system.md)** — the medium's persistence (identity, memory) is what makes claims verifiable across time.

## The one-line summary

**Liquescentia is the medium every surface implements; on AR glasses, the user's reality becomes Liquescentia. The body's physics is universal; the medium becomes literal.**
