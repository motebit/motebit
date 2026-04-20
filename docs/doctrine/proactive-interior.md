# Proactive interior

A motebit's interior is active. The body is passive. Idle is not absence — idle is the time the motebit uses to consolidate what it knows. This doctrine names what proactive means, what's allowed, and what protects the user from runaway action.

## Three pillars

### 1. Presence — typed operational mode

The motebit is in exactly one of three modes at any instant:

- **idle** — waiting for the next user message or idle tick. Surfaces render the baseline creature.
- **tending** — running a consolidation cycle. Surfaces render a subtle indicator (slower breath, dimmer eye glow). The user can interrupt at any time; the cycle yields on the next abort checkpoint.
- **responsive** — actively processing a user turn. Standard speaking/attention cues.

State machine lives in [`packages/runtime/src/presence.ts`](../../packages/runtime/src/presence.ts). Subscribe shape mirrors `StateVectorEngine.subscribe()` exactly so surfaces adopt the same observer pattern they already know.

A watchdog timer is armed when the motebit enters tending. If `exitTending` is not called within budget (default 4 phases × 15s × 2 safety factor = 120s), the watchdog forces presence back to idle and emits a `presence_recovered` event. This is the safety net for an awaited promise that ignores its abort signal.

### 2. Consolidation cycle — the four phases

The motebit's only proactive maintenance loop. Lives in [`packages/runtime/src/consolidation-cycle.ts`](../../packages/runtime/src/consolidation-cycle.ts). Invoked by the runtime's idle-tick when `proactiveAction: "consolidate"` is configured, OR called directly via `runtime.consolidationCycle()`.

| Phase           | What it does                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **orient**      | Read the current memory index and the recent-activity window. Cheap projection.                                                                   |
| **gather**      | Run reflection (its insights become same-cycle promotion candidates), rank notable memories, cluster episodic candidates by embedding similarity. |
| **consolidate** | Summarize each cluster via the LLM, form a semantic memory, link parents with PartOf edges, tombstone the cluster members.                        |
| **prune**       | Retention enforcement, decay tombstoning, low-notability noise-removal.                                                                           |

Each phase has an independent budget (default 15s). When the budget fires, the phase yields partial work and the cycle moves to the next phase. Phase errors are caught and recorded in `CycleResult.phasesErrored`; subsequent phases run.

The cycle emits one `ConsolidationCycleRun` event with the full result payload. It does not surface to the user via toast, chat bubble, or notification — calm software. Discovery happens through the memory panel's consolidation log (follow-up surface work).

### 3. Proactive capability scope — fail-closed by default

When presence is `tending`, the AI loop's tool registry is filtered to a small allowlist. Two layers of restriction stack:

1. **User opt-in.** `MotebitConfig.proactiveCapabilities: string[]` defaults to `[]`. The user explicitly names which tools may fire proactively.
2. **Runtime allowlist.** Even names the user opted into are intersected with `TENDING_ALLOWED_TOOLS` (currently: `form_memory`, `rewrite_memory`, `prune_memory`, `search_conversations`). Surface-output tools (`send_notification`, `send_user_file`, anything that touches the world outside the motebit) are blocked even if the user named them.

This is sovereign default writ at the tool boundary: the motebit cannot do anything proactively until the user explicitly says yes, and even then only memory-touching things. Implementation in [`packages/runtime/src/scoped-tool-registry.ts`](../../packages/runtime/src/scoped-tool-registry.ts).

## Why we unified

Before this work, motebit had two parallel maintenance paths: `runHousekeeping` (timer-scheduled in cli/web/mobile) and `proactiveAction:"reflect"` (idle-tick triggered). They overlapped in scope (both touched memory consolidation), differed in shape, and would have drifted further apart with each new consumer. The cycle is the unification.

The strategic prize: every proactive AI tool today binds the agent's identity to the operator's billing relationship. Motebit binds it to a sovereign Ed25519 identity, with consolidation receipts the agent signs to itself, anchorable on Solana via `spec/credential-anchor-v1`. That asymmetry is the moat.

