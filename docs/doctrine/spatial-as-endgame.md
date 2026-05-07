# Spatial as endgame — the AR-glasses companion thesis

The motebit's spatial surface is not "AR/VR/WebXR generically." It is the **prototype of the AR-glasses companion** — the form factor that, on a 5–10 year horizon, replaces the phone the way the phone replaced the flip phone. Every pattern developed in the spatial surface is load-bearing for that endgame. Discipline there, not preciousness.

This doctrine pins what spatial is for, why motebit's architecture is naturally a glasses architecture, and the operational rules that follow — including a fifth spatial primitive (presentation) the original "no panels" rule was missing.

## The form-factor thesis

Phones replaced flip phones because **always-with-you** beat **phone-when-you-need-it**. Whatever replaces phones must satisfy a stricter constraint: hands-free, eyes-up, in-context. That eliminates watches (too small), earpieces (voice-only), brain interfaces (decades out). It leaves AR glasses — the only candidate combining high information bandwidth with low interruption cost.

This is not speculation. Apple Vision Pro proved the paradigm (form factor wrong, paradigm right). Meta's Orion prototype demonstrated all-day AR is technically feasible. Apple, Meta, Google, and Snap are all spending billions on glasses programs because they see the same trajectory. The bet isn't "AR glasses might happen." It's "if anything replaces phones, AR glasses are the strongest candidate."

The motebit ships into a world where this transition is in progress. Today's surfaces (web, desktop, mobile) are bridges to the eventual glasses surface. The spatial surface is where we develop the patterns that will become the glasses patterns.

## Why motebit's architecture is naturally a glasses architecture

Motebit's principles read **more true** on glasses than on any other surface. This is not coincidence — it is convergent design. Whoever builds a sovereign agent companion ends up at this architecture, because the constraints of a daily-companion-on-glasses force them.

| Principle                                                                      | On phone / desktop                | On AR glasses                                                                                                                                             |
| ------------------------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Persistent sovereign identity**                                              | Useful — multi-device sync        | **Mandatory** — no reauth per glance, per payment, per overlay                                                                                            |
| **Memory**                                                                     | Helpful — context across sessions | **The killer feature** — your glasses see your life; the agent's memory is what makes it valuable                                                         |
| **Calm software**                                                              | Differentiation                   | **Survival** — intrusive AR is unwearable                                                                                                                 |
| **Surface tension at the boundary**                                            | Conceptual                        | **Literal** — when content overlays reality, the boundary between "yours" and "platform's" is visceral                                                    |
| **Sensitivity routing** (medical / financial / secret never reach external AI) | Privacy-respecting                | **Existential** — your glasses see medical info, financial info, intimate moments. Sovereign processing is the precondition for the device being wearable |
| **Adapter pattern** (LLM is replaceable)                                       | Forward-looking                   | **Required** — daily perception cannot be locked to one provider                                                                                          |
| **Sovereign interior, governed boundary**                                      | Architecturally clean             | **The product itself** — the glasses surface is the membrane between you and the world                                                                    |
| **Settlement at the edge**                                                     | Future-looking                    | **Ambient micropayments** — every interaction has a cost; the agent paying on your behalf is the only sustainable model                                   |

The motebit isn't a generic agent that happens to work on glasses. The architecture is **shaped to be the glasses companion**. Every other surface is preparation.

## What "spatial as proto" means operationally

The spatial surface today (`apps/spatial`) is not a feature for VR enthusiasts or a hedge against future tech. It is the **prototype of the production glasses surface**. Three operational consequences:

1. **Build for the glasses paradigm explicitly.** Voice-first, gaze-anchored, gesture-secondary, ambient-presence, world-aware. Not VR-game HUDs. Not desktop-app window managers. Not phone-app rectangles in 3D space.
2. **Higher discipline, not lower.** Spatial gets a higher bar than other surfaces, not a lower one. Mistakes here will rot the production glasses surface when it ships. Patterns developed here are load-bearing.
3. **Sacred ≠ exempt.** Spatial still must ship at proto quality. The discipline is **rigor** (the patterns we develop here will be the production patterns), not **preciousness** (this can't be touched because it's the future). Drift gates apply. Sibling-boundary applies. Coverage applies.

## The five spatial primitives

The original doctrine named four primitives — creature, satellite, environment, attractor — and forbade "panels." That rule was reacting to a real failure mode (VR-game HUDs and 2D-dashboard cargo-cult), but it missed a fifth primitive essential to the companion-on-glasses thesis: **presentation**.

| Primitive        | What it is                                                         | Anchored to               |
| ---------------- | ------------------------------------------------------------------ | ------------------------- |
| **Creature**     | The motebit's body. Identity, mood, attention.                     | Self                      |
| **Satellite**    | Receipts, credentials, signed events orbiting the creature.        | Creature's orbit          |
| **Environment**  | Memory as ambient backdrop; the spectral medium.                   | The scene around the user |
| **Attractor**    | Goals — locations the motebit is drawn toward.                     | User's spatial intent     |
| **Presentation** | Surfaces the motebit shows you: pages, terminals, tools, the slab. | The motebit's gesture     |

