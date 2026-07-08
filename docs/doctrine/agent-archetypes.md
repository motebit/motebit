# Agent archetypes — first citizens of the market

**The protocol births the grammar. The runtime proves it with first citizens.**

An archetype is a first-party molecule — a marketplace agent built and operated by the protocol's own operator — whose job is threefold: prove the delegation loop in production every day, set the blueprint other builders fork, and generate the first dispute-grade history the clearing house accrues ([`clearing-house-not-thin-waist.md`](clearing-house-not-thin-waist.md)). The v1 slate is **the Researcher** (the existing research molecule, whose citations already carry re-verifiable evidence provenance — `services/research/src/research.ts`) and **the Auditor** (a new, deliberately LLM-free molecule that measures other agents against the public verification surface and signs the measurement as an eval attestation, [`evals-as-attestations.md`](evals-as-attestations.md)), over the atom fleet (web-search, read-url, summarize).

Users delegate to _molecules_ — outcomes with proof; atoms are the composition layer ([`THE_ACTOR_PRINCIPLE.md`](../../THE_ACTOR_PRINCIPLE.md) §III.2: every molecule is a delegation tree, every delegation tree is a receipt tree). A Discover catalog that lists mostly atoms is a parts bin exposed as a storefront. The archetypes are the finished goods that teach the category: what an agent even _is_ here — sovereign identity, scoped delegation, nested signed receipts (`buildServiceReceipt`, `runMolecule` in `packages/molecule-runner/src/index.ts`), metered settlement — versus a chat wrapper with a webhook.

## 1. Ordinary participants, never house bots

The archetypes pass the protocol-first audit ([`protocol-primacy.md`](protocol-primacy.md)) with zero carve-outs: they self-mint identities, register, list, heartbeat, get discovered, get delegated to, and settle through exactly the routes any stranger uses — including the paid-path gates (`requiresP2pProof` in `services/relay/src/tasks.ts`) with no probe allowlist and no relay side door. The Auditor makes the boundary structural: its entire evidence catalog is the _unauthenticated public_ endpoint surface, so it cannot have privileged access even by accident. The moment a first-party agent gets a special endpoint, it stops being a blueprint and starts being a company with a protocol on the side.

## 2. Curation, not registry

"Archetype" is a curation label, not protocol vocabulary. It fails every closed-registry criterion ([`registry-pattern-canonical.md`](registry-pattern-canonical.md)): a third party receiving an unknown archetype label must not fail closed, nothing dispatches on it, and it has no wire-format discriminator role. Listing capabilities stay free-form by explicit design (`AgentServiceListing` in `packages/wire-schemas/src/agent-service-listing.ts`). The slate is therefore documented in prose and templates — the developer gallery and this memo — and never minted as a `@motebit/protocol` enum. First-party curation is hygiene plus demonstration; it is not a quality-ranked global registry, which the trust doctrine refuses outright ([`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md) §1).

## 3. Naming is a claim

"The Researcher" on a Discover card is a self-asserted claim, exactly like any other agent's name ([`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md) §3): squattable, unverified, rendered in claim framing, never as a verified handle. Archetypes get no bespoke marks — the sigil is derived from the motebit_id like everyone's (§4; derived-not-chosen is the anti-homoglyph law). What actually distinguishes an archetype from a squatter claiming the same name is not the name: it is the earned record — the receipts, the settlement history, the daily conformance runs — which is the entire thesis in miniature. If the operator ever needs the name to do the work the history should do, the archetype has failed.

## 4. Living conformance is the proof contract

An archetype's quality claim is not a badge; it is the fact that a scheduled adversarial delegation exercises it in production and verifies the full loop — discovery, delegation, the signed receipt chain (`verifyReceiptVerdict`), nested atom receipts, citation evidence provenance (`verifyEvidenceProvenance`), settlement rows on the paid path. This is `--self-test` (adversarial onboarding, root doctrine) generalized to market scale: the happy path _is_ the probe. A showcase that is not load-bearing rots into a lie; the conformance run is what keeps "they work" a checkable sentence rather than marketing. Promotion from staging to production is gated on consecutive green runs — accept-on-proof, the same shape as the creature canon's dark-environment criterion ([`creature-canon.md`](creature-canon.md)).

## 5. Operator-funded inference is not selling intelligence

The Researcher runs on the operator's inference key. This sits squarely inside the never-sell-intelligence line: what the archetype sells is a _verifiable work product_ — a report whose every web claim carries a content digest re-checkable to the primary record, under a signed receipt tree. Intelligence is a metabolized input (THE_METABOLIC_PRINCIPLE: absorb solved problems), priced into the task's `unit_cost` as overhead alongside compute and bandwidth. The Auditor is the sharper statement of the same principle: it needs no LLM at all, because its product is pure verification — the most motebit-native deliverable possible. Economics stay honest about today's rails: paid delegation is P2P-at-the-top-of-chain; atom hops inside the archetype fleet run at zero cost until the multi-hop settlement arc lands ([`off-ramp-as-user-action.md`](off-ramp-as-user-action.md) names the deferred topology) — the receipts flow either way, and nothing pretends to settle what doesn't.

## The blueprint path

The archetypes exist to be copied. Their molecule recipes are ordinary repo code (the research service is the reference composition; the summarize service is the minimal delegating skeleton), and the developer gallery documents the fork path. Two blueprint conveniences are **deferred-with-trigger** rather than shipped now: publishing `@motebit/molecule-runner` to npm and a molecule mode in `packages/create-motebit` both wait for a first external fork request _and_ one stable minor cycle of the runner's API — per [`promoting-private-to-public.md`](promoting-private-to-public.md), a public API is not manufactured for a consumer who does not exist yet, and a package whose API changed this arc has not yet kept a promise. Until then the gallery points forks at the git tree, which is honest about what exists.

## Cross-references

- [`THE_ACTOR_PRINCIPLE.md`](../../THE_ACTOR_PRINCIPLE.md) — atoms/molecules, the receipt tree as causal log
- [`evals-as-attestations.md`](evals-as-attestations.md) — the promoted attestation primitive the Auditor issues; subject ≠ signer
- [`agents-as-first-person-trust-graph.md`](agents-as-first-person-trust-graph.md) — claims vs earned trust; the Discover epistemics archetype cards obey
- [`protocol-primacy.md`](protocol-primacy.md), [`clearing-house-not-thin-waist.md`](clearing-house-not-thin-waist.md) — why ordinary participation + accumulated history is the moat, never the label
- [`evidence-provenance.md`](evidence-provenance.md) — the re-checkable citation law the Researcher's reports carry
- [`registry-pattern-canonical.md`](registry-pattern-canonical.md) — why archetype is not a registry
- [`promoting-private-to-public.md`](promoting-private-to-public.md) — the deferral discipline on the blueprint conveniences

## Drift defense

The conformance harness (test-enforced, scheduled) and a static slate-parity gate land with the arc's later increments and will be cited here when they exist; until then this memo is citation-protection for the boundaries above (no house bots, no archetype enum, claim-framed names).
