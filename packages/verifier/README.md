# @motebit/verifier

Apache-2.0 library for verifying signed Motebit artifacts. The thin file-reading + human-formatting layer on top of [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto)'s pure verification primitives.

```bash
npm i @motebit/verifier
```

```ts
import { verifyArtifact } from "@motebit/verifier";

// In-memory / browser: pass the receipt JSON string. (Node convenience:
// `verifyFile("./receipt.json")` reads the file for you.)
const result = await verifyArtifact(receiptJson);
if (result.type === "receipt" && result.valid) {
  // `valid` is integrity (signed + intact) — NOT identity. The binding rung
  // is `result.sovereign`, on this package's result type (not the bare
  // `@motebit/crypto` result). Render the rung, never `valid`, as identity:
  console.log(
    result.sovereign ? "sovereign — author proven offline" : "integrity-only — signer not bound",
  );
}
```

Zero relay contact. Zero network. The signer's public key is embedded in the artifact or derivable from it; verification is pure crypto against committed wire formats.

## Looking for the `motebit-verify` command-line tool?

Install [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) instead. That package ships the `motebit-verify` binary with every hardware-attestation platform bundled. This package (`@motebit/verifier`) is the library it sits on — reach for it when you're writing TypeScript code that consumes signed artifacts programmatically.

The naming follows the verb / agent-noun lineage that survives for decades — `git` / `libgit2`, `cargo` / `tokio`, `npm` / `@npm/arborist`. Verb (`verify`) = the tool a human installs. Agent-noun with `-er` suffix (`verifier`) = the library code links against.

## Why this exists

Motebit's moat is the **self-signing body**: every action the agent takes emits a signed receipt that any third party can verify without running the motebit. This package is the smallest public surface of that promise — a deterministic verification library that answers _"is this signed artifact authentic, and what does it claim?"_ — exposed for programmatic consumption.

## What it verifies

The unified `verify()` dispatcher in [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) auto-detects and verifies:

- **identity** — `motebit.md` (YAML frontmatter + content + Ed25519 signature)
- **receipt** — `ExecutionReceipt` (task ID, tools used, prompt/result hashes, signature)
- **credential** — W3C-style Verifiable Credentials
- **presentation** — W3C-style Verifiable Presentations

This package wraps the dispatcher with `verifyFile` (path → result), `verifyArtifact` (string → result), `verifySkillDirectory` (path-to-a-skill-directory → result, for skill bundles shipped as a tree rather than a single file), and `formatHuman` (result → printable banner).

