/**
 * Signed revocation evidence (spec/standing-delegation-v1.md §5.2–§5.3):
 * `verifyRevocationSetAttestation`, `verifyRevocationInclusionReceipt`,
 * `verifyRevocationOmissionProof`, `verifyRevocationEquivocationProof`.
 *
 * Every refusal code has a test. Attestations that violate the producer rules
 * (out-of-order, count, digest, foreign delegator) are FORGED here by signing
 * a raw body through suite dispatch — `signRevocationSetAttestation` itself refuses to
 * emit them — so each verifier check is exercised on an otherwise validly
 * signed attestation. Tamper file: scripts/tampers/revocation-evidence.ts.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type {
  DelegationRevocation,
  DelegationRevocationSetAttestation,
  DelegationRevocationSetAttestationEntry,
  DelegationRevocationInclusionReceipt,
} from "@motebit/protocol";
import {
  signRevocationSetAttestation,
  verifyRevocationSetAttestation,
  signRevocationInclusionReceipt,
  verifyRevocationInclusionReceipt,
  computeRevocationRecordsDigest,
  verifyRevocationOmissionProof,
  verifyRevocationEquivocationProof,
  type VerifyRevocationSetAttestationExpectations,
} from "../delegation-revocation-set-attestation.js";
import { signDelegationRevocation } from "../artifacts.js";
import { bytesToHex, canonicalJsonForSigning, toBase64Url } from "../signing.js";
import { getPublicKeyBySuite, signBySuite } from "../suite-dispatch.js";

const SUITE = "motebit-jcs-ed25519-b64-v1" as const;
// Ephemeral, test-only keys. Never reuse.
const RELAY_PRIV = new Uint8Array(32).fill(0x71);
const OTHER_RELAY_PRIV = new Uint8Array(32).fill(0x72);
const DELEGATOR_PRIV = new Uint8Array(32).fill(0x73);
const OTHER_DELEGATOR_PRIV = new Uint8Array(32).fill(0x74);

const NOW = 1_800_000_000_000;
const CHALLENGE = "c2f1e0d9-challenge-0001";
const DELEGATOR_ID = "019a0000-0000-7000-8000-00000000d001";
const OTHER_DELEGATOR_ID = "019a0000-0000-7000-8000-00000000d002";
const RELAY_ID = "019a0000-0000-7000-8000-00000000a001";

let relayPub: string;
let otherRelayPub: string;
let delegatorPub: string;
let otherDelegatorPub: string;
let revA: DelegationRevocation;
let revB: DelegationRevocation;
let revForeign: DelegationRevocation;
let entries: DelegationRevocationSetAttestationEntry[];

async function pub(priv: Uint8Array): Promise<string> {
  return bytesToHex(await getPublicKeyBySuite(priv, SUITE));
}

/** Sign an arbitrary body as the relay — bypasses the producer's own refusals. */
async function forge<T extends { signature?: unknown }>(
  body: Omit<T, "signature">,
  priv: Uint8Array = RELAY_PRIV,
): Promise<T> {
  const msg = new TextEncoder().encode(canonicalJsonForSigning(body));
  const sig = await signBySuite(SUITE, msg, priv);
  return { ...body, signature: toBase64Url(sig) } as T;
}

async function attest(
  overrides: Partial<Parameters<typeof signRevocationSetAttestation>[0]> = {},
  priv: Uint8Array = RELAY_PRIV,
): Promise<DelegationRevocationSetAttestation> {
  return signRevocationSetAttestation(
    {
      relay_motebit_id: RELAY_ID,
      relay_public_key: priv === RELAY_PRIV ? relayPub : await pub(priv),
      delegator_motebit_id: DELEGATOR_ID,
      challenge: CHALLENGE,
      as_of: NOW,
      seq_high_water: 10,
      entries,
      ...overrides,
    },
    priv,
  );
}

