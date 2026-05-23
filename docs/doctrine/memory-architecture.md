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

Today `MemoryNode` carries only recording time, and `Supersedes` invalidates at _recording_ time. That means motebit can say "I recorded this on May 23" but not "this was true May 10–18 and was superseded May 21." Bi-temporal validity closes that: supersession sets `valid_until` on the superseded node (event-time end) **and keeps the `Supersedes` edge** for provenance — one mechanism, never a parallel `invalidated_at` field, and never mutation of the old node. Retrieval can then answer both _"current memory"_ and _"as-of memory."_

This is the same move motebit already trusts for **key revocation** — the effective `compromised_at` differs from the relay's recording time (the backdated-revocation work). `recorded time ≠ effective time`, applied to the interior. And it composes with the self-attesting thesis: a memory's validity interval becomes an **attestable** property — memory as auditable as a receipt. The reference shape (`valid_from` / `valid_until`) already exists in `@motebit/protocol`; the delta is putting it on `MemoryNode`.

## Sovereign, signed, sensitive — the moat layer

What the commodity shape structurally cannot have:

- **Sovereign.** Memory is interior structure bound to the motebit's keypair, owned by the user — not a vendor's hosted store. Restoring the seed restores the memory's owner.
- **Sensitive, fail-closed.** Sensitivity (`none` / `personal` / `medical` / `financial` / `secret`) is carried on every candidate and node; medical/financial/secret never reach external AI; retention obeys `MAX_RETENTION_DAYS_BY_SENSITIVITY` cliffs ([`retention-policy.md`](retention-policy.md)). Privacy is memory _physics_, not a setting.
- **Signed.** Consolidation emits a `memory_consolidated` event (a registered `EventType`); the end state makes it a first-class signed artifact, so the memory's evolution is itself verifiable.
- **Self-auditing.** `notability.ts` scores memory health — **phantom** (isolated high-confidence belief), **conflict** (contradiction partner), **decay** (near-death) — through the `TrustSemiring`. Memory health and trust share one algebra.

## What must never happen

The invariants this doctrine fences (the inverse of the moat):

1. **Opaque vendor memory** — memory the user cannot own, export, or verify.
2. **Deletion by mutation** — overwriting a belief in place. Supersession is invalidation-with-provenance; history is preserved.
3. **Sensitive egress** — medical/financial/secret memory reaching external AI, ever.
4. **Unbounded retention** — memory that ignores sensitivity ceilings or the deletion-certificate authority.

## Shipped vs. delta

Shipped today: the typed graph, episodic/semantic nodes, the seven-edge taxonomy, confidence + exponential decay reinforced on access, recency×importance×relevance + Hebbian retrieval, ADD/UPDATE/REINFORCE/NOOP consolidation, reflection + curiosity, the notability self-audit, sensitivity + retention + deletion certificates, and the idle consolidation cycle.

The deltas to reach the end-game (deliberate future work, in order):

- **Bi-temporal validity** — `valid_from` / `valid_until` on `MemoryNode`; supersession sets `valid_until`; as-of retrieval. Spec change first ([`spec/memory-delta-v1.md`](../../spec/memory-delta-v1.md)).
- **`DerivedFrom` edge** — provenance from a reflection-synthesized memory back to its source observations.
- **Episodic-eager extraction** — capture interest/trajectory memories via the existing `Episodic` type, not only high-confidence semantic facts; what turns a fact-store into a companion.
- **Reliable bounded consolidation** — the idle cycle currently runs only when Proactive Interior is enabled; make it run by default within the governance bounds above.
- **Signed `memory_consolidated`** — promote the consolidation event to a first-class signed artifact, fully realizing the "signed" leg.

## Cross-references

- [`dissolution-spectrum.md`](dissolution-spectrum.md) — memory decay as axis 1 of the five-axis dissolution physics.
- [`retention-policy.md`](retention-policy.md) — sensitivity ceilings, the append-only horizon, and the `DeletionCertificate`.
- [`proactive-interior.md`](proactive-interior.md) — the `consolidationCycle()` and fail-closed proactive scope.
- [`self-attesting-system.md`](self-attesting-system.md) — why a memory's validity interval should be attestable.
- [`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md) — selectivity and sensitivity enforced structurally, not by prompt.
- `THE_METABOLIC_PRINCIPLE.md` — the embedder is absorbed through an adapter; the accumulated graph is the residue.
