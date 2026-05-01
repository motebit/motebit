/**
 * Operator retention manifest tests — phase 6a.
 *
 * Three invariants:
 *   1. The signed manifest verifies through `verifyRetentionManifest`
 *      against the relay's public key.
 *   2. Tampering with any field invalidates the signature.
 *   3. The manifest's content (stores list, honest_gaps, default
 *      sensitivity) matches what the source-of-truth declares.
 *
 * Sibling to transparency.test.ts. Same suite, same signing flow.
 */
import { describe, it, expect, beforeAll } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair } from "@motebit/encryption";
import { verifyRetentionManifest } from "@motebit/crypto";
import { buildSignedManifest, RETENTION_MANIFEST_CONTENT } from "../retention-manifest.js";
import type { RelayIdentity } from "../federation.js";

let relayIdentity: RelayIdentity;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeypair();
  relayIdentity = {
    relayMotebitId: "01975554-3001-7c00-9d05-test-relay-keys",
    publicKey,
    privateKey,
    publicKeyHex: "ignored-in-test",
    did: "did:motebit:01975554-3001-7c00-9d05-test-relay-keys",
  };
});

describe("retention manifest — sign + verify round-trip", () => {
  it("signs a manifest that verifies through verifyRetentionManifest", async () => {
    const manifest = await buildSignedManifest(relayIdentity);

    const result = await verifyRetentionManifest(manifest, relayIdentity.publicKey);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest).not.toBeNull();
    expect(result.manifest?.spec).toBe("motebit/retention-manifest@1");
    expect(result.manifest?.suite).toBe("motebit-jcs-ed25519-hex-v1");
    expect(result.manifest?.operator_id).toBe(relayIdentity.relayMotebitId);
  });

  it("rejects a manifest tampered after signing", async () => {
    const manifest = await buildSignedManifest(relayIdentity);
    const tampered = {
      ...manifest,
      pre_classification_default_sensitivity: "secret" as const,
    };
    const result = await verifyRetentionManifest(tampered, relayIdentity.publicKey);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("does not verify against operator_public_key")),
    ).toBe(true);
  });

  it("rejects a manifest signed by a different key", async () => {
    const manifest = await buildSignedManifest(relayIdentity);
    const wrong = await generateKeypair();
    const result = await verifyRetentionManifest(manifest, wrong.publicKey);
    expect(result.valid).toBe(false);
  });

  it("rejects a manifest with the wrong spec value", async () => {
    const manifest = await buildSignedManifest(relayIdentity);
    const wrongSpec = { ...manifest, spec: "motebit/retention-manifest@2" as never };
    const result = await verifyRetentionManifest(wrongSpec, relayIdentity.publicKey);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unexpected spec"))).toBe(true);
  });

  it("rejects a non-hex signature", async () => {
    const manifest = await buildSignedManifest(relayIdentity);
    const badSig = { ...manifest, signature: "not-hex-bytes" };
    const result = await verifyRetentionManifest(badSig, relayIdentity.publicKey);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("128-char hex"))).toBe(true);
  });
});

describe("retention manifest — content honesty", () => {
  it("stores list is empty in phase 6a (matches doctrine)", async () => {
    expect(RETENTION_MANIFEST_CONTENT.stores).toEqual([]);
  });

  it("declares pre_classification_default_sensitivity = personal", async () => {
    expect(RETENTION_MANIFEST_CONTENT.pre_classification_default_sensitivity).toBe("personal");
  });

  it("honest_gaps split into pending / out_of_deployment / different_mechanism", async () => {
    const gaps = RETENTION_MANIFEST_CONTENT.honest_gaps;
    expect(gaps).toBeDefined();
    if (gaps === undefined) return;
    // Phase 6a follow-up — every gap carries one of the three discriminator
    // prefixes, so verifiers can distinguish "we will run this once enforcement
    // lands" from "this isn't ours regardless of phase" from "different doctrine."
    for (const gap of gaps) {
      expect(
        gap.startsWith("pending:") ||
          gap.startsWith("out_of_deployment:") ||
          gap.startsWith("different_mechanism:"),
      ).toBe(true);
    }
    expect(gaps.some((g) => g.startsWith("pending:") && g.includes("phase 4b-3"))).toBe(true);
    expect(
      gaps.some(
        (g) =>
          g.startsWith("out_of_deployment:") &&
          g.includes("conversation_messages") &&
          g.toLowerCase().includes("phase 5-ship"),
      ),
    ).toBe(true);
    expect(gaps.some((g) => g.startsWith("different_mechanism:") && g.includes("presence"))).toBe(
      true,
    );
    expect(gaps.some((g) => g.includes("onchain anchor"))).toBe(true);
  });

  it("manifest issued_at is signed (changing it invalidates the signature)", async () => {
    const manifest = await buildSignedManifest(relayIdentity, 1700000000000);
    const tampered = { ...manifest, issued_at: 1700000001000 };
    const result = await verifyRetentionManifest(tampered, relayIdentity.publicKey);
    expect(result.valid).toBe(false);
  });
});