/**
 * A validly signed attestation body with `mutate` applied BEFORE signing. The
 * records digest is recomputed over the mutated entries (unless the mutation
 * set it, or `keepDigest`), so each forged attestation breaks exactly one rule.
 */
async function forgedAttestation(
  mutate: (b: Omit<DelegationRevocationSetAttestation, "signature">) => void,
  keepDigest = false,
): Promise<DelegationRevocationSetAttestation> {
  const { signature: _s, ...body } = await attest();
  const original = body.records_digest;
  mutate(body);
  if (!keepDigest && body.records_digest === original) {
    body.records_digest = await computeRevocationRecordsDigest(body.entries);
  }
  return forge<DelegationRevocationSetAttestation>(body);
}

function expectations(
  over: Partial<VerifyRevocationSetAttestationExpectations> = {},
): VerifyRevocationSetAttestationExpectations {
  return {
    pinnedRelayPublicKey: relayPub,
    challenge: CHALLENGE,
    delegatorMotebitId: DELEGATOR_ID,
    now: NOW,
    lastSeenSeq: 0,
    ...over,
  };
}

beforeAll(async () => {
  relayPub = await pub(RELAY_PRIV);
  otherRelayPub = await pub(OTHER_RELAY_PRIV);
  delegatorPub = await pub(DELEGATOR_PRIV);
  otherDelegatorPub = await pub(OTHER_DELEGATOR_PRIV);
  revA = await signDelegationRevocation(
    {
      grant_id: "019a0000-0000-7000-8000-0000000000g1",
      delegator_id: DELEGATOR_ID,
      delegator_public_key: delegatorPub,
      revoked_at: NOW - 5_000,
    },
    DELEGATOR_PRIV,
  );
  revB = await signDelegationRevocation(
    {
      grant_id: "019a0000-0000-7000-8000-0000000000g2",
      delegator_id: DELEGATOR_ID,
      delegator_public_key: delegatorPub,
      revoked_at: NOW - 4_000,
    },
    DELEGATOR_PRIV,
  );
  revForeign = await signDelegationRevocation(
    {
      grant_id: "019a0000-0000-7000-8000-0000000000g3",
      delegator_id: OTHER_DELEGATOR_ID,
      delegator_public_key: otherDelegatorPub,
      revoked_at: NOW - 3_000,
    },
    OTHER_DELEGATOR_PRIV,
  );
  entries = [
    { seq: 3, received_at: NOW - 4_900, record: revA },
    { seq: 7, received_at: NOW - 3_900, record: revB },
  ];
});

