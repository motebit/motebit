/**
 * Runtime-parse tests for CredentialBundleSchema. Validates the
 * agent-signed reputation export — the artifact that makes relay
 * choice actually exercisable.
 */
import { describe, expect, it } from "vitest";

import { CredentialBundleSchema } from "../credential-bundle.js";

const SAMPLE: Record<string, unknown> = {
  motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
  exported_at: 1_713_456_000_000,
  credentials: [
    {
      type: ["VerifiableCredential"],
      issuer: "did:key:z6...",
      credentialSubject: { id: "did:key:z6..." },
    },
  ],
  anchor_proofs: [{ batch_id: "batch-1", merkle_root: "a".repeat(64), tx_hash: "0xabc" }],
  key_succession: [{ from: "old-key", to: "new-key", at: 1_700_000_000_000 }],
  bundle_hash: "c".repeat(64),
  suite: "motebit-jcs-ed25519-b64-v1",
  signature: "sig-base64url",
};

describe("CredentialBundleSchema", () => {
  it("parses a fully-populated bundle", () => {
    const b = CredentialBundleSchema.parse(SAMPLE);
    expect(b.motebit_id).toBe("019cd9d4-3275-7b24-8265-61ebee41d9d0");
    expect(b.credentials).toHaveLength(1);
    expect(b.suite).toBe("motebit-jcs-ed25519-b64-v1");
  });

  it("accepts a fresh agent's empty bundle (no credentials yet)", () => {
    const b = CredentialBundleSchema.parse({
      ...SAMPLE,
      credentials: [],
      anchor_proofs: [],
      key_succession: [],
    });
    expect(b.credentials).toEqual([]);
    expect(b.anchor_proofs).toEqual([]);
  });

  it("accepts arbitrary inner-document shapes (per-entry validation deferred)", () => {
    const b = CredentialBundleSchema.parse({
      ...SAMPLE,
      credentials: [{ anything: "goes", at_this_layer: true, nested: { ok: 1 } }],
    });
    expect((b.credentials[0] as Record<string, unknown>).anything).toBe("goes");
  });

  it("rejects the wrong cryptosuite (no legacy-no-suite path)", () => {
    expect(() =>
      CredentialBundleSchema.parse({ ...SAMPLE, suite: "motebit-future-pqc-v7" }),
    ).toThrow();
  });

  it("rejects extra top-level keys (strict — protocol surface is closed)", () => {
    expect(() => CredentialBundleSchema.parse({ ...SAMPLE, sneak: "not allowed" })).toThrow();
  });

  it("rejects missing bundle_hash (content-addressing is non-optional)", () => {
    const bad = { ...SAMPLE };
    delete bad.bundle_hash;
    expect(() => CredentialBundleSchema.parse(bad)).toThrow();
  });

  it("rejects missing signature (agent-signed is the whole point)", () => {
    const bad = { ...SAMPLE };
    delete bad.signature;
    expect(() => CredentialBundleSchema.parse(bad)).toThrow();
  });

  it("rejects empty motebit_id", () => {
    expect(() => CredentialBundleSchema.parse({ ...SAMPLE, motebit_id: "" })).toThrow();
  });
});
