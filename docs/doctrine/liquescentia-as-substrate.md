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

`CANONICAL_MATERIAL` (`spec.ts`): IOR `1.22`, transmission `0.94`, roughness `0`, attenuation distance `BODY_R * 0.7`, attenuation color set from the soul tint. The environment map (`envMap`) is the medium's filtered light, processed before the liquescent body refracts it.

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

On VR and web/desktop, Liquescentia is fully synthetic (`ENV_LIGHT` renders the gradient). On AR glasses, **the user's real world becomes Liquescentia** — natural lighting, environment colors, physical spectral character become the medium the liquescent body refracts.

The architecture names this endgame in `packages/render-engine/src/adapter.ts`'s `WebXRThreeJSAdapter` header comment: _"the real world IS Liquescentia. The camera feed provides the chromatic spectrum the liquescent body refracts."_

**Current state:** the adapter uses `ENV_LIGHT` unconditionally as both today's behavior and the eventual fallback. Promotion to real-world spectrum (via `XRSession.requestLightProbe()` / `WebXRManager.getEstimatedLight()`) is endgame work blocked on a real-device test surface (Vision Pro AR mode / Quest passthrough rig). The code's comment names the gap; this doctrine pins what closing it requires.

**Renderer promotion — WebGL → WebGPU.** The renderer itself promotes from Three.js `WebGLRenderer` to `WebGPURenderer` (in the `three/webgpu` namespace). Apple shipped WebGPU in Safari 26 (June 2025) on visionOS / iOS 26 / iPadOS 26 / macOS Tahoe; combined with Chrome (since 2023), Edge, and Firefox (2025), WebGPU's by-default availability is now ~70% globally — production-ready for the slab's hero surfaces.

The migration is **lower-risk than the conservative framing implies**. Three.js's `WebGPURenderer` ships with TSL (Three Shader Language), which transpiles to WGSL or GLSL depending on the runtime backend. Same scene graph, same materials, same physics — the slab's contract (Ring 1) is identical across both renderers; only the renderer instance swaps at the `RenderAdapter` seam. The "parallel-implementation tax" that would justify deferring doesn't exist if motebit stays on Three.js (which it should — re-platforming off Three.js is not in scope here).

Three triggers can fire the migration, ordered by leverage:

1. **`apps/spatial` lands on Vision Pro hardware.** WebGPU is the canonical visionOS WebXR rendering API; alignment is forced. The original sole trigger this doctrine named.
2. **A render artifact demands compute shaders.** Real fluid sim for the pinch animation, particle systems for memory surfacing, advanced post-processing — WebGL has no compute path.
3. **Voluntary endgame.** Once the slab's visual character is stable and the consumer-side product surface is shipping, a pre-emptive renderer migration is defensible on its own merits: cleaner API, future-aligned, no parallel maintenance. No technical waiting required.

Cross-browser fallback handled by Three.js auto-detection (`createRenderer({ forceWebGL: false })`). The ~15% long tail (older Firefox, some Android, Intel macOS) continues on WebGL automatically. **The capture pipeline migration (JPEG → WebCodecs `VideoDecoder` + `importExternalTexture`) is separate end-game work that lives at the screencast layer**, not the renderer layer — see [`motebit-computer.md`](motebit-computer.md) §"Compositing — content vs chrome split" for that pin. Renderer and capture migrate independently on their own triggers.

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
