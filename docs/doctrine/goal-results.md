# Goal results

A goal is a commitment ([`goals-vs-tasks`](goals-vs-tasks.md)). A commitment, when motebit fires it, produces a **result** — the actual content motebit generated. The Goals panel today conflates three distinct categories on a single card and loses two of the three to truncation. This memo names the three categories, the existing primitives each maps to, and the implementation phases that close the gap between the current state and the architectural intent.

## The three categories

Every goal fire produces three things. They have different shapes, different storage, different render surfaces, different doctrines.

1. **Commitment** — the goal record itself. The user's declaration: prompt, cadence, budget envelope, current status. Lives in the panel as a card on flat surfaces (per [`panel-temporal-registers`](panel-temporal-registers.md) §"Apple design-language per register" — runtime register), in a Presentation primitive in spatial (per [`panel-presentation-modes`](panel-presentation-modes.md) §"Spatial: panels become Presentations"). **Already shipped.**
2. **Receipt** — per-fire audit trail. `last_run_at`, `spent_tokens`, `consecutive_failures`, `last_error`, the per-fire `goal_outcomes` row, the `goal_executed` event. The signed trace of what was done; the cryptographic record. Surfaces as per-card meta (status pulse, countdown, budget bar) on flat surfaces; as satellites orbiting the creature on spatial. **Already shipped on flat surfaces.**
3. **Artifact** — the actual produced content. The research report, the synthesized text, the bundle of tool results and citations. The _thing motebit made_. Per [`receipts-unified`](receipts-unified.md), the canonical shape is `ContentArtifactManifest` — JCS+Ed25519+suite-dispatch signed, independently verifiable via `@motebit/verifier`. **Currently truncated to a 160-char preview on the goal card; the full content is generated and discarded.** This is the gap.

The Goals panel today shows all three on the same card — commitment as prompt + cadence, receipt as budget bar + status pulse, artifact as 160-char preview. The conflation is fine UX-wise for surfacing all three near each other; the **content loss** is the architectural failure.

## Where each category renders, per surface

Same controller state across surfaces; the render category changes:

| Category   | Web / desktop / mobile (flat)         | Spatial (3D scene)                                   |
| ---------- | ------------------------------------- | ---------------------------------------------------- |
| Commitment | Card in `panel` (rail / immersive)    | Card in a Presentation primitive                     |
| Receipt    | Per-card meta (pulse, bar, countdown) | Satellite orbiting the creature (signed-event shape) |
| Artifact   | **Slab item** (mind-mode embodiment)  | **Presentation primitive** (5th spatial primitive)   |

The render category for an artifact is **a primitive in its own right**, distinct from the panel that holds the commitment. The user shouldn't expect to read a research report on a goal card; the report lives on the slab (today) or in a Presentation primitive motebit summons (spatial). The card surfaces _that the result exists_; the artifact's render surface is where the user _reads_ it.

This generalizes beyond goals — every motebit output that the user might want to attend to is an artifact, rendered through the artifact-as-Presentation pipeline. Goals is the first consumer; tool-call results are siblings; future chat-output bundles will compose against the same shape.

## The slab is already the artifact's flat-surface render

Per [`motebit-computer`](motebit-computer.md), the slab is _"what the motebit is — or has been — seeing, doing, and attending to"_. A goal fire is something motebit has been doing; its output naturally lands on the slab. The slab is **not** a 2D rendering — it's a 3D scene-graph primitive (Three.js mesh, `MeshPhysicalMaterial`, depth-shared with the creature, parented in the scene graph). The 2D viewport on web is a window onto the scene, not a flattening of it. The same slab code renders on AR glasses tomorrow with no controller change; only the camera changes.

So "artifact lands as a slab item on flat surfaces" is **not a 2D-handoff-that-becomes-spatial-later** — it's already a spatial render today, just viewed through a perspective camera. The slab embodiment for goal artifacts is the `mind` mode per [`motebit-computer`](motebit-computer.md) §"Six embodiment modes" — motebit's own synthesis, distinct from tool-call results (`tool_result` mode), distinct from browser content (`virtual_browser`), etc.

