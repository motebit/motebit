/**
 * StandingDelegationSchema — wire validation, with focus on the @1.1
 * `subject_binding` field: it must round-trip through the public parse path
 * (the `.strict()` schema preserves it, never strips it), validate its nested
 * shape, and stay optional (a @1.0 grant parses without it).
 */
import { describe, it, expect } from "vitest";
import { StandingDelegationSchema } from "../standing-delegation.js";

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
