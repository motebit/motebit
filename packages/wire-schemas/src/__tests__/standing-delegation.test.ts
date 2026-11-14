/**
 * StandingDelegationSchema — wire validation, with focus on the @1.1
 * `subject_binding` field: it must round-trip through the public parse path
 * (the `.strict()` schema preserves it, never strips it), validate its nested
 * shape, and stay optional (a @1.0 grant parses without it).
 */
import { describe, it, expect } from "vitest";
import {
  StandingDelegationSchema,
  DelegationRevocationSetAttestationSchema,
  DelegationRevocationInclusionReceiptSchema,
} from "../standing-delegation.js";

const HEX64 = "a".repeat(64);

function baseGrant(): Record<string, unknown> {
  return {
    grant_id: "grant-1",
    delegator_id: "did:motebit:alice",
    delegator_public_key: HEX64,
    delegate_id: "did:motebit:bob",
    delegate_public_key: "b".repeat(64),
    scope: "web_search,summarize",
    subject: "research:thesis=acme",
    cadence_ms: 86_400_000,
    issued_at: 1_700_000_000_000,
    not_before: null,
    expires_at: 1_800_000_000_000,
    max_token_ttl_ms: 3_600_000,
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig-placeholder",
  };
}

const BINDING = {
  schema: "motebit.subject-binding.v1",
  artifact_schema: "motebit.monitor-scope.v1",
  digest_method: "jcs-sha256-hex",
  digest: "c".repeat(64),
};

