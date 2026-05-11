# Liquescentia as substrate — the medium in code

[`LIQUESCENTIA.md`](../../LIQUESCENTIA.md) derives the medium's five properties from droplet physics. This doctrine maps each property to its canonical code home and names the AR-glasses endgame.

Liquescentia is the shared physics every motebit-rendering surface obeys. Web, desktop, mobile, spatial, and future glasses all render Liquescentia conditions — spatial is the surface where the medium is most visible, but the physics inherits everywhere.

## Five properties → code primitives

### 1. Spectral gradient → `ENV_LIGHT`

The medium carries a chromatic field — warm horizon, cool zenith. Glass is invisible in spectrally uniform light; the gradient makes the body legible.

`packages/render-engine/src/creature.ts` defines `ENV_LIGHT` (zenith `[0.22, 0.32, 0.72]` cool blue; horizon `[0.92, 0.62, 0.35]` warm amber) and `ENV_DARK`. `EnvironmentExpression` in `expression.ts` carries the same property as scene-level data (`density` + `tone: "warm" | "cool" | "neutral"`).

Flat lighting, monochromatic backgrounds, ambient-uniform environments make the motebit invisible. Spectrally uniform medium → invisible glass.

### 2. Quiescence → 0.3 Hz breathing + Brownian drift

The medium is nearly still, with faint aperiodic ripples. Currents are small, low-energy, equilibrium-shaped.

The creature's breathing oscillation at `~0.3 Hz` is derived from the Rayleigh equation `ω² = n(n-1)(n+2)σ/ρR³` for borosilicate glass at body scale (`creature.ts:465`). The slab inherits at 30% amplitude (`slab.ts` `SLAB_BREATHE_AMPLITUDE_FACTOR = 0.3`) — sympathetic breathing, one body, one rhythm. Drift is Brownian noise modulated by `BehaviorCues.drift_amplitude`.

Fast pulses, sharp transitions, jittery animations break the equilibrium regime. The medium whispers.

### 3. Luminous density → `CANONICAL_MATERIAL` + envMap

Neither transparent nor opaque. Light passes through with body — informed by the medium's spectral character before it reaches the droplet.

`CANONICAL_MATERIAL` (`spec.ts`): IOR `1.22`, transmission `0.94`, roughness `0`, attenuation distance `BODY_R * 0.7`, attenuation color set from the soul tint. The environment map (`envMap`) is the medium's filtered light, processed before the glass refracts it.

Opaque body, no transmission, missing envMap → marble. The optics ARE Liquescentia.

### 4. Cohesive permeability → policy gate's surface tension

The medium permits information to cross the droplet's surface at a rate governed by surface tension. High surface tension → low permeability.

`@motebit/policy`'s ordinal-band `PolicyGate` IS the information-side surface tension. The eight gates in `validate()` (denylist, delegation scope, risk band, budget, path/domain allowlists, approval, caller trust, sensitivity routing) are membrane physics applied to information. `SensitivityLevel` (`none → personal → medical → financial → secret`) is the gradient of permeability.