When AR glasses arrive, the same artifact renders through the spatial Presentation primitive — motebit summons + holds + dissolves a held-tablet of the content. The slab item and the Presentation primitive are the _same artifact category_, just rendered through different scene composition (slab plane today, Presentation primitive in spatial-app's renderer tomorrow). Both inherit `Liquescentia` substrate per [`liquescentia-as-substrate`](liquescentia-as-substrate.md).

## Graduation: artifacts can detach to satellites

Per [`motebit-computer`](motebit-computer.md) §"Three end states", a slab item can `detach` via the Rayleigh-Plateau bead-release physics — long-press or drag converts it from a working-surface item into a persistent scene artifact. The same mechanic generalizes per the bridge in [`panel-presentation-modes`](panel-presentation-modes.md) §"Spatial: panels become Presentations": a goal artifact that matters enough that the user wants it persistently visible **detaches into a satellite** orbiting the creature.

So the artifact lifecycle has three end states (already typed in [`motebit-computer`](motebit-computer.md)):

- **Dissolve** — ephemeral, finishes and fades. The default for noise.
- **Rest** — working material, sits on the slab until the user dismisses it or the session ends. The default for most goal results.
- **Detach** — graduates to a scene artifact / satellite, persistent until the user dismisses. The path for results the user wants to keep visible.

This is **already-shipped infrastructure**. Goal artifacts compose against it; they don't need their own lifecycle primitive.

## The implementation gap and its phases

The doctrine names what should be; the code currently approximates it. The gap is:

- **Today**: full result is generated by the runtime, web adapter truncates to 160 chars, runner stores the truncated preview, full content is lost. No slab handoff. No artifact manifest. No detach affordance for goal results.
- **Endgame**: full content is preserved, wrapped as a signed `ContentArtifactManifest`, pushed to the slab as a `mind`-mode slab item with full lifecycle (`rest` by default, user can `detach` to satellite). Card carries a navigational anchor (e.g., "View result") that scrolls / focuses the slab item.

Three implementation phases close the gap:

**Phase 1 (this memo) — architectural contract.** Names the three-category split, anchors each to existing primitives. Future implementation lands against a named contract, not against an implicit assumption. No code change.

**Phase 2 (sibling commit) — content preservation.** Runner preserves the full result alongside the existing 160-char preview (additive field on `ScheduledGoal` and `GoalFireResult`). Web adapter returns the untruncated content. Renderers can surface a longer preview (~500 chars / first paragraph) in the card detail; no full-content surface in the card (that's the slab's job). **Layer 2's UI work scope is deliberately bounded** so Phase 3 doesn't have to undo it.

**Phase 3 (deferred arc) — slab handoff + manifest signing + cross-surface mirror.** Result content wraps as `ContentArtifactManifest` per [`receipts-unified`](receipts-unified.md) (JCS+Ed25519+suite-dispatch signed if motebit identity is loaded; queued-for-signing if not). Runner pushes a `mind`-mode slab item via `@motebit/render-engine` on fire-complete. Card gains "View result" affordance that opens the slab + scrolls to the item. Desktop scheduler + mobile scheduler mirror the integration per the one-pass-delivery doctrine. Detach affordance composes naturally with the existing slab `detach` mechanic — no new code needed for graduation.

The phasing isn't intermediate-state busywork; each phase is required infrastructure for the next, and each is reviewable on its own. Phase 1's doctrine is the contract. Phase 2's data preservation is required by Phase 3 (the manifest needs full content). Phase 3 is the cross-surface engineering arc that needs its own focus session, not session-end compression.

## What this memo deliberately does not do

- **Doesn't extend `SlabItemKind` or `EmbodimentMode`.** Goal artifacts render in the existing `mind` embodiment mode per [`motebit-computer`](motebit-computer.md). If a future need surfaces — e.g., a `goal_artifact` kind with goal-specific affordances (re-run, edit goal, raise budget from the slab item) — that's a phase-3 sub-decision, not a phase-1 commitment.
- **Doesn't propose a new render surface.** The slab + Presentation + satellite trio already covers the lifecycle. Adding a "goal artifact panel" or similar would be the failure mode [`spatial-as-endgame`](spatial-as-endgame.md) forbids: a new chrome surface for a category that already has render primitives.
- **Doesn't dictate when results auto-open vs. require user click.** That's a per-surface UX decision (Phase 3) — calm-software default is probably _quiet appearance on slab, user opens slab when they want to read_, not _auto-grab-attention-on-fire_. But the calm-software audit happens in the Phase 3 PR with real screenshots, not in this doctrine memo.

## Cross-references

- [`goals-vs-tasks`](goals-vs-tasks.md) — goal = user-declared outcome. The commitment category in this memo's split.
- [`panel-temporal-registers`](panel-temporal-registers.md) — Goals is the runtime register's execution-primitive panel; the bounded-commitment envelope axis is the receipt category's load-bearing dimension.
- [`panel-presentation-modes`](panel-presentation-modes.md) — flat-surface Panel ↔ spatial Presentation translation. The same memo bridges to satellites via the detach mechanic this memo's artifact graduation uses.
- [`motebit-computer`](motebit-computer.md) — the slab is the flat-surface render of artifacts (mind-mode for goal results). Three end states (dissolve / rest / detach) cover the artifact lifecycle.
- [`receipts-unified`](receipts-unified.md) — `ContentArtifactManifest` is the canonical signed shape for artifacts, sibling to `ExecutionReceipt` and `ToolInvocationReceipt`.
- [`spatial-as-endgame`](spatial-as-endgame.md) — Presentation primitive (5th) is the spatial render category for artifacts. Satellite primitive is the detached form. The "no panels" rule is what makes the categorical translation honest.
- [`liquescentia-as-substrate`](liquescentia-as-substrate.md) — slab items and Presentation primitives both inherit the substrate; the artifact's render category breathes at the same 0.3 Hz rhythm as the creature and the slab.

## How to apply

Before adding surface code that handles a goal-fire result, answer two questions:

1. **Which category is this surfacing?** Commitment / receipt / artifact. If your code is touching the artifact, route through the existing slab-item / Presentation pipeline — don't invent a fourth render surface on the goal card.
2. **Is this preserving the full content, or losing it?** Phase 2's preservation field (`last_response_full`) is the storage contract. If your code touches goal-fire results and doesn't preserve the full content, you're recreating today's gap.

If a future contributor wonders "where do goal results go?", they read this memo first, find that artifacts are signed bundles rendered as slab items (today) or Presentation primitives (spatial), and compose against the existing pipeline rather than building a new surface.
