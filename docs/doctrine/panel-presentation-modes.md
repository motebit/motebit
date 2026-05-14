# Panel presentation modes

Panels are records (per [`records-vs-acts`](records-vs-acts.md)). Records have a temporal axis (per [`panel-temporal-registers`](panel-temporal-registers.md)). This memo adds the third axis: **how a panel embodies on the surface it currently lives on**. Same panel, same controller, same state — the embodiment changes; the information does not.

The axis is named `PanelPresentationMode`. It's a closed registry. It composes with the closed `EmbodimentMode` registry in [`chrome-as-state-render`](chrome-as-state-render.md) by the same logic: information shape is constant; render shape is a function of the mode. New modes are registry additions, never wire-format breaks.

## The two-axis split

A panel has **two** orthogonal axes that compose:

- **Presentation mode** — _how_ the panel embodies on the surface (rail / immersive / spatial). Cross-surface; mode availability depends on the surface.
- **Interior register** — _what_ the panel is currently showing (list / create / detail / ...). Per-panel; opaque to the doctrine, modeled by the controller.

The Goals "Commit a goal" affordance is an **interior register** change, not a presentation-mode change. It does not get a separate surface; the panel's interior flips from `list` to `create`. Same panel, same width, same controller — the body of the panel becomes the form. Cancel returns to `list`. This is the iOS Reminders pattern (`+` flips the row into edit register inline) generalized.

The category error this doctrine forbids is **modals**. A modal is a panel-shaped thing that lacks panel semantics — it is neither a new presentation mode nor an interior register; it is a fourth UI primitive smuggled in alongside body + panel + slab. The pre-2026-05-14 Goals "Commit a goal" sheet was the worked example: it occupied the same 280px column as the rail panel, with the panel's empty-register CTA visible behind it. Two panel-shaped surfaces stacked on the same canvas. Caught and fixed in the same arc that named this doctrine. There is no `modal` entry in `PanelPresentationMode` and there will never be one — modals are structurally unrepresentable.

## The closed `PanelPresentationMode` registry

v1 ships three entries:

- **`rail`** — fixed-width side rail on a flat surface (~280px on web/desktop). The panel sits alongside the body. Records visible without dismissing the act surface. Today's default on web + desktop.
- **`immersive`** — the panel fills the available viewport. Body recedes. Same content as rail, just no compromise on space. Native default on mobile (the phone is too narrow for a real rail; iOS slide-up sheets are already immersive). On web/desktop it's a deliberate "focus on this commitment" register — Goals at 200 commitments needs immersive; Goals at 3 commitments does not.
- **`spatial`** — the panel detaches from the surface chrome and floats as a glass object in motebit's space. Deferred for v1. This is the AR-glasses endgame per [`spatial-as-endgame`](spatial-as-endgame.md): on glasses there is no rail and no viewport — only the user's real world as `Liquescentia` per [`liquescentia-as-substrate`](liquescentia-as-substrate.md). When `spatial` lands it becomes the **sixth spatial primitive** alongside creature / satellite / environment / attractor / presentation.

