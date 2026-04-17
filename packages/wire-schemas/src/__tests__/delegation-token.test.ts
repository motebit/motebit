/**
 * Runtime-parse tests for DelegationTokenSchema. The drift test pins the
 * committed JSON Schema; this suite verifies the zod schema accepts the
 * shape real motebit delegators emit and rejects shapes that would bypass
 * authorization.
 */
import { describe, expect, it } from "vitest";

import { DelegationTokenSchema } from "../delegation-token.js";

const HEX_KEY = "a".repeat(64);
const HEX_KEY_2 = "b".repeat(64);

const SAMPLE: Record<string, unknown> = {
  delegator_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
  delegator_public_key: HEX_KEY,
  delegate_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
  delegate_public_key: HEX_KEY_2,
  scope: "web_search,summarize",
  issued_at: 1_713_456_000_000,
  expires_at: 1_713_459_600_000,
  suite: "motebit-jcs-ed25519-b64-v1",
  signature: "sig-base64url-here",
};

describe("DelegationTokenSchema", () => {
  it("parses a minimal valid token", () => {
    const t = DelegationTokenSchema.parse(SAMPLE);
    expect(t.delegator_id).toBe("019cd9d4-3275-7b24-8265-61ebee41d9d0");
    expect(t.scope).toBe("web_search,summarize");
  });

  it("accepts the wildcard scope", () => {
    const t = DelegationTokenSchema.parse({ ...SAMPLE, scope: "*" });
    expect(t.scope).toBe("*");
  });

  it("rejects a non-hex delegator public key", () => {
    expect(() =>
      DelegationTokenSchema.parse({ ...SAMPLE, delegator_public_key: "not-hex" }),
    ).toThrow();
  });

  it("rejects a short hex public key (wrong length)", () => {
    expect(() =>
      DelegationTokenSchema.parse({ ...SAMPLE, delegator_public_key: "a".repeat(32) }),
    ).toThrow();
  });

  it("rejects an UPPERCASE hex key (spec requires lowercase)", () => {
    expect(() =>
      DelegationTokenSchema.parse({ ...SAMPLE, delegator_public_key: "A".repeat(64) }),
    ).toThrow();
  });

  it("rejects an unknown cryptosuite", () => {
    expect(() =>
      DelegationTokenSchema.parse({ ...SAMPLE, suite: "motebit-future-pqc-v7" }),
    ).toThrow();
  });

  it("rejects extra top-level keys (strict mode)", () => {
    expect(() => DelegationTokenSchema.parse({ ...SAMPLE, sneak: "not allowed" })).toThrow();
  });

  it("rejects a token missing `signature`", () => {
    const bad = { ...SAMPLE };
    delete bad.signature;
    expect(() => DelegationTokenSchema.parse(bad)).toThrow();
  });

  it("rejects empty scope (min length 1)", () => {
    expect(() => DelegationTokenSchema.parse({ ...SAMPLE, scope: "" })).toThrow();
  });
});