The drag-drop substrate (`@motebit/protocol::perception.ts` + the runtime's `feedPerception`) makes membrane physics gesture-visible. Every drop is bytes crossing the boundary under conditions: classifier inspects the payload, `UserActionAttestation` accompanies the bytes, the gate composes with the target mode's `EmbodimentSensitivityRouting`. The converse — artifacts detaching from the slab carrying their `ExecutionReceipt` — is provenance crossing outward under signature. See [`motebit-computer.md`](motebit-computer.md) §"Perception input."

The policy gate isn't a feature — it's surface tension manifested in the information dimension.

### 5. Persistence → identity + memory + dissolution spectrum

The medium persists. Liquescentia is the standing condition that exists whether or not any particular droplet is present.

**Identity-side cohesion.** `@motebit/core-identity`'s Ed25519 keypair (generated locally, stored in OS keyring, never garbage-collected on session end) is the body's irreducible binding force.

**Dissolution spectrum.** The medium reclaims state at multiple rates simultaneously — memory recency, trust score, credential validity, retention horizon, audit capacity. See [`dissolution-spectrum.md`](dissolution-spectrum.md) for the five axes, their constants, and the three structural forms (exponential / cliff / capacity).

The consolidation cycle (see [`proactive-interior.md`](proactive-interior.md)) is the active mechanism that pumps against dissolution on the memory axis.

## AR glasses — the medium becomes literal

On VR and web/desktop, Liquescentia is fully synthetic (`ENV_LIGHT` renders the gradient). On AR glasses, **the user's real world becomes Liquescentia** — natural lighting, environment colors, physical spectral character become the medium the glass refracts.

The architecture names this endgame in `packages/render-engine/src/adapter.ts`'s `WebXRThreeJSAdapter` header comment: _"the real world IS Liquescentia. The camera feed provides the chromatic spectrum that the glass refracts."_

**Current state:** the adapter uses `ENV_LIGHT` unconditionally as both today's behavior and the eventual fallback. Promotion to real-world spectrum (via `XRSession.requestLightProbe()` / `WebXRManager.getEstimatedLight()`) is endgame work blocked on a real-device test surface (Vision Pro AR mode / Quest passthrough rig). The code's comment names the gap; this doctrine pins what closing it requires.

**Renderer promotion — WebGL → WebGPU.** Alongside the light-source promotion, the spatial surface promotes the renderer itself from WebGL (Three.js `WebGLRenderer`) to WebGPU (`WebGPURenderer` in the `three/webgpu` namespace). Apple shipped WebGPU in Safari 26 (June 2025) on visionOS; it is the canonical visionOS WebXR rendering API going forward. Same scene graph, swap the renderer at the `RenderAdapter` seam, same physics — the slab's contract (Ring 1) is identical across both renderers. The trigger isn't aesthetic; the trigger is `apps/spatial` landing on real Vision Pro hardware, where alignment with the platform's WebXR canonical API is forced. Until then, WebGL stays the working renderer everywhere and WebGPU is a future backend on the existing adapter, not a parallel interface (see [`motebit-computer.md`](motebit-computer.md) §"Compositing — content vs chrome split").

## Operational consequences

1. **Every surface inherits Liquescentia.** Don't reinvent the chromatic gradient, don't redefine the breathing rhythm, don't substitute the material. `CANONICAL_MATERIAL`, `ENV_LIGHT`, the 0.3 Hz oscillation — doctrine, not preferences.
2. **Departures need physical justification, not aesthetic preference.** "I want a brighter background" isn't a justification. "The user is in a high-noise environment and the spectral gradient must compress to maintain legibility" is — that's a coupling argument from the same physics that produced the gradient.
3. **AR surfaces yield to reality.** When XR light estimation is available, prefer real-world spectrum over `ENV_LIGHT`. The synthetic medium is a fallback; the real medium is the goal.

## Cross-cuts

- [`LIQUESCENTIA.md`](../../LIQUESCENTIA.md) — the manifesto. This doctrine is its operational counterpart.
- [`DROPLET.md`](../../DROPLET.md) — the body physics the medium permits. 0.3 Hz comes from the body's eigenmode equation evaluated in the medium's regime.
- [`THE_MUSIC_OF_THE_MEDIUM.md`](../../THE_MUSIC_OF_THE_MEDIUM.md) — body↔medium coupling. Drift, sag, sympathetic breathing.
- [`spatial-as-endgame.md`](spatial-as-endgame.md) — spatial is where Liquescentia is most visible. AR glasses is where it becomes literal.
- [`motebit-computer.md`](motebit-computer.md) — the slab inherits the medium's rhythm at 30% creature amplitude.
- [`self-attesting-system.md`](self-attesting-system.md) — identity + memory persistence is what makes claims verifiable across time.