describe("verifyRevocationSetAttestation", () => {
  it("accepts an attestation the pinned relay signed (happy path round-trip)", async () => {
    const h = await attest();
    expect(h.count).toBe(2);
    expect(h.records_digest).toBe(await computeRevocationRecordsDigest(entries));
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({ valid: true });
  });

  it("accepts an empty attestation (positive absence evidence)", async () => {
    const h = await attest({ entries: [], seq_high_water: 0 });
    expect(h.count).toBe(0);
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({ valid: true });
  });

  it("refuses an attestation signed by a key other than the pinned one (wrong key)", async () => {
    const h = await attest({}, OTHER_RELAY_PRIV);
    expect(h.relay_public_key).toBe(otherRelayPub);
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({
      valid: false,
      refusal: "revocation_evidence_invalid",
      reason: "public_key_mismatch",
    });
  });

  it("refuses an attestation whose signature does not verify (bad signature)", async () => {
    const h = { ...(await attest()), as_of: NOW - 1 };
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({
      valid: false,
      refusal: "revocation_evidence_invalid",
      reason: "signature_invalid",
    });
  });

  it("refuses an attestation carrying the pinned key but signed by another key", async () => {
    const { signature: _s, ...body } = await attest();
    const h = await forge<DelegationRevocationSetAttestation>(body, OTHER_RELAY_PRIV);
    expect((await verifyRevocationSetAttestation(h, expectations())).valid).toBe(false);
    expect(await verifyRevocationSetAttestation(h, expectations())).toMatchObject({
      reason: "signature_invalid",
    });
  });

  it("refuses a malformed signature", async () => {
    const h = { ...(await attest()), signature: "AAAA" };
    expect(await verifyRevocationSetAttestation(h, expectations())).toMatchObject({
      refusal: "revocation_evidence_invalid",
      reason: "malformed_signature",
    });
  });

  it("refuses an attestation answering another challenge (challenge mismatch)", async () => {
    const h = await attest({ challenge: "someone-elses-challenge" });
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({
      valid: false,
      refusal: "revocation_evidence_invalid",
      reason: "challenge_mismatch",
    });
  });

  it("refuses an attestation for another delegator (delegator mismatch)", async () => {
    const h = await attest({ delegator_motebit_id: OTHER_DELEGATOR_ID, entries: [] });
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({
      valid: false,
      refusal: "revocation_evidence_invalid",
      reason: "delegator_mismatch",
    });
  });

  it("refuses an attestation carrying an entry for another delegator", async () => {
    const h = await forgedAttestation((b) => {
      b.entries = [...entries, { seq: 9, received_at: NOW - 2_000, record: revForeign }];
      b.count = 3;
    });
    expect(await verifyRevocationSetAttestation(h, expectations())).toMatchObject({
      refusal: "revocation_evidence_invalid",
      reason: "delegator_mismatch",
    });
  });

  it("refuses out-of-order entries", async () => {
    const h = await forgedAttestation((b) => {
      b.entries = [entries[1]!, entries[0]!];
    });
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({
      valid: false,
      refusal: "revocation_evidence_invalid",
      reason: "entries_out_of_order",
    });
  });

  it("refuses duplicate seqs (not strictly ascending)", async () => {
    const h = await forgedAttestation((b) => {
      b.entries = [entries[0]!, { ...entries[1]!, seq: 3 }];
    });
    expect(await verifyRevocationSetAttestation(h, expectations())).toMatchObject({
      reason: "entries_out_of_order",
    });
  });

  it("refuses an entry seq above seq_high_water", async () => {
    const h = await forgedAttestation((b) => {
      b.seq_high_water = 5;
    });
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({
      valid: false,
      refusal: "revocation_evidence_invalid",
      reason: "entry_seq_exceeds_high_water",
    });
  });

  it("refuses a count that disagrees with the entries", async () => {
    const h = await forgedAttestation((b) => {
      b.count = 1;
    });
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({
      valid: false,
      refusal: "revocation_evidence_invalid",
      reason: "count_mismatch",
    });
  });

  it("refuses a records_digest that disagrees with the entries", async () => {
    const h = await forgedAttestation((b) => {
      b.records_digest = "0".repeat(64);
    });
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({
      valid: false,
      refusal: "revocation_evidence_invalid",
      reason: "records_digest_mismatch",
    });
  });

  it("refuses an entry dropped under the original digest and count", async () => {
    const h = await forgedAttestation((b) => {
      b.entries = [entries[0]!];
      b.count = 1;
    }, true);
    expect(await verifyRevocationSetAttestation(h, expectations())).toMatchObject({
      reason: "records_digest_mismatch",
    });
  });

  it("refuses a stale attestation (older than window plus skew)", async () => {
    const h = await attest({ as_of: NOW - 120_001 });
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({
      valid: false,
      refusal: "revocation_evidence_stale",
      reason: "stale",
    });
  });

  it("accepts an attestation exactly at window plus skew", async () => {
    const h = await attest({ as_of: NOW - 120_000 });
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({ valid: true });
  });

  it("honours a tighter freshness window override", async () => {
    const h = await attest({ as_of: NOW - 30_000 });
    expect(
      await verifyRevocationSetAttestation(
        h,
        expectations({ maxAgeMs: 10_000, clockSkewMs: 10_000 }),
      ),
    ).toMatchObject({ refusal: "revocation_evidence_stale", reason: "stale" });
  });

  it("refuses an attestation dated in the future beyond skew", async () => {
    const h = await attest({ as_of: NOW + 60_001 });
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({
      valid: false,
      refusal: "revocation_evidence_stale",
      reason: "future_as_of",
    });
  });

  it("accepts an attestation dated in the future within skew", async () => {
    const h = await attest({ as_of: NOW + 60_000 });
    expect(await verifyRevocationSetAttestation(h, expectations())).toEqual({ valid: true });
  });

  it("refuses a rollback below the last accepted seq_high_water", async () => {
    const h = await attest();
    expect(await verifyRevocationSetAttestation(h, expectations({ lastSeenSeq: 11 }))).toEqual({
      valid: false,
      refusal: "revocation_evidence_rollback",
      reason: "rollback",
    });
  });

  it("accepts seq_high_water equal to the last accepted one", async () => {
    const h = await attest();
    expect(await verifyRevocationSetAttestation(h, expectations({ lastSeenSeq: 10 }))).toEqual({
      valid: true,
    });
  });

  it("refuses when any required expectation is missing", async () => {
    const h = await attest();
    for (const key of [
      "pinnedRelayPublicKey",
      "challenge",
      "delegatorMotebitId",
      "now",
      "lastSeenSeq",
    ] as const) {
      const exp = { ...expectations() } as Record<string, unknown>;
      delete exp[key];
      expect(
        await verifyRevocationSetAttestation(
          h,
          exp as unknown as VerifyRevocationSetAttestationExpectations,
        ),
      ).toMatchObject({ refusal: "revocation_evidence_invalid", reason: "missing_expectation" });
    }
  });

  it("refuses an unknown suite or spec", async () => {
    const h = await attest();
    expect(
      await verifyRevocationSetAttestation(
        { ...h, suite: "motebit-jcs-ed25519-hex-v1" as never },
        expectations(),
      ),
    ).toMatchObject({ reason: "unsupported_suite" });
    expect(
      await verifyRevocationSetAttestation(
        { ...h, spec: "motebit/other@1.0" as never },
        expectations(),
      ),
    ).toMatchObject({ reason: "unsupported_spec" });
  });

  it("refuses a malformed attestation shape", async () => {
    const h = await attest();
    expect(
      await verifyRevocationSetAttestation({ ...h, entries: "nope" as never }, expectations()),
    ).toMatchObject({ reason: "malformed_attestation" });
    expect(
      await verifyRevocationSetAttestation({ ...h, relay_public_key: "ABC" }, expectations()),
    ).toMatchObject({ reason: "malformed_public_key" });
  });

  it("checks the signature before the challenge (verification order)", async () => {
    const h = { ...(await attest()), challenge: "tampered" };
    expect(await verifyRevocationSetAttestation(h, expectations())).toMatchObject({
      reason: "signature_invalid",
    });
  });
});

