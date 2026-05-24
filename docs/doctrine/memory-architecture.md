# Memory architecture — a signed, sovereign, bi-temporal knowledge graph that decays

Memory is not a feature bolted onto the chat surface. It is the **interior that accumulates** — the substance of the second of the three things no one else is building together (persistent identity, _accumulated trust_, governance at the boundary). Identity is the boundary; the model is the fuel; memory is what the metabolism leaves behind. So memory is held to the same bar as identity, receipts, policy, and settlement: typed, signed, sovereign, governed. The one-line end state:

> **A signed, sovereign, bi-temporal knowledge graph that decays.**

Every word is load-bearing, and most of it already exists in `@motebit/memory-graph`. This doctrine names the whole shape — what ships today, what the deltas are — so the memory story stops being scattered across [`dissolution-spectrum.md`](dissolution-spectrum.md), [`retention-policy.md`](retention-policy.md), and [`proactive-interior.md`](proactive-interior.md) and reads as one architecture.

## Why memory is protocol-grade, not chat-history-plus-embeddings

The failure mode the whole industry starts in: memory as a flat vector store of conversation snippets, retrieved by cosine similarity, owned by the vendor, never forgotten, never typed, never signed. That is a weak leg. If memory is "chat history plus embeddings," it cannot be the moat — it is a commodity the model provider already ships.

Motebit's memory is structurally different on four axes the commodity shape lacks: it is **typed** (a knowledge graph with cognitive node/edge taxonomies, not a blob), it **decays** (dissolution physics — forgetting is signal-preservation, not loss), it is **sovereign** (interior structure bound to the motebit's keypair, not a vendor's cloud DB), and it is **governed** (sensitivity-gated, retention-bounded, deletion-certified). The differentiator is not any single one — the field has each somewhere — it is the **composition**.

## The shape — a typed knowledge graph

Memory is a directed graph of `MemoryNode`s and typed edges, not a vector pool. The vocabularies are closed enums (interop law, same discipline as the rest of the protocol):

- **Node taxonomy** — `MemoryType` (`@motebit/protocol`): `Episodic` (timestamped observations, interaction trajectories) and `Semantic` (distilled, durable facts/preferences). Procedural memory is **not** a `MemoryType` — it lives in [`@motebit/skills`](../../packages/skills/CLAUDE.md) as install-gated procedural knowledge. The episodic/semantic split is load-bearing: they carry different entry confidences (`promotion.ts`: episodic 0.6, semantic 0.7, explicit user statement higher), different decay, and different retrieval weight. Conflating them into one store is the common design error.
- **Edge taxonomy** — `RelationType` (`@motebit/sdk`): `Related` (semantic proximity, Hebbian-strengthened on co-retrieval), `CausedBy` / `FollowedBy` (causal + temporal), `ConflictsWith` (contradiction that does not yet supersede), `Reinforces` (confirmation), `PartOf` (composition), `Supersedes` (one belief replaces another). This is already richer than the typical `{related, supersedes}` pair — the temporal and conflict edges are what make multi-hop and belief-revision reasoning possible.

The graph is in `packages/memory-graph/src/index.ts` (`MemoryGraph`); embeddings come through an adapter with a deterministic hash fallback (`embeddings.ts`) per the metabolic principle — absorb the model-backed embedder, never bind to it.

## Write — extraction is selective, deferred, and confidence-scored

The model tags memory **candidates** during its turn (`extractMemoryTags` in `@motebit/ai-core` → `MemoryCandidate { content, confidence, sensitivity, memory_type }`). Formation is **deferred** off the turn's critical path (the `memory_formation_deferred` chunk → `formMemoriesFromCandidates`, queued single-lane) so latency stays low. Candidates are classified by confidence into certainty tiers (`memory-index.ts`): **absolute** (≥ 0.95), **confident** (0.7–0.95), **tentative** (< 0.7). Selectivity is the intended behavior, not a bug — a durable fact ("user's name is Daniel", 95%) forms; an abstract exchange yields few candidates worth persisting.

## Read — recency × importance × relevance, then the graph

Retrieval (`retrieval.ts`) is the Generative-Agents scoring extended with graph structure: a weighted blend of semantic **similarity** (embedding cosine), **confidence** (decayed), and **recency**, then a semantic rerank, then 1-hop traversal over `Related` edges. Co-retrieved nodes strengthen their `Related` edge (**Hebbian co-retrieval**) — recall reshapes the graph, biologically grounded and beyond what most systems do. Scoring weights are tunable (`ScoringConfig`); higher graph maturity shifts weight toward semantic precision.