Closed-union, additive-extension shape — same as `SuiteId` ([`agility-as-role`](agility-as-role.md)), `EmbodimentMode` ([`motebit-computer`](motebit-computer.md) §"Six embodiment modes"), `GoalBudgetAxis` ([`panel-temporal-registers`](panel-temporal-registers.md) §"Bounded commitment is multi-dimensional"). When a fourth mode is needed (e.g. `peer-presented` — a panel rendered through a peer's viewport during shared gaze), it lands as a registry addition; existing call sites compile unchanged.

## Per-surface availability matrix

Not every mode applies to every surface. This is per-surface availability, not a universal toggle:

| Surface | `rail`                | `immersive`        | `spatial`          |
| ------- | --------------------- | ------------------ | ------------------ |
| Web     | ✓ (default)           | ✓ (focus register) | deferred           |
| Desktop | ✓ (default)           | ✓ (focus register) | deferred           |
| Mobile  | – (screen too narrow) | ✓ (native default) | deferred           |
| Spatial | – (no rail surface)   | ✓ (pull-close)     | ✓ (native default) |

A "–" means the mode is **structurally unavailable** on that surface — not a v1 deferral, but a category mismatch. There is no rail on glasses because there is no surface chrome to attach a rail to. There is no rail on a phone because 280px on a 390px-wide screen leaves no body. The availability table is not aspirational; it's typed.

Transitions form a sensible graph within each surface:

- Web / desktop: `rail` ↔ `immersive`. Default `rail`; user toggles to `immersive` for focus-mode work.
- Mobile: `immersive` only. No transitions needed — the mode is the native default.
- Spatial: `spatial` ↔ `immersive`. Default `spatial` (panel lives as a glass object in the room); user pulls it close and it fills their field of view (`immersive` on glasses ≠ filling a rectangle — it fills the visual register the user is foveating on).

## The spatial endgame

`spatial` is named in v1 even though no code ships it. The reason is doctrine-shaped, not roadmap-shaped: when AR glasses arrive (the 5–10 year horizon per [`spatial-as-endgame`](spatial-as-endgame.md)), the panel must already be a typed primitive that the spatial renderer can pick up — not a retrofit. Naming it now prevents the panel layer from accumulating rail-shaped assumptions ("a panel is a rectangle"; "a panel has a width"; "a panel has a close button") that would have to be unwound under deadline pressure later.

The spatial panel is the **slab's sibling**. The slab is motebit's first-person perceptual field per [`motebit-computer`](motebit-computer.md). The spatial panel is the user's window into motebit's accumulated state — a glass object alongside the slab, both inhabiting the same `Liquescentia` substrate. On glasses, the slab and the spatial panels float in the user's room and recede when work ends. The doctrine of calm-AR (surfaces emerge from gesture, recede when done) applies identically to both. The spatial panel is the runtime/identity register made spatial; the slab is the body's act surface made spatial.

When `spatial` lands, the panel controller does not change. Same `getState()`, same `subscribe()`, same actions. The renderer changes — instead of `domElement.appendChild`, it's a Three.js / WebXR scene-graph entry the spatial app composes alongside the creature. The information is constant; the embodiment is the variable.

## What this means for `interior register`

The doctrine does not enumerate interior registers — those are panel-specific and live in the controller. But it sets the rule: **creation, editing, and detail flows are interior-register transitions, not modal overlays**. The Goals panel's "Commit a goal" affordance is the worked example:

- **Wrong (pre-2026-05-14):** rail panel + modal-shaped sheet stacked on the same column. The sheet had no panel semantics; it was a UI accident.
- **Right:** the panel's body flips register from `list` to `create`. Same width, same controller, same subscription. Cancel returns to `list`. On mobile (immersive presentation), the same register flip happens — the form takes over the immersive surface. On spatial (future), the same flip happens — the glass object's interior shows the form. **The interior register is presentation-mode-agnostic.**

This generalizes beyond Goals. Sovereign's "Add credential" should be a `create` register inside the Sovereign panel, not a modal. Capabilities' "Connect MCP server" should be a `create` register inside the Capabilities panel, not a modal. Conversations' message detail should be a `detail` register inside Conversations, not a side-by-side split. When you find yourself reaching for a modal, you have a category error: rotate the panel's interior register instead.

## Typed enforcement

[`packages/panels/src/registry.ts`](../../packages/panels/src/registry.ts) ships the closed `PanelPresentationMode` type and the per-surface availability table. Both are `as const` so the type system pins them:

```ts
export type PanelPresentationMode = "rail" | "immersive" | "spatial";

export const PANEL_PRESENTATION_AVAILABILITY = {
  web: ["rail", "immersive"],
  desktop: ["rail", "immersive"],
  mobile: ["immersive"],
  spatial: ["immersive", "spatial"],
} as const;
```

A surface that tries to render a panel in an unavailable mode is a type error at the call site. A future contributor proposing a `modal` mode hits the closed-union rejection — there is no slot for it.

This is the same shape as `PanelPrimitive` (which deliberately omits `governance` so governance-as-panel cannot be declared). The structural unrepresentability of modals is the doctrine working as intended.

## Cross-references

- [`records-vs-acts`](records-vs-acts.md) — **parent**. Records sit on panels; acts pass through the body. This memo refines _how_ the records side embodies.
- [`panel-temporal-registers`](panel-temporal-registers.md) — sibling. That memo named the temporal axis (identity vs runtime register); this one names the presentation axis. Two orthogonal axes on the records surface.
- [`chrome-as-state-render`](chrome-as-state-render.md) — sibling. Chrome renders as `f(controlState × embodimentMode)` for the slab; panels render as `f(panel × presentationMode)` for the records side. Same shape.
- [`motebit-computer`](motebit-computer.md) — the slab's typed `EmbodimentMode` is the structural twin of `PanelPresentationMode`. Both close their unions; both ship the spatial entry now to keep the AR-glasses endgame typed.
- [`liquescentia-as-substrate`](liquescentia-as-substrate.md) — on glasses, the user's real world is the medium. Spatial panels inherit `Liquescentia` from the substrate, just as the slab and the creature do.
- [`spatial-as-endgame`](spatial-as-endgame.md) — when `spatial` lands, panels become the sixth primitive alongside creature / satellite / environment / attractor / presentation.
- [`always-already-slab`](always-already-slab.md) — the slab is always-already there; the panel inherits the same property through the substrate. A `create` register inside an empty panel is READY, not absent.
- [`agility-as-role`](agility-as-role.md) — closed-union, additive-registry pattern. Eighth instance: cryptosuite / license-floor / settlement-rail / TaskShape / EmbodimentMode / GoalBudgetAxis / PanelPresentationMode.

## How to apply

Before adding any panel-shaped surface or creation flow, answer two questions:

1. **Is this a different panel, or the same panel showing different content?** Same panel + different content = interior register change. Different panel = different `SIDE_RAIL_PANELS` entry. If the answer is "I want a modal," the doctrine is telling you the category is wrong — pick one of the two.
2. **What presentation mode does this surface support?** Check `PANEL_PRESENTATION_AVAILABILITY`. If you're trying to render `rail` on mobile or `spatial` on web today, the type system rejects you — and rightly. The availability table is not negotiable per-feature.

If both answers come out clean, you're applying the doctrine. If either is muddy, you have a category error to resolve before any pixels move.
