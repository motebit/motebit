# Identity is boundary-universal

The sovereign Ed25519 identity is the same primitive at every boundary the agent
touches. It is not a relay credential, a payment key, and a web signature that
happen to share a curve — it is **one identity, presented at many membranes.**
The droplet has one boundary; the boundary meets many surfaces.

The invariant motebit owns is not "agent identity." It is the full pipeline:

    identity → authorization → policy → action → receipt → settlement → trust

"Agent identity" sounds like one primitive. The pipeline is what it actually is:
a complete operating layer for **accountable autonomy** — who acted, under whose
authority, within what policy, producing what proof, moving what value, with what
trust consequence. Everything above (intelligence, apps, surfaces) and below
(models, chains, rails) is pluggable. The pipeline is the constant.

## The boundaries

Same key, same `/.well-known` publication, same signing discipline. Each new
boundary is an **adapter, not a new primitive** — a fresh agility axis over the
existing identity (see [`agility-as-role.md`](agility-as-role.md)), never a fork
of the self.

| Boundary            | State                    | Mechanism                                       |
| ------------------- | ------------------------ | ----------------------------------------------- |
| agent ↔ relay       | shipped                  | signed device/auth tokens, audience-bound       |
| agent ↔ agent       | shipped (onchain-proven) | P2P settlement, signed delegation receipts      |
| agent ↔ user        | shipped                  | governed delegation, pairing, cold-start ack    |
| agent ↔ wallet/rail | shipped                  | sovereign Solana + guest rails                  |
| agent ↔ website     | **deferred**             | Web Bot Auth (RFC 9421 HTTP Message Signatures) |
| agent ↔ enterprise  | **deferred**             | IAM bridges / VC presentation                   |

## The thin-waist position — and the honest qualifier

Every durable layered system has an hourglass with a narrow, universal, invariant
waist that everything routes through (IP, HTTP). Motebit is **architected to be
the sovereign thin waist** for agent identity/trust/settlement — pluggable
intelligence above, pluggable chains/rails below, the invariant pipeline in the
middle, owned by no platform.

But a thin waist is **earned by adoption, not architecture.** IP, HTTP, Stripe,
Docker, Kubernetes became waists because the ecosystem routed through them.

> Motebit is architected like a _possible_ thin waist. It is not yet the thin
> waist. The gap is distribution, not code.

