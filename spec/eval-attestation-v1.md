# motebit/eval-attestation@1.0

**Status:** stable · **License of this spec:** Apache-2.0 · **Wire schema:** [`spec/schemas/eval-attestation-v1.json`](schemas/eval-attestation-v1.json)

The signed third-party-measurement artifact. A receipt is first-person provenance — _"I did this thing, here is the proof."_ An eval attestation is third-party measurement — _"I observed this thing about you, here is the proof."_ **Subject ≠ signer** is the category law (doctrine: `docs/doctrine/evals-as-attestations.md`); self-issued attestations (subject == issuer) are permitted as the floor, but the signature always speaks for the issuer, never the subject.

Consumer #1 is the Auditor archetype (`docs/doctrine/agent-archetypes.md`): a marketplace agent that measures another agent's public verification surface and signs the results, transported over the relay's standard task path.

## 1. Scope

### The boundary (load-bearing)

Verifying an attestation establishes exactly one sentence: **"this issuer said these measurements about this subject, as of this basis."** It deliberately establishes nothing else:

- **Not the truth of the measurements.** Each result embeds a whole per-axis `VerificationVerdict` — the issuer's _claims_. A skeptical consumer re-runs the underlying laws over the cited evidence (`verifyEvidenceProvenance` per evidence ref; receipt verdicts over re-fetched receipts).
- **Not issuer authority.** Who counts as a trusted auditor is app-layer, exactly like `EvidenceProvenance.binding`.
- **Not the issuer key → motebit_id binding.** The consumer's `verifySovereignBinding`-shaped responsibility, as with bond commitments.
- **Not freshness.** `expires_at` and `as_of` are carried, consumer-policied — an expired attestation still verifies; the consumer holds the staleness tolerance.

### No flattened verdicts

There is no top-level pass/fail anywhere in this artifact. Results embed the per-axis verdict whole, so the verdict family's governing rule — no unknown / unchecked / stale / integrity-only result may silently read `true` — survives transport inside an eval.

## 2. Wire format

### 2.1 — EvalAttestation

#### Wire format (foundation law)

```
EvalAttestation {
  attestation_id: string            // UUIDv7, issuer-generated
  eval_kind:      EvalKind          // closed registry (§3); unknown fails closed at intake
  subject: {
    motebit_id:       string        // the measured party; MAY equal issuer.motebit_id
    artifact_digests?: DigestRef[]  // content addresses of subject artifacts consumed
  }
  issuer: {
    motebit_id: string              // the measuring party — the SIGNER
    public_key: string              // issuer Ed25519 key, lowercase hex (self-describing)
  }
  issued_at:   number               // unix ms — when the measurement was signed
  expires_at?: number               // issuer-declared staleness bound; carried, consumer-policied
  as_of: {                          // the evidence-read basis: what was true AS-OF, never timelessly
    timestamp_ms: number
    anchor?: { chain: string, slot?: number, height?: number }
  }
  results:    EvalResult[]          // non-empty; §2.2
  evidence?:  EvidenceRef[]         // unsigned observations that informed the audit (never verdicts)
  invocation?: { task_id?: string, relay_task_id?: string }
  suite:      "motebit-jcs-ed25519-b64-v1"   // pinned literal
  signature:  string                // Ed25519 over canonicalJson(minus signature), base64url
}
```

### 2.2 — EvalResult

#### Wire format (foundation law)

```
EvalResult {
  check:   string                   // FREE-FORM snake_case measurement id (issuer catalog);
                                    // never a registry — see §3 for the closed/free split
  verdict: VerificationVerdict      // the measured value, embedded WHOLE (§2.3)
}
```

### 2.3 — VerificationVerdict

#### Wire format (foundation law)

The per-axis structured verdict, as defined by `@motebit/protocol` (`verification-verdict.ts`) and the verification-verdict conformance corpus ([`spec/conformance/verification-verdict/`](conformance/verification-verdict/README.md)):

