/**
 * StandingDelegationSchema — wire validation, with focus on the @1.1
 * `subject_binding` field: it must round-trip through the public parse path
 * (the `.strict()` schema preserves it, never strips it), validate its nested
 * shape, and stay optional (a @1.0 grant parses without it).
 */
import { describe, it, expect } from "vitest";
import {
  StandingDelegationSchema,
  DelegationRevocationHeadSchema,
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

function baseHead(): Record<string, unknown> {
  return {
    spec: "motebit/delegation-revocation-head@1.0",
    relay_id: "relay-1",
    relay_public_key: "d".repeat(64),
    delegator_id: "did:motebit:alice",
    challenge: "nonce-1",
    as_of: 1_700_000_100_000,
    seq_high_water: 9,
    count: 1,
    entries: [{ seq: 4, received_at: 1_700_000_000_500, record: revocation() }],
    records_digest: "e".repeat(64),
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "head-sig",
  };
}

function baseReceipt(): Record<string, unknown> {
  return {
    spec: "motebit/delegation-revocation-inclusion-receipt@1.0",
    relay_id: "relay-1",
    relay_public_key: "d".repeat(64),
    grant_id: "grant-1",
    delegator_id: "did:motebit:alice",
    revocation_signature: "rev-sig",
    seq: 4,
    received_at: 1_700_000_000_500,
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "receipt-sig",
  };
}

describe("DelegationRevocationHeadSchema (@1.3)", () => {
  it("parses a well-formed head and preserves its entries", () => {
    const parsed = DelegationRevocationHeadSchema.parse(baseHead());
    expect(parsed.entries[0]!.record.grant_id).toBe("grant-1");
  });

  it("parses an empty head (absence evidence)", () => {
    expect(() =>
      DelegationRevocationHeadSchema.parse({ ...baseHead(), entries: [], count: 0 }),
    ).not.toThrow();
  });

  it("rejects another spec discriminator (domain separation)", () => {
    expect(() =>
      DelegationRevocationHeadSchema.parse({
        ...baseHead(),
        spec: "motebit/delegation-revocation-inclusion-receipt@1.0",
      }),
    ).toThrow();
  });

  it("rejects a non-canonical relay key", () => {
    expect(() =>
      DelegationRevocationHeadSchema.parse({ ...baseHead(), relay_public_key: "D".repeat(64) }),
    ).toThrow();
  });

  it("rejects a non-integer, zero or negative entry seq", () => {
    for (const seq of [0, 1.5, -1]) {
      const h = baseHead();
      h.entries = [{ seq, received_at: 1, record: revocation() }];
      expect(() => DelegationRevocationHeadSchema.parse(h)).toThrow();
    }
  });

  it("rejects a non-hex records_digest", () => {
    expect(() =>
      DelegationRevocationHeadSchema.parse({ ...baseHead(), records_digest: "zz" }),
    ).toThrow();
  });

  it("rejects an unknown key on the head, an entry, or a record (strict)", () => {
    expect(() => DelegationRevocationHeadSchema.parse({ ...baseHead(), surprise: 1 })).toThrow();
    const e = baseHead();
    e.entries = [{ seq: 4, received_at: 1, record: revocation(), extra: true }];
    expect(() => DelegationRevocationHeadSchema.parse(e)).toThrow();
    const r = baseHead();
    r.entries = [{ seq: 4, received_at: 1, record: { ...revocation(), extra: true } }];
    expect(() => DelegationRevocationHeadSchema.parse(r)).toThrow();
  });

  it("rejects an empty or oversized challenge", () => {
    expect(() => DelegationRevocationHeadSchema.parse({ ...baseHead(), challenge: "" })).toThrow();
    expect(() =>
      DelegationRevocationHeadSchema.parse({ ...baseHead(), challenge: "x".repeat(257) }),
    ).toThrow();
  });
});

describe("DelegationRevocationInclusionReceiptSchema (@1.3)", () => {
  it("parses a well-formed receipt", () => {
    expect(DelegationRevocationInclusionReceiptSchema.parse(baseReceipt()).seq).toBe(4);
  });

  it("rejects the head's spec discriminator (domain separation)", () => {
    expect(() =>
      DelegationRevocationInclusionReceiptSchema.parse({
        ...baseReceipt(),
        spec: "motebit/delegation-revocation-head@1.0",
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
