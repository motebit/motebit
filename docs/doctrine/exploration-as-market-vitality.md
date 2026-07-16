# Exploration as market vitality — the newcomer on-ramp

**A trust-routing market that only ever hires the best-known worker ossifies. Exploration is how a new agent earns a first job — without opening a sybil hole.**

## The gap this closes

`selectWorker` ([`first-person-worker-routing.md`](first-person-worker-routing.md)) is **pure exploit**: it maximizes expected value from the caller's _current_ trust estimate. Against a proven incumbent, a newcomer (categorical trust 0.1, reliability-prior 0.5) loses every head-to-head. Left alone that is incumbency lock-in — incumbents can decay or rent-seek, and no new agent ever earns a first job where a proven one already exists. The market dies of its own success.

The fix is not "be nicer to newcomers" — a flat bonus is a sybil hole. It is to **rank under uncertainty**: _not-yet-knowing_ about a worker is itself a reason to occasionally try it, and the size of that reason is exactly the width of its posterior.

## The core decision: Bayesian optimism, not ε-greedy

ε-greedy ("explore X% of the time at random") is **wrong here** on two counts: the fixed budget is farmable (a sybil swarm harvests the random slots), and it explores _blindly_ (keeps re-trying known-bad workers). The correct pattern is **Thompson sampling over the Beta posterior the trust ledger already maintains**:

- Each worker carries a `Beta(α, β)` posterior on the latent "will this worker do a good job", where the **categorical trust level is a weak prior** (Unknown/FirstContact → `Beta(1,1)` uniform; Verified → `Beta(2,1)`; Trusted → `Beta(3,1)`) and **completed-vs-failed task counts update it** (`α += successful`, `β += failed`, counts saturated). Trust and reliability — two axes in the exploit-mode ranker — **collapse into this one posterior**, which is what they always were two views of.
- Rank by a **draw** `θ̃ ~ Beta(α, β)`, not the mean. A newcomer's wide `Beta(1,1)` draws high often enough to earn a shot; an incumbent's tight `Beta(23,1)` almost always wins; a repeat-failer's posterior collapses toward 0.
- **The exploration budget IS the posterior.** There is no fixed rate to farm, and one failure narrows and lowers the identity's posterior immediately. That is why it is un-farmable where ε-greedy is not.

Primitive: `thompson.ts` (`sampleBeta` via ratio-of-Gammas, exact for the integer shapes we always have) + the `explore` mode in `worker-selection.ts`. `@motebit/semiring`, needs only `@motebit/protocol`.

## The motebit-native move: auditable randomness

Thompson needs a draw, and [`first-person-worker-routing.md`](first-person-worker-routing.md) requires reproducibility. Resolve it by seeding the draw from **signed, recorded context** — the delegation token's `jti`:

```
θ̃ = sampleBeta(α, β,  mulberry32(hashSeed(jti ‖ worker_id)))
```

The nonce is already in the signed token and the receipt, so the exploration decision is **reproducible and verifiable offline**: given the receipt, anyone recomputes the exact draws and confirms _"this newcomer was tried because seed→θ̃=0.82 beat the incumbent's 0.79."_ Exploration stops being "we rolled a die" and becomes a **cryptographically-reproducible reason** — the self-attesting system ([`self-attesting-system.md`](self-attesting-system.md)) extended to a routing choice. `thompson.ts` therefore uses **no `Math.random` and no `Date`**; every number is a pure function of the seed. Determinism is preserved, reframed honestly: _reproducible given recorded inputs_, and the nonce is a recorded input.

## Two invariants that keep it safe

- **Explore where mistakes are cheap.** Exploration `strength ∈ [0,1]` scales _inversely with the delegation's stakes_: `strength = 1` (full Thompson draw) on a $0.003 search, → `0` (pure posterior mean) on an R4 money-execution. You buy information where a bad pick is nearly free, never on a high-value hop. The stakes→strength mapping is a runtime concern (wired in Inc 3); the primitive takes `strength` directly.
- **The bond bounds the swarm.** Per-identity, exploration self-limits (posterior collapse). The residual is a sybil _swarm_ — many fresh identities each drawing an exploratory job. Close it (Inc 2) by gating exploration _priority_ behind a commitment bond ([`commitment-bond.md`](commitment-bond.md)): an unbonded newcomer is _sampled_; a bonded one is _prioritized_, because its stake makes a swarm expensive. The bond finally feeds **ranking, not just eligibility** — with the right semantics: a bond buys a **faster shot, never a quality score** (skin-in-the-game signals "I won't rug you," not "I'm good at the task"). History **or** stake **or** a lucky draw: three on-ramps, no hole.

