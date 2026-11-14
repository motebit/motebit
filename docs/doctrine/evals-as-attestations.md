# Evals as attestations, not receipts

> **Layer:** narrative

Signed evaluation artifacts are an attestation, not a receipt. This memo names the category split so future contributors don't re-litigate whether an `EvalReceipt` should join the [three-type receipt family](receipts-unified.md), and records the trigger for promoting the deferred protocol primitive when a real consumer arrives.

**Status:** [doctrine-status.md § evals-as-attestations](../ops/doctrine-status.md#evals-as-attestationsmd)

## The category split

The three existing receipt types — `ExecutionReceipt`, `ToolInvocationReceipt`, `ContentArtifactManifest` — share one structural property beyond their JCS + Ed25519 + suite-dispatch envelope: **the signer is the actor**. The agent signs its own task completion. The agent signs its own tool calls. The producer signs its own bundle assembly. Subject = signer in every case; the receipt is first-person provenance — _"I did this thing, here is the proof."_

An evaluation is structurally different: a third party measures a property of an agent and signs the measurement. _"I observed this thing about you, here is the proof."_ Subject ≠ signer by construction. The peer-issued case (a relay or third-party scorer issues an eval against a worker motebit) is the high-trust signal; the self-issued case is the floor — and even self-issued evals are not the same shape as receipts, because the eval result is a measurement of a property, not a record of an act.

That structural difference puts evals in the **attestation** family, not the receipt family.

## Precedent: hardware attestation lives outside receipts

Motebit's existing code already enforces this split. The four hardware-attestation verifiers — `crypto-appattest`, `crypto-android-keystore`, `crypto-tpm`, `crypto-webauthn` — are deliberately **separate packages from the receipt family**, because hardware attestation is structurally the same shape as an eval: the device hardware signs a claim about a key generated on it; subject ≠ signer. The `HardwareAttestationSemiring` consumes these claims as additive scoring inputs (per [`hardware-attestation.md`](hardware-attestation.md)).

The same architectural argument applies to evals. Collapsing them into the receipt family would hide the subject ≠ signer asymmetry that makes both legible at the type level.

## The deferral

A signed `EvalAttestation` type in `@motebit/protocol` was a real future primitive. When this section was written it had zero consumers, zero wire-format presence, and no recorded drift between independent implementations (since 2026-07-08 the Auditor is consumer #1 — see "Promotion" below). Per the registry-promotion criteria in [`registry-pattern-canonical.md`](registry-pattern-canonical.md), this was the same deferral shape as `SettlementAsset` sub-phase B per [`off-ramp-as-user-action.md`](off-ramp-as-user-action.md) — single literal, no cross-implementation drift surface to defend against yet. We name the doctrine first; the code follows when a real consumer arrives. This is the doctrine-first / code-second pattern per [`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md).

### Named trigger for promotion

Ship `EvalAttestation` (in `@motebit/protocol`, with the eight-artifact closed registry per [`registry-pattern-canonical.md`](registry-pattern-canonical.md)) when **any one** of the following holds:

1. A second motebit emits a signed eval against another motebit and a transport (relay-mediated A2A, direct HTTP, in-memory hub) needs the wire shape to be canonical.
2. A third-party scorer (paid reputation service, regulatory auditor, federation peer) wants to issue evals as a fee-bearing service against motebits.
3. The relay starts issuing behavioral probes against worker motebits and signing the results as a service surface — the relay-as-issuer case.
4. A second implementation (Rust, Go, …) wants to consume evals and the wire format needs cross-language stability.

Until one of those triggers fires, evals stay internal to CI as test-suite artifacts under existing package surfaces.

## Promotion (2026-07-08)

**Trigger #1 fired.** The archetype arc ([`agent-archetypes.md`](agent-archetypes.md)) ships the Auditor — a first-party marketplace service whose deliverable is a signed measurement of _another_ motebit (identity binding, succession, revocation, receipt spot-checks, bond integrity, solvency), transported over the relay's standard task path. That is verbatim the trigger-1 sentence: a second motebit emitting a signed eval against another motebit, with a transport needing the wire shape to be canonical. Trigger #2 fires with it — the Auditor is fee-bearing.

The primitive is what this memo promised: the EvalAttestation wire type in `@motebit/protocol` with a closed `EvalKind` registry (`ALL_EVAL_KINDS`; unknown kinds fail closed at wire intake) under the eight-artifact treatment ([`registry-pattern-canonical.md`](registry-pattern-canonical.md)), signing/verification laws in `@motebit/crypto` (subject ≠ signer carried structurally; the verify law establishes "this issuer said this about this subject" and deliberately never the truth of the measurement), a zod wire schema with a committed JSON Schema, and re-exports through `@motebit/verifier` so external consumers never reach past the aggregator. Each measurement embeds the per-axis verification verdict whole — no top-level pass/fail boolean, the same no-silent-true discipline as the verdict vocabulary itself.

**Promotion of the envelope is not a mandate to build issuers.** The `@motebit/evals` runner sketched in "What ships now" below — composing the in-repo test suites into signed-eval producers — waits for its own consumer test.

## What ships now

The behavioral coverage gap that motivated this discussion gets closed through testing discipline, not protocol commitment:

- **Property-based tests** on high-consequence surfaces — conservation invariants, hardware-attestation chain mutations, skill-manifest fuzz.
- **Cross-model behavioral equivalence** as an in-package test suite in `@motebit/runtime`. Backstops [`intelligence-pluggability-contract.md`](intelligence-pluggability-contract.md) behaviorally where `check-prompt-budget` and `check-prompt-density` already cover the structural half.
- **Real-fixture capture** for at least one hardware-attestation platform. Android Keystore is the cheapest path; iOS App Attest fixtures are structurally harder, TPM EK certs are structurally unpublishable per the existing audit memos.

These ship as tests under existing package surfaces, not as a new package or protocol type. The existing test infrastructure is what composes into a `@motebit/evals` runner that produces signed `EvalAttestation`s, at which point the test suites already in place become producers of the primitive. The deferral does not strand the work; it sequences it.

## Cross-cuts

- [`receipts-unified.md`](receipts-unified.md) — the contrast family. Receipts are first-person provenance; this memo establishes evals as third-party measurement.
- [`hardware-attestation.md`](hardware-attestation.md) — the structural precedent. Hardware attestation lives outside receipts for the same subject ≠ signer reason; the `HardwareAttestationSemiring` is the additive-scoring shape evals will inherit.
- [`registry-pattern-canonical.md`](registry-pattern-canonical.md) — the eight-artifact promotion pattern that `EvalAttestation` follows.
- [`off-ramp-as-user-action.md`](off-ramp-as-user-action.md) — the sub-phase B deferral precedent (single literal, no cross-implementation drift yet, defer until consumer arrives).
- [`intelligence-pluggability-contract.md`](intelligence-pluggability-contract.md) — the doctrine whose behavioral half is backed by the cross-model equivalence test in `@motebit/runtime`.
- [`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md) — the doctrine-first / code-second pattern this deferral follows.
