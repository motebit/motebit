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

**Phase 3 — slab annotation + turn-id capture + manifest signing.** **Shipped 2026-05-14** across runtime + panels + web + desktop in four commits (`6522d6bc`, `44e942c4`, `8aef52a8`, plus the manifest-signing close commit). The audit that opened Phase 3 found the goal-fire-as-slab-item pipeline was already complete in the runtime — `projectSlabForTurn` at `motebit-runtime.ts:1660` already opens a `stream`/`mind` slab item per turn, `restItem` settles it with the full artifact text on success. Phase 3 doesn't push a new slab item; it makes the existing one _legible_, _navigable_, and _verifiable_:

- **Legibility** — `sendMessageStreaming` gains a `goalContext?: { goal_id, goal_prompt }` option threaded through `projectSlabForTurn`'s payload at `openItem` / `updateItem` / `restItem` calls. The slab renderer reads `payload.goalContext` and renders a minimal "from goal · &lt;prompt&gt;" chrome row so the resting slab item is identifiable as the goal's artifact rather than an anonymous turn (web + desktop slab-items.ts, byte-aligned).
- **Navigability** — `slabTurnIdForRun(runId)` (exported from `@motebit/runtime`) is the single-sourced wire shape for the slab item's id. Adapters thread an explicit `runId` to `sendMessageStreaming`, compute the same id via the helper, and return `turnId` on `GoalFireResult.fired`. The runner persists `ScheduledGoal.last_turn_id`, clears symmetrically on error. Goal card detail surfaces a "View result" affordance (`panel-action-ghost` styling — secondary; `panel-action-pill` stays reserved for "Commit goal") that calls the renderer's `setSlabVisible(true)`. Cross-surface mirror: desktop's `goals_list` SQL projects `latest_outcome_id` (the latest COMPLETED outcome's id — the desktop scheduler uses `runId` as `outcome_id`); the adapter applies `slabTurnIdForRun` at projection time.
- **Verifiability** — `goal-result` is added to `@motebit/protocol`'s closed `ContentArtifactType` registry (the first non-relay-state-export consumer; named constant `GOAL_RESULT_ARTIFACT`; drift gate `check-artifact-type-canonical` mirrors the addition). New runtime helper `signGoalArtifact(content, { goalId, runId })` wraps the artifact bytes via `signContentArtifact` (`@motebit/crypto`, suite `motebit-jcs-ed25519-hex-v1`); identity-load-pending fires return null fail-safe rather than sign with a placeholder. Web stores the manifest in localStorage under `motebit.goal_artifact_manifest.${goal_id}` — verifiable offline by `motebit-verify content-artifact <body> --manifest <manifest>` (CLI auto-supports the new type via `ALL_CONTENT_ARTIFACT_TYPES`).

**Phase-3 deferral close — receipt summary on the goal card.** The Phase-3 doctrine assumed web shipped a "Signed" indicator alongside the receipt-category surface; web actually only persisted the manifest in localStorage with no visible indicator. The deferral close adds a glanceable **receipt-summary row** to the collapsed card view on each surface, between the header row and the budget bar:

```
ran 5m ago · signed     ← successful fire, manifest minted
ran 5m ago              ← successful fire, signing skipped (identity not loaded)
failed 5m ago           ← last fire errored (amber tint)
```

The row reads as `f(last_run_at, last_error, last_manifest_signed)`. `last_manifest_signed` is a new field on `ScheduledGoal` (`@motebit/panels`) cleared symmetrically with `last_response_full` and `last_turn_id` on error fires — the indicator must not outlive the artifact it attested. Adapters thread `manifestSigned: boolean` through `GoalFireResult.fired`; legacy adapters omit and the runner stores `null` so the renderer simply omits the indicator (calm-software degradation).

The verb pair `ran` / `failed` is deliberately calm-software-shaped: the doctrine register is Apple Reminders / Shortcuts, not aviation-cockpit. "Signed" stays lowercase to match the `cadence` / `in 56m` / `paused` ghost-color register on the same card. The hover-title on the "signed" chip names what's attested ("Result wrapped as a signed ContentArtifactManifest — independently verifiable via motebit-verify") so the indicator maps to the unified-receipt doctrine without forcing a docs trip.

**Phase-3 deferral close — SHIPPED 2026-05-14 across all surfaces.** Desktop's `tauri-migrations` v4 + mobile's `expo-sqlite-migrations` v24 both added a `signed_manifest TEXT` column to `goal_outcomes`; their schedulers now call `runtime.signGoalArtifact` at fire-time and persist the manifest JSON alongside the artifact bytes. The SQL / projection layer on each surface derives `last_manifest_signed` as `(signed_manifest IS NOT NULL on the latest COMPLETED outcome)`, threading into `ScheduledGoal.last_manifest_signed` on the panels-runner contract. The receipt-summary row reads identically on web / desktop / mobile — calm-software degradation when identity isn't loaded or the signer throws (NULL → no indicator). The `@motebit/protocol` `GOAL_RESULT_ARTIFACT` registry entry that Phase 3 added now has three independent signing consumers per the closed `ContentArtifactType` family.

**Originally deferred from Phase 3 (now closed above):**

- ~~Desktop + mobile **manifest persistence**.~~ Closed 2026-05-14.
- Mobile **slab handoff** (per [[mobile_glass_deferred]]). Mobile's slab is structurally less developed than web/desktop; Phase 3's data-preservation (commit 1) is enough mobile coverage for the artifact-bytes durability story. The `last_turn_id` field on `ScheduledGoal` is absent on mobile's adapter projection today; mobile mirror lands when mobile-slab matures.
- Plan-mode (once) goals create N inner slab items rather than a single goal-scoped artifact, so the "View result" affordance is correctly absent for them. Collapsing plan-step slab items into a single goal-scoped artifact is a separate arc.

The phasing isn't intermediate-state busywork; each phase is required infrastructure for the next, and each is reviewable on its own. Phase 1's doctrine is the contract. Phase 2's data preservation is required by Phase 3 (the manifest needs full content). Phase 3 makes the slab pipeline legible + verifiable end-to-end.

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