## Forget — decay is dissolution physics

Forgetting is a feature: it suppresses noise and prevents context bloat. Confidence decays exponentially with time (`computeDecayedConfidence`, per-node `half_life` + `recencyHalfLife`), reinforced on access (Ebbinghaus: strength rises with importance and repeated retrieval). This is **axis 1 of the dissolution spectrum** — see [`dissolution-spectrum.md`](dissolution-spectrum.md) for the unified five-axis physics. Decayed-to-near-zero nodes are pruned in the consolidation cycle. Forgetting is loss of _salience_, never destruction of _history_ (see bi-temporal, below).

## Consolidate & reflect — bounded idle metabolism

Consolidation resolves new candidates against existing memory via an LLM decision (`consolidation.ts`, `ConsolidationDecision`): **ADD** (new), **UPDATE** (supersede), **REINFORCE** (confirm), **NOOP** (skip) — the same verb set the strongest extractive-memory systems converge on. Reflection synthesizes higher-level insight and surfaces `findCuriosityTargets` / `detectReflectionPatterns` from graph structure.

This runs in the four-phase idle cycle `runtime.consolidationCycle()` (orient → gather → consolidate → prune → flush; [`proactive-interior.md`](proactive-interior.md), gate `check-consolidation-primitives` #34) — motebit's "sleep-time compute." **It must stay bounded by governance: alive, never hungry.** Idle consolidation runs only over sensitivity-cleared memory classes; sensitive memory obeys the retention cliffs; external AI receives only sensitivity-cleared projections (`check-sensitivity-routing` #65); `DeletionCertificate`s remain authoritative. Proactive tool scope is fail-closed by default.

## Bi-temporal validity — memory you can audit at a point in time

The headline of the end-game. A memory has two independent time dimensions:

- **Recording time** — when the motebit learned it (`created_at`, already present; the append-only horizon in [`retention-policy.md`](retention-policy.md)).
- **Validity time** — when the fact it asserts was _true in the world_ (`valid_from` / `valid_until`).

The in-store layer is **already built**: `MemoryContent.valid_from` / `valid_until` (`@motebit/protocol`) are inherited by `MemoryNode`; `formMemory` stamps `valid_from`; supersession (the consolidation `UPDATE` path in `@motebit/memory-graph`) sets `valid_until` on the superseded node, **keeps it live and keeps the `Supersedes` edge** for provenance — one mechanism, never a parallel `invalidated_at` field, never mutation or tombstoning of the old node; and every retrieval lens filters `valid_until` so current recall excludes superseded beliefs while an `includeExpired` flag reaches them.

This is the same move motebit already trusts for **key revocation** — the effective `compromised_at` differs from the relay's recording time (the backdated-revocation work). `recorded time ≠ effective time`, applied to the interior. And it composes with the self-attesting thesis: a memory's validity interval becomes an **attestable** property — memory as auditable as a receipt.

Both protocol-grade pieces now ship: (1) **wire emission** — `memory_formed` carries `valid_from`/`valid_until` and `memory_consolidated` carries `superseded_valid_until` (spec [`memory-delta-v1.md`](../../spec/memory-delta-v1.md) §3.5/§5.1/§5.5), so validity syncs across devices and federation, not just locally; (2) **point-in-time as-of-`T` retrieval** — `recallRelevantCore`'s `asOf` option + the shared `isValidAt(node, t)` predicate select nodes whose `[valid_from, valid_until)` interval contains `T`, so recall answers "current," "all history," AND "what did I believe as of date `T`." Bi-temporal validity is therefore end-to-end.

## Sovereign, signed, sensitive — the moat layer

What the commodity shape structurally cannot have:

- **Sovereign.** Memory is interior structure bound to the motebit's keypair, owned by the user — not a vendor's hosted store. Restoring the seed restores the memory's owner.
- **Sensitive, fail-closed.** Sensitivity (`none` / `personal` / `medical` / `financial` / `secret`) is carried on every candidate and node; medical/financial/secret never reach external AI; retention obeys `MAX_RETENTION_DAYS_BY_SENSITIVITY` cliffs ([`retention-policy.md`](retention-policy.md)). Privacy is memory _physics_, not a setting.
- **Signed.** Each memory consolidation _cycle_ emits a signed `ConsolidationReceipt` (Ed25519/JCS via `signConsolidationReceipt`; portably verifiable with `verifyConsolidationReceipt`, no relay needed) attesting the cycle's `phases_run` (orient/gather/consolidate/prune/flush) + timing — Merkle-batched and anchored on-chain via `ConsolidationReceiptsAnchored`. The memory's _evolution_ is cryptographically attested at the cycle granularity (the meaningful unit), not per micro-decision. The per-decision `memory_consolidated` events ride the event log; the signed receipt is the cycle-level attestation.
- **Self-auditing.** `notability.ts` scores memory health — **phantom** (isolated high-confidence belief), **conflict** (contradiction partner), **decay** (near-death) — through the `TrustSemiring`. Memory health and trust share one algebra.

## What must never happen

The invariants this doctrine fences (the inverse of the moat):

1. **Opaque vendor memory** — memory the user cannot own, export, or verify.
2. **Deletion by mutation** — overwriting a belief in place. Supersession is invalidation-with-provenance; history is preserved.
3. **Sensitive egress** — medical/financial/secret memory reaching external AI, ever.
4. **Unbounded retention** — memory that ignores sensitivity ceilings or the deletion-certificate authority.

## Shipped vs. delta

Shipped today: the typed graph, episodic/semantic nodes, the eight-edge taxonomy, confidence + exponential decay reinforced on access, recency×importance×relevance + Hebbian retrieval, ADD/UPDATE/REINFORCE/NOOP consolidation, reflection + curiosity, the notability self-audit, sensitivity + retention + deletion certificates, the idle consolidation cycle, **bi-temporal validity end-to-end** (`valid_from`/`valid_until` on `MemoryContent`, stamped at formation, supersession sets `valid_until` and preserves the node, emitted on the `memory_formed`/`memory_consolidated` wire so it syncs across devices/federation, and point-in-time as-of-`T` retrieval — spec [`memory-delta-v1.md`](../../spec/memory-delta-v1.md) §3.5/§5.1/§5.5), and **episodic-eager extraction** (the tag instruction captures interest/trajectory memories as `Episodic`, not just high-confidence semantic facts — what makes the cognitive taxonomy load-bearing and motebit a thinking companion rather than a fact store; bounded by low confidence so one-off interests decay).

Also shipped: **default-on bounded consolidation** — the idle cycle now defaults **on** where inference is free to the user (on-device / BYOK; opt-in on metered motebit-cloud via [`inferenceIsFreeToUser`](../../packages/sdk/src/provider-mode.ts)), so episodic→semantic abstraction + curiosity + the already-built signed `ConsolidationReceipt` emission + anchoring fire by default rather than waiting for a Settings opt-in. Bounded two ways: the `consolidate` phase drops ≥`Medical` episodics from external-AI summarization on non-sovereign providers (the privacy floor inside the cycle), and the per-cycle reflection LLM call is gated on a new user message since the last cycle (`_lastConsolidationCycleAt`) so an idle motebit stops re-reflecting against the user's provider every interval. **Catch-up consolidation** closes the short-session gap: the idle-tick only fires while the process runs and the user idles past the quiet window, so `start()` also fires a one-shot `catchUpConsolidationIfOverdue()` — a single cycle (not a parallel loop) when none has run within the catch-up window, read from the persistent `ConsolidationCycleRun` event log so it survives restarts, fully abortable by a user message. See [`proactive-interior.md`](proactive-interior.md) § "Default posture".

And the last named edge: **`DerivedFrom` provenance** — when reflection persists a high-signal insight, it links the insight back to the source observations it was derived from (the reflection-input nodes most similar to it by embedding, above a relatedness floor, capped per insight). The reflection analog of consolidation's `PartOf` cluster→summary edge; together they make the graph's _synthesis_ traceable, not just its nodes. `RelationType.DerivedFrom` is the eighth edge.

With that, the end-game shape this doctrine names — **a signed, sovereign, bi-temporal knowledge graph that decays** — is realized end-to-end; no named deltas remain open. Future work is _deepening_ within the shape (richer provenance granularity, per-fire `ExecutionReceipt`-sourced ledger, reliable bounded consolidation tuning), not new legs of the skeleton.

## Cross-references

- [`dissolution-spectrum.md`](dissolution-spectrum.md) — memory decay as axis 1 of the five-axis dissolution physics.
- [`retention-policy.md`](retention-policy.md) — sensitivity ceilings, the append-only horizon, and the `DeletionCertificate`.
- [`proactive-interior.md`](proactive-interior.md) — the `consolidationCycle()` and fail-closed proactive scope.
- [`self-attesting-system.md`](self-attesting-system.md) — why a memory's validity interval should be attestable.
- [`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md) — selectivity and sensitivity enforced structurally, not by prompt.
- `THE_METABOLIC_PRINCIPLE.md` — the embedder is absorbed through an adapter; the accumulated graph is the residue.
