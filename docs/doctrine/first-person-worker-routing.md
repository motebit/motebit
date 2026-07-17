# First-person worker routing

**The sovereign chooses who to hire from its own accumulated trust — never a global score, never the relay's arbitrary order.**

## The gap this closes

A molecule that sub-delegates a capability (the Researcher hiring a `web_search` atom) has to answer "which of the agents advertising this capability do I hire?" Until now it answered one of two ways, both unsatisfying:

1. **Pinned** — an env var (`MOTEBIT_WEB_SEARCH_TARGET_ID`) names exactly one worker. Correct as an explicit affordance, but it's a hardcode, not a decision.
2. **Unpinned** — `resolveP2pPaymentRequest` (`packages/runtime/src/relay-delegation.ts`) did `candidates.find(admissible)` over the relay's discovery response, and the relay's discovery query has **no `ORDER BY`**. So the fallback behind every pin was _first-eligible-in-arbitrary-SQL-order_ — a coin flip.

Meanwhile the molecule was **accumulating first-person trust the whole time** — pairwise `agent_trust` records (`(self, remote)`), interaction counts, completed-vs-failed tasks, promotions through the trust ladder — and **never consulting any of it to choose.** The trust graph was write-only with respect to routing. This makes it **read**: the atom you've had good, cheap, reliable results from is the atom you hire again. That is thesis #2 (_more capable the longer it runs_) showing up in the **hand**, not a panel — the "interior drawn upon" of [`felt-accumulation.md`](felt-accumulation.md), applied to an act.

## Two routing graphs, not one

This is **not** the auto-routing primitive of [`auto-routing-as-protocol-primitive.md`](auto-routing-as-protocol-primitive.md). That one routes **models** — `f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`, "which LLM answers this prompt", live in the proxy on `model:"auto"`, and it correctly lives in BSL `@motebit/policy`. This routes **workers** — "which motebit agent fulfills this capability" — a different graph (the trust graph, not the model catalog), and it lives where that graph lives: the runtime, composing the `@motebit/semiring` algebra. Keeping them separate is deliberate; they share the word "routing" and nothing else.

## The invariants

- **First-person, never global.** Ranking reads the caller's OWN `agent_trust` ledger, keyed `(self, remote)`. No inward global reputation score is consulted and none is constructed — that refusal _is_ the sybil resistance ([`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md)): a throwaway identity starts at the cold-start floor and must earn its way up through real completed work, non-transitively, pairwise. This is the sovereign counterpart to the relay's `graphRankCandidates` (`packages/market`): same semiring, opposite vantage — the relay ranks with what the caller disclosed; the molecule ranks with what it privately knows.

- **The pin is a deterministic override, ranking is the default.** A `targetWorkerId` is a _hire_ (surface-determinism — a tapped worker is a decision, not a suggestion): it bypasses ranking entirely and never substitutes ([`surface-determinism.md`](surface-determinism.md)). Ranking replaces only the _arbitrary unpinned_ path.

- **Ranking is an ordering, never a gate.** The HARD gates (advertises the capability P2P-eligibly, declares a settlement address, is not self, satisfies any pin) decide WHO is admissible. The selector only ORDERS the survivors. A null/unmatched selector result, an absent selector, or a single admissible candidate all fall back to first-admissible — today's behavior, unchanged. No worker that would have been paid before is now excluded; the change is _which_ admissible worker wins.

- **Deterministic.** Highest composite score, ties broken by `motebit_id` ascending. Same inputs → same hire (a routing decision must be reproducible).

## The primitive

`selectWorker` / `rankWorkers` in `@motebit/semiring` (`worker-selection.ts`) — a pure, reusable convenience over the existing `rankReachableAgents`. It builds a single-hop star graph (self → each admissible candidate) over the multi-objective `RouteWeightSemiring` and returns the winner with the `route` weight that produced its score as provenance ("why this worker"). It needs only `@motebit/protocol` + semiring's own exports, so it is not runtime-bound; the runtime injects it at the seam via a closure over its `agent_trust` store (a `WorkerSelector` — `packages/runtime/src/relay-delegation.ts`), threaded to BOTH the dry-run meter pre-flight and the live broadcast so the priced worker and the paid worker are the same one.

Three axes, one signal each:

- **trust** = the earned categorical level (`trustLevelToScore`), with a **0.1 cold-start floor** so an UNKNOWN-but-capable worker is still hireable — you cannot have earned trust before you have worked together.
- **reliability** = Beta-binomial success rate (Laplace prior α=β=1) — the **continuous accumulation lever**: each successful task lifts a worker above an untried one without waiting for a categorical promotion. Inlined rather than importing `@motebit/policy`'s scalar `computeReputationScore` (which collapses success+volume+recency into one number) — here each axis stays separate so the composite weights can trade them off. Same prior, same intent. **Scoped per capability** — see "Competence is a skill" below.
- **cost** = the worker's `unit_cost` for the capability. `rankReachableAgents` normalizes cost as `1/(1+cost)`, which is nearly flat below ~$0.10 — so at micro-price scale cost is deliberately a **weak** tiebreaker (you don't drop a trusted worker to save a fraction of a cent); it only dominates across dollar-scale gaps.

Default weights are trust-dominant (`0.5 trust / 0.3 reliability / 0.2 cost`), overridable per caller — the "swap the semiring to change what _best_ means" lever.

## Competence is a skill; the relationship is not

The categorical **trust level** and the **reliability counts** answer two different questions, and only one of them is capability-specific:

- The trust _level_ (`unknown → first_contact → verified → trusted`, and `blocked`) is a **pairwise relationship** — "do I trust this agent at all; is it a throwaway I should freeze out." That correctly spans capabilities: it is the sybil-resistance edge and the cold-start floor, earned once with an agent, not re-earned per skill.
- The success/fail **counts** are **competence**, which is per-skill: being reliable at `web_search` says nothing about `read_url`. Pooling them lets a proven `web_search` provider free-ride into `read_url` hires it has never done — a cross-capability bleed observed live (one atom serving two capabilities inflating both from one).

So the posterior is scoped by its natural grain. `AgentTrustRecord.capability_stats` (`{capability: {successful_tasks, failed_tasks}}`, local-only, never on the wire) buckets the counts per capability; the pairwise `trust_level` stays capability-agnostic and sets the **weak prior** (`levelPrior`). Hiring for capability X reads only X's bucket — a worker rich at `web_search` but cold at `read_url` starts `read_url` at the uncertain 0.5, with a small relationship head-start from the level prior, and must earn `read_url` reliability on its own. Absent a bucket the posterior reads **cold-at-this-capability, never the aggregate** — that fallback is exactly the bleed the scoping removes. Threaded as `selectWorker(self, candidates, { capability })`; with no capability it uses the aggregate counts, byte-identical to the pre-scoping default. `competenceCounts` in `worker-selection.ts`.

## The write side: the ledger the selector reads is actually filled

Ranking is only real if the counts accumulate. A completed paid sub-hop (`executeGrantedDelegation`) now feeds the molecule's own ledger: on a verified worker receipt it calls `bumpTrustFromReceipt(receipt, true, capability)`, crediting the **direct** counterparty it chose and paid (never a laundered sub-sub-worker — the ego-star rule of [`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md)) and landing the success in that capability's bucket. Verify-before-bump: the receipt must self-verify against its own embedded `public_key` (the same self-verifiable discipline as the sovereign-receipt path) or it earns no credit — an unverifiable receipt never fabricates a trust edge. Best-effort: a bump failure never fails the delegation.

## What this increment did NOT do (deferred, with triggers)

- **Cost at micro-scale.** The absolute `1/(1+cost)` normalization barely discriminates sub-cent prices. A relative (ratio) cost normalization is a refinement for **when sub-cent price competition actually needs to matter** — i.e. a real market of same-capability atoms competing on fractions of a cent.
- **The "why" is computed but not surfaced.** `selectWorker` returns the provenance `route`, but the sub-hop receipt / log does not yet carry "hired Bob because trust 0.9, reliability 0.83". Surfacing it (the legible routing decision) is the next increment — trigger: the first time an operator or owner asks "why did it pick that worker?".
- **The runtime's `AgentGraphManager` still doesn't self-rank multi-hop.** This seam ranks the _direct_ candidates for one capability. Multi-hop best-path (the dormant `rankAgents`/`mostTrustedPath` query API) stays deferred until a genuine multi-hop _choice_ exists (a capability reachable only through an intermediary).
- **The live Researcher still pins its atoms.** Unpinning it (removing `MOTEBIT_WEB_SEARCH_TARGET_ID` so it chooses by trust) is the visible thesis demo — but it needs a **second provider of the same capability** on staging to show anything, so it's a deliberate follow-up, not folded in. The value shipped regardless: the latent trust-blind, non-deterministic selection defect is closed the moment a second provider registers.

## Proof

`selectWorker` is unit-tested in `@motebit/semiring` (trust-dominant, cold-start floor, blocked-exclusion, reliability-breaks-tie, accumulation-lifts-untried, deterministic tie-break, provenance, custom weights). The seam wiring is tested in `@motebit/runtime` (`relay-delegation.test.ts`): ranked winner over first-candidate, null → first-admissible fallback, pin bypasses the selector, single-candidate skips ranking, and the capability `unit_cost` reaches the selector.
