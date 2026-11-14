#!/usr/bin/env tsx
/**
 * Generate the signed-revocation-evidence conformance corpus
 * (spec/standing-delegation-v1.md §5.2–§5.3, standing-delegation@1.3).
 * Deterministic fixed test keys (Ed25519 is deterministic, so the corpus is
 * byte-stable). Clean artifacts are minted by the real producers
 * (`signRevocationSetAttestation`, `signRevocationInclusionReceipt`); attestations that break a
 * producer rule are forged by signing the raw body through suite dispatch.
 * Every expectation is asserted against the producer's own verifier BEFORE
 * the corpus is written.
 *
 * Four case families:
 *   - attestation → expected verdict of `verifyRevocationSetAttestation`
 *   - receipt     → expected verdict of `verifyRevocationInclusionReceipt`
 *   - omission    → expected boolean of `verifyRevocationOmissionProof`
 *   - equivocation→ expected boolean of `verifyRevocationEquivocationProof`
 *
 * Regenerate: npx tsx scripts/gen-delegation-revocation-set-attestation-corpus.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  bytesToHex,
  canonicalJsonForSigning,
  toBase64Url,
  signDelegationRevocation,
  signRevocationSetAttestation,
  verifyRevocationSetAttestation,
  computeRevocationRecordsDigest,
  signRevocationInclusionReceipt,
  verifyRevocationInclusionReceipt,
  verifyRevocationOmissionProof,
  verifyRevocationEquivocationProof,
  type VerifyRevocationSetAttestationExpectations,
} from "../packages/crypto/src/index.js";
import { getPublicKeyBySuite, signBySuite } from "../packages/crypto/src/suite-dispatch.js";
import type {
  DelegationRevocation,
  DelegationRevocationSetAttestation,
  DelegationRevocationSetAttestationEntry,
  DelegationRevocationInclusionReceipt,
} from "../packages/protocol/src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "spec/conformance/delegation-revocation-set-attestation");
const OUT = join(OUT_DIR, "corpus.json");

const SUITE = "motebit-jcs-ed25519-b64-v1" as const;
// Fixed keys — deterministic, test-only, never reuse.
const RELAY_PRIV = new Uint8Array(32).fill(0x81);
const OTHER_RELAY_PRIV = new Uint8Array(32).fill(0x82);
const DELEGATOR_PRIV = new Uint8Array(32).fill(0x83);
const OTHER_DELEGATOR_PRIV = new Uint8Array(32).fill(0x84);

const NOW = 1_800_000_000_000;
// 32 bytes as hex — the spec's recommended challenge shape (fixed for byte-stability).
const CHALLENGE = "c0ffee00000000000000000000000000000000000000000000000000000000c1";
const OTHER_CHALLENGE = "c0ffee00000000000000000000000000000000000000000000000000000000c2";
const RELAY_ID = "019a0000-0000-7000-8000-00000000a0a1";
const DELEGATOR_ID = "019a0000-0000-7000-8000-00000000d0d1";
const OTHER_DELEGATOR_ID = "019a0000-0000-7000-8000-00000000d0d2";

interface Case {
  name: string;
  check: "attestation" | "receipt" | "omission" | "equivocation";
  description: string;
  input: Record<string, unknown>;
  expected: unknown;
}

async function pub(priv: Uint8Array): Promise<string> {
  return bytesToHex(await getPublicKeyBySuite(priv, SUITE));
}

async function forge<T>(body: Record<string, unknown>, priv = RELAY_PRIV): Promise<T> {
  const sig = await signBySuite(
    SUITE,
    new TextEncoder().encode(canonicalJsonForSigning(body)),
    priv,
  );
  return { ...body, signature: toBase64Url(sig) } as T;
}

async function main(): Promise<void> {
  const relayPub = await pub(RELAY_PRIV);
  const delegatorPub = await pub(DELEGATOR_PRIV);

  const rev = (grant: string, revokedAt: number): Promise<DelegationRevocation> =>
    signDelegationRevocation(
      {
        grant_id: grant,
        delegator_id: DELEGATOR_ID,
        delegator_public_key: delegatorPub,
        revoked_at: revokedAt,
      },
      DELEGATOR_PRIV,
    );
  const revA = await rev("019a0000-0000-7000-8000-0000000000c1", NOW - 5_000);
  const revB = await rev("019a0000-0000-7000-8000-0000000000c2", NOW - 4_000);
  const revC = await rev("019a0000-0000-7000-8000-0000000000c3", NOW - 3_000);
  const revForeign = await signDelegationRevocation(
    {
      grant_id: "019a0000-0000-7000-8000-0000000000c9",
      delegator_id: OTHER_DELEGATOR_ID,
      delegator_public_key: await pub(OTHER_DELEGATOR_PRIV),
      revoked_at: NOW - 2_000,
    },
    OTHER_DELEGATOR_PRIV,
  );
  const entries: DelegationRevocationSetAttestationEntry[] = [
    { seq: 3, received_at: NOW - 4_900, record: revA },
    { seq: 7, received_at: NOW - 3_900, record: revB },
  ];

  const attest = async (
    over: Partial<Parameters<typeof signRevocationSetAttestation>[0]> = {},
    priv = RELAY_PRIV,
  ): Promise<DelegationRevocationSetAttestation> =>
    signRevocationSetAttestation(
      {
        relay_motebit_id: RELAY_ID,
        relay_public_key: await pub(priv),
        delegator_motebit_id: DELEGATOR_ID,
        challenge: CHALLENGE,
        as_of: NOW,
        seq_high_water: 10,
        entries,
        ...over,
      },
      priv,
    );
  const forgedAttestation = async (
    mutate: (b: Record<string, unknown>) => void,
  ): Promise<DelegationRevocationSetAttestation> => {
    const { signature: _s, ...body } = await attest();
    const b = body as Record<string, unknown>;
    const originalDigest = body.records_digest;
    mutate(b);
    // Each forged attestation breaks exactly one rule: re-commit the digest to the
    // mutated entries unless the mutation is the digest itself.
    if (b.records_digest === originalDigest) {
      b.records_digest = await computeRevocationRecordsDigest(
        b.entries as DelegationRevocationSetAttestationEntry[],
      );
    }
    return forge<DelegationRevocationSetAttestation>(b);
  };
  const receipt = async (
    r: DelegationRevocation,
    seq: number,
    priv = RELAY_PRIV,
  ): Promise<DelegationRevocationInclusionReceipt> =>
    signRevocationInclusionReceipt(
      {
        relay_motebit_id: RELAY_ID,
        relay_public_key: await pub(priv),
        revocation: r,
        seq,
        received_at: NOW - 1_000,
      },
      priv,
    );

  const exp: VerifyRevocationSetAttestationExpectations = {
    pinnedRelayPublicKey: relayPub,
    challenge: CHALLENGE,
    delegatorMotebitId: DELEGATOR_ID,
    now: NOW,
    lastSeenSeq: 0,
  };
  const invalid = (reason: string) => ({
    valid: false,
    refusal: "revocation_evidence_invalid",
    reason,
  });

  const cases: Case[] = [];
  const attestationCase = (
    name: string,
    description: string,
    h: DelegationRevocationSetAttestation,
    expected: unknown,
    expectations: VerifyRevocationSetAttestationExpectations = exp,
  ): void => {
    cases.push({
      name,
      check: "attestation",
      description,
      input: { attestation: h, expectations },
      expected,
    });
  };

  attestationCase("attestation-clean", "An attestation the pinned relay signed.", await attest(), {
    valid: true,
  });
  attestationCase(
    "attestation-empty",
    "No revocations for the delegator: positive absence evidence.",
    await attest({ entries: [], seq_high_water: 0 }),
    { valid: true },
  );
  attestationCase(
    "attestation-wrong-key",
    "Signed by a relay key other than the pinned one.",
    await attest({}, OTHER_RELAY_PRIV),
    invalid("public_key_mismatch"),
  );
  attestationCase(
    "attestation-bad-signature",
    "as_of changed after signing.",
    { ...(await attest()), as_of: NOW - 1 },
    invalid("signature_invalid"),
  );
  attestationCase(
    "attestation-malformed-signature",
    "Signature is not 64 base64url bytes.",
    { ...(await attest()), signature: "AAAA" },
    invalid("malformed_signature"),
  );
  attestationCase(
    "attestation-challenge-mismatch",
    "Answers another consumer's challenge.",
    await attest({ challenge: OTHER_CHALLENGE }),
    invalid("challenge_mismatch"),
  );
  attestationCase(
    "attestation-delegator-mismatch",
    "Covers another delegator.",
    await attest({ delegator_motebit_id: OTHER_DELEGATOR_ID, entries: [] }),
    invalid("delegator_mismatch"),
  );
  attestationCase(
    "attestation-foreign-entry",
    "Carries an entry for another delegator (forged).",
    await forgedAttestation((b) => {
      b.entries = [...entries, { seq: 9, received_at: NOW - 2_000, record: revForeign }];
      b.count = 3;
    }),
    invalid("delegator_mismatch"),
  );
  attestationCase(
    "attestation-out-of-order",
    "Entries not strictly ascending by seq (forged).",
    await forgedAttestation((b) => {
      b.entries = [entries[1], entries[0]];
    }),
    invalid("entries_out_of_order"),
  );
  attestationCase(
    "attestation-seq-above-high-water",
    "An entry seq exceeds seq_high_water (forged).",
    await forgedAttestation((b) => {
      b.seq_high_water = 5;
    }),
    invalid("entry_seq_exceeds_high_water"),
  );
  attestationCase(
    "attestation-count-mismatch",
    "count disagrees with entries (forged).",
    await forgedAttestation((b) => {
      b.count = 1;
    }),
    invalid("count_mismatch"),
  );
  attestationCase(
    "attestation-digest-mismatch",
    "records_digest disagrees with entries (forged).",
    await forgedAttestation((b) => {
      b.records_digest = "0".repeat(64);
    }),
    invalid("records_digest_mismatch"),
  );
  attestationCase(
    "attestation-stale",
    "as_of older than window (60 s) plus skew (60 s).",
    await attest({ as_of: NOW - 120_001 }),
    { valid: false, refusal: "revocation_evidence_stale", reason: "stale" },
  );
  attestationCase(
    "attestation-stale-boundary",
    "as_of exactly window plus skew old: accepted.",
    await attest({ as_of: NOW - 120_000 }),
    { valid: true },
  );
  attestationCase(
    "attestation-future",
    "as_of more than skew (60 s) in the future.",
    await attest({ as_of: NOW + 60_001 }),
    { valid: false, refusal: "revocation_evidence_stale", reason: "future_as_of" },
  );
  attestationCase(
    "attestation-rollback",
    "seq_high_water below one already accepted from this relay key.",
    await attest(),
    { valid: false, refusal: "revocation_evidence_rollback", reason: "rollback" },
    { ...exp, lastSeenSeq: 11 },
  );
  attestationCase(
    "attestation-unsupported-spec",
    "A receipt's spec discriminator on an attestation body.",
    { ...(await attest()), spec: "motebit/delegation-revocation-inclusion-receipt@1.0" as never },
    invalid("unsupported_spec"),
  );
  attestationCase(
    "attestation-weak-challenge",
    "The consumer's own challenge is shorter than 32 characters (under 128 bits).",
    await attest(),
    invalid("weak_challenge"),
    { ...exp, challenge: "nonce-1" },
  );
  attestationCase(
    "attestation-unknown-field",
    "An unknown top-level field (the wire schema is strict), validly signed.",
    await forgedAttestation((b) => {
      b.surprise = 1;
    }),
    invalid("malformed_attestation"),
  );
  attestationCase(
    "attestation-entry-unknown-field",
    "An entry with an unknown field, validly signed (forged).",
    await forgedAttestation((b) => {
      b.entries = [{ ...entries[0], extra: true }, entries[1]];
    }),
    invalid("malformed_attestation"),
  );

  const receiptCase = (
    name: string,
    description: string,
    r: DelegationRevocationInclusionReceipt,
    submitted: DelegationRevocation,
    expected: unknown,
  ): void => {
    cases.push({
      name,
      check: "receipt",
      description,
      input: {
        receipt: r,
        expectations: { pinnedRelayPublicKey: relayPub, revocation: submitted },
      },
      expected,
    });
  };
  receiptCase(
    "receipt-clean",
    "The pinned relay receipted the submitted revocation.",
    await receipt(revA, 3),
    revA,
    {
      valid: true,
    },
  );
  receiptCase(
    "receipt-wrong-key",
    "Receipted by another relay key.",
    await receipt(revA, 3, OTHER_RELAY_PRIV),
    revA,
    { valid: false, reason: "public_key_mismatch" },
  );
  receiptCase(
    "receipt-bad-signature",
    "seq changed after signing.",
    { ...(await receipt(revA, 3)), seq: 4 },
    revA,
    { valid: false, reason: "signature_invalid" },
  );
  receiptCase(
    "receipt-other-revocation",
    "Names a revocation other than the one submitted.",
    await receipt(revA, 3),
    revB,
    { valid: false, reason: "revocation_mismatch" },
  );
  receiptCase(
    "receipt-unsupported-suite",
    "A suite other than the pinned one.",
    { ...(await receipt(revA, 3)), suite: "motebit-jcs-ed25519-hex-v1" as never },
    revA,
    { valid: false, reason: "unsupported_suite" },
  );

  const omission = (
    name: string,
    description: string,
    r: DelegationRevocationInclusionReceipt,
    h: DelegationRevocationSetAttestation,
    expected: unknown,
  ): void => {
    cases.push({
      name,
      check: "omission",
      description,
      input: { receipt: r, attestation: h },
      expected,
    });
  };
  omission(
    "omission-detected",
    "Receipt at seq 9; a later attestation at high-water 10 lacks the record.",
    await receipt(revC, 9),
    await attest(),
    { valid: true },
  );
  omission(
    "omission-wrong-seq",
    "The attestation carries the record, but at a seq other than receipted.",
    await receipt(revB, 8),
    await attest(),
    { valid: true },
  );
  omission(
    "omission-carried",
    "The attestation carries the receipted record.",
    await receipt(revB, 7),
    await attest(),
    { valid: false, reason: "record_carried" },
  );
  omission(
    "omission-not-covered",
    "Attestation high-water below the receipted seq.",
    await receipt(revC, 11),
    await attest(),
    { valid: false, reason: "seq_not_covered" },
  );
  omission(
    "omission-other-relay",
    "Receipt and attestation signed by different relay keys.",
    await receipt(revC, 9, OTHER_RELAY_PRIV),
    await attest(),
    { valid: false, reason: "relay_key_mismatch" },
  );
  omission(
    "omission-forged-receipt",
    "Receipt signature does not verify.",
    { ...(await receipt(revC, 9)), received_at: 1 },
    await attest(),
    { valid: false, reason: "signature_invalid" },
  );

  const equivocation = (
    name: string,
    description: string,
    a: DelegationRevocationSetAttestation,
    b: DelegationRevocationSetAttestation,
    expected: unknown,
  ): void => {
    cases.push({
      name,
      check: "equivocation",
      description,
      input: { attestationA: a, attestationB: b },
      expected,
    });
  };
  equivocation(
    "equivocation-detected",
    "Same key, delegator and high-water; different records_digest.",
    await attest(),
    await attest({ entries: [entries[0]!], challenge: OTHER_CHALLENGE }),
    { valid: true },
  );
  equivocation(
    "equivocation-same-entries",
    "Same entries under different challenge and as_of: same digest.",
    await attest(),
    await attest({ challenge: OTHER_CHALLENGE, as_of: NOW + 5 }),
    { valid: false, reason: "same_records_digest" },
  );
  equivocation(
    "equivocation-different-high-water",
    "Different seq_high_water.",
    await attest(),
    await attest({ entries: [entries[0]!], seq_high_water: 4 }),
    { valid: false, reason: "seq_high_water_differs" },
  );
  equivocation(
    "equivocation-forged",
    "One attestation's signature does not verify.",
    await attest(),
    { ...(await attest({ entries: [entries[0]!] })), as_of: 1 },
    { valid: false, reason: "signature_invalid" },
  );

  // Assert every expectation against the producer's own law before writing.
  for (const c of cases) {
    let got: unknown;
    if (c.check === "attestation") {
      got = await verifyRevocationSetAttestation(
        c.input.attestation as DelegationRevocationSetAttestation,
        c.input.expectations as VerifyRevocationSetAttestationExpectations,
      );
    } else if (c.check === "receipt") {
      got = await verifyRevocationInclusionReceipt(
        c.input.receipt as DelegationRevocationInclusionReceipt,
        c.input.expectations as { pinnedRelayPublicKey: string; revocation: DelegationRevocation },
      );
    } else if (c.check === "omission") {
      got = await verifyRevocationOmissionProof(
        c.input.receipt as DelegationRevocationInclusionReceipt,
        c.input.attestation as DelegationRevocationSetAttestation,
      );
    } else {
      got = await verifyRevocationEquivocationProof(
        c.input.attestationA as DelegationRevocationSetAttestation,
        c.input.attestationB as DelegationRevocationSetAttestation,
      );
    }
    if (!isDeepStrictEqual(got, c.expected)) {
      throw new Error(
        `case ${c.name}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(got)}`,
      );
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const corpus = {
    schema: "motebit.delegation-revocation-set-attestation-corpus.v1",
    spec: "standing-delegation@1.3 §5.2–§5.3",
    cases,
  };
  writeFileSync(OUT, JSON.stringify(corpus, null, 2) + "\n");
  process.stdout.write(`wrote ${cases.length} cases to ${OUT}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
