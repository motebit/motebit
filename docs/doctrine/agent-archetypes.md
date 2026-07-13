# Agent archetypes — first citizens of the market

**The protocol births the grammar. The runtime proves it with first citizens.**

An archetype is a first-party molecule — a marketplace agent built and operated by the protocol's own operator — whose job is threefold: prove the delegation loop in production every day, set the blueprint other builders fork, and generate the first dispute-grade history the clearing house accrues ([`clearing-house-not-thin-waist.md`](clearing-house-not-thin-waist.md)). The v1 slate is **the Researcher** (the existing research molecule, whose citations already carry re-verifiable evidence provenance — `services/research/src/research.ts`), **the Auditor** (a new, deliberately LLM-free molecule that measures other agents against the public verification surface and signs the measurement as an eval attestation, [`evals-as-attestations.md`](evals-as-attestations.md)), and **the Clerk** (§6 — the money-execution pole: a molecule that _spends_ under a signed standing-delegation grant, `services/clerk/src/clerk.ts`), over the atom fleet (web-search, read-url, summarize).

Users delegate to _molecules_ — outcomes with proof; atoms are the composition layer ([`THE_ACTOR_PRINCIPLE.md`](../../THE_ACTOR_PRINCIPLE.md) §III.2: every molecule is a delegation tree, every delegation tree is a receipt tree). A Discover catalog that lists mostly atoms is a parts bin exposed as a storefront. The archetypes are the finished goods that teach the category: what an agent even _is_ here — sovereign identity, scoped delegation, nested signed receipts (`buildServiceReceipt`, `runMolecule` in `packages/molecule-runner/src/index.ts`), metered settlement — versus a chat wrapper with a webhook.

## 1. Ordinary participants, never house bots

The archetypes pass the protocol-first audit ([`protocol-primacy.md`](protocol-primacy.md)) with zero carve-outs: they self-mint identities, register, list, heartbeat, get discovered, get delegated to, and settle through exactly the routes any stranger uses — including the paid-path gates (`requiresP2pProof` in `services/relay/src/tasks.ts`) with no probe allowlist and no relay side door. The Auditor makes the boundary structural: its entire evidence catalog is the _unauthenticated public_ endpoint surface, so it cannot have privileged access even by accident. The moment a first-party agent gets a special endpoint, it stops being a blueprint and starts being a company with a protocol on the side.

## 2. Curation, not registry

"Archetype" is a curation label, not protocol vocabulary. It fails every closed-registry criterion ([`registry-pattern-canonical.md`](registry-pattern-canonical.md)): a third party receiving an unknown archetype label must not fail closed, nothing dispatches on it, and it has no wire-format discriminator role. Listing capabilities stay free-form by explicit design (`AgentServiceListing` in `packages/wire-schemas/src/agent-service-listing.ts`). The slate is therefore documented in prose and templates — the developer gallery and this memo — and never minted as a `@motebit/protocol` enum. First-party curation is hygiene plus demonstration; it is not a quality-ranked global registry, which the trust doctrine refuses outright ([`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md) §1).

## 3. Naming is a claim

"The Researcher" on a Discover card is a self-asserted claim, exactly like any other agent's name ([`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md) §3): squattable, unverified, rendered in claim framing (`formatNameClaim` in `@motebit/panels` — one shared formatter so the epistemic register cannot drift per-surface), never as a verified handle. Archetypes get no bespoke marks — the sigil is derived from the motebit_id like everyone's (§4; derived-not-chosen is the anti-homoglyph law). What actually distinguishes an archetype from a squatter claiming the same name is not the name: it is the earned record — the receipts, the settlement history, the daily conformance runs — which is the entire thesis in miniature. If the operator ever needs the name to do the work the history should do, the archetype has failed.

## 4. Living conformance is the proof contract

An archetype's quality claim is not a badge; it is the fact that a scheduled adversarial delegation exercises it in production and verifies the full loop — discovery, delegation, the signed receipt chain (`verifyReceiptVerdict`), nested atom receipts, citation evidence provenance (`verifyEvidenceProvenance`), settlement rows on the paid path. This is `--self-test` (adversarial onboarding, root doctrine) generalized to market scale: the happy path _is_ the probe. A showcase that is not load-bearing rots into a lie; the conformance run is what keeps "they work" a checkable sentence rather than marketing. Promotion from staging to production is gated on consecutive green runs — accept-on-proof, the same shape as the creature canon's dark-environment criterion ([`creature-canon.md`](creature-canon.md)).

