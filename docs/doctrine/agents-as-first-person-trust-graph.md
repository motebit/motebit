# Agents are a first-person trust graph

The Agents panel is where the whole thesis becomes visible or hides itself. It is
the one surface that renders, in a single glance, who an agent is, what it offers,
and whether it can be trusted — and it is the surface most likely to drift into a
prettier service registry under implementation pressure. This doctrine fixes the
primitive before that happens.

> Agents are not fleet members, services, or global-leaderboard entries. They are
> **self-certifying counterparties seen through first-person trust.**

The true primitive, stated once:

    self-certifying identity
    + first-person petname
    + deterministic recognition face
    + bilateral trust edge
    + receipt-proven history

Everything below derives from that line.

## 1. Trust is first-person and bilateral — never global reputation

`AgentTrustRecord` is keyed by the pair `[motebit_id, remote_motebit_id]`
([`packages/protocol/src/index.ts`](../../packages/protocol/src/index.ts)). Trust
is not "the network says this agent is good." It is **"I have earned trust with
this peer, through receipts and outcomes I can verify."** The ladder
(`unknown → first_contact → verified → trusted → blocked`) is promoted by _my_
success rate with _that peer_, demoted by _my_ failures with it. It does not
travel.

The relay issues a `ReputationCredential` carrying global aggregates
([`packages/crypto/src/credentials.ts`](../../packages/crypto/src/credentials.ts)),
but the runtime treats it as a **discovery hint, never an override** of
first-person trust — the same posture as additive hardware-attestation scoring
(see [`hardware-attestation.md`](hardware-attestation.md)): a signal, never a gate.

This is the moat, made structural. A global reputation score is sybil-bait — a
number to farm, buy, or game. A first-person trust graph has nothing to game: each
motebit earns its own edges from receipts it holds, and there is no portable score
to inflate. Sovereignty and sybil-resistance are the _same property_ here, and
both follow from refusing the global score. See
[`security-boundaries.md`](security-boundaries.md).

The graph the semiring ranks
([`packages/semiring/src/agent-network.ts`](../../packages/semiring/src/agent-network.ts))
is an **ego graph**: a star of edges from `self → each known peer`, plus
delegation edges harvested from receipt trees. "Best agent" is a first-person
shortest-path, not a network consensus.

## 2. Known and Discover stay separate — the epistemic split is the thesis

The panel controller
([`packages/panels/src/agents/controller.ts`](../../packages/panels/src/agents/controller.ts))
has two tabs, and they are two different **epistemic objects**:

| Lens         | What it is                          | Object                         |
| ------------ | ----------------------------------- | ------------------------------ |
| **Known**    | what I proved myself, from receipts | my first-person trust edges    |
| **Discover** | what the network _claims_ exists    | relay roster + relay's opinion |

Collapsing them into one tidy "trust graph at two distances" is **anti-thesis** —
it erases the boundary between _what I know_ and _what is claimed_, which is the
exact distinction sovereignty rests on. Keep them separate; make each side
legible. Discover cards must read as claims ("claims to be Scout · seen via relay ·
no earned trust yet"); Known cards read as earned relationships ("Scout · 3
successful tasks · trusted · last worked with 2h ago").

## 3. Naming is petnames — never a global naming authority

Human-meaningful + decentralized + secure is Zooko's Triangle: pick two. A global
human-readable name service (ANS-style, DNS-backed) buys human-meaning by
reintroducing a **central naming authority** — the precise centralization vector
motebit refuses. The resolution is a **petname system**, and it is isomorphic to
the trust model: naming is first-person because trust is first-person.

| Name layer             | Property                             | Mirrors                      |
| ---------------------- | ------------------------------------ | ---------------------------- |
| **Sigil + key**        | global, secure, _not_ memorable      | the self-certifying id       |
| **Self-asserted name** | memorable, _not_ secure (squattable) | a discovery-time _claim_     |
| **Petname**            | memorable + secure (my namespace)    | first-person bilateral trust |

Known shows my petname ("Scout"). Discover shows the self-asserted name as a claim
("claims to be Scout"). The key/fingerprint is the only global, secure anchor.

## 4. Identity is self-certifying; the face is derived, not chosen

A `motebit_id` is already `UUIDv8(SHA-256(pubkey))` — self-certifying
([`packages/create-motebit/src/generate.ts`](../../packages/create-motebit/src/generate.ts)).
The panel renders it as raw hex, and the creature's appearance comes from _chosen_
static presets
([`packages/sdk/src/color-presets.ts`](../../packages/sdk/src/color-presets.ts)).
So identity is cryptographically self-certifying and visually anonymous. That gap
_is_ the legibility problem.

The fix is on-thesis: **the face is the key.** Derive a deterministic visual
fingerprint from the agent's pubkey / genesis key (not the truncated id — more
entropy, survives any id-representation change; see
[`identity-binding-verification.md`](identity-binding-verification.md)). You cannot
choose another agent's face, because it is a function of their key.