describe("StandingDelegationSchema — subject_binding (@1.1)", () => {
  it("parses and PRESERVES subject_binding through the public path", () => {
    const parsed = StandingDelegationSchema.parse({ ...baseGrant(), subject_binding: BINDING });
    expect(parsed.subject_binding).toEqual(BINDING);
  });

  it("stays optional — a @1.0 grant parses without subject_binding", () => {
    const parsed = StandingDelegationSchema.parse(baseGrant());
    expect(parsed.subject_binding).toBeUndefined();
  });

  it("rejects an unknown digest_method (fail-closed literal)", () => {
    const bad = { ...BINDING, digest_method: "jcs-blake3-hex" };
    expect(() =>
      StandingDelegationSchema.parse({ ...baseGrant(), subject_binding: bad }),
    ).toThrow();
  });

  it("rejects a non-hex digest", () => {
    const bad = { ...BINDING, digest: "not-hex" };
    expect(() =>
      StandingDelegationSchema.parse({ ...baseGrant(), subject_binding: bad }),
    ).toThrow();
  });

  it("rejects an unknown key inside subject_binding (strict)", () => {
    const bad = { ...BINDING, surprise: 1 };
    expect(() =>
      StandingDelegationSchema.parse({ ...baseGrant(), subject_binding: bad }),
    ).toThrow();
  });

  it("still rejects an unknown top-level key (strict, unchanged)", () => {
    expect(() => StandingDelegationSchema.parse({ ...baseGrant(), surprise: 1 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Signed revocation evidence (@1.3, spec §5.2–§5.3)
// ---------------------------------------------------------------------------

function revocation(): Record<string, unknown> {
  return {
    grant_id: "grant-1",
    delegator_id: "did:motebit:alice",
    delegator_public_key: HEX64,
    revoked_at: 1_700_000_000_000,
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "rev-sig",
  };
}

function baseAttestation(): Record<string, unknown> {
  return {
    spec: "motebit/delegation-revocation-set-attestation@1.0",
    relay_motebit_id: "relay-1",
    relay_public_key: "d".repeat(64),
    delegator_motebit_id: "did:motebit:alice",
    challenge: "d".repeat(64),
    as_of: 1_700_000_100_000,
    seq_high_water: 9,
    count: 1,
    entries: [{ seq: 4, received_at: 1_700_000_000_500, record: revocation() }],
    records_digest: "e".repeat(64),
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "attestation-sig",
  };
}

function baseReceipt(): Record<string, unknown> {
  return {
    spec: "motebit/delegation-revocation-inclusion-receipt@1.0",
    relay_motebit_id: "relay-1",
    relay_public_key: "d".repeat(64),
    grant_id: "grant-1",
    delegator_motebit_id: "did:motebit:alice",
    revocation_signature: "rev-sig",
    seq: 4,
    received_at: 1_700_000_000_500,
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "receipt-sig",
  };
}

describe("DelegationRevocationSetAttestationSchema (@1.3)", () => {
  it("parses a well-formed attestation and preserves its entries", () => {
    const parsed = DelegationRevocationSetAttestationSchema.parse(baseAttestation());
    expect(parsed.entries[0]!.record.grant_id).toBe("grant-1");
  });

  it("parses an empty attestation (absence evidence)", () => {
    expect(() =>
      DelegationRevocationSetAttestationSchema.parse({
        ...baseAttestation(),
        entries: [],
        count: 0,
      }),
    ).not.toThrow();
  });

  it("rejects another spec discriminator (domain separation)", () => {
    expect(() =>
      DelegationRevocationSetAttestationSchema.parse({
        ...baseAttestation(),
        spec: "motebit/delegation-revocation-inclusion-receipt@1.0",
      }),
    ).toThrow();
  });

  it("rejects a non-canonical relay key", () => {
    expect(() =>
      DelegationRevocationSetAttestationSchema.parse({
        ...baseAttestation(),
        relay_public_key: "D".repeat(64),
      }),
    ).toThrow();
  });

  it("rejects a non-integer, zero or negative entry seq", () => {
    for (const seq of [0, 1.5, -1]) {
      const h = baseAttestation();
      h.entries = [{ seq, received_at: 1, record: revocation() }];
      expect(() => DelegationRevocationSetAttestationSchema.parse(h)).toThrow();
    }
  });

  it("rejects a non-hex records_digest", () => {
    expect(() =>
      DelegationRevocationSetAttestationSchema.parse({
        ...baseAttestation(),
        records_digest: "zz",
      }),
    ).toThrow();
  });

  it("rejects an unknown key on the attestation, an entry, or a record (strict)", () => {
    expect(() =>
      DelegationRevocationSetAttestationSchema.parse({ ...baseAttestation(), surprise: 1 }),
    ).toThrow();
    const e = baseAttestation();
    e.entries = [{ seq: 4, received_at: 1, record: revocation(), extra: true }];
    expect(() => DelegationRevocationSetAttestationSchema.parse(e)).toThrow();
    const r = baseAttestation();
    r.entries = [{ seq: 4, received_at: 1, record: { ...revocation(), extra: true } }];
    expect(() => DelegationRevocationSetAttestationSchema.parse(r)).toThrow();
  });

  it("rejects a challenge shorter than 32 or longer than 256 characters", () => {
    expect(() =>
      DelegationRevocationSetAttestationSchema.parse({ ...baseAttestation(), challenge: "" }),
    ).toThrow();
    expect(() =>
      DelegationRevocationSetAttestationSchema.parse({
        ...baseAttestation(),
        challenge: "x".repeat(31),
      }),
    ).toThrow();
    expect(() =>
      DelegationRevocationSetAttestationSchema.parse({
        ...baseAttestation(),
        challenge: "x".repeat(257),
      }),
    ).toThrow();
  });
});

describe("DelegationRevocationInclusionReceiptSchema (@1.3)", () => {
  it("parses a well-formed receipt", () => {
    expect(DelegationRevocationInclusionReceiptSchema.parse(baseReceipt()).seq).toBe(4);
  });

  it("rejects the attestation's spec discriminator (domain separation)", () => {
    expect(() =>
      DelegationRevocationInclusionReceiptSchema.parse({
        ...baseReceipt(),
        spec: "motebit/delegation-revocation-set-attestation@1.0",
      }),
    ).toThrow();
  });

  it("rejects a zero seq, a missing revocation_signature, and an unknown key", () => {
    expect(() =>
      DelegationRevocationInclusionReceiptSchema.parse({ ...baseReceipt(), seq: 0 }),
    ).toThrow();
    const { revocation_signature: _r, ...noSig } = baseReceipt();
    expect(() => DelegationRevocationInclusionReceiptSchema.parse(noSig)).toThrow();
    expect(() =>
      DelegationRevocationInclusionReceiptSchema.parse({ ...baseReceipt(), surprise: 1 }),
    ).toThrow();
  });
});
