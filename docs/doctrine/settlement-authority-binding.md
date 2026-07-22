# Settlement authority is agent-owned — a relay transports it, never creates it

**Discovery informs where an agent claims to be paid; only an agent-owned binding authorizes a pay-to destination. A relay — origin or federated peer — transports the binding, it never manufactures the authority by returning JSON.**

This is [`memory-never-confers-authority.md`](memory-never-confers-authority.md) one level out. That invariant says memory may inform but only a signed artifact authorizes money _movement_ (`verifiedGrant`); this one says peer JSON may inform but only an agent-owned binding authorizes money _destination_. Same shape, same reason: the thing that decides where value goes must be rooted in the sovereign's own key, not in a coordination layer that can lie.

## The hole (verified from the bytes)

`settlement_address` is an unsigned, free-form base58 string. Its only integrity guarantee is that whoever wrote it held a bearer token for the `motebit_id` at write time. After that it is trusted unconditionally at every consumption point:

- Set as a raw column write at `POST /api/v1/agents/register` (`services/relay/src/agents.ts`) and again at `PATCH /api/v1/agents/:motebitId/sweep-config` — no signature over the address, ever.
- Read straight into discovery by `queryLocalAgents` (`services/relay/src/task-routing.ts`) and forwarded across federation as a bare string in the federated candidate.
- Consumed as the on-chain pay-to destination with no intervening proof: the payer in `resolveP2pPaymentRequest` (`packages/runtime/src/relay-delegation.ts`), the local-worker leg check in `services/relay/src/tasks.ts`, and the federated 3-leg forward in `federatedP2pIntent`.

The tell is an asymmetry already in the code: in the same federated-payment block, both relay treasuries are verified as `deriveSolanaAddress(relayIdentity.publicKey)` and `deriveSolanaAddress(peerRow.public_key)` — cryptographically pinned — while the **worker's** address is trusted as a string. A malicious federated peer both _supplies_ and _"verifies"_ the worker leg. This is the residual [`docs/doctrine/routing-decision-transcript.md`](routing-decision-transcript.md)'s sibling PR (the bond-signal-integrity fix) named as potentially existential and deliberately left open: a peer asserting a valid-but-lying candidate can redirect a worker's payments.