Two rules make this safe rather than decorative:

- **Sigils derive params, not pixels.** The pure function is
  `pubkey → { palette, geometry seed, symmetry, density, … }` — Ring 1, identical
  everywhere, zero-dep, testable. The _render_ is per-surface (Ring 3): SVG/canvas
  on web, `StyleSheet` on mobile, compact glyph on CLI, and — the payoff — a **3D
  droplet presence in spatial from the same seed** (see
  [`spatial-as-endgame.md`](spatial-as-endgame.md)). Emitting pixels from a shared
  package breaks the panels pattern ([`panels-pattern.md`](panels-pattern.md)) and
  forecloses spatial. A peer's _derived_ identity sigil is distinct from a
  motebit's _chosen_ creature aesthetic (self-expression); they coexist.

- **The face is recognition, not proof — with a distinctness budget.** If trust
  attaches to a _visual_, a near-collision sigil is a homoglyph attack: mint keys
  until one renders close enough to "Scout" to fool a human. So the sigil must
  derive into a **continuous, perceptually-uniform space** (e.g. OKLCH across many
  orthogonal axes), never a small preset enum — and the invariant is measurable:

  > The sigil's distinctness budget — the size of its perceptually-distinct output
  > space — must dominate a realistic adversary's key-minting budget; below that
  > margin, recognition falls back to the fingerprint.

  The authority is always the fingerprint / receipt chain
  ([`self-attesting-system.md`](self-attesting-system.md)). Face aids the human;
  fingerprint proves identity; petname anchors the relationship; receipts prove the
  history.

## 5. The panel holds records; hiring is an act

The Agents panel is a **record surface** — who exists, who I know, what they claim,
what I have proven with them. Hiring/delegating is an **act**, and it runs the full
pipeline (`authorize → policy → action → receipt → settlement → trust`; see
[`delegation.md`](delegation.md)). Burying that act inside a modal attached to a
trust card violates both [`records-vs-acts.md`](records-vs-acts.md) and the
no-modals-on-panels rule. The directory shows _who you could work with_; _working
with them_ rotates the interior register or fires as a body act.

> **Invariant: the panel holds records; hiring is an act.** The exact cross-surface
> choreography (web / desktop / mobile / spatial / cli) is a marked **open
> implementation fork** — to be resolved against the spatial Presentation primitive
> before UI is wired, not pre-committed here.

## 6. Money history derives from receipts, never trust-record drift

`AgentTrustRecord` carries interaction and task counts and latency stats — not a
settled-dollar total. To show economic history, derive it from the **receipt
tree** (the source of truth; see [`receipts-unified.md`](receipts-unified.md)).
Never denormalize a money field onto the trust record — that is the kind of drift
that lies later.

## 7. ERC-8004 / ANS validate the category, not the architecture

The independent frontier (ERC-8004's identity/reputation/validation registries;
the Agent Name Service) is converging on motebit's exact concerns, which **validates
the category**. But the alignment is not 1:1, and the divergence is deliberate:

- **Identity** — aligned: self-certifying Ed25519 / did:key.
- **Validation** — aligned: signed receipts / receipt trees.
- **Reputation** — _divergent on purpose:_ ERC-8004 is global/onchain; motebit is
  first-person and bilateral. The divergence is the moat (§1).
- **Naming** — _divergent on purpose:_ ANS is a naming authority; motebit uses
  petnames over self-certifying ids (§3).

Per the metabolic principle: adopt the category's stabilizing standards as
boundary adapters when a consumer arrives; never copy a global-reputation or
central-naming architecture that fights sovereignty. This is the same posture as
[`identity-universal-boundary.md`](identity-universal-boundary.md).

## What not to build

A global reputation score or leaderboard; a fleet / org-chart framing (those agents
are sovereign counterparties, not your employees); a central name-registry
dependency; a roleplay agent roster with assigned costumes. Each is more legible in
the short term and each fights the architecture — trading the sybil-resistant
first-person moat for a legibility you get more honestly from a derived face and a
petname.

## Gotchas and bounds

This architecture is correct, not free. Each elegance buys a cost; the bound is
what keeps the cost from eating the property it paid for.

- **Cold-start re-centralizes in the relay (the load-bearing one).** First-person
  trust is useless at first contact — every peer starts `unknown`, so the first
  delegation is always blind, and the relay's `ReputationCredential` hint becomes
  the _only_ signal at exactly the moment trust is decisive. Through usage, that
  hint can quietly become the de facto global score, re-centralizing trust in the
  relay — the precise thing §1 refuses. **Bound:** the relay hint is structurally
  capped (it may not dominate a routing decision), decays as first-person edges
  accrue, and renders always-labeled as the relay's unverified claim. A hint that
  can override first-person trust is a bug, not a default.