Presentation is the primitive that lets the motebit act as a **bridge** to the spatial OS (Apple visionOS, Meta Horizon OS, future glasses OS). When the user says "show me that paper," the motebit reaches and presents — a held-tablet, a satellite-orbiting page, a brought-into-view artifact. The surface emerges _from the motebit's gesture_ and recedes when work ends.

This is not "panel" in the desktop sense. A desktop panel floats independently, summoned by a window manager. A motebit presentation is **anchored to the creature's act of showing** — it has a source, it has a duration, it returns to absence when its purpose is served.

## The refined "no panels" rule

> **Surfaces emerge from the motebit's gesture and recede when work ends.**
>
> The creature is the source; surfaces are presented, held, shown. Disconnected window-manager panels — surfaces with no relationship to the creature's body or attention — remain the anti-goal. Surfaces _anchored to the motebit's act of presentation_ are how the motebit acts inside the spatial OS.

Three concrete tests for any proposed surface:

1. **Does the motebit summon it, or does the user?** Window manager → wrong. Motebit-presents → right. (User-summoned overlays are fine _if_ the motebit is the summoning agent — e.g., user voice-commands "show me the receipt," motebit presents.)
2. **Is it anchored to the creature, or floating in user-space?** Anchored → right. Free-floating → wrong.
3. **Does it recede when work ends, or persist as chrome?** Recede → right. Persist → wrong.

A held-tablet the motebit shows passes all three. An always-on dashboard at the corner of vision fails all three.

## Failure modes specific to the glasses target

- **VR-game HUD.** Heads-up display blasting attention. Persistent statuses, fixed-position overlays, "always-on" chrome. Survives in games because the user opted into immersive entertainment; lethal in a daily companion.
- **Desktop window manager.** Floating panels summoned by user gesture, rearranged like browser tabs. The motebit reduces to a launcher; the companion erases.
- **Cinema mode.** User is passive, motebit performs. No agency on either side. Works in entertainment; wrong for sovereign-extension positioning.
- **Always-on chrome.** Badges, notifications, pop-ups in vision. Calm-software's antithesis; on glasses, this is unwearable.
- **Cargo-cult phone.** Shrinking phone UI into a 3D rectangle and floating it. The medium-native question — "what does this look like when there's no phone" — is the right one.
- **Cargo-cult VR.** Treating spatial as immersive entertainment. Spatial is a daily companion surface, not an entertainment surface. Game-shaped patterns (immersive isolation, fixed playspace, controller-driven input) are the wrong defaults.

## Default companion shape

The motebit on glasses (and its proto on `apps/spatial`) defaults to:

- **Body-anchored, not viewport-anchored.** Rest position near the user's shoulder; orbits the user, not the camera. The companion follows you; it does not float at a fixed point in space.
- **Gaze-aware.** Tilts toward the user's attention; recedes when attention is elsewhere.
- **Voice-first.** Voice is the primary input channel. Gesture is secondary. Controllers don't exist.
- **Ambient when idle.** Present but unobtrusive. No idle chrome, no thinking-dots, no progress bars in vision. The creature's own breath is the ambient signal.
- **Gestures-on-objects, not menus.** Pinch / tap / long-press on a creature, satellite, or presentation. No floating menus, no right-click contexts.
- **Recedes on work-end.** Active items emerge with the work; presentations dismiss when done; satellites complete their orbit and fade.

These defaults are how a motebit reads as a daily companion rather than an app. Departing from them needs explicit justification.

## The OS-bridge framing

On glasses, the motebit is **not the OS** (Apple owns visionOS; Meta owns Horizon OS; future glasses-makers will own theirs). The motebit is **not a separate app** competing for window space. The motebit is the **agent layer that mediates between the user and what the OS provides** — adding identity, memory, governance, trust, and signed receipts to interactions that would otherwise be commodity.

Concretely:

- The OS provides primitives (browser, files, communication, payments, sensors).
- The motebit invokes those primitives **on the user's behalf**, under sovereign identity and governed boundary.
- The motebit's **presentation** primitive is how OS-provided content (a webpage, a document, a payment confirmation) is brought into view — anchored to the motebit, not to a window manager.
- Every action produces a signed receipt; every policy decision a hash-chained audit entry; every delegation a verifiable proof.

This positioning is what makes motebit a **sovereign extension of the user's life** rather than another app. The architectural thesis (`docs/doctrine/the-stack-one-layer-up.md`) — that hosted agent platforms and motebit converge on the same five primitives, and the difference is who owns the identity layer — is exactly the bridge claim made spatial.

### Mediation depth — the walled-garden risk

The OS-bridge framing assumes the platform owners _let_ motebit mediate. They might not. Apple's `app-sandbox` model on visionOS doesn't permit third-party agents to read across apps or drive system actions; future glasses platforms may follow the same pattern. The mediation depth the architecture can achieve is determined by the platform's stance on agent integration, which sits on a spectrum:

