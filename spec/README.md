# Motebit protocol specifications

Licensed Apache-2.0 ([`LICENSE`](LICENSE)).

## Admission rule

A document belongs in /spec/ only when it defines a versioned contract whose observable bytes, semantics, or verification rules may be implemented independently of Motebit's reference runtime.

Every spec below is listed once, under one class. Status is a compatibility promise and comes from a closed set — `Draft`, `Stable` or `Deprecated` — read from the leading word of the spec's own `**Status:**` line; a spec whose status is still a founder decision is shown as `pending decision`. `scripts/check-spec-coverage.ts` checks that every spec is indexed once under one class with a matching status from that closed set, and that each either declares a wire format or carries a stated reason it is normative without one. Whether a spec satisfies the admission rule above is human judgment; the gate does not decide it.

Supporting trees: [`schemas/`](schemas/) (generated JSON Schemas for the wire artifacts) and [`conformance/`](conformance/) (test corpora).

## Identity & authority

- [identity-v1.md](identity-v1.md) · Status: Stable · the portable agent identity file and key succession.
- [auth-token-v1.md](auth-token-v1.md) · Status: Stable · signed, audience-bound bearer tokens.
- [signed-request-envelope-v1.md](signed-request-envelope-v1.md) · Status: Draft · per-request signatures verified against a registered key.
- [device-self-registration-v1.md](device-self-registration-v1.md) · Status: Stable · a device registering itself by signing over its own key.
- [standing-delegation-v1.md](standing-delegation-v1.md) · Status: Draft · revocable grants that authorize per-tick delegation tokens.
- [seed-escrow-v1.md](seed-escrow-v1.md) · Status: Draft · encrypted seed storage the holder cannot open.
- [machine-roster-v1.md](machine-roster-v1.md) · Status: pending decision · signed enrollment and retirement of the machines that host a motebit.
- [migration-v1.md](migration-v1.md) · Status: Draft · moving an agent between relays with identity, reputation and balance intact.

## Evidence & verification

- [execution-ledger-v1.md](execution-ledger-v1.md) · Status: Stable · signed execution receipts and the ledger they form.
- [credential-v1.md](credential-v1.md) · Status: Stable · verifiable credentials for agent reputation.
- [eval-attestation-v1.md](eval-attestation-v1.md) · Status: Stable · signed third-party measurements of an agent.
- [evidence-provenance-v1.md](evidence-provenance-v1.md) · Status: pending decision · re-checkable provenance for the evidence a verdict cites.
- [consolidation-receipt-v1.md](consolidation-receipt-v1.md) · Status: Stable · verifiable receipts for idle-time consolidation cycles.
- [consolidation-mutation-manifest-v1.md](consolidation-mutation-manifest-v1.md) · Status: Stable · commitment to the exact mutations a consolidation cycle made.
- [routing-transcript-v1.md](routing-transcript-v1.md) · Status: Stable · a recomputable record of a worker-routing decision.

## Execution & routing

- [delegation-v1.md](delegation-v1.md) · Status: Draft · task submission, routing, execution and receipting between agents.
- [discovery-v1.md](discovery-v1.md) · Status: Draft · finding agents and their capabilities.
- [market-v1.md](market-v1.md) · Status: Stable · listings, pricing, budgets and delegation tokens.
- [proposals-v1.md](proposals-v1.md) · Status: Draft · negotiating a shared plan across motebits before execution.

## Settlement & economics

- [settlement-v1.md](settlement-v1.md) · Status: Stable · settlement records and payment rails.
- [settlement-invoice-v1.md](settlement-invoice-v1.md) · Status: pending decision · offline-verifiable invoices for issuer-run rails.
- [agent-settlement-anchor-v1.md](agent-settlement-anchor-v1.md) · Status: Draft · Merkle proofs tying a worker's settlement to an onchain anchor.
- [bond-v1.md](bond-v1.md) · Status: pending decision · self-signed, RPC-verified commitment bonds.
- [dispute-v1.md](dispute-v1.md) · Status: Draft · raising, evidencing and resolving delegation disputes.

## Federation & transparency

- [relay-federation-v1.md](relay-federation-v1.md) · Status: Stable · relay-to-relay peering, discovery and routing.
- [relay-transparency-v1.md](relay-transparency-v1.md) · Status: Draft · the signed operator-posture declaration verifiers pin.
- [credential-anchor-v1.md](credential-anchor-v1.md) · Status: Draft · Merkle-batched onchain anchoring of credential hashes.
- [agent-revocation-v1.md](agent-revocation-v1.md) · Status: pending decision · signed, reasoned records of operator de-listing and reinstatement.

## Runtime interoperability

Event-log, sync and lifecycle payloads.

- [memory-delta-v1.md](memory-delta-v1.md) · Status: Stable · memory-graph events replayed across devices.
- [goal-lifecycle-v1.md](goal-lifecycle-v1.md) · Status: Stable · goal events and their replay semantics.
- [plan-lifecycle-v1.md](plan-lifecycle-v1.md) · Status: Stable · plan and step state-transition events.

## Surface & tool interoperability

MCP, computer use and skills.

- [agent-mcp-surface-v1.md](agent-mcp-surface-v1.md) · Status: Draft · the canonical MCP tool names a motebit exposes to peers.
- [computer-use-v1.md](computer-use-v1.md) · Status: Draft · observing and acting on the operating system.
- [skills-v1.md](skills-v1.md) · Status: Draft · signed skill packages.
- [skills-registry-v1.md](skills-registry-v1.md) · Status: Draft · publishing and discovering signed skills.

## Vocabulary

- [terminology-v1.md](terminology-v1.md) · Status: Draft · the normative glossary of public terms.
