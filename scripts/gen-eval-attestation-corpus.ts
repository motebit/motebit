/**
 * Generator for the EvalAttestation conformance corpus.
 *
 * Writes spec/conformance/eval-attestation/corpus.json — the versioned,
 * pinnable vector set a second implementation runs ITS verifier against
 * (motebit/eval-attestation@1.0; docs/doctrine/evals-as-attestations.md).
 *
 * Determinism: every artifact is minted from FIXED private keys. Ed25519
 * keygen and signing are deterministic, so the signed bytes are byte-stable
 * across runs — re-running this generator on an unchanged producer
 * reproduces corpus.json exactly.
 *
 * Non-circularity guard: each case carries a hand-coded EXPECTED result; the
 * generator asserts the producer's own verifier emits it BEFORE writing, so
 * a verifier regression can't be silently frozen into the corpus.
 *
 * Regenerate:  npx tsx scripts/gen-eval-attestation-corpus.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  signEvalAttestation,
  verifyEvalAttestation,
  bytesToHex,
  type VerifyEvalAttestationResult,
} from "../packages/crypto/src/index.js";
import type { EvalAttestation, VerificationVerdict } from "../packages/protocol/src/index.js";
import { getPublicKeyBySuite } from "../packages/crypto/src/suite-dispatch.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "spec/conformance/eval-attestation/corpus.json");

const SUITE = "motebit-jcs-ed25519-b64-v1" as const;

// Fixed keys — issuer and subject. Deterministic, test-only, never reuse.
const ISSUER_PRIV = new Uint8Array(32).fill(0x41);
const SUBJECT_PRIV = new Uint8Array(32).fill(0x42);

interface CorpusCase {
  name: string;
  description: string;
  input: { attestation: unknown };
  expected: VerifyEvalAttestationResult;
}

/** A representative passing verdict for embedded measurements. */
function passingVerdict(): VerificationVerdict {
  return {
    type: "receipt",
    integrity: "verified",
    identityBinding: "sovereign",
    authority: "unknown",
    revocation: { status: "unchecked" },
    temporalBasis: "clockless",
    evidenceBasis: [
      {
        kind: "receipt",
        ref: "sha256:3f2e1d0c0b0a09080706050403020100ffeeddccbbaa99887766554433221100",
      },
    ],
    repair: {
      code: "revocation.unchecked",
      axis: "revocation",
      summary: "Revocation status was not consulted for this spot-check",
      fix: "Fetch the operator revocation feed and re-run the check",
    },
  };
}