The integrity-vs-binding split of [`identity-binding-verification.md`](identity-binding-verification.md) applies exactly: a discovered address has **integrity** (it is some string the writer set) but no **binding** (is this address really this agent's authorized payout?). Nothing checks the binding today, though the agent's `public_key` sits in the very same registry row.

## The shape: two rungs, not a new gate

Settlement authority is a ladder, additive like [`identity-binding-verification.md`](identity-binding-verification.md) and [`hardware-attestation.md`](hardware-attestation.md) — never a hard admission gate that bricks legacy agents. A discovered address resolves to a rung, and a payer acts on the rung honestly:

- **unverified** — a raw string with no binding to the identity key. Today's default. A hint, never authority: a payer MUST NOT auto-settle to an unverified address (the interim rule _discoverable ≠ settlement-authorized_, made structural).
- **derived-bound** — `settlement_address === deriveSolanaAddress(agent.public_key)`. The address IS the identity key's Solana address, so the binding is **tautological and offline** — the same zero-trust shape as the commitment bond's `bonded_address === deriveSolanaAddress(bonded_public_key)` (`verifyBondCommitment`, `packages/crypto/src/artifacts.ts`) and the sovereign/`did:key` identity rung. Crucially, the reference agent runner already sets exactly this (`deriveSolanaAddress(identity.publicKey)` in `packages/molecule-runner/src/index.ts`), so the **common case is already bound** — the fix is to _check the equality_ the relay already computes for its own treasuries. No new artifact, no migration, closes the majority immediately.
- **signed-bound** — for an agent that pays out to a wallet **distinct** from its identity key (custody separation, a cold payout wallet, the `sweep-config` override), a signed SettlementBinding artifact: the agent's identity key signs authorization of an arbitrary payout address within a validity window. Verified against the agent's key with succession/time-windowing (`verifyKeyBindingAtTime`, `packages/crypto/src/index.ts`) so a binding signed while key K was active keeps authorizing, and a forgery under a rotated-away or revoked key fails. Its strength composes with whatever identity-binding rung the signer key itself reaches (pinned/anchored/sovereign).

Why not the alternatives: **pure derivation** (require `address === identity-derived`) is wrong — it forbids custody separation and the sweep-config override, both legitimate. **A signed service listing** conflates pricing with payout authority and rides a relay-write, not a self-signed artifact. The two-rung ladder keeps custody separation possible (signed-bound) while making the honest common case free (derived-bound) and the dangerous default inert (unverified is a hint, not a destination).

## The invariant

**A discovered `settlement_address` may become a pay-to destination only at `derived-bound` or `signed-bound`. An `unverified` address is a hint a payer may display but never auto-settle to.** The relay stores and transports the binding evidence (the agent's `public_key` for the derived rung, the signed artifact for the signed rung); it never asserts authority a peer can't independently re-verify. A federated peer that omits the binding is treated as `unverified` — conservative-correct, the same reasoning that closed bond-laundering.

This subordinates the coordination layer exactly as `memory-never-confers-authority` subordinates the Trusted-caller bypass: the relay keeps coordinating (discovery, pricing, receipts, settlement recording) but cannot _create_ the one thing that decides where money lands.

## Increments

- **Inc 0 (this doc)** — the invariant, the two-rung ladder, the transport-not-create rule.
- **Inc 1 — the derived rung + the consumer refusal.** Verify `settlement_address === deriveSolanaAddress(agent.public_key)` at the three pay-to seams (`relay-delegation.ts` before broadcast; the local worker-leg check and the federated worker-leg re-verification in `tasks.ts`), and refuse/gate auto-settlement when it does not hold and no signed binding is present. This alone closes the residual for the reference-agent (derived) case and the federation-laundering variant, with **zero new artifact and zero migration** — the majority of agents are already derived-bound.
- **Inc 2 — the SettlementBinding signed artifact** (`packages/protocol` type + signSettlementBinding/verifySettlementBinding in `packages/crypto/src/artifacts.ts`, the bond template; suite-dispatched, JCS + Ed25519), for the custody-separation minority. Verified via `verifyKeyBindingAtTime` for succession/revocation windows.
- **Inc 3 — producer + transport.** The agent mints its binding (the runner that already derives the address now signs it); the relay ingests it at both SET seams (register + sweep-config) behind verifySettlementBinding + the registry key→id check (the bond `recordBondCommitment` template), persists the canonical artifact, and carries it in discover + the federation candidate so a receiver re-verifies rather than trusting the string.
- **Inc 4 — conformance + drift gate.** A check-settlement-authority gate (sibling of `check-money-authority` and `check-bond-address-binding`) that a discovered address is never a pay-to destination at the `unverified` rung; a conformance vector that a malicious-peer forged address is refused.

## Backward-compatibility

Additive, the bond/sovereign-binding pattern. Legacy agents have an address but no binding: an address equal to `deriveSolanaAddress(public_key)` reads `derived-bound` immediately (the reference runner, and any honestly-configured agent, passes for free); an unequal legacy address reads `unverified` and degrades to hint-only for auto-settlement until the agent re-registers with a signed binding — it is never hard-failed out of discovery. The federation-transport half is safe to add at once (an omitted binding is simply `unverified`). The required-for-auto-settlement rung applies to newly-written addresses and money-moving paths, not to discovery or display.

## Cross-cuts

- [`memory-never-confers-authority.md`](memory-never-confers-authority.md) — the parent invariant: only signed artifacts authorize money; this is its destination-side twin.
- [`identity-binding-verification.md`](identity-binding-verification.md) — the integrity-vs-binding split, the additive ladder, and `verifyKeyBindingAtTime` for succession/revocation windows the signed rung reuses.
- [`commitment-bond.md`](commitment-bond.md) — the exact address-binding template (`bonded_address === deriveSolanaAddress(bonded_public_key)`, `verifyBondCommitment`, `recordBondCommitment`, the self-signing submit route); settlement binding is its sibling with a signed override for a distinct wallet.
- [`settlement-rails.md`](settlement-rails.md) — the custody split; the relay's out-of-custody P2P path is exactly where a forged destination redirects real funds.
- [`receipts-unified.md`](receipts-unified.md) — the signed-artifact family the SettlementBinding joins (JCS + Ed25519 + suite-dispatch + offline verifier).