describe("signRevocationSetAttestation (producer refusals)", () => {
  it("refuses out-of-order entries, a seq above high-water, and a foreign delegator", async () => {
    await expect(attest({ entries: [entries[1]!, entries[0]!] })).rejects.toThrow(/ascending/);
    await expect(attest({ seq_high_water: 5 })).rejects.toThrow(/ascending/);
    await expect(
      attest({ entries: [{ seq: 1, received_at: NOW, record: revForeign }] }),
    ).rejects.toThrow(/delegator/);
  });
});

describe("verifyRevocationInclusionReceipt", () => {
  async function receipt(
    over: Partial<Parameters<typeof signRevocationInclusionReceipt>[0]> = {},
    priv: Uint8Array = RELAY_PRIV,
  ): Promise<DelegationRevocationInclusionReceipt> {
    return signRevocationInclusionReceipt(
      {
        relay_motebit_id: RELAY_ID,
        relay_public_key: priv === RELAY_PRIV ? relayPub : await pub(priv),
        revocation: revA,
        seq: 3,
        received_at: NOW - 4_900,
        ...over,
      },
      priv,
    );
  }

  it("accepts a receipt the pinned relay signed for the submitted revocation", async () => {
    const r = await receipt();
    expect(r.revocation_signature).toBe(revA.signature);
    expect(
      await verifyRevocationInclusionReceipt(r, {
        pinnedRelayPublicKey: relayPub,
        revocation: revA,
      }),
    ).toEqual({ valid: true });
  });

  it("refuses a receipt signed by another relay key", async () => {
    const r = await receipt({}, OTHER_RELAY_PRIV);
    expect(
      await verifyRevocationInclusionReceipt(r, {
        pinnedRelayPublicKey: relayPub,
        revocation: revA,
      }),
    ).toEqual({ valid: false, reason: "public_key_mismatch" });
  });

  it("refuses a receipt whose signature does not verify", async () => {
    const r = { ...(await receipt()), seq: 4 };
    expect(
      await verifyRevocationInclusionReceipt(r, {
        pinnedRelayPublicKey: relayPub,
        revocation: revA,
      }),
    ).toEqual({ valid: false, reason: "signature_invalid" });
  });

  it("refuses a receipt naming a different revocation", async () => {
    const r = await receipt();
    expect(
      await verifyRevocationInclusionReceipt(r, {
        pinnedRelayPublicKey: relayPub,
        revocation: revB,
      }),
    ).toEqual({ valid: false, reason: "revocation_mismatch" });
  });

  it("refuses a receipt naming another revocation of the same grant", async () => {
    const r = await receipt();
    const sameGrant = await signDelegationRevocation(
      {
        grant_id: revA.grant_id,
        delegator_id: DELEGATOR_ID,
        delegator_public_key: delegatorPub,
        revoked_at: NOW - 1,
      },
      DELEGATOR_PRIV,
    );
    expect(
      await verifyRevocationInclusionReceipt(r, {
        pinnedRelayPublicKey: relayPub,
        revocation: sameGrant,
      }),
    ).toEqual({ valid: false, reason: "revocation_mismatch" });
  });

  it("refuses an attestation presented as a receipt (spec domain separation)", async () => {
    const h = await attest();
    expect(
      await verifyRevocationInclusionReceipt(h as unknown as DelegationRevocationInclusionReceipt, {
        pinnedRelayPublicKey: relayPub,
        revocation: revA,
      }),
    ).toEqual({ valid: false, reason: "unsupported_spec" });
  });

  it("refuses when an expectation is missing", async () => {
    const r = await receipt();
    expect(
      await verifyRevocationInclusionReceipt(r, {
        pinnedRelayPublicKey: "",
        revocation: revA,
      }),
    ).toEqual({ valid: false, reason: "missing_expectation" });
  });
});