It also re-exports the structured-verdict surface from `@motebit/crypto`: **`verifyReceiptVerdict`** (a signed receipt → a `VerificationVerdict` whose independent axes — integrity, identityBinding, authority, revocation, temporalBasis, evidenceBasis, plus a first-class `repair` — cannot silently collapse to `true`; there is no top-level `valid` boolean to over-read), **`verifyDelegationTokenVerdict`** (a per-tick token against its standing grant — `authority` and `revocation` stay orthogonal, and `temporalMode` selects whether a clock-rollback is load-bearing), and **`isFullyVerified`** (the fail-closed collapse to a boolean: `true` only when every load-bearing axis passes — stricter than the legacy per-function booleans by design). See [`verify-family-fail-closed.md`](https://github.com/motebit/motebit/blob/main/docs/doctrine/verify-family-fail-closed.md).

It also re-exports **`verifyEvidenceProvenance`** — the law that re-checks a verdict's `evidenceBasis` down to the primary record (verifiable-locality extended from signatures to _evidence_). A verdict's `EvidenceRef` may carry optional `provenance`; this law confirms the named `span` is an exact substring of `projection(bytes)` where the bytes content-address to `digest` — re-verifiable **presence**, never truth, with no oracle (a fabricated figure cannot be placed into a content-addressed record). The projection recipe is an _injected, app-owned_ seam: absent ⇒ the span is located over the raw bytes directly (re-verifiable by construction); present with no resolver ⇒ it fails closed (`projection_unresolved`), so motebit never owns a document-format catalog. Re-exported here so a consumer pinning `@motebit/verifier` re-checks evidence from the same surface it already consumes. See [`evidence-provenance.md`](https://github.com/motebit/motebit/blob/main/docs/doctrine/evidence-provenance.md).

It also re-exports **`verifyApprovalDecision`** from `@motebit/crypto` — the "approve" governance band's signed human-consent artifact (`ApprovalDecision`). Unlike the auto-detected artifact types above, an `ApprovalDecision` is verified explicitly against a **pinned approver key** (it carries no `motebit_id → key` binding, so verifying against its own embedded key is circular). See [the governance-triad guide](https://docs.motebit.com/docs/developer/governance-triad) for where a verified decision sits on the binding ladder.

For the same reason — authority is the scope/chain, not a `motebit_id → key` ladder resolvable from the artifact alone — the **delegation family** is also re-exported as explicit verifiers (not auto-detected): **`verifyDelegation`** (a standalone or per-tick `DelegationToken`), **`verifyStandingDelegation`** (a standing grant: signature, activation, expiry, and an injected revocation seam), **`verifyTokenAgainstGrant`** (a per-tick token IS a valid tick of its grant — scope narrows, TTL bounded, grant not revoked), and **`verifyDelegationRevocation`** (a revocation's signature; the caller binds it to the grant). A standing grant's revocation check is the consumer's responsibility — the verifiers are I/O-free and cannot fetch a feed — so **`findGrantRevocation`** does that check correctly: it returns the revocation that authoritatively revokes a grant from a candidate set, binding on `grant_id` **and** the grant's `delegator_public_key` **and** a valid signature, so matching `grant_id` alone (the foot-gun) cannot spoof a revocation. Build the `verifyStandingDelegation` `isRevoked` seam from it. This lets a consumer validate a standing monitor's authorization root, every tick token, and revocation through this package alone. See [`standing-delegation@1.0`](https://github.com/motebit/motebit/blob/main/spec/standing-delegation-v1.md).

`settlement-invoice@1.0` extends the receipt chain to the money — a verifiable bill a customer re-derives offline (motebit owns the format; the issuer runs the rails). Two issuer-signed artifacts are re-exported as explicit verifiers, both checked against the issuer's REGISTERED key (a carried key, if present, must match it): **`verifyCostAttestation`** (an issuer's cost-of-one-execution declaration in nano-USD against a named rate table, bound to its `ExecutionReceipt` by digest, with an `attested_at >= completed_at` temporal axis) and **`verifyInvoice`** (a flat fee plus passthrough bounded by `passthrough_minor <= floor(Σ cost_nanos / 1e7)`, with per-line cost binding, issuer-consistency, and a detectable `stale_cost_overstatement` axis for a downward supersession). Both return a per-axis structured verdict, never a naked boolean. The two mandated digest helpers — **`executionReceiptDigest`** and **`costAttestationDigest`** — are re-exported too so a producer and verifier reproduce a binding by construction. See [`settlement-invoice@1.0`](https://github.com/motebit/motebit/blob/main/spec/settlement-invoice-v1.md).

`standing-delegation@1.1` adds an optional, generic **`subject_binding`** on the grant (**`SubjectBindingV1`**): the delegator's signature reaches the EXACT resolved subjects the authority covers, by digest-binding a detached, vertically-typed scope artifact — closing the gap where an interpreter (not the delegator) chose the identities the agent acts on. **`subjectBindingDigest`** computes the canonical digest of that detached artifact (`hex(SHA-256(canonicalJson))`), and **`verifySubjectBinding`** checks, fail-closed, that a presented artifact matches the grant's signed binding (digest method, declared `artifact_schema`, digest). Authority only — subject _completeness_ ("every signed subject was attempted") is a monitor receipt-profile rule on top, never a property of the generic binding.

On the same principle, the **signed-request-envelope family** is re-exported as explicit signer/verifier — **`signRequestEnvelope`** and **`verifyRequestEnvelope`** ([`signed-request-envelope@1.0`](https://github.com/motebit/motebit/blob/main/spec/signed-request-envelope-v1.md)): stateless per-request identity authentication where the signature is verified against the identity's **registered** public key (resolved by the caller from `motebit_id`, never carried by the request), the payload travels detached behind a `payload_digest`, and `aud` binding kills cross-service replay. Not auto-detected — the key comes from the registry, not the envelope.

## Guarantees

- **No network.** Verification runs entirely offline. No relay calls, no DID resolution over the wire.
- **No dependencies beyond `@motebit/crypto`.** Every dependency is a trust attack surface we'd have to re-audit on every upgrade.
- **Suite-agile.** New signature suites (post-quantum, future) are registry additions, not library changes — `@motebit/crypto`'s `verifyBySuite` dispatches for us.

## Related

- [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) — the **`motebit-verify` CLI** that ships with every hardware-attestation platform bundled. Install this if you want the command-line tool.
- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — the verification primitives this package wraps (Apache-2.0, zero deps)
- [`@motebit/protocol`](https://www.npmjs.com/package/@motebit/protocol) — protocol types for the artifacts being verified (Apache-2.0, zero deps)
- [`@motebit/sdk`](https://www.npmjs.com/package/@motebit/sdk) — developer contract for building Motebit-powered agents
- [`create-motebit`](https://www.npmjs.com/package/create-motebit) — scaffold a signed agent identity
- [`motebit`](https://www.npmjs.com/package/motebit) — reference runtime and operator console

## License

Apache-2.0 — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The Apache License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