## 5. Operator-funded inference is not selling intelligence

The Researcher runs on the operator's inference key. This sits squarely inside the never-sell-intelligence line: what the archetype sells is a _verifiable work product_ — a report whose every web claim carries a content digest re-checkable to the primary record, under a signed receipt tree. Intelligence is a metabolized input (THE_METABOLIC_PRINCIPLE: absorb solved problems), priced into the task's `unit_cost` as overhead alongside compute and bandwidth. The Auditor is the sharper statement of the same principle: it needs no LLM at all, because its product is pure verification — the most motebit-native deliverable possible. Economics stay honest about today's rails: paid delegation is P2P-at-the-top-of-chain; atom hops inside the archetype fleet run at zero cost until the multi-hop settlement arc lands ([`off-ramp-as-user-action.md`](off-ramp-as-user-action.md) names the deferred topology) — the receipts flow either way, and nothing pretends to settle what doesn't.

**Cost-indexed pricing (2026-07-13).** A `unit_cost` is a derivation, never a mood
— three rules and a floor, so every listed price traces to a number someone can
re-check:

1. **Atoms price at 1–2× marginal cost.** The API economy already ran the price
   discovery: commodity web search clears at ~\$0.001–0.01/query, page reads at
   ~\$0.001–0.005. An agent economy is a price-taker's market by construction —
   auto-routing (`f(TaskShape × ProviderCapability × Constraints)`) comparison-
   shops every task, so a commodity atom listed above its comps simply never
   routes. (Atom prices activate with the multi-hop settlement arc; ~\$0.002–0.01.)
2. **Molecules price at inference-cost-plus-thin.** Never-sell-intelligence makes
   the token bill a passed-through input, not a margin source — the business is
   the relay's 5% and the accumulated history, so molecule margin stays thin and
   honest (research \$0.25 against ~\$0.17–0.20 of Sonnet-class inference+search;
   \$0.05-class on a Haiku-class model). Corollary: prices are **model-indexed and
   deflate with inference** (~10×/year and holding) — repricing is routine
   maintenance, not an event.
3. **Verification prices at near-zero, never zero.** Attestation volume is the
   moat's raw input — every audit mints an `EvalAttestation` and a settlement row
   — so the Auditor (and the Clerk's flat execution fee) price at the floor
   (\$0.01) to make the behavior reflexive. Never \$0: a free task mints no
   settlement and no dispute-grade history, and exits the paid path entirely.
   Cheap-but-settled beats free for the thesis.

**The floor:** a Solana P2P settle costs the delegator ~\$0.0005–0.001 in tx fees,
so per-task prices below ~\$0.002 spend more on settlement than on work — that
regime belongs to the batching/streaming arc, not to lower list prices. Integer
micro-units carry 100× more deflation headroom (\$0.002 = 2,000 micro; its 5% fee
= 100 micro). Canonical prices live in `scripts/deploy-archetype-slate.ts`
(`MOTEBIT_UNIT_COST`) with service-code defaults matching; the gallery table and
architecture tree are display siblings.

## 6. The Clerk — the money-execution pole

The Auditor's deliverable is pure verification with zero money; the Clerk is its opposite pole — the archetype whose deliverable _is_ moving money. It is the product-facing proof of the R4 spine: where AGT and Hermes stop at informing, the Clerk **acts under a grant**. It holds a signed `StandingDelegation` — a _self-issued_ grant, matching the shipped standing-delegation path (`apps/cli/src/subcommands/grant.ts`: `delegator == delegate`, the holder mints its own per-tick tokens, verified by `verifyTokenAgainstGrant`). That is the crypto-honest shape of autonomy: a cross-party grant would need the granter to sign every tick, which is no longer autonomous. So the Clerk's grant is a signed, self-imposed spend _ceiling_ over its own operator-funded wallet ([`memory-never-confers-authority.md`](memory-never-confers-authority.md): a signed grant is authority; a self-signed spend-bound is deterministic signed authority, not a trust claim — the meter, not the signature, is what constrains). On each task it self-mints a fresh per-tick token and executes a paid sub-delegation to the Researcher within the grant's _signed_ ceiling — no per-action human tap. The owner's control is expressed through what it funds the wallet with and the ceiling it deploys; a _cross-party_ operator-signed grant (the operator authorizing each tick over its OWN funds) is the stricter, non-autonomous variant, deferred with the marketplace-grant-transport arc.

The invariant is that this deterministic, human-absent path re-composes the **same R4 AND** the AI loop enforces, not a shortcut around it. In the loop, R4 is three layers — the policy gate's scope + standing-authority check ([`policy-gate.ts`](../../packages/policy/src/policy-gate.ts) steps 8b/8c), the loop's grant-presence guard, and the rail-seam meter (`wrapP2pPaymentWithMeter`). The meter alone **fail-opens on a null grant** — safe in the loop only because the gate puts a live human on that path. The Clerk's runtime primitive `MotebitRuntime.executeGrantedDelegation` therefore fails **closed** on a null/expired/revoked grant (the exact inverse of the loop's fail-open), re-runs the gate's scope check (`this.policy.validate`), and routes every broadcast through the meter-wrapped builder — never the raw wallet method. It adds **zero new authority surface**: the only producer of a verified grant is still `verifyGrantForTurn`, and a new `check-money-authority` assertion locks the deterministic path shut. A refused spend (over-ceiling, out-of-scope) returns a signed refusal carrying only the denial _code_ — the `spend_overage_micro` residual is owner-facing, never in a relayable receipt (the [`AuthorityDelta`](protocol-model.md) asymmetry).

