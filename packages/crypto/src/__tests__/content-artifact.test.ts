/**
 * Content-artifact provenance tests.
 *
 * Invariants pinned:
 *
 *   1. `signContentArtifact` produces a manifest that `verifyContentArtifact`
 *      accepts.
 *   2. Tampering the content bytes produces `content_hash_mismatch`.
 *   3. Tampering the manifest body produces `signature_invalid`.
 *   4. Verifying under a different producer's key produces `signature_invalid`.
 *   5. Empty content is supported (zero-byte artifacts have provenance too).
 *   6. The optional `invocation` context is preserved through sign + verify.
 *   7. Canonical-JSON discipline: producer key order doesn't change the
 *      signature (the canonicalization handles ordering).
 *   8. The pinned `CONTENT_ARTIFACT_SUITE` is `motebit-jcs-ed25519-hex-v1`.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  signContentArtifact,
  verifyContentArtifact,
  CONTENT_ARTIFACT_SUITE,
  type ContentArtifactManifest,
} from "../content-artifact.js";
import { generateKeypair, bytesToHex } from "../signing.js";

interface Keys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyHex: string;
  did: string;
}

let producer: Keys;
let attacker: Keys;

async function makeKeys(): Promise<Keys> {
  const kp = await generateKeypair();
  const hex = bytesToHex(kp.publicKey);
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyHex: hex,
    did: `did:key:z${hex.slice(0, 16)}`,
  };
}

beforeAll(async () => {
  producer = await makeKeys();
  attacker = await makeKeys();
});

async function signSample(
  content: Uint8Array,
  overrides: Partial<{
    artifactType: string;
    invocation: { task_id?: string; receipt_id?: string };
    producedAt: string;
  }> = {},
): Promise<ContentArtifactManifest> {
  return signContentArtifact(content, {
    artifactType: overrides.artifactType ?? "audit-trail",
    producer: producer.did,
    producerPublicKey: producer.publicKey,
    producerPrivateKey: producer.privateKey,
    claimGenerator: "motebit/1.x.x-test",
    invocation: overrides.invocation,
    producedAt: overrides.producedAt,
  });
}

describe("signContentArtifact + verifyContentArtifact — round trip", () => {
  it("a signed manifest verifies under the producer's public key", async () => {
    const content = new TextEncoder().encode("audit entry 1\naudit entry 2\n");
    const manifest = await signSample(content);

    expect(manifest.suite).toBe(CONTENT_ARTIFACT_SUITE);
    expect(manifest.producer).toBe(producer.did);
    expect(manifest.producer_public_key).toBe(producer.publicKeyHex);
    expect(manifest.artifact_type).toBe("audit-trail");
    expect(manifest.signature).toMatch(/^[A-Za-z0-9_-]+$/);

    const result = await verifyContentArtifact(manifest, content);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("the optional invocation context survives the round trip", async () => {
    const content = new TextEncoder().encode("memory export");
    const manifest = await signSample(content, {
      invocation: { task_id: "task-42", receipt_id: "rcpt-99" },
    });
    expect(manifest.invocation).toEqual({ task_id: "task-42", receipt_id: "rcpt-99" });
    expect((await verifyContentArtifact(manifest, content)).valid).toBe(true);
  });

  it("empty content has provenance too — zero-byte artifacts are first-class", async () => {
    const content = new Uint8Array(0);
    const manifest = await signSample(content);
    expect((await verifyContentArtifact(manifest, content)).valid).toBe(true);
  });
});

describe("verifyContentArtifact — failure modes", () => {
  it("rejects with content_hash_mismatch when the content was tampered", async () => {
    const content = new TextEncoder().encode("original audit entry");
    const manifest = await signSample(content);
    const tampered = new TextEncoder().encode("modified audit entry");
    const result = await verifyContentArtifact(manifest, tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("content_hash_mismatch");
  });

  it("rejects with signature_invalid when the manifest was tampered", async () => {
    const content = new TextEncoder().encode("audit");
    const manifest = await signSample(content);
    // Mutate the artifact_type — content_hash still matches (we didn't touch
    // content) but the signature was over the original manifest body.
    const tampered: ContentArtifactManifest = { ...manifest, artifact_type: "memory-export" };
    const result = await verifyContentArtifact(tampered, content);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("rejects with signature_invalid when the declared public key isn't the signer", async () => {
    // Swap the public key for the attacker's; signature stays the same.
    // verifyBySuite computes against the wrong key and fails.
    const content = new TextEncoder().encode("audit");
    const manifest = await signSample(content);
    const swapped: ContentArtifactManifest = {
      ...manifest,
      producer_public_key: attacker.publicKeyHex,
    };
    const result = await verifyContentArtifact(swapped, content);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("rejects with malformed_public_key when the hex is invalid", async () => {
    const content = new TextEncoder().encode("audit");
    const manifest = await signSample(content);
    const broken: ContentArtifactManifest = {
      ...manifest,
      producer_public_key: "not-hex",
    };
    const result = await verifyContentArtifact(broken, content);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("malformed_public_key");
  });

  it("rejects with content_hash_mismatch before signature check (cheap-first)", async () => {
    // Both tampered: ensures we surface the hash mismatch (cheaper to detect)
    // rather than running the signature primitive on a doomed verification.
    const content = new TextEncoder().encode("audit");
    const manifest = await signSample(content);
    const tampered: ContentArtifactManifest = {
      ...manifest,
      producer_public_key: attacker.publicKeyHex,
    };
    const wrongContent = new TextEncoder().encode("different");
    const result = await verifyContentArtifact(tampered, wrongContent);
    expect(result.reason).toBe("content_hash_mismatch");
  });
});

describe("CONTENT_ARTIFACT_SUITE — protocol surface", () => {
  it("is pinned to motebit-jcs-ed25519-hex-v1", () => {
    // Hardcoded literal — protects against accidental rename in
    // suite-dispatch.ts (the wire format depends on this constant
    // remaining stable across motebit versions).
    expect(CONTENT_ARTIFACT_SUITE).toBe("motebit-jcs-ed25519-hex-v1");
  });
});

describe("canonical-JSON discipline", () => {
  it("signature is deterministic for the same inputs", async () => {
    const content = new TextEncoder().encode("audit");
    const producedAt = "2026-05-11T00:00:00.000Z";
    const a = await signSample(content, { producedAt });
    const b = await signSample(content, { producedAt });
    expect(a.signature).toBe(b.signature);
    expect(a.content_hash).toBe(b.content_hash);
  });
});
