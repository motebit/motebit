/**
 * Tests for the skill arm of the unified `verify()` dispatcher
 * (@motebit/crypto/index.ts). The dispatcher recognizes a
 * `SkillEnvelope` shape, runs the envelope-signature primitive, and
 * leaves body_hash + files cross-checks unattempted (those require
 * on-disk bytes — `@motebit/verifier::verifySkillDirectory` augments).
 */
import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import type { SkillEnvelope, SkillManifest, SkillSignature } from "@motebit/protocol";
import { signSkillEnvelope, verify, type SkillVerifyResult } from "../index.js";

if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

async function makeKeypair(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey };
}

function makeManifest(sig: SkillSignature): SkillManifest {
  return {
    name: "example-skill",
    description: "An example.",
    version: "1.0.0",
    platforms: ["macos", "linux"],
    metadata: { author: "test", category: "software-development", tags: ["example"] },
    motebit: {
      spec_version: "1.0",
      sensitivity: "none",
      hardware_attestation: { required: false, minimum_score: 0 },
      signature: sig,
    },
  };
}

async function buildSignedEnvelope(): Promise<{
  envelope: SkillEnvelope;
  publicKey: Uint8Array;
}> {
  const { privateKey, publicKey } = await makeKeypair();
  const stubSig: SkillSignature = {
    suite: "motebit-jcs-ed25519-b64-v1",
    public_key: Array.from(publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    value: "AA",
  };
  const unsigned: Omit<SkillEnvelope, "signature"> = {
    spec_version: "1.0",
    skill: { name: "example-skill", version: "1.0.0", content_hash: "a".repeat(64) },
    manifest: makeManifest(stubSig),
    body_hash: "b".repeat(64),
    files: [],
  };
  const envelope = await signSkillEnvelope(unsigned, privateKey, publicKey);
  return { envelope, publicKey };
}

describe("verify() — skill arm", () => {
  it("detects a SkillEnvelope JSON object as type=skill", async () => {
    const { envelope } = await buildSignedEnvelope();
    const result = (await verify(envelope)) as SkillVerifyResult;
    expect(result.type).toBe("skill");
    expect(result.envelope).not.toBeNull();
    expect(result.skill).toBe("example-skill@1.0.0");
  });

  it("detects a SkillEnvelope JSON string and parses it", async () => {
    const { envelope } = await buildSignedEnvelope();
    const result = (await verify(JSON.stringify(envelope))) as SkillVerifyResult;
    expect(result.type).toBe("skill");
    expect(result.envelope).not.toBeNull();
  });

  it("envelope-sig step passes for a freshly signed envelope", async () => {
    const { envelope } = await buildSignedEnvelope();
    const result = (await verify(envelope)) as SkillVerifyResult;
    expect(result.steps.envelope.valid).toBe(true);
    expect(result.steps.envelope.reason).toBe("ok");
    expect(result.signer).toBe(envelope.signature.public_key);
  });

  it("returns valid=false even when sig passes — body_hash + files unattempted", async () => {
    // The bare-envelope verify path is honest: full verification needs
    // the on-disk body + files. `valid: true` is reserved for the
    // directory walker in @motebit/verifier.
    const { envelope } = await buildSignedEnvelope();
    const result = (await verify(envelope)) as SkillVerifyResult;
    expect(result.valid).toBe(false);
    expect(result.steps.body_hash).toBeNull();
    expect(result.steps.files).toEqual([]);
    expect(result.errors?.some((e) => e.message.includes("body_hash"))).toBe(true);
  });

  it("envelope-sig fails with ed25519_mismatch when the body_hash field is tampered", async () => {
    const { envelope } = await buildSignedEnvelope();
    const tampered: SkillEnvelope = { ...envelope, body_hash: "f".repeat(64) };
    const result = (await verify(tampered)) as SkillVerifyResult;
    expect(result.steps.envelope.valid).toBe(false);
    expect(result.steps.envelope.reason).toBe("ed25519_mismatch");
  });

  it("--expectedType skill is honored when input is a non-skill", async () => {
    const result = (await verify({} as unknown, { expectedType: "skill" })) as SkillVerifyResult;
    expect(result.type).toBe("skill");
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toMatch(/Unrecognized/);
  });
});
