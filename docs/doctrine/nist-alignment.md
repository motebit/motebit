# NIST alignment as derivation, not certification

Motebit's relationship to NIST standards is not "we comply with X." It is "the primitives NIST is converging on are the primitives we derived from droplet physics." The alignment is the **consequence** of the architecture being correct, not an external compliance posture pulling the architecture into shape. This document is the canonical map — both for our own coherence and for any reader (federal, enterprise, NCCoE) asking how motebit's protocol surface meets the standards landscape.

The April 2, 2026 NCCoE submission ([`nist-submission.md`](../../nist-submission.md)) is the frozen historical artifact of that engagement; this doctrine is the living version. The submission cited a snapshot; the doctrine moves with the code and is structurally bound to it via `check-doctrine-citations` (drift-defense #84). Standards we cite resolve; ones we don't claim don't appear.

## Where the system is going

NIST AI guidance shifted center of gravity over 2023–2026:

- **2023–2024.** Voluntary risk-management frameworks (AI RMF 1.0; GenAI Profile / AI 600-1). Product-level guidance for individual AI systems.
- **2024–early 2025.** Dual-use foundation model reporting (AI 600-2) and content-authenticity initiatives. Briefly mandatory under EO 14110.
- **Early 2025.** EO 14110 rescinded; AI Safety Institute partially defunded; federal mandatory-reporting trajectory collapses.
- **2025–2026.** Voluntary frameworks survive at the federal layer; state-level mandates land (Colorado AI Act, CA SB-1047 redux, NY AI Bill of Rights); **NCCoE's "Software and AI Agent Identity and Authorization" project becomes the live coordination point** for what audits agent action.

The trajectory: **from regulating frontier models → to regulating agent action accountability.** Frontier models are an industrial-policy concern; agent action accountability is an identity-and-audit concern. The second territory is where motebit's protocol surface lives natively.

## The strategic posture

**Co-authorship of the agent-identity standard, not certification against rolling federal mandates.**

This posture follows from the protocol-model derivation ([`protocol-model.md`](protocol-model.md)). The permissive-floor protocol surface (`@motebit/protocol`, `@motebit/crypto`, `@motebit/sdk` — Apache-2.0) is open-licensed precisely so adoption doesn't require negotiation. Federal procurement, enterprise audit, NCCoE laboratory partnership all consume the same artifacts third-party developers consume: signed receipts, verifier primitives, wire-format JSON Schemas. The protocol surface is the integration surface.

The April 2 submission to NCCoE was the channel through which motebit's primitives entered the standards conversation. Closing the issue thread on APS ([#22](https://github.com/motebit/motebit/issues/22)) established the precedent that motebit doesn't subordinate its interior governance to external trust frameworks. Both posture-defining events compose: motebit engages with the standards landscape through the protocol surface, not through compliance theater.

## What motebit ships against the asks

The recurring asks across NIST documents (SP 800-63-4, SP 800-207, NISTIR 8587, FIPS 203/204/205, NCCoE concept paper, AI RMF, GenAI Profile) collapse to eight categories. Seven are shipped; one is named as deferred extension.

### 1. Persistent, verifiable agent identity

**Ask.** Agents acting on behalf of humans need cryptographic identity that survives across surfaces, devices, providers.

**Motebit.** Ed25519 sovereign identity per [`THE_SOVEREIGN_INTERIOR.md`](../../THE_SOVEREIGN_INTERIOR.md). Identity is interior; the keypair is the agent. The protocol declares one identity file format ([`spec/identity-v1.md`](../../spec/identity-v1.md)), one suite registry ([`packages/protocol/src/crypto-suite.ts`](../../packages/protocol/src/crypto-suite.ts)), one verifier primitive that any third party runs without motebit cooperation.

**Aligned with.** SP 800-63-4 (AAL2-characteristic via hardware-backed key storage where available; formal AAL assessment pending), W3C DID 1.0 (`did:key` derivation), W3C VC 2.0 (`eddsa-jcs-2022` suite).

### 2. Cryptographic delegation chains with cascade revocation

**Ask.** When a principal authorizes an agent to act, and that agent sub-delegates to other agents, the full chain must be verifiable and revocation must cascade.

**Motebit.** `signDelegation` / `verifyDelegation` / `verifyDelegationChain` in `@motebit/crypto`. Every signed token carries `aud` audience binding (cross-endpoint replay defense, locked structurally by [`check-audience-canonical`](../../scripts/check-audience-canonical.ts), drift-defense #83); the closed `TokenAudience` registry in [`packages/protocol/src/audience.ts`](../../packages/protocol/src/audience.ts) is the wire law. Key-succession + token blacklist provide cascade revocation per [`spec/delegation-v1.md`](../../spec/delegation-v1.md) §§4.5–4.7.

**Aligned with.** NISTIR 8587 (token security: short expiry, scope binding, audience binding), SP 800-63 (revocation requirements — answered onchain via credential-anchor; chain is the registry).

### 3. Audit-grade non-repudiation

**Ask.** Every consequential agent action must produce a record that a third party can verify after the fact, without trusting the operator.

**Motebit.** Every action emits a signed `ExecutionReceipt` ([`spec/execution-ledger-v1.md`](../../spec/execution-ledger-v1.md)). The relay archives receipts byte-identically (`relay_receipts.receipt_json` is append-only per CLAUDE.md Rule 11); verifiers re-canonicalize and re-verify without relay contact. Wire-format JSON Schemas at [`packages/wire-schemas/src/execution-receipt.ts`](../../packages/wire-schemas/src/execution-receipt.ts) (and siblings) give third-party implementers the validation surface. Drift gate [`check-wire-schema-usage`](../../scripts/check-wire-schema-usage.ts) ensures every inbound body parses through the schema layer at the relay boundary.

**Aligned with.** AI RMF MEASURE function, GenAI Profile MS-2 (information integrity), NCCoE auditability requirements.

### 4. Cross-domain trust accumulation

**Ask.** Trust between agents from different organizations / individuals can't depend on a single central authority. Agents must accumulate verifiable reputation peer-to-peer.

**Motebit.** Peer-issued `AgentReputationCredential` (W3C VC 2.0) per [`spec/credential-v1.md`](../../spec/credential-v1.md). Trust accumulates through verified execution receipts; credentials are portable across relays and verifiable using only the issuer's public key. Semiring-algebraic routing factors credential count, issuer trust, recency, and revocation status. Onchain credential anchoring ([`spec/credential-anchor-v1.md`](../../spec/credential-anchor-v1.md)) provides offline-revocation-checkability — closes the SP 800-63 revocation requirement gap without CA/CRL/OCSP.

**Aligned with.** NCCoE cross-trust-boundary requirements, W3C VC 2.0, post-PKI revocation models.

### 5. Hardware-rooted identity (additive, never a gate)

**Ask.** Hardware attestation (Secure Enclave, TPM, StrongBox) should strengthen identity claims without excluding software-only identity from the protocol.

**Motebit.** `HardwareAttestationSemiring` in `@motebit/semiring` — `(max, min, 0, 1)` over `[0, 1]`, **additive scoring, never an admission gate** ([`hardware-attestation.md`](hardware-attestation.md)). The negative invariant is structurally locked by [`check-ha-not-a-gate`](../../scripts/check-ha-not-a-gate.ts) (drift-defense #82). Four attestation leaves ship today: Apple App Attest, Android Keystore, TPM 2.0, WebAuthn. New platform = one `platform` union entry; the verifier and semiring are closed under additions.

**Aligned with.** SP 800-63-4 hardware-backed authenticator requirements, FIDO Alliance attestation models, NCCoE infrastructure-evidence patterns.

### 6. Post-quantum migration readiness

**Ask.** Identity and signature systems must declare a path to PQ-safe algorithms before classical Ed25519 is broken.

**Motebit.** Cryptosuite agility shipped 2026-04-13. `SuiteAlgorithm` union in [`packages/protocol/src/crypto-suite.ts`](../../packages/protocol/src/crypto-suite.ts) pre-types `"ML-DSA-44" | "ML-DSA-65" | "SLH-DSA-SHA2-128s"`. PQ migration is a registry entry + a new dispatch arm in [`packages/crypto/src/suite-dispatch.ts`](../../packages/crypto/src/suite-dispatch.ts) — not a wire-format break. Closed `SuiteId` union + `SUITE_REGISTRY` + exhaustive switches in `verifyBySuite`/`signBySuite`/`getPublicKeyBySuite` mean adding a PQ suite is a compile-driven additive change.

**Aligned with.** NIST FIPS 203 (ML-KEM, key encapsulation — for transport, future), NIST FIPS 204 (ML-DSA, digital signatures), NIST FIPS 205 (SLH-DSA, stateless hash-based).

### 7. Zero-trust at every action boundary

**Ask.** No ambient authority. Every call verified. No implicit trust.

**Motebit.** Audience-bound tokens at every signing site (drift-locked by `check-audience-canonical`). `dualAuth` pattern on relay endpoints + browser-sandbox after the relay-mediated dispatcher-token flow shipped (drift-defenses #82–#84, spec [`computer-use-v1.md`](../../spec/computer-use-v1.md) §8.2). Sensitivity routing enforced before any provider call ([`check-sensitivity-routing`](../../scripts/check-sensitivity-routing.ts), drift-defense #65) — `medical | financial | secret` never reaches external AI. PolicyGate at every tool boundary; surface affordances invoke capabilities, never construct prompts ([`check-affordance-routing`](../../scripts/check-affordance-routing.ts), drift-defense #15).

**Aligned with.** SP 800-207 (Zero Trust Architecture).

### 8. Content provenance for standalone artifacts

**Ask.** Content that travels independently of the conversation (memory exports, audit-trail JSON, plan dumps, future generated documents and media) should carry verifiable provenance binding the bytes to a producer identity and a moment of production. C2PA-shape: manifest separate from content, signed over the manifest, content's hash bound in.

**Motebit.** `signContentArtifact` / `verifyContentArtifact` / `ContentArtifactManifest` in [`packages/crypto/src/content-artifact.ts`](../../packages/crypto/src/content-artifact.ts). Pinned suite `motebit-jcs-ed25519-hex-v1`. Two-step verification — SHA-256 content-hash recomputation catches tampering of the bytes; Ed25519 signature verification over the canonical-JSON manifest catches tampering of the metadata. Both must pass; fail-closed with typed reasons (`content_hash_mismatch | signature_invalid | malformed_public_key | malformed_signature | unsupported_suite`).

**Recognition note.** This section was initially "deferred until a real consumer ships" in this doctrine's first cut. A grep audit immediately after publication surfaced the 12 state-export routes at [`services/relay/src/state-export.ts`](../../services/relay/src/state-export.ts) producing unsigned downloadable JSON today (audit trails, memory graphs, plan exports, conversation pulls, gradient history, execution-ledger reconstruction). The original framing was wrong — the consumer was already shipping; the primitive was the missing piece. Closing the gap was correct; deferring it would have left the self-attesting-system doctrine ([`self-attesting-system.md`](self-attesting-system.md)) contradicting the export surface.

**Consumer-side migration: shipped 2026-05-11.** All 12 state-export endpoints route through a closure-scope `emitSignedExport` helper that wraps `signContentArtifact` with `relayIdentity` and emits the outer manifest in the `X-Motebit-Content-Manifest` HTTP header. Witness-composition: relay attests "this is what I assembled at time T," bounded to the relay's own database state — never claims authority over agent actions. Body serialization is JCS-canonical so a verifier hashes the received bytes verbatim against `manifest.content_hash` without recanonicalization. The design choice settled on relay-signs-as-host across all twelve; the layered model on `execution-ledger` keeps the spec-1.0-compliant inner body unchanged (agent-signature field omitted per §6 because the relay does not hold the agent's private key) and adds the outer envelope alongside, never collapsing the two witness boundaries. Drift gate `check-state-export-signed` (drift-defense #86) makes the consumer-side coherency permanent — every new `app.get(...)` in `state-export.ts` MUST route through the helper or fail CI. The lattice that caught the original §8 over-claim now permanently prevents its return.

**Third-party verifier: shipped 2026-05-11.** `motebit-verify content-artifact <body-file> --manifest <header-or-path>` in [`packages/verify/src/cli.ts`](../../packages/verify/src/cli.ts) is the canonical third-party verification path — Apache-2.0, offline, network-free. Closes the producer-consumer asymmetry: producer-side signing is ceremony unless a consumer demands it. The subcommand sources `--expect` values from `ALL_CONTENT_ARTIFACT_TYPES` (closed registry; drift gate `check-artifact-type-canonical`). `--producer-key <hex>` pins the expected signer; a verifier who has fetched the relay's public key from [`/.well-known/motebit-transparency.json`](https://motebit.com/.well-known/motebit-transparency.json) (which is itself self-signed and self-attesting) can confirm any state-export manifest originated from that specific operator. Trust-anchor chain: transparency.json verifies its own signature against the embedded `relay_public_key`; that key then verifies every content-artifact manifest. No relay contact at verify time; no operator-trusted intermediary.

**Operational consumer: shipped 2026-05-11.** The producer-consumer loop is now closed at the product layer, not just at the CLI. [`packages/state-export-client/`](../../packages/state-export-client/) (Apache-2.0, browser-safe) ships `fetchTransparencyAnchor` (TOFU bootstrap) and `verifiedStateExportFetch` (per-call wrapper); `apps/inspector` consumes both, so every admin-dashboard state-export fetch now verifies the producer-signed manifest against the response body and pins the producer against the relay's transparency-declared key. The CLI sibling (`motebit-verify content-artifact`) handles file-on-disk verification; this package handles in-browser response-from-fetch verification. The drift gate `check-state-export-consumer-verifies` (drift-defense #87) makes the consumer-side coherency permanent — every new source file in `apps/` or `packages/` that contains a state-export URL template MUST import from `@motebit/state-export-client`, or fail CI. The producer-consumer-gate triple is now structurally locked: producer #86, registry #85, consumer #87. An operator who silently degrades their signing breaks every shipping consumer that demands verification, instead of silently degrading without anyone noticing — the operational invariant the self-attesting-system doctrine requires.

**Savant gap closed 2026-05-11.** The TOFU bootstrap fetch of `/.well-known/motebit-transparency.json` was the last network-layer trust hole — a DNS hijack, malicious ISP, or compromised CA could substitute a different declaration whose self-signature verifies (against the attacker's key). The relay now anchors `sha256(canonicalJson(declaration))` to Solana via the Memo program (`motebit:transparency:v1:{hash}`) at startup whenever `SOLANA_RPC_URL` is configured (`anchorTransparencyDeclaration` in `services/relay/src/transparency.ts`). A verifier with the relay's pinned anchor address — published out-of-band, like Apple's App Attest root cert — calls `lookupTransparencyAnchor` from `@motebit/state-export-client` to cross-check the declaration's hash against the onchain memo. Mismatch or absence yields a typed reason (`anchor_hash_mismatch` / `no_anchor_found`); the verifier rejects the first-fetch declaration without ever trusting the HTTPS channel that delivered it. The chain is: pinned anchor address (out-of-band trust root) → Solana memo (different channel than HTTPS) → declaration hash → `relay_public_key` (commits the operator to one identity) → every content-artifact manifest verifies against that key forever after. No relay contact, no operator-trusted intermediary, no CA trust at any layer of the verification path. Drift-locked by `check-transparency-onchain-anchored` (drift-defense #88): every relay startup that wires a Solana submitter MUST also anchor the declaration, or fail CI. Doctrine: `docs/doctrine/operator-transparency.md` § Stage 2a (onchain anchor, lifted forward independent of multi-operator wire-format spec).

**Trust-anchor primitive codified 2026-05-11.** `spec/relay-transparency-v1.md` (Stage 2b-i) lands the wire-format spec for the trust-anchor envelope — `SignedTransparencyDeclaration` shape, hash derivation, suite pinning, onchain anchor memo format, succession rules. The doctrine drift that the savant-gap critique surfaced (Stage 2 conflating onchain-anchor and wire-format under one "second operator" trigger) had a second split inside Stage 2b itself: the wire-format spec served two distinct purposes — **trust-anchor codification** (single-operator independent, motebit's own verifiers consume it) and **operator-comparison vocabulary** (multi-operator, comparison ecosystem). The first ships now; the second stays deferred behind the original trigger. Asymmetry closed: every other trust anchor in motebit (identity, execution-ledger, credential, credential-anchor, settlement) has a spec; transparency now does too. Wire types in `@motebit/protocol::SignedTransparencyDeclaration`; zod schema in `@motebit/wire-schemas`; JSON Schema in `spec/schemas/signed-transparency-declaration-v1.json` (Apache-2.0). Doctrine: `docs/doctrine/operator-transparency.md` § Stage 2b-i (trust-anchor primitive spec, shipped); § Stage 2b-ii (operator-comparison fields, still deferred).

**Inner-receipt verification closed 2026-05-11.** The execution-ledger reconstruction at `/api/v1/execution/:motebitId/:goalId` now surfaces byte-identical inner signed receipts via the v1.1 `signed_receipts` field (additive per [`spec/execution-ledger-v1.md`](../../spec/execution-ledger-v1.md) §4.3). Producer-side wiring sources the bytes from `relay_receipts.receipt_json` (per `services/relay/CLAUDE.md` Rule 11) and bumps the `spec` field to `motebit/execution-ledger@1.1` when any inner receipt is archived; graceful degradation to `motebit/execution-ledger@1.0` when the archive is empty (testnet, ephemeral, partial sync). Closes the **operator-trust gap** the prior commits left open — before v1.1, a relay-assembled bundle's outer manifest could be verified (commit d36cb5fd) but inner receipts were truncated to 16-char `signature_prefix` summaries (display-only, not verifiable). After v1.1, a federation peer, regulatory auditor, or third-party validator can iterate the embedded `signed_receipts`, parse each canonical-JSON receipt, and verify each Ed25519 signature against the named motebit's public key — without trusting the relay's word that "motebit X did this work." Cross-relay verification becomes possible. Drift-locked by `check-execution-ledger-receipts-archived` (drift-defense #89): the gate scans `state-export.ts` for the three required symbols (`getStoredReceiptJson`, `motebit/execution-ledger@1.1`, `motebit/execution-ledger@1.0` fallback) and rejects silent regressions back to summary-only semantics. The self-attesting-system doctrine becomes operationally true at the bundle layer: every claim verifiable, including ones embedded in relay-assembled state exports.

**Inner-receipt verifier shipped 2026-05-12.** The v1.1 producer-consumer arc closes at the consumer side. `@motebit/state-export-client::verifyInnerSignedReceipts` parses each `signed_receipts` entry as an `ExecutionReceipt`, calls `verifyReceipt` from `@motebit/crypto` (now publicly exported), and walks `delegation_receipts` recursively for multi-hop chains. The shipping CLI `motebit-verify content-artifact <body> --manifest <header>` auto-invokes the recursive verifier whenever the manifest's `artifact_type === "execution-ledger"` and the body declares v1.1 — no flag required, calm-software default. Per-receipt outcomes surface in both human output (`✓ inner receipts N/M VERIFIED` + per-receipt task_id + signer DID) and JSON output (typed failure reason per entry). Exit code gates on outer AND inner — a v1.1 bundle where any inner receipt fails (`signature_invalid`, `missing_public_key`, `malformed_json`, `delegation_failed`) fails the overall verification even when the outer relay signature is valid: the relay is correctly attesting bytes it assembled, but those bytes contain falsified inner claims. Drift-locked by `check-execution-ledger-inner-receipt-verified` (drift-defense #90): the gate scans the state-export-client primitive home, the package's re-export, and the CLI's import + call site, rejecting any regression that disconnects the consumer-side wiring from the producer-side bytes. The producer-consumer-gate triple is now closed for inner receipts: producer #89 surfaces the bytes, this gate (#90) ensures consumers recursively verify, the existing #87 covers the outer envelope. End-to-end: a federation peer with the relay's transparency-pinned key + the cross-relay state-export + `motebit-verify` can audit every motebit's claim inside without trusting the relay or any intermediary.

**Aligned with.** C2PA Content Authenticity v1.x, Content Authenticity Initiative manifest formats. The motebit manifest shape maps cleanly to C2PA assertions (`c2pa.actions` → `claim_generator` + `produced_at`; `c2pa.hash.data` → `content_hash`); C2PA-native tooling reads via a translation layer when industry consumption demands strict compatibility.

## What motebit does not claim

**AI 600-2 (Dual-Use Foundation Model Reporting).** Motebit does not train foundation models. The metabolic principle ([`THE_METABOLIC_PRINCIPLE.md`](../../THE_METABOLIC_PRINCIPLE.md)) makes model providers adapters with fallback — glucose, not enzymes. The 10^26 FLOPS reporting threshold doesn't apply.

**Content-moderation mandates.** Motebit's answer to content harm is the sensitivity ladder ([`packages/protocol/src/sensitivity.ts`](../../packages/protocol/src/sensitivity.ts)) and `assertSensitivityPermitsAiCall` enforced fail-closed before any provider call. Categorical moderation lists are not motebit's primitive.

**Centralized model registries.** The federation protocol ([`spec/relay-federation-v1.md`](../../spec/relay-federation-v1.md)) is the alternative. Motebits register with their relay; relays federate; trust accumulates peer-to-peer; routing is algebraic.

**Compliance-by-attestation without architecture.** The protocol layer is Apache-2.0 precisely so anyone can verify motebit's claims independently. There is no opaque attestation surface motebit asks regulators to trust — every claim is structurally verifiable using only published primitives and the signer's public key.

## How this stays coherent

Three structural defenses keep this document and the alignment claims it makes from rotting:

1. **`check-doctrine-citations`** (drift-defense #84) — every backtick-shaped path-reference and `check-X` gate-name resolves to a real file or registered gate. If a NIST standard or motebit primitive gets renamed or removed, the citation fails CI before the doc lies.

2. **`check-claude-md`** (drift-defense #25) — this file must be indexed in root [`CLAUDE.md`](../../CLAUDE.md) under "Cross-cutting doctrine (read on demand)." Sub-doctrine is only discoverable through the root index.

3. **The protocol surface is itself the proof.** Every claim above maps to a published, Apache-2.0, third-party-verifiable primitive. The doctrine cannot diverge from the architecture for long without `check-spec-impl-coverage`, `check-spec-routes`, `check-spec-tools`, or `check-suite-declared` failing on a related artifact. The alignment is structurally distributed across the lattice, not concentrated in this one document.

## See also

- [`protocol-model.md`](protocol-model.md) — permissive floor, three-layer model, why Apache-2.0 is load-bearing
- [`self-attesting-system.md`](self-attesting-system.md) — every claim independently verifiable using only published primitives
- [`security-boundaries.md`](security-boundaries.md) — sybil defense layers, token binding, injection
- [`hardware-attestation.md`](hardware-attestation.md) — additive scoring, never a gate
- [`agility-as-role.md`](agility-as-role.md) — the role/instance pattern that lets PQ migration be additive
- [`nist-submission.md`](../../nist-submission.md) — frozen historical artifact: the April 2, 2026 NCCoE submission