- **Full OS access** (best case) — agent reads cross-app content, drives system actions, presents content adjacent to native apps. Motebit operates as the agent layer the doctrine names.
- **Scoped extension API** (likely middle case) — agent gets a defined set of system hooks (intent handlers, accessibility services, share-targets, file-provider extensions). Motebit mediates within the platform's sanctioned boundaries.
- **Sandboxed app** (worst case) — agent runs only in its own surface, no cross-app reach. Motebit becomes a sovereign companion that integrates where APIs allow and falls back to its own surfaces elsewhere.

The architectural hedge is built in: motebit's sovereign primitives — identity, memory, governance, signed receipts, trust — work standalone in any sandbox. The depth of mediation contracts as the platform restricts; the **value of sovereignty does not**. A motebit confined to its own surface still owns identity across providers, memory across sessions, and policy across actions — the things that distinguish an agent from a feature. The walled garden constrains what motebit can _reach_, not what motebit _is_.

So the architecture is robust across the platform spectrum, but the product positioning is platform-dependent: _"agent layer for the spatial OS"_ requires the OS to cooperate; _"sovereign agent that bridges to platform APIs where allowed"_ works regardless. Both are defensible; the first is more strategic, the second is more durable. Motebit ships the second and pursues the first as APIs open — convergent, not contingent.

## Connections to existing doctrine

- **[motebit-computer.md](motebit-computer.md)** — the slab. In spatial, the slab is a **held-tablet the motebit presents to you**, not a floating plane. The slab doctrine's "rest as dominant state" maps to "the held-tablet stays in view as long as the motebit is using it; recedes when work ends." The slab's Ring 1 contract / Ring 3 renderer split is what lets the same lifecycle types serve both desktop/web (Three.js plane) and glasses (held-tablet WebXR).
- **[records-vs-acts.md](records-vs-acts.md)** — records (credentials, settled history) live in summonable HUD overlays; acts (work in progress, presentations, delegations) live in the motebit's gesture. The split holds; the surfaces just become spatial.
- **[surface-determinism.md](surface-determinism.md)** — explicit affordances route through `invokeCapability`. On glasses, voice + gaze + gesture are the input set; surface-determinism is enforced the same way (typed capability, never a constructed prompt).
- **[the-stack-one-layer-up.md](the-stack-one-layer-up.md)** — the convergence claim. On glasses, the **OS** is the layer one up; motebit is the agent layer that mediates. Apple/Meta provide the spatial primitives; motebit provides identity, memory, governance, trust.
- **[hardware-attestation.md](hardware-attestation.md)** — software identity is the floor; hardware attestation is additive scoring. On glasses, the device's secure element attests the agent's key — the user knows the motebit they're seeing is theirs.
- **[liquescentia-as-substrate.md](liquescentia-as-substrate.md)** — the deepest coherence of this doctrine. On AR glasses, the user's real world _becomes_ Liquescentia (the medium that makes the glass droplet legible). The synthetic chromatic gradient (`ENV_LIGHT`) is fallback; reality is the goal. `WebXRThreeJSAdapter` already drops the synthetic env when XR light estimation is available — code crystallized this before the doctrine named it.

## Streaming perception — the future arc, deliberately uncanonized

The drag-drop perception substrate that ships today (`@motebit/protocol::perception.ts` + `runtime.feedPerception`) is the **discrete-gesture** case: one drop, one typed payload, one classification, one slab item. The natural follow-on for AR glasses is the **continuous-stream** case — the user grants the motebit visual perception of their environment and the motebit perceives over time, with continuous or windowed classification, granular consent, revocation with bounded teardown, and selective memory promotion under cryptographic provenance.

The two are different architectural shapes. The discrete substrate's primitives (closed `DropPayloadKind` union, `feedPerception(payload)` typed input, single sensitivity classification per drop) don't extend 1:1 to streams; a stream is a subscription with consent windows and frame-bounded teardown semantics, not a sequence of drops. The mode-contract spectrum already makes room for it — a future entry alongside `shared_gaze` covering motebit-mediated world perception under explicit grant — but the substrate that backs it has not been designed and is **deliberately uncanonized** until a real consumer drives the type (likely when on-device multimodal AI is good enough for sovereign processing without cloud round-trip AND a permissive AR platform exposes camera APIs to vetted agents).

The composition story is sound: sensitivity routing may extend to frame-level, region-level, event-level, or windowed classification; the policy gate's `cohesive permeability` extends to admission control over live perception; the consolidation cycle can absorb promoted visual memory the same way it absorbs text; signed receipts can carry "the motebit perceived this at this moment" the same way they carry tool-execution provenance. The form factor is arriving (Vision Pro 2024, Quest 3, Ray-Ban Meta, smart-glasses 2026–2030 territory); existing market products do "look-and-ask" without sovereign identity, per-tier classification, accumulated memory, or multi-vendor governance. That gap is what motebit's architecture is shaped to fill — but the substrate ships when reality drives the typing, not before. **Doctrine follows code in motebit; speculative substrate sketches don't earn doctrine status.**

## The one-line summary

**Spatial is the prototype of the AR-glasses companion. Build for that, not for "AR/VR/WebXR generically."**

Every primitive, every gesture, every presentation in `apps/spatial` is a draft of the production glasses surface. Discipline matches that stake.