describe("verifyRevocationOmissionProof", () => {
  async function receiptFor(rev: DelegationRevocation, seq: number, priv = RELAY_PRIV) {
    return signRevocationInclusionReceipt(
      {
        relay_motebit_id: RELAY_ID,
        relay_public_key: await pub(priv),
        revocation: rev,
        seq,
        received_at: NOW - 1_000,
      },
      priv,
    );
  }

  it("holds when a later attestation covers the receipted seq but lacks the record", async () => {
    const revC = await signDelegationRevocation(
      {
        grant_id: "019a0000-0000-7000-8000-0000000000g4",
        delegator_id: DELEGATOR_ID,
        delegator_public_key: delegatorPub,
        revoked_at: NOW - 1_000,
      },
      DELEGATOR_PRIV,
    );
    const r = await receiptFor(revC, 9);
    const a = await attest({ seq_high_water: 10 });
    expect(await verifyRevocationOmissionProof(r, a)).toEqual({ valid: true });
  });

  it("holds when the attestation carries the record at a different seq than receipted", async () => {
    const r = await receiptFor(revB, 8);
    expect(await verifyRevocationOmissionProof(r, await attest())).toEqual({ valid: true });
  });

  it("does not hold when the attestation carries the receipted record", async () => {
    const r = await receiptFor(revB, 7);
    expect(await verifyRevocationOmissionProof(r, await attest())).toEqual({
      valid: false,
      reason: "record_carried",
    });
  });

  it("does not hold when the attestation's high-water does not cover the receipted seq", async () => {
    const r = await receiptFor(revB, 11);
    expect(await verifyRevocationOmissionProof(r, await attest())).toEqual({
      valid: false,
      reason: "seq_not_covered",
    });
  });

  it("does not hold across different relay keys", async () => {
    const r = await receiptFor(revB, 9, OTHER_RELAY_PRIV);
    expect(await verifyRevocationOmissionProof(r, await attest())).toEqual({
      valid: false,
      reason: "relay_key_mismatch",
    });
  });

  it("does not hold across different delegators", async () => {
    const r = await receiptFor(revForeign, 9);
    expect(await verifyRevocationOmissionProof(r, await attest())).toEqual({
      valid: false,
      reason: "delegator_mismatch",
    });
  });

  it("does not hold when the receipt signature is forged", async () => {
    const r = { ...(await receiptFor(revB, 9)), received_at: 1 };
    expect(await verifyRevocationOmissionProof(r, await attest())).toEqual({
      valid: false,
      reason: "signature_invalid",
    });
  });

  it("does not hold when the attestation signature is forged", async () => {
    const r = await receiptFor(revB, 9);
    const a = { ...(await attest()), as_of: 1 };
    expect(await verifyRevocationOmissionProof(r, a)).toEqual({
      valid: false,
      reason: "signature_invalid",
    });
  });
});