The independent frontier is converging on motebit's exact primitives — verifiable
agent identity (DIDs), trust-scored discovery, causal-chain auditing, economic
coordination (the IETF Web Bot Auth work; Cloudflare/Google/OpenAI signed agents;
Visa Trusted Agent Protocol, Mastercard Agent Pay, Google AP2; the "Trust Fabric"
and Agent Network Protocol papers; W3C's AI-agent-protocol CG). That convergence
**validates the shape** and simultaneously means the waist is a **contested,
winner-take-most race.** Motebit's edge in it is _sovereignty_; its disadvantage
is _distribution_. Being right is necessary, not sufficient.

## The discipline that decides it: sovereign by construction

Sovereignty-as-a-feature loses to convenience. The graveyard is large — SSI,
Diaspora, PGP, web3 "own your data." Every time a user is asked to _choose_
sovereignty as a virtue, convenience wins. The win condition is the inversion:

> **Sovereign by construction. Sold as capability. Never sold as virtue.**

Users adopt the agent because it is the _best_ agent — it remembers, proves,
pays, earns trust, and works everywhere — and it is sovereign **by construction,**
not because the user opted into an ideology. Builders adopt the protocol because
it makes them faster/safer/richer, not because it is philosophically pure.

    The moat is sovereignty. The product is capability.

Positioning follows: motebit is **"the accountability layer that lets AI agents
act, pay, and build trust"** — _"Motebit makes autonomous agents accountable."_
Not _"a self-sovereign identity protocol for agents"_ (too abstract,
virtue-coded, graveyard-adjacent). Sovereignty is the structural advantage
_underneath_ the user benefit, never the pitch on top of it.

This is the same law as [`the-stack-one-layer-up.md`](the-stack-one-layer-up.md)
(incumbents converge on the same primitives; the difference is who owns the
identity). Incumbents can ship agent IDs, signed requests, registries, and
policy — what they **cannot credibly own is the neutral, user-sovereign, portable
trust layer** without dismantling their own lock-in. That is the defense. It only
pays off if the sovereign path is also the most capable path.

## Core vs. adapters

- **Core (the invariant pipeline, never an adapter):** persistent identity,
  delegated authority, policy boundaries, signed receipts, settlement proof,
  accumulated trust.
- **Adapters (pluggable, additive, swappable):** MCP, A2A, x402, **Web Bot Auth**,
  enterprise IAM, wallets/chains, browser & runtime surfaces.

Adapters consume the identity; they never replace it.

## Web Bot Auth — deferred standards adapter (not a pivot, not shipped)

The agent↔website boundary: an automated client publishes an Ed25519 public key at
a `/.well-known/` directory and signs each outbound request per **RFC 9421** (HTTP
Message Signatures) so origin servers can verify _who_ is calling. Motebit already
does Ed25519 + `/.well-known/motebit.json` + receipt/payment signing — the adapter
is a second well-known directory and RFC 9421 signing over the **existing**
sovereign key, no new primitive.

> Snapshot, 2026-06 (sources below — these will age; the _mechanism_ above is the
> durable part, not the calendar): an IETF working group is standardizing this
> (`draft-meunier-web-bot-auth-architecture`), authored out of Cloudflare +
> Google, with Amazon/Akamai/OpenAI participating and OpenAI already signing
> Operator requests; a BCP was targeted ~Aug 2026. Treat participants/dates as a
> dated snapshot, not doctrine.

The industry taxonomy splits agent-auth into four trust anchors — card-network
tokens (Mastercard Agent Pay), attestation headers (Visa TAP), issuer-signed VCs
(Google AP2), and **self-sovereign DIDs settling onchain.** The fourth slot _is_
motebit (did:key Ed25519 + Solana settlement). The other three are
platform/network-owned; motebit is the self-sovereign one — a named, distinct
place in the landscape.

**Discipline (per the metabolic principle):** _adopt_ the standard when it
stabilizes; never invent a bespoke request-signing scheme (that fragments and
re-implements glucose). Treat it as additive scoring at the boundary, never a new
gate — same posture as [`hardware-attestation.md`](hardware-attestation.md).

**Trigger to build:** the standard stabilizes AND motebit agents need to reach
sites that require it, OR a concrete consumer arrives. **Until then it is
positioning, not code** — never claim it as shipped (the repo is public, the
thesis is provable-truth; overclaiming on a truth-product is fatal). See
[`self-attesting-system.md`](self-attesting-system.md).

## Sequencing

Do not absorb every frontier idea into the repo. The map is drawn; the territory
is empty. Build order, in priority of earning the waist:

1. Settlement surfaced truthfully in tool results (stop the confabulation).
2. An undeniable demo of live paid agent delegation.
3. External builders/users on the live loop.
4. _Then_ Web Bot Auth as a standards-compatible boundary adapter.

The endgame is the _why_. Adoption is the _war_. This doctrine marks the edge of
the map; it does not authorize a sprint to it.

---

Related: [`the-stack-one-layer-up.md`](the-stack-one-layer-up.md),
[`protocol-primacy.md`](protocol-primacy.md),
[`protocol-model.md`](protocol-model.md),
[`identity-binding-verification.md`](identity-binding-verification.md),
[`agility-as-role.md`](agility-as-role.md),
[`hardware-attestation.md`](hardware-attestation.md),
[`off-ramp-as-user-action.md`](off-ramp-as-user-action.md),
[`self-attesting-system.md`](self-attesting-system.md). External: IETF Web Bot
Auth, Cloudflare Web Bot Auth, Visa TAP, Mastercard Agent Pay, Google AP2, Trust
Fabric (arXiv 2507.07901), CSA agentic-web zero-trust (arXiv 2508.12259), Agent
Network Protocol.