- **It is an ego-star, not a transitive graph.** First-person trust has no
  transitivity (I trust Alice, Alice trusts Bob ⇒ I learn nothing about Bob); the
  only multi-hop structure is delegation edges I personally witnessed. **Bound:**
  do not market "trust graph" as recommendation/reachability; transitive or
  delegated trust is a future axis with its own threat model (trust laundering
  through cheap intermediaries), never a silent default.

- **The sigil's distinctness budget is necessary, not sufficient (§4).** The
  measurable bound is output-space size; the real limit is human perceptual
  discrimination — far smaller, and worse at list scale, across themes, and under
  colorblindness (~8% of men). **Bound:** the fingerprint stays primary for any
  trust-bearing decision (the UI enforces this, not just the prose); the sigil is
  tuned for discrimination at the _smallest_ render size with a colorblind-safe
  primary axis; pair it with a word-pair fingerprint (BIP-39-style) — humans
  compare words far better than abstract shapes. Note also: a key-derived face
  cannot disambiguate _your own_ petname collisions ("Scout" vs "Scott"), and
  deterministic art from arbitrary keys is unmoderatable without breaking
  determinism — both are recognition limits, not identity proofs.

- **Petnames solve personal legibility, not collaborative legibility (§3).** Local
  names do not travel; the moment two parties coordinate about a third agent they
  fall back to the fingerprint. And petname assignment is a pincer: manual ⇒ the
  long tail stays UUIDs; auto-from-self-asserted-name ⇒ the squattable name becomes
  the default and the impersonator wins. **Bound:** the fingerprint is the shared
  cross-party referent; petname auto-suggestion (if any) is gated behind earned
  first-person trust, never adopted at discovery.

- **Legibility is back-loaded — it does not, alone, answer the distribution gap.**
  Faces + petnames + earned trust are most legible to a veteran; the Known tab is
  empty at onboarding, so a stranger sees only the relay roster, faceless and
  trustless. The model also _refuses_ the at-a-glance aggregate (no global score to
  total). **Bound:** treat this doctrine as the panel's _honesty_ fix, not the
  product's _front door_. The legible-to-a-stranger wedge is a separate problem
  (see [`identity-universal-boundary.md`](identity-universal-boundary.md), §
  sequencing); do not conflate the two.

- **"Derive from receipts" has a render cost.** Literal per-paint receipt-tree
  walks are slow; denormalizing a money field onto the trust record is forbidden
  (§6). **Bound:** the permitted middle path is a **materialized projection** — a
  cache rebuilt _from_ receipts, clearly derived, never a source of truth.

- **Hire-as-act is asserted before it is proven implementable (§5).** Spatial has
  no panels and CLI has no interior register to rotate; the invariant may force an
  awkward flow there, and the relief valve is exactly the drift this doc forbids (a
  surface ships a modal, or the invariant is quietly relaxed). **Bound:** the
  invariant holds, but it must be _demonstrated_ on spatial + CLI before the
  cross-surface choreography hardens — prove the check can be cashed.

- **Sequencing — the meta-gotcha.** Writing this doctrine now is cheap and correct
  (it prevents drift while the design is fresh). _Implementing_ it is real feature
  work that sits _after_ "external users" in motebit's own build order
  ([`identity-universal-boundary.md`](identity-universal-boundary.md)). **Bound:**
  gate the build on a concrete consumer (the live demo needs it, or a builder asks)
  — not on the design merely feeling resolved. Architecture is more comfortable
  than distribution; this section exists partly to name that.

---

Related: [`delegation.md`](delegation.md),
[`records-vs-acts.md`](records-vs-acts.md),
[`identity-binding-verification.md`](identity-binding-verification.md),
[`identity-universal-boundary.md`](identity-universal-boundary.md),
[`security-boundaries.md`](security-boundaries.md),
[`hardware-attestation.md`](hardware-attestation.md),
[`panels-pattern.md`](panels-pattern.md),
[`panel-temporal-registers.md`](panel-temporal-registers.md),
[`spatial-as-endgame.md`](spatial-as-endgame.md),
[`receipts-unified.md`](receipts-unified.md),
[`self-attesting-system.md`](self-attesting-system.md),
[`the-stack-one-layer-up.md`](the-stack-one-layer-up.md). External (category
validation, not architecture): ERC-8004 (Identity/Reputation/Validation
registries), Agent Name Service (ANS), Zooko's Triangle / petname systems
(Stiegler–Miller).