describe("verifyRevocationEquivocationProof", () => {
  it("holds for two attestations at the same seq_high_water with different digests", async () => {
    const a = await attest();
    const b = await attest({ entries: [entries[0]!], challenge: "other" });
    expect(await verifyRevocationEquivocationProof(a, b)).toEqual({ valid: true });
  });

  it("does not hold for two attestations over the same entries (challenge and as_of differ)", async () => {
    const a = await attest();
    const b = await attest({ challenge: "other", as_of: NOW + 5 });
    expect(a.records_digest).toBe(b.records_digest);
    expect(await verifyRevocationEquivocationProof(a, b)).toEqual({
      valid: false,
      reason: "same_records_digest",
    });
  });

  it("does not hold at different seq_high_water", async () => {
    const a = await attest();
    const b = await attest({ entries: [entries[0]!], seq_high_water: 4 });
    expect(await verifyRevocationEquivocationProof(a, b)).toEqual({
      valid: false,
      reason: "seq_high_water_differs",
    });
  });

  it("does not hold across different relay keys", async () => {
    const a = await attest();
    const b = await attest({ entries: [entries[0]!] }, OTHER_RELAY_PRIV);
    expect(await verifyRevocationEquivocationProof(a, b)).toEqual({
      valid: false,
      reason: "relay_key_mismatch",
    });
  });

  it("does not hold across different delegators", async () => {
    const a = await attest();
    const b = await attest({ delegator_motebit_id: OTHER_DELEGATOR_ID, entries: [] });
    expect(await verifyRevocationEquivocationProof(a, b)).toEqual({
      valid: false,
      reason: "delegator_mismatch",
    });
  });

  it("does not hold when either attestation's signature is forged", async () => {
    const a = await attest();
    const b = { ...(await attest({ entries: [entries[0]!] })), as_of: 1 };
    expect(await verifyRevocationEquivocationProof(a, b)).toEqual({
      valid: false,
      reason: "signature_invalid",
    });
    expect(await verifyRevocationEquivocationProof(b, a)).toEqual({
      valid: false,
      reason: "signature_invalid",
    });
  });
});