See [`scripts/check-consolidation-primitives.ts`](../../scripts/check-consolidation-primitives.ts) (drift gate #34) for the canonical-vs-inline test.

## Self-attesting consolidation — the receipt

Every consolidation cycle that runs at least one phase produces a signed `ConsolidationReceipt` when the runtime has signing keys configured. The receipt is the foundation of the moat: third parties verify the motebit's proactive work from the receipt alone, no relay contact required.

Shape (in `@motebit/protocol`):

- `motebit_id`, `cycle_id`, `started_at`, `finished_at`, `phases_run`, `phases_yielded`
- `summary` — structural counts only (orient nodes, gather clusters, gather notable, consolidate merged, prune counts)
- `public_key` (embedded, hex) for portable verification
- `suite: "motebit-jcs-ed25519-b64-v1"` + `signature` (base64url Ed25519 over JCS canonical body)

**Privacy boundary is the type.** There is no field on `ConsolidationReceipt` that could carry memory content, embeddings, or sensitive identifiers. Adding such a field is a protocol break — surface it for review, never inline. The summary commits to "merged 12 clusters into 3 semantics," not to which 12 or what they contained.

Sign + verify primitives live in `@motebit/crypto` (`signConsolidationReceipt`, `verifyConsolidationReceipt`); the runtime calls the signer in `consolidationCycle`'s post-phase hook and emits a `ConsolidationReceiptSigned` event with the signed body in the payload. Best-effort emission — a signing or event-store failure never throws past the cycle boundary.

**Anchoring** the receipt onchain is the next layer (deferred follow-up). The shape is anchor-ready: a stable hash over the canonical body can be Merkle-batched and submitted to Solana via the existing `SolanaMemoSubmitter` (the same pattern `spec/credential-anchor-v1` defines for credentials). Until then, the receipt is self-attesting — anchoring is the additive proof that the receipt existed at the time it claims, not a precondition for it being verifiable.

## What the user sees

A motebit running with the proactive interior enabled:

- Settles into `tending` during quiet windows. The creature shows a subtle visual cue (TBD per surface — desktop renders via existing `BehaviorCues.eye_dilation` + `glow_intensity` modulation).
- Returns to `idle` when the cycle completes. No toast, no notification, no chat bubble.
- Surfaces consolidation activity post-hoc in the memory panel: "Consolidated overnight: 12 memories merged, 3 promoted." Records, not interruptions.
- Yields immediately when the user sends a message. `presence.enterResponsive()` triggers the cycle's AbortSignal; in-flight phase yields on the next checkpoint; partial work persists (memory writes are atomic).

## What's deferred

Surface polish for desktop landed in this PR as the runtime config wire + integration test only. Three follow-up pieces are explicitly deferred so the foundation can ship first:

- **Settings UI toggles** — two opt-in checkboxes in `apps/desktop/src/ui/settings.ts`: "Allow [name] to act on its own time" and "Allow [name] to consolidate memory while idle." Persistence already supported via `DesktopAIConfig.proactive`.
- **Creature presence visual** — modulate `BehaviorCues.eye_dilation` + `glow_intensity` based on `presence.mode === "tending"`. Subscribe pattern is in place; adapter rendering is the missing piece.
- **Memory panel "Consolidation log"** — disclosure card querying `events.query({ event_types: [EventType.ConsolidationCycleRun] })` with the existing expandable-card pattern.

Web + mobile + spatial follow one-pass after desktop's UI lands.

The unification of `runHousekeeping` is also deferred: `housekeeping.ts` stays as a deprecated alias on the consolidation drift gate's allowlist with a named follow-up. Migrating the cli/web/mobile schedulers and the 30+ test sites in one PR was deemed unsafe; the deprecation window holds them green while the cycle proves out on desktop.

## How to apply

When you write code that "does something during idle time," ask three questions before adding a new path:

1. **Is it memory consolidation?** Then it's a phase of the existing cycle. Add to gather/consolidate/prune in `consolidation-cycle.ts`. Don't write a parallel loop.
2. **Is it a side-effecting proactive tool?** Then add the tool to `TENDING_ALLOWED_TOOLS` only after a deliberate review of its blast radius. Default answer is no — surface-output tools are bounded by user opt-in only, not by the runtime's tending scope.
3. **Is it a new presence mode?** Almost certainly no. The three modes (idle / tending / responsive) cover the design space. Adding a fourth requires updating every surface's render layer; the bar is doctrine-level, not local convenience.

Drift gate #34 (`check-consolidation-primitives`) catches the most likely failure mode: a future consumer reaches for `clusterBySimilarity + provider.generate + formMemory + deleteMemory` inline because the cycle "looked complicated." The fix is `runtime.consolidationCycle()`. The cycle is one line to call.