async function main(): Promise<void> {
  const issuerPub = await getPublicKeyBySuite(ISSUER_PRIV, SUITE);
  const subjectPub = await getPublicKeyBySuite(SUBJECT_PRIV, SUITE);
  const issuerId = `motebit-issuer-${bytesToHex(issuerPub).slice(0, 12)}`;
  const subjectId = `motebit-subject-${bytesToHex(subjectPub).slice(0, 12)}`;

  const baseBody: Omit<EvalAttestation, "signature" | "suite"> = {
    attestation_id: "0197f000-0000-7000-8000-000000000001",
    eval_kind: "verification_audit",
    subject: {
      motebit_id: subjectId,
      artifact_digests: [
        {
          algorithm: "sha-256",
          value: "aa00bb11cc22dd33ee44ff5566778899aabbccddeeff00112233445566778899",
        },
      ],
    },
    issuer: { motebit_id: issuerId, public_key: bytesToHex(issuerPub) },
    issued_at: 1751932800000,
    as_of: { timestamp_ms: 1751932799000 },
    results: [{ check: "receipt_spot_check", verdict: passingVerdict() }],
    evidence: [
      {
        kind: "listing",
        ref: "sha256:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        provenance: {
          digest: {
            algorithm: "sha-256",
            value: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
          },
          span: '"unit_cost":0.05',
        },
      },
    ],
    invocation: { task_id: "0197f000-0000-7000-8000-00000000000a" },
  };

  const clean = await signEvalAttestation(baseBody, ISSUER_PRIV);

  const selfIssued = await signEvalAttestation(
    {
      ...baseBody,
      attestation_id: "0197f000-0000-7000-8000-000000000002",
      subject: { motebit_id: issuerId },
    },
    ISSUER_PRIV,
  );

  const expiring = await signEvalAttestation(
    {
      ...baseBody,
      attestation_id: "0197f000-0000-7000-8000-000000000003",
      expires_at: 1751932800001,
    },
    ISSUER_PRIV,
  );

  const cases: CorpusCase[] = [
    {
      name: "clean",
      description:
        "A well-formed attestation verifies. Establishes ONLY 'this issuer said these measurements about this subject' — never measurement truth.",
      input: { attestation: clean },
      expected: { valid: true },
    },
    {
      name: "self-issued-valid",
      description:
        "subject.motebit_id == issuer.motebit_id verifies — self-issued evals are the doctrine's floor (a trust grade, not a malformed artifact). Consumers weigh issuer independence at the app layer.",
      input: { attestation: selfIssued },
      expected: { valid: true },
    },
    {
      name: "expired-still-verifies",
      description:
        "expires_at is carried, consumer-policied — the envelope law does NOT enforce freshness. An expired attestation verifies; the consumer holds the staleness tolerance.",
      input: { attestation: expiring },
      expected: { valid: true },
    },
    {
      name: "tampered-results",
      description:
        "Mutating a measurement after signing invalidates the signature — the verdicts are inside the signed body.",
      input: {
        attestation: {
          ...clean,
          results: [
            {
              ...clean.results[0],
              verdict: { ...clean.results[0]!.verdict, integrity: "invalid" },
            },
          ],
        },
      },
      expected: { valid: false, reason: "signature_invalid" },
    },
    {
      name: "tampered-subject",
      description:
        "Re-pointing an attestation at a different subject invalidates the signature — an eval cannot be transplanted between agents.",
      input: {
        attestation: { ...clean, subject: { motebit_id: "motebit-someone-else" } },
      },
      expected: { valid: false, reason: "signature_invalid" },
    },
    {
      name: "unsupported-suite",
      description: "Unknown or missing suite fails closed before any signature work.",
      input: { attestation: { ...clean, suite: "motebit-jcs-ed25519-hex-v1" } },
      expected: { valid: false, reason: "unsupported_suite" },
    },
    {
      name: "unknown-eval-kind",
      description:
        "eval_kind is a CLOSED registry — a consumer that cannot interpret the measurement family must not act on its verdicts. Unknown kinds fail closed at wire intake.",
      input: { attestation: { ...clean, eval_kind: "vibes_audit" } },
      expected: { valid: false, reason: "unknown_eval_kind" },
    },
    {
      name: "empty-results",
      description: "An attestation that measured nothing is not an attestation.",
      input: { attestation: { ...clean, results: [] } },
      expected: { valid: false, reason: "empty_results" },
    },
    {
      name: "malformed-public-key",
      description: "Issuer key must be 32-byte lowercase-hex Ed25519.",
      input: {
        attestation: { ...clean, issuer: { ...clean.issuer, public_key: "not-hex" } },
      },
      expected: { valid: false, reason: "malformed_public_key" },
    },
    {
      name: "malformed-signature",
      description: "Signature must be base64url of 64 bytes.",
      input: { attestation: { ...clean, signature: "AAAA" } },
      expected: { valid: false, reason: "malformed_signature" },
    },
  ];

  // Non-circularity guard: the producer's own verifier must emit each case's
  // hand-coded expectation before the corpus is written.
  for (const c of cases) {
    const got = await verifyEvalAttestation(c.input.attestation as EvalAttestation);
    const want = c.expected;
    if (got.valid !== want.valid || got.reason !== want.reason) {
      throw new Error(
        `corpus invariant violated for case "${c.name}": expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
    }
  }

  const corpus = {
    schema: "motebit.eval-attestation-corpus.v1",
    description:
      "Cross-implementation conformance vectors for verifyEvalAttestation (motebit/eval-attestation@1.0). Each case: run the envelope law over input.attestation and assert the structured result deep-equals expected. The law establishes 'this issuer said these measurements about this subject' and deliberately NOT measurement truth, issuer authority, key→motebit_id binding, or expires_at/as_of freshness (carried, consumer-policied). subject == issuer is valid (self-issued floor). All artifacts minted from fixed test keys; deterministic and byte-stable. See ./README.md and spec/eval-attestation-v1.md.",
    cases,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(corpus, null, 2) + "\n");
  console.log(`gen-eval-attestation-corpus: wrote ${cases.length} case(s) → ${OUT}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
