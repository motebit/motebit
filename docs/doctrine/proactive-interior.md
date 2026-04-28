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

Every proactive AI tool today binds the agent's identity to the operator's billing relationship. Motebit binds it to a sovereign Ed25519 identity, with consolidation receipts the agent signs to itself, anchorable on Solana via `spec/credential-anchor-v1`. That asymmetry is the moat.

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

**Anchoring** the receipt onchain is additive proof. `runtime.anchorPendingConsolidationReceipts(submitter?)` queries every signed receipt that hasn't appeared in a prior `ConsolidationReceiptsAnchored` event, hashes each one's canonical body to a Merkle leaf, builds a tree, and (if a `ChainAnchorSubmitter` is supplied) submits the root via `SolanaMemoSubmitter` — the same `motebit:anchor:v1:{root}:{leaf_count}` memo format the relay uses for credential anchors (`spec/credential-anchor-v1.md`).

**Auto-anchor policy.** Optional `proactiveAnchor` runtime config fires `anchorPendingConsolidationReceipts` automatically after each signed receipt when a trigger is reached: `batchThreshold` (default 8 unanchored receipts) OR `minAnchorIntervalMs` (default 0 = disabled). Omit the config to disable; pass `{}` for defaults with local-only anchors; pass `{ submitter }` to also publish onchain. Failures are best-effort — a submitter outage yields a local-only anchor; the next cycle sees only one new un-anchored receipt, not an accumulating backlog. Without the policy, anchoring requires a manual call (from a scheduled job, idle-tick hook, or surface affordance).

The anchor itself is not separately signed. Cryptographic load is carried by (a) the Ed25519 signatures on the receipts the anchor groups, and (b) the Solana transaction signed by the motebit's identity key (the address IS the identity public key — Ed25519 curve coincidence). When no submitter is provided, the anchor still emits with the Merkle root populated and `tx_hash`/`network` absent — verifiable by recomputation, just not timestamp-attested onchain. A submitter failure is non-fatal: the runtime emits a local-only anchor and logs the submitter error.

Receipt ordering inside a batch is stable: by `finished_at` ascending, with `receipt_id` lexicographic as tiebreaker. Verifiers reproduce the same root from the same set of receipts.

**Third-party verification.** `verifyConsolidationAnchor(anchor, receipts, publicKey)` in `@motebit/encryption` composes the three offline checks: receipt-order matches the anchor's commitment, every receipt's Ed25519 signature verifies against the motebit's public key, and the recomputed Merkle root equals `anchor.merkle_root`. When the verifier additionally has `anchor.tx_hash`, they fetch the Solana tx, parse the memo (`parseMemoAnchor` in `@motebit/wallet-solana`), and confirm the onchain root matches — that's the timestamp-attestation layer. The verification function never throws past its boundary; callers get a structured `{ ok, reason, recomputedMerkleRoot }` result. Reference TypeScript types + verifier primitives live in `@motebit/protocol` (Apache-2.0, zero monorepo deps) + `@motebit/crypto` (Apache-2.0) + `@motebit/encryption` (BSL). Normative wire format: [`spec/consolidation-receipt-v1.md`](../../spec/consolidation-receipt-v1.md) (Stable), with zod schemas and committed JSON Schema in `@motebit/wire-schemas`. A third-party implementer builds a producer or verifier in any language from the spec + the JSON Schema alone — no motebit source required.

## What the user sees

A motebit running with the proactive interior enabled:

- Settles into `tending` during quiet windows. The creature shows a subtle visual cue — `MotebitRuntime.renderFrame` applies a presence modulation when `presence.mode === "tending"`: `eye_dilation` capped at 0.5 (half-closed) and `glow_intensity` scaled ×0.85 (slightly dimmer). Every surface consuming `renderFrame` gets the modulation for free; no per-surface override needed.
- Returns to `idle` when the cycle completes. No toast, no notification, no chat bubble.
- Surfaces consolidation activity post-hoc in the memory panel. Desktop: "Consolidation log" view lists each cycle with a status badge — `cycleId ⚓` for signed+anchored, `cycleId ✓` for signed-only, `cycleId` for unsigned (no keys or zero-phase cycle) — plus a one-line summary ("merged 3, pruned-decay 7") and time-ago. Records, not interruptions.
- Yields immediately when the user sends a message. `presence.enterResponsive()` triggers the cycle's AbortSignal; in-flight phase yields on the next checkpoint; partial work persists (memory writes are atomic).

## What's deferred

Desktop UI landed (settings toggle + creature presence modulation + memory-panel consolidation log). Web + mobile + spatial follow one-pass after desktop's UI dogfoods.

## What was deferred and is now done

The `runHousekeeping` unification landed 2026-04-28. The deferred-design question — does curiosity belong in the cycle's `gather` phase or stay a separate signal the gradient manager subscribes to? — was settled by the data: `housekeeping()` had been called only at runtime shutdown since the 2026-04-20 unification, firing at a soon-to-be-disposed gradient manager. Curiosity-target computation was effectively dead in production for eight days, and the gradient was being kept fresh only by interactive-turn paths (cold-start, every-fifth-turn reflection) — never during long idle windows.

Resolution: curiosity is a `gather`-class operation and now lives in the cycle's `gather` phase. `findCuriosityTargets` runs over the same live-node set the rest of `gather` already loaded; the result is pushed via the cycle's `setCuriosityTargets` dep callback into `gradientManager.setCuriosityTargets`. The cycle gained a parallel `computeAndStoreGradient` dep callback so the post-prune gradient recompute runs once per cycle, restoring the periodic-during-idle gradient updates the shutdown-only housekeeping path never delivered.

Net: `packages/runtime/src/housekeeping.ts` deleted. `MotebitRuntime.housekeeping()` deleted. The shutdown call in `stop()` deleted. The `episodicConsolidation` config option (zero callers, zero effect — never propagated into the cycle) deleted. Surfaces (`apps/{cli,web,mobile,spatial}`) migrated their periodic-tick callers from `runtime.housekeeping()` to `runtime.consolidationCycle()`. The cycle is now the only proactive maintenance loop, in code as well as in doctrine.

## How to apply

When you write code that "does something during idle time," ask three questions before adding a new path:

1. **Is it memory consolidation?** Then it's a phase of the existing cycle. Add to gather/consolidate/prune in `consolidation-cycle.ts`. Don't write a parallel loop.
2. **Is it a side-effecting proactive tool?** Then add the tool to `TENDING_ALLOWED_TOOLS` only after a deliberate review of its blast radius. Default answer is no — surface-output tools are bounded by user opt-in only, not by the runtime's tending scope.
3. **Is it a new presence mode?** Almost certainly no. The three modes (idle / tending / responsive) cover the design space. Adding a fourth requires updating every surface's render layer; the bar is doctrine-level, not local convenience.

Drift gate #34 (`check-consolidation-primitives`) catches the most likely failure mode: a future consumer reaches for `clusterBySimilarity + provider.generate + formMemory + deleteMemory` inline because the cycle "looked complicated." The fix is `runtime.consolidationCycle()`. The cycle is one line to call.
