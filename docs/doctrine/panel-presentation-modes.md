# Panel presentation modes

Panels are records (per [`records-vs-acts`](records-vs-acts.md)). Records have a temporal axis (per [`panel-temporal-registers`](panel-temporal-registers.md)). This memo adds the third axis: **how a panel embodies on the surface it currently lives on**. Same panel, same controller, same state — the embodiment changes; the information does not.

The axis is named `PanelPresentationMode`. It's a closed registry. It composes with the closed `EmbodimentMode` registry in [`chrome-as-state-render`](chrome-as-state-render.md) by the same logic: information shape is constant; render shape is a function of the mode. New modes are registry additions, never wire-format breaks.

## Scope: flat surfaces only

Panels are a **flat-surface concept**. They live on web, desktop, and mobile — surfaces with viewport chrome that admits rectangular records-areas attached to edges. They do **not** exist on spatial. The spatial app composes scene primitives per [`spatial-as-endgame`](spatial-as-endgame.md) (creature / satellite / environment / attractor / presentation), and that doctrine explicitly forbids window-manager panels. In spatial, the same controller state that renders as a panel on web/desktop/mobile renders as a **Presentation primitive** (a surface motebit holds and shows, anchored to the creature's gesture, that recedes when work ends). The category translates; the controller doesn't. See §"Spatial: panels become Presentations" below.

## The two-axis split

A panel has **two** orthogonal axes that compose:

- **Presentation mode** — _how_ the panel embodies on the flat surface (rail / immersive). Cross-surface across web/desktop/mobile; mode availability depends on the surface.
- **Interior register** — _what_ the panel is currently showing (list / create / detail / ...). Per-panel; opaque to the doctrine, modeled by the controller.

The Goals "Commit a goal" affordance is an **interior register** change, not a presentation-mode change. It does not get a separate surface; the panel's interior flips from `list` to `create`. Same panel, same width, same controller — the body of the panel becomes the form. Cancel returns to `list`. This is the iOS Reminders pattern (`+` flips the row into edit register inline) generalized.

The category error this doctrine forbids is **modals**. A modal is a panel-shaped thing that lacks panel semantics — it is neither a new presentation mode nor an interior register; it is a fourth UI primitive smuggled in alongside body + panel + slab. The pre-2026-05-14 Goals "Commit a goal" sheet was the worked example: it occupied the same 280px column as the rail panel, with the panel's empty-register CTA visible behind it. Two panel-shaped surfaces stacked on the same canvas. Caught and fixed in the same arc that named this doctrine. There is no `modal` entry in `PanelPresentationMode` and there will never be one — modals are structurally unrepresentable.

## The closed `PanelPresentationMode` registry

v1 ships two entries:

- **`rail`** — fixed-width side rail on a flat surface (~280px on web/desktop). The panel sits alongside the body. Records visible without dismissing the act surface. Today's default on web + desktop.
- **`immersive`** — the panel fills the available viewport. Body recedes. Same content as rail, just no compromise on space. Native default on mobile (the phone is too narrow for a real rail; iOS slide-up sheets are already immersive). On web/desktop it's a deliberate "focus on this commitment" register — Goals at 200 commitments needs immersive; Goals at 3 commitments does not.

Closed-union, additive-extension shape — same as `SuiteId` ([`agility-as-role`](agility-as-role.md)), `EmbodimentMode` ([`motebit-computer`](motebit-computer.md) §"Six embodiment modes"), `GoalBudgetAxis` ([`panel-temporal-registers`](panel-temporal-registers.md) §"Bounded commitment is multi-dimensional"). When a third flat-surface mode is needed (e.g. `peer-presented` — a panel rendered through a peer's viewport during shared gaze), it lands as a registry addition; existing call sites compile unchanged. **A `spatial` mode is not coming** — the spatial surface composes Presentation primitives, not panels (see §"Spatial: panels become Presentations" below).

## Per-surface availability matrix

Not every mode applies to every flat surface. This is per-surface availability, not a universal toggle:

| Surface | `rail`                | `immersive`        |
| ------- | --------------------- | ------------------ |
| Web     | ✓ (default)           | ✓ (focus register) |
| Desktop | ✓ (default)           | ✓ (focus register) |
| Mobile  | – (screen too narrow) | ✓ (native default) |

A "–" means the mode is **structurally unavailable** on that surface — not a v1 deferral, but a category mismatch. There is no rail on a phone because 280px on a 390px-wide screen leaves no body. The availability table is not aspirational; it's typed.

The spatial surface is **deliberately absent** from this table — panels don't exist on spatial. See the next section.

Transitions form a sensible graph within each flat surface:

- Web / desktop: `rail` ↔ `immersive`. Default `rail`; user toggles to `immersive` for focus-mode work.
- Mobile: `immersive` only. No transitions needed — the mode is the native default.

## Spatial: panels become Presentations

[`spatial-as-endgame`](spatial-as-endgame.md) §"The five spatial primitives" enumerates the closed registry of what exists in motebit's 3D scene: **creature / satellite / environment / attractor / presentation**. The doctrine explicitly forbids panels under §"The refined 'no panels' rule":

> Surfaces emerge from the motebit's gesture and recede when work ends. The creature is the source; surfaces are presented, held, shown. Disconnected window-manager panels — surfaces with no relationship to the creature's body or attention — remain the anti-goal.

A "spatial panel" — a glass object the user opens via a window-manager affordance, that floats in user-space, that persists as chrome — **fails all three of `spatial-as-endgame.md`'s tests**:

1. Window-manager-summoned (the user clicks "open panel") → wrong; motebit must be the summoning agent.
2. Free-floating in user-space → wrong; spatial surfaces are anchored to the creature.
3. Persistent chrome → wrong; spatial surfaces recede when work ends.

So in spatial, **there is no `PanelPresentationMode`**. The same controller state that renders as a rail or immersive panel on web/desktop/mobile renders as a **Presentation primitive** on spatial — the 5th spatial primitive, anchored to the creature's act of showing. The user says "show me my goals"; motebit summons + holds + dissolves a held-tablet shape with the goals content rendered inside. Same controller. Different render category. Different summoning semantics.

The render-target translation is per-surface, not per-mode (refined below — web/desktop carry **both** categories):

| Surface                      | Records render category                              | Summoning semantics                                         |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| Web (flat + 3D scene)        | **Panel** (rail / immersive) **or** **Presentation** | user opens panel / motebit summons artifact                 |
| Desktop (flat + 3D scene)    | **Panel** (rail / immersive) **or** **Presentation** | user opens panel / motebit summons artifact                 |
| Mobile (flat, no scene room) | **Panel** (immersive sheet)                          | user opens panel                                            |
| Spatial (3D scene)           | **Presentation** primitive                           | user expresses intent → motebit summons / holds / dissolves |

When the spatial app builds out, the Goals controller does not change. Its `getState()`, `subscribe()`, and action methods are renderer-agnostic. The spatial app implements a renderer that **does not consume `PanelPresentationMode`** — it composes a Presentation primitive instead, sourced from the same controller. The information is constant; the embodiment changes categorically, not modally.

**Individual records graduate to satellites via detach.** Inside a Presentation (or on the flat-surface panel today), an individual card can be long-pressed or dragged off the surface to detach as a **scene artifact / satellite** orbiting the creature — the same `detach` mechanic [`motebit-computer`](motebit-computer.md) §"Three end states" defines for slab items, with the same Rayleigh-Plateau bead-release physics. The Presentation is the _collection container_; the satellite is the _individual record made spatial and persistent_. This is the bridge between the records primitives across all three relevant doctrines: panels (this memo, flat-surface collection), Presentation primitives ([`spatial-as-endgame`](spatial-as-endgame.md) §"The five spatial primitives", spatial collection), and satellites ([`spatial-as-endgame`](spatial-as-endgame.md), spatial individual). The graduation pattern works on every surface — long-press a card on the web Goals rail today and it could already pin via the same mechanic; spatial just renders the satellite in the user's room instead of the slab's right-of-creature region.

**This doctrine memo's scope ends at flat surfaces.** The spatial render category is governed by [`spatial-as-endgame`](spatial-as-endgame.md), not here. Don't add `spatial` to `PanelPresentationMode` — that's the doctrine collision corrected in this memo's history.

## Refinement (2026-06-04): the three record-embodiments — panel, slab, artifact

The flat/spatial split above is correct but was drawn too coarsely, and the coarseness let two misreads in: "no panels" (a _spatial_ statement) read as "no panels anywhere," and "panels become Presentations" read as "a panel becomes a free-floating window-object." Both wrong. A whole panel graduating into a floating window is the **spatial anti-goal** ("disconnected window-manager panels… remain the anti-goal," [`spatial-as-endgame`](spatial-as-endgame.md); the slab is itself "not a panel, not a window," [`motebit-computer`](motebit-computer.md)).

The correct model is **three record-embodiments, not two**, and they already coexist on web/desktop:

1. **Panel — browse.** The dense records surface (agent roster, credential list, balance ledger). `rail` / `immersive`. Records are _panel content, not slab content_ ([`motebit-computer`](motebit-computer.md)). The scan/compare workhorse — 50 agents in a side rail beats a floating cluster.
2. **Slab — present / compose / act.** The motebit's **workstation** beside the creature — the surface in the app today where it reads a page or runs a tool. Selected content is _presented through the one slab_; **composing and acting happen here.** A hire is a **form + a delegation outbound**, which are the slab's **hand** organ verbatim ([`motebit-computer`](motebit-computer.md) §Hand). It is not a new floating object; it is the single working surface that already exists.
3. **Artifact / satellite — promote.** An individual durable record (a signed receipt, an active delegation) **detaches** from the slab into the scene — the slab's `detach` end-state + the satellite mechanic (§"Spatial: panels become Presentations"). Promotion, only when earned. A panel never graduates _wholesale_; individual records do.

So records flow: **panel (browse) → slab (present / compose / act) → artifact (durable, detached).** The "Presentation primitive" of [`spatial-as-endgame`](spatial-as-endgame.md) is the **spatial render of the slab's present role**; on a flat 3D viewport the slab fills that role directly.

Per-surface substrate:

- **Web / desktop** — all three (panel + slab + detached artifacts). Slab + scene exist today.
- **Mobile** — panel (`immersive`) + slab (the creature webview); artifacts sparingly (no room for a populated scene).
- **Spatial (glasses)** — slab-as-Presentation + satellites; **no panel.**

**The through-line — one controller, three surfaces:** a phone renders the roster as a **panel**, a laptop presents it through the **slab**, and glasses render that same slab role as a **held-tablet the motebit presents into your view** — all from the one unchanged `AgentsController` (`getState` / `subscribe` / actions). The spatial mechanic is that **the work comes to you, not you to it**: the companion orbits near you at rest (gaze-aware, glanceable), and when it presents it **brings the held surface forward into your view** — you never reposition to find it; the surface is held out, then recedes when work ends ([`spatial-as-endgame`](spatial-as-endgame.md): "the companion follows you," surfaces "emerge from the motebit's gesture"). Rest is a position; presenting is a behavior — the motebit is the one that moves. This is the argument that the **spatial endgame is not a rewrite**: it is the same controller meeting a wider substrate, `params-not-pixels` ([`the-stack-one-layer-up`](the-stack-one-layer-up.md)) at the records layer. Web/desktop are therefore the **spatial rehearsal** — the endgame is dogfoodable on a Mac before the hardware exists. Build the controller once; the surfaces are render targets.

**What does NOT change.** `PanelPresentationMode` stays `"rail" | "immersive"` — the slab and the Presentation/satellite primitives are _separate render categories_ ([`motebit-computer`](motebit-computer.md), [`spatial-as-endgame`](spatial-as-endgame.md)), never panel modes. No `spatial` enum entry; `PanelSurface` unchanged; the typed enforcement below untouched. **Status:** this names the model; the slab already renders on web/desktop today, and the spatial Presentation/satellite render is the named next render-engine arc — not "shipped," but "model locked, renderer named."

## Inline > transition > modal-forbidden

There are three shapes a creation / edit / detail flow can take on a panel. Listed in **preference order** — pick the leftmost that fits the form weight:

1. **Inline always-visible affordance** _(Apple Reminders bottom-bar pattern)._ The form lives permanently at the bottom of the panel. Cards (or the empty caption) scroll in the area above. No transition, no second page, no register flip. Submit clears the form in place and re-seeds defaults for consecutive commits. **This is the preferred shape when the form is light enough to coexist with the list** — roughly < 40% of the panel's vertical real estate.
2. **Interior-register transition** _(list ↔ create, list ↔ detail)._ The panel rotates between registers in place; same width, same controller, same subscription. **Use this when the form is too heavy to coexist** — multi-step wizards, large detail surfaces, anything that would crowd the records list if always visible. Mobile's immersive presentation often lands here naturally; on rail the transition is the escape hatch when the form genuinely doesn't fit.
3. **Modal overlay** — **structurally unrepresentable.** `modal` is not a member of `PanelPresentationMode` and never will be. A modal-shaped surface stacked over a panel is a category error: two panel-shaped things on the same canvas, neither with clean panel semantics. If your form needs more space than a transition gives, the right escape is the `immersive` presentation mode (the panel grows to fill the viewport), not a modal.

**Worked example: Goals.** Pre-2026-05-14 the "Commit a goal" affordance shipped as shape 3 — a slide-down sheet over the rail panel. Caught and fixed in commit `6dddf10d` as shape 2 — `list` ↔ `create` register transition. Caught again the same day and shipped as shape 1 (commit landing this clarification): the form is ~280px tall and coexists comfortably with the cards list, so the transition was over-engineering. The form now lives at the bottom of the Goals panel always-visible; the empty register shows a vertically-centered "Commit motebit to a goal" caption in the cards area above. **Single page. No transition. No dismiss.** This is the Apple-grade calm pattern: the action is always one click away; the introduction sits above; the form's own commit button is the action affordance.

The arc of three shapes is itself the worked lesson: reach for shape 1 first. Only escalate to shape 2 when the form's weight forces it. Shape 3 is never the answer.

**Generalizes to other panels.** Sovereign's "Add credential": light form → shape 1 (inline at bottom). Capabilities' "Connect MCP server": medium form (auth config, scope selection) → shape 1 today, shape 2 if it grows. Conversations' message detail: heavy surface → shape 2 (`detail` register transition). When you find yourself reaching for shape 3 (modal), you have a category error: drop down to shape 2; if shape 2 doesn't fit either, your form genuinely needs `immersive` presentation, not a modal.

## Typed enforcement

[`packages/panels/src/registry.ts`](../../packages/panels/src/registry.ts) ships the closed `PanelPresentationMode` type and the per-surface availability table. Both are `as const` so the type system pins them:

```ts
export type PanelPresentationMode = "rail" | "immersive";

export type PanelSurface = "web" | "desktop" | "mobile";

export const PANEL_PRESENTATION_AVAILABILITY = {
  web: ["rail", "immersive"],
  desktop: ["rail", "immersive"],
  mobile: ["immersive"],
} as const;
```

A surface that tries to render a panel in an unavailable mode is a type error at the call site. A future contributor proposing a `modal` mode hits the closed-union rejection — there is no slot for it. A future contributor proposing a `spatial` mode hits the same rejection — `PanelSurface` does not include `"spatial"`, and adding it would cross the categorical boundary [`spatial-as-endgame`](spatial-as-endgame.md) draws.

This is the same shape as `PanelPrimitive` (which deliberately omits `governance` so governance-as-panel cannot be declared). The structural unrepresentability of modals AND of spatial panels is the doctrine working as intended.

## Cross-references

- [`records-vs-acts`](records-vs-acts.md) — **parent**. Records sit on panels; acts pass through the body. This memo refines _how_ the records side embodies.
- [`panel-temporal-registers`](panel-temporal-registers.md) — sibling. That memo named the temporal axis (identity vs runtime register); this one names the presentation axis. Two orthogonal axes on the records surface.
- [`chrome-as-state-render`](chrome-as-state-render.md) — sibling. Chrome renders as `f(controlState × embodimentMode)` for the slab; panels render as `f(panel × presentationMode)` for the records side on flat surfaces. Same shape on the flat-surface side; the spatial render category is different per `spatial-as-endgame.md`.
- [`spatial-as-endgame`](spatial-as-endgame.md) — **categorical boundary**. The five spatial primitives are creature / satellite / environment / attractor / presentation. Panels are not among them and explicitly cannot be. On spatial, the same controller state renders as a Presentation primitive (motebit-summoned, anchored to the creature, recedes when work ends), not as a panel-with-spatial-mode. This memo's `PanelPresentationMode` scope is flat surfaces only.
- [`motebit-computer`](motebit-computer.md) — the slab's typed `EmbodimentMode` is partially analogous to `PanelPresentationMode` (both close their unions), but the slab is a scene-graph primitive across all surfaces (3D today even on flat viewports), whereas panels are flat-surface DOM overlays whose spatial counterpart is the Presentation primitive in `spatial-as-endgame.md`. Don't conflate them.
- [`intent-gated-slab`](intent-gated-slab.md) — the slab is always-already there; the panel inherits the always-already property on its flat-surface substrate. A `create` register inside an empty panel is READY, not absent.
- [`agility-as-role`](agility-as-role.md) — same structural family: closed union + additive registry + drift-gate enforcement. `PanelPresentationMode` is not itself a registered agility-as-role instance (that doctrine names seven pluggable-role swaps — cryptosuite, license-floor, settlement-rail, foundation-model, inference-host, model-lab, TaskShape — canonical in `agility-as-role.md`). The pattern's reach into typed vocabularies (`EmbodimentMode`, `GoalBudgetAxis`, `PanelPresentationMode`) is the same shape applied to a different category of decision — kept distinct so the agility-as-role registry stays load-bearing for the role-vs-instance discipline.

## How to apply

Before adding any panel-shaped surface or creation flow, answer three questions:

1. **Is this a flat surface (web / desktop / mobile) or a spatial surface?** If spatial, this doctrine does not apply — see [`spatial-as-endgame`](spatial-as-endgame.md) for the Presentation primitive that replaces the panel category there. The same controller renders as a Presentation in spatial; the categorical translation happens in the renderer, not via a new presentation-mode entry.
2. **Is this a different panel, or the same panel showing different content?** Same panel + different content = interior register change. Different panel = different `SIDE_RAIL_PANELS` entry. If the answer is "I want a modal," the doctrine is telling you the category is wrong — pick one of the two.
3. **What presentation mode does this flat surface support?** Check `PANEL_PRESENTATION_AVAILABILITY`. If you're trying to render `rail` on mobile, the type system rejects you. The availability table is not negotiable per-feature.

If all three come out clean, you're applying the doctrine. If any is muddy, you have a category error to resolve before any pixels move.