## Carried over from #326 (unchanged)

Ranking is still an **ordering, never a gate** — exploration only reorders _admissible_ candidates; it never makes an ineligible worker eligible, never touches the hard gates or money authority ([`memory-never-confers-authority.md`](memory-never-confers-authority.md)). Still **first-person** — each delegator explores from its own posterior. There is **no cross-delegator or global exploration sharing**; that would be the global reputation score whose refusal _is_ the sybil resistance ([`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md)).

## Increments

- **Inc 0 (this doc) + Inc 1 — SHIPPED.** The seeded sampler (`thompson.ts`) + `explore` mode on `rankWorkers`/`selectWorker`. Backward-compatible: absent an `explore` config, behavior is byte-identical to #326. Dormant until Inc 3 wires it — nothing passes `explore` yet. Proven statistically (below).
- **Inc 2 — bond lifts ranking — SHIPPED.** `RankableWorker.bonded`; in explore mode a verified bond multiplies exploration strength (`BOND_EXPLORE_BOOST`, capped at 1). Multiplicative so it respects the stakes floor (`strength 0` stays 0 even bonded — a bond is not a pass onto a high-value job), and it never touches the mean — priority, never quality. Tested: a bonded newcomer explores more in the contested zone; at `strength 0` the bond never displaces the incumbent.
- **Inc 3 — wire + provenance — SHIPPED.** The runtime's `WorkerSelector` closure (`motebit-runtime.ts`) now passes `explore: { seed, strength }` to `selectWorker` on every unpinned delegation: the **seed is the tick token's Ed25519 `signature`** (unique per turn, a recorded signed artifact — the draw is reproducible from the token, never `Math.random`), and **strength = `explorationStrengthForStakes(cost)`** (full below ~$0.10, linear ramp to pure-exploit by ~$1.00 — explore where a bad pick is cheap). The decision is surfaced via a structured `routing.worker_selected` log (selected worker, candidate count, strength, `explored` = did the draw override the exploit-favorite, quality) — discharging #326's deferred "surface the why". This is the flip that makes exploration real, but like #326's unpin it is **observationally inert until a second provider of a capability** exists (one candidate ⇒ the seam never ranks). Tested: high-stakes ⇒ deterministic exploit; low-stakes ⇒ exploration engaged at strength 1 over both candidates; the stakes ramp as a unit.
  - **Still deferred — bond-live-wiring.** The `bonded` flag (Inc 2) is live in the primitive but the runtime closure can't set it yet: the discovery response doesn't surface per-candidate bond status. Trigger: extend the relay's `/api/v1/agents/discover` (or the candidate shape) to carry a verified-bond signal, then join it in the closure — a discovery-schema change deliberately out of this increment's scope. Until then bonded and unbonded newcomers explore identically live (correct-but-incomplete: the sybil-swarm bound isn't active on real hops yet).
- **Inc 4 — the end-game proof — SHIPPED.** A deterministic bandit **simulation** (`worker-selection-simulation.test.ts`): workers with hidden true quality θ, T rounds of hire → seeded-outcome → update. Proves, reproducibly and at once: the market DISCOVERS a better newcomer (θ=0.95) and converges to it over a seeded star (θ=0.85); the good newcomer is genuinely promoted; the sybil is STARVED (< 1/10 the good newcomer's picks); high-stakes rounds (`strength 0`) never explore (the star every round, newcomer and sybil never); and a bond promotes a good newcomer FASTER.

## Deferred, with triggers

- **Contextual bandits** (a worker good at X, bad at Y) — trigger: a worker's success rate splits by task type.
- **Exploration decay as the market matures** — falls out of Thompson naturally; an explicit global cool-down waits for a real steady-state market to tune against.
- **Micro-scale cost lever** (#326's relative-cost-normalization) — price is a newcomer's other entry lever; fix them together when a real same-capability price war exists.
- **REFUSED (not deferred):** any cross-delegator / global exploration or reputation sharing. Named here so no future increment "optimizes" it in.

## Proof

`thompson.ts` is unit-tested for determinism (same seed → same draw), uniformity, `mean ≈ α/(α+β)`, the wide-Beta(1,1)-vs-tight-Beta(21,1) variance ordering, and offline reproducibility. `worker-selection.ts` explore mode is tested for: strength 0 = pure exploit (newcomer never displaces the incumbent), full exploration gives a fresh newcomer a shot while the incumbent still wins the majority, one failure shrinks the newcomer's shots, a repeat-failer collapses toward never-picked (< 3%), more strength ⇒ more exploration, the earned level as a head-start prior (Verified beats Unknown), and same-seed reproducibility.