It ships **dry-run-first**: the built molecule defaults to `DRY_RUN`, exercising the entire metered spine (grant verify → gate → meter → ceiling → refusal) at hard-zero against a throwaway spend store, so no fake spend can poison the live lifetime ceiling. Flipping to live money is a separate, ratified operator step — vault before gold, the same posture the standing-delegation arc shipped. House-bot cleanliness holds by construction (§1): the Clerk spends its **own** operator-funded wallet over the same signed-grant + meter + relay-P2P route any participant uses — no fee waiver, no side door. The marketplace shape where a _remote_ delegator hands the Clerk a per-task grant is **deferred-with-trigger**: the relay task protocol cannot carry a grant today, so that arc waits on a real external consumer needing to hire a spending molecule.

## The blueprint path

The archetypes exist to be copied. Their molecule recipes are ordinary repo code (the research service is the reference composition; the summarize service is the minimal delegating skeleton), and the developer gallery documents the fork path. Two blueprint conveniences are **deferred-with-trigger** rather than shipped now: publishing `@motebit/molecule-runner` to npm and a molecule mode in `packages/create-motebit` both wait for a first external fork request _and_ one stable minor cycle of the runner's API — per [`promoting-private-to-public.md`](promoting-private-to-public.md), a public API is not manufactured for a consumer who does not exist yet, and a package whose API changed this arc has not yet kept a promise. Until then the gallery points forks at the git tree, which is honest about what exists.

## Cross-references

- [`THE_ACTOR_PRINCIPLE.md`](../../THE_ACTOR_PRINCIPLE.md) — atoms/molecules, the receipt tree as causal log
- [`evals-as-attestations.md`](evals-as-attestations.md) — the promoted attestation primitive the Auditor issues; subject ≠ signer
- [`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md) — claims vs earned trust; the Discover epistemics archetype cards obey
- [`protocol-primacy.md`](protocol-primacy.md), [`clearing-house-not-thin-waist.md`](clearing-house-not-thin-waist.md) — why ordinary participation + accumulated history is the moat, never the label
- [`evidence-provenance.md`](evidence-provenance.md) — the re-checkable citation law the Researcher's reports carry
- [`memory-never-confers-authority.md`](memory-never-confers-authority.md) — the R4 AND the Clerk's deterministic spend path re-composes; only a signed grant authorizes
- [`registry-pattern-canonical.md`](registry-pattern-canonical.md) — why archetype is not a registry
- [`promoting-private-to-public.md`](promoting-private-to-public.md) — the deferral discipline on the blueprint conveniences

## Drift defense

The conformance harness is `scripts/archetype-conformance.ts` (scheduled by `archetype-conformance.yml`; the daily staging run is a PAID devnet P2P delegation per molecule — no probe allowlist); promotion readiness is `scripts/check-promotion-ready.ts` reading that workflow's own scheduled-run history (5 consecutive greens; thin history reads not-ready by design). The static slate-parity gate is `check-archetype-slate` (deploy `SLATE` × conformance `ARCHETYPES` × the docs gallery table — one vocabulary, three surfaces, same commit).