```
VerificationVerdict {
  type:            VerdictSubject   // closed union incl. succession | revocation |
                                    // bond_commitment | solvency_proof (2026-07-08 widening)
  integrity:       "verified" | "invalid"
  identityBinding: "sovereign" | "anchored" | "pinned" | "unverified" | "invalid"
  authority:       "valid" | "expired" | "not_yet_valid" | "insufficient" | "unknown"
  revocation:      { status: "fresh"|"stale"|"unchecked"|"revoked", freshness?: RevocationFreshness }
  temporalBasis:   "clockless" | "local_clock" | "ledger_anchored"
  evidenceBasis:   EvidenceRef[]
  repair?:         RepairInstruction   // present on any non-passing axis
}
```

## 3. The EvalKind registry (closed) vs check names (free-form)

`eval_kind` names the measurement **family** a consumer dispatches on to interpret `results[]`. It is a **closed registry** — an unknown kind fails closed at wire intake, because a consumer that cannot interpret the measurement family must not act on its verdicts.

Members:

| kind                 | meaning                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verification_audit` | Measurements of an agent's public verification surface (identity binding, succession, revocation, receipt spot-checks, bond, solvency); every result verdict-typed |

`EvalResult.check` stays **free-form** (snake_case by convention): the per-check name is the issuer's catalog label. Freezing check names into protocol would make motebit the authority over every third-party scorer's measurement menu — the same document-format-authority trap `EvidenceProvenance.projection` refuses. Registries own what verifiers must dispatch on; conventions own what issuers may invent.

## 4. Signing

JCS (RFC 8785) canonicalization over the attestation **minus** `signature`; Ed25519; base64url signature encoding; suite pinned to `motebit-jcs-ed25519-b64-v1`. Optional fields are ABSENT, never `undefined`-valued — producers build them via conditional spread so canonical bytes are stable. Post-quantum migration is a new `SuiteId` + dispatch arm, never a wire break.

## 5. Verification law

`verifyEvalAttestation` (`@motebit/crypto`, re-exported by `@motebit/verifier`) — fail-closed, structured reasons:

1. `suite` must equal the pinned literal → `unsupported_suite`.
2. `eval_kind` must be a registry member → `unknown_eval_kind`.
3. `results` must be non-empty → `empty_results`.
4. `issuer.public_key` must be 32-byte lowercase-hex Ed25519 → `malformed_public_key`.
5. `signature` must be base64url of 64 bytes → `malformed_signature`; and verify over the canonical bytes against the embedded issuer key → `signature_invalid`.

What it deliberately does **not** check: §1's boundary list (measurement truth, issuer authority, key→id binding, freshness, subject≠issuer).

## 6. Evidence composition

`subject.artifact_digests` is the audit's evidence closure — content addresses of everything the issuer consumed about the subject, re-fetchable and re-checkable. Attestation-level `evidence[]` carries **unsigned** observations (a listing read, a ranking output) that informed the audit but cannot honestly produce a verdict (an integrity axis has no "unknown" — unsigned bytes are evidence, never measurements). Each evidence ref MAY carry `EvidenceProvenance` (motebit/evidence-provenance@1.0) so a consumer re-checks the issuer's reads down to the primary record.

Receipt composition: when an attestation is produced by a delegated task, the worker's `ExecutionReceipt` wraps the attestation in its result payload — the receipt is the first-person act ("I performed this audit task"), the attestation is the third-party measurement, and each verifies independently.

## 7. Conformance corpus

[`spec/conformance/eval-attestation/`](conformance/eval-attestation/README.md) — fixed-key, byte-stable vectors covering the clean path, the self-issued floor, the expired-still-verifies rule, per-field tamper, and every structured failure reason. A second implementation runs its verifier over each `input.attestation` and must emit the identical structured result. Regenerate with `npx tsx scripts/gen-eval-attestation-corpus.ts` (the generator asserts each expectation against the producer's verifier before writing).
