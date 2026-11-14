#!/usr/bin/env tsx
/**
 * Generate the signed-revocation-evidence conformance corpus
 * (spec/standing-delegation-v1.md §5.2–§5.3, standing-delegation@1.3).
 * Deterministic fixed test keys (Ed25519 is deterministic, so the corpus is
 * byte-stable). Clean artifacts are minted by the real producers
 * (`signRevocationHead`, `signRevocationInclusionReceipt`); heads that break a
 * producer rule are forged by signing the raw body through suite dispatch.
 * Every expectation is asserted against the producer's own verifier BEFORE
 * the corpus is written.
 *
 * Four case families:
 *   - head        → expected verdict of `verifyRevocationHead`
 *   - receipt     → expected verdict of `verifyRevocationInclusionReceipt`
 *   - omission    → expected boolean of `detectRevocationOmission`
 *   - equivocation→ expected boolean of `detectRevocationEquivocation`
 *
 * Regenerate: npx tsx scripts/gen-delegation-revocation-head-corpus.ts
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
  signRevocationHead,
  verifyRevocationHead,
  computeRevocationRecordsDigest,
  signRevocationInclusionReceipt,
  verifyRevocationInclusionReceipt,
  detectRevocationOmission,
  detectRevocationEquivocation,
  type VerifyRevocationHeadExpectations,
} from "../packages/crypto/src/index.js";
import { getPublicKeyBySuite, signBySuite } from "../packages/crypto/src/suite-dispatch.js";
import type {
  DelegationRevocation,
  DelegationRevocationHead,
  DelegationRevocationHeadEntry,
  DelegationRevocationInclusionReceipt,
} from "../packages/protocol/src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "spec/conformance/delegation-revocation-head");
const OUT = join(OUT_DIR, "corpus.json");

const SUITE = "motebit-jcs-ed25519-b64-v1" as const;
// Fixed keys — deterministic, test-only, never reuse.
const RELAY_PRIV = new Uint8Array(32).fill(0x81);
const OTHER_RELAY_PRIV = new Uint8Array(32).fill(0x82);
const DELEGATOR_PRIV = new Uint8Array(32).fill(0x83);
const OTHER_DELEGATOR_PRIV = new Uint8Array(32).fill(0x84);

const NOW = 1_800_000_000_000;
const CHALLENGE = "conformance-challenge-0001";
const RELAY_ID = "019a0000-0000-7000-8000-00000000a0a1";
const DELEGATOR_ID = "019a0000-0000-7000-8000-00000000d0d1";
const OTHER_DELEGATOR_ID = "019a0000-0000-7000-8000-00000000d0d2";

interface Case {
  name: string;
  check: "head" | "receipt" | "omission" | "equivocation";
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
  const entries: DelegationRevocationHeadEntry[] = [
    { seq: 3, received_at: NOW - 4_900, record: revA },
    { seq: 7, received_at: NOW - 3_900, record: revB },
  ];

  const head = async (
    over: Partial<Parameters<typeof signRevocationHead>[0]> = {},
    priv = RELAY_PRIV,
  ): Promise<DelegationRevocationHead> =>
    signRevocationHead(
      {
        relay_id: RELAY_ID,
        relay_public_key: await pub(priv),
        delegator_id: DELEGATOR_ID,
        challenge: CHALLENGE,
        as_of: NOW,
        seq_high_water: 10,
        entries,
        ...over,
      },
      priv,
    );
  const forgedHead = async (
    mutate: (b: Record<string, unknown>) => void,
  ): Promise<DelegationRevocationHead> => {
    const { signature: _s, ...body } = await head();
    const b = body as Record<string, unknown>;
    const originalDigest = body.records_digest;
    mutate(b);
    // Each forged head breaks exactly one rule: re-commit the digest to the
    // mutated entries unless the mutation is the digest itself.
    if (b.records_digest === originalDigest) {
      b.records_digest = await computeRevocationRecordsDigest(
        b.entries as DelegationRevocationHeadEntry[],
      );
    }
    return forge<DelegationRevocationHead>(b);
  };
  const receipt = async (
    r: DelegationRevocation,
    seq: number,
    priv = RELAY_PRIV,
  ): Promise<DelegationRevocationInclusionReceipt> =>
    signRevocationInclusionReceipt(
      {
        relay_id: RELAY_ID,
        relay_public_key: await pub(priv),
        revocation: r,
        seq,
        received_at: NOW - 1_000,
      },
      priv,
    );

  const exp: VerifyRevocationHeadExpectations = {
    pinnedRelayPublicKey: relayPub,
    challenge: CHALLENGE,
    delegatorId: DELEGATOR_ID,
    now: NOW,
    lastSeenSeq: 0,
  };
  const invalid = (reason: string) => ({
    valid: false,
    refusal: "revocation_evidence_invalid",
    reason,
  });

  const cases: Case[] = [];
  const headCase = (
    name: string,
    description: string,
    h: DelegationRevocationHead,
    expected: unknown,
    expectations: VerifyRevocationHeadExpectations = exp,
  ): void => {
    cases.push({ name, check: "head", description, input: { head: h, expectations }, expected });
  };

  headCase("head-clean", "A head the pinned relay signed.", await head(), { valid: true });
  headCase(
    "head-empty",
    "No revocations for the delegator: positive absence evidence.",
    await head({ entries: [], seq_high_water: 0 }),
    { valid: true },
  );
  headCase(
    "head-wrong-key",
    "Signed by a relay key other than the pinned one.",
    await head({}, OTHER_RELAY_PRIV),
    invalid("public_key_mismatch"),
  );
  headCase(
    "head-bad-signature",
    "as_of changed after signing.",
    { ...(await head()), as_of: NOW - 1 },
    invalid("signature_invalid"),
  );
  headCase(
    "head-malformed-signature",
    "Signature is not 64 base64url bytes.",
    { ...(await head()), signature: "AAAA" },
    invalid("malformed_signature"),
  );
  headCase(
    "head-challenge-mismatch",
    "Answers another consumer's challenge.",
    await head({ challenge: "someone-elses-challenge" }),
    invalid("challenge_mismatch"),
  );
  headCase(
    "head-delegator-mismatch",
    "Covers another delegator.",
    await head({ delegator_id: OTHER_DELEGATOR_ID, entries: [] }),
    invalid("delegator_mismatch"),
  );
  headCase(
    "head-foreign-entry",
    "Carries an entry for another delegator (forged).",
    await forgedHead((b) => {
      b.entries = [...entries, { seq: 9, received_at: NOW - 2_000, record: revForeign }];
      b.count = 3;
    }),
    invalid("delegator_mismatch"),
  );
  headCase(
    "head-out-of-order",
    "Entries not strictly ascending by seq (forged).",
    await forgedHead((b) => {
      b.entries = [entries[1], entries[0]];
    }),
    invalid("entries_out_of_order"),
  );
  headCase(
    "head-seq-above-high-water",
    "An entry seq exceeds seq_high_water (forged).",
    await forgedHead((b) => {
      b.seq_high_water = 5;
    }),
    invalid("entry_seq_exceeds_high_water"),
  );
  headCase(
    "head-count-mismatch",
    "count disagrees with entries (forged).",
    await forgedHead((b) => {
      b.count = 1;
    }),
    invalid("count_mismatch"),
  );
  headCase(
    "head-digest-mismatch",
    "records_digest disagrees with entries (forged).",
    await forgedHead((b) => {
      b.records_digest = "0".repeat(64);
    }),
    invalid("records_digest_mismatch"),
  );
  headCase(
    "head-stale",
    "as_of older than window (60 s) plus skew (60 s).",
    await head({ as_of: NOW - 120_001 }),
    { valid: false, refusal: "revocation_evidence_stale", reason: "stale" },
  );
  headCase(
    "head-stale-boundary",
    "as_of exactly window plus skew old: accepted.",
    await head({ as_of: NOW - 120_000 }),
    { valid: true },
  );
  headCase(
    "head-future",
    "as_of more than skew (60 s) in the future.",
    await head({ as_of: NOW + 60_001 }),
    { valid: false, refusal: "revocation_evidence_stale", reason: "future_as_of" },
  );
  headCase(
    "head-rollback",
    "seq_high_water below one already accepted from this relay key.",
    await head(),
    { valid: false, refusal: "revocation_evidence_rollback", reason: "rollback" },
    { ...exp, lastSeenSeq: 11 },
  );
  headCase(
    "head-unsupported-spec",
    "A receipt's spec discriminator on a head body.",
    { ...(await head()), spec: "motebit/delegation-revocation-inclusion-receipt@1.0" as never },
    invalid("unsupported_spec"),
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

  const omission = (
    name: string,
    description: string,
    r: DelegationRevocationInclusionReceipt,
    h: DelegationRevocationHead,
    expected: boolean,
  ): void => {
    cases.push({ name, check: "omission", description, input: { receipt: r, head: h }, expected });
  };
  omission(
    "omission-detected",
    "Receipt at seq 9; a later head at high-water 10 lacks the record.",
    await receipt(revC, 9),
    await head(),
    true,
  );
  omission(
    "omission-wrong-seq",
    "Head carries the record, but at a seq other than receipted.",
    await receipt(revB, 8),
    await head(),
    true,
  );
  omission(
    "omission-carried",
    "Head carries the receipted record.",
    await receipt(revB, 7),
    await head(),
    false,
  );
  omission(
    "omission-not-covered",
    "Head high-water below the receipted seq.",
    await receipt(revC, 11),
    await head(),
    false,
  );
  omission(
    "omission-other-relay",
    "Receipt and head signed by different relay keys.",
    await receipt(revC, 9, OTHER_RELAY_PRIV),
    await head(),
    false,
  );
  omission(
    "omission-forged-receipt",
    "Receipt signature does not verify.",
    { ...(await receipt(revC, 9)), received_at: 1 },
    await head(),
    false,
  );

  const equivocation = (
    name: string,
    description: string,
    a: DelegationRevocationHead,
    b: DelegationRevocationHead,
    expected: boolean,
  ): void => {
    cases.push({
      name,
      check: "equivocation",
      description,
      input: { headA: a, headB: b },
      expected,
    });
  };
  equivocation(
    "equivocation-detected",
    "Same key, delegator and high-water; different records_digest.",
    await head(),
    await head({ entries: [entries[0]!], challenge: "other-consumer" }),
    true,
  );
  equivocation(
    "equivocation-same-entries",
    "Same entries under different challenge and as_of: same digest.",
    await head(),
    await head({ challenge: "other-consumer", as_of: NOW + 5 }),
    false,
  );
  equivocation(
    "equivocation-different-high-water",
    "Different seq_high_water.",
    await head(),
    await head({ entries: [entries[0]!], seq_high_water: 4 }),
    false,
  );
  equivocation(
    "equivocation-forged",
    "One head's signature does not verify.",
    await head(),
    { ...(await head({ entries: [entries[0]!] })), as_of: 1 },
    false,
  );

  // Assert every expectation against the producer's own law before writing.
  for (const c of cases) {
    let got: unknown;
    if (c.check === "head") {
      got = await verifyRevocationHead(
        c.input.head as DelegationRevocationHead,
        c.input.expectations as VerifyRevocationHeadExpectations,
      );
    } else if (c.check === "receipt") {
      got = await verifyRevocationInclusionReceipt(
        c.input.receipt as DelegationRevocationInclusionReceipt,
        c.input.expectations as { pinnedRelayPublicKey: string; revocation: DelegationRevocation },
      );
    } else if (c.check === "omission") {
      got = await detectRevocationOmission(
        c.input.receipt as DelegationRevocationInclusionReceipt,
        c.input.head as DelegationRevocationHead,
      );
    } else {
      got = await detectRevocationEquivocation(
        c.input.headA as DelegationRevocationHead,
        c.input.headB as DelegationRevocationHead,
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
    schema: "motebit.delegation-revocation-head-corpus.v1",
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
