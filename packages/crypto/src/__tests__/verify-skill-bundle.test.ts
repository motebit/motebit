/**
 * Tests for `verifySkillBundle` — the canonical pure-function full-verify
 * primitive across surfaces. Browser, Node-library, and CLI callers all
 * end up here once they have envelope + body bytes + optional files map.
 *
 * Each test exercises a different verification axis (envelope sig,
 * body hash, per-file hash) so the discriminated step shape can be
 * asserted independently of the others. Test factory builds a real
 * Ed25519-signed envelope so the sig step actually runs cryptography
 * rather than mock-asserting on a hand-rolled value.
 */
import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import type { SkillEnvelope, SkillManifest, SkillSignature } from "@motebit/protocol";
import { hash, signSkillEnvelope, verifySkillBundle } from "../index.js";

if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function makeManifest(sig: SkillSignature): SkillManifest {
  return {
    name: "fixture-skill",
    description: "test fixture",
    version: "1.0.0",
    platforms: ["macos", "linux"],
    metadata: { author: "test", category: "software-development", tags: ["test"] },
    motebit: {
      spec_version: "1.0",
      sensitivity: "none",
      hardware_attestation: { required: false, minimum_score: 0 },
      signature: sig,
    },
  };
}

interface Fixture {
  envelope: SkillEnvelope;
  body: Uint8Array;
  files: Record<string, Uint8Array>;
}

async function buildFixture(opts?: {
  bodyOverride?: string;
  files?: Record<string, Uint8Array>;
}): Promise<Fixture> {
  const sk = ed.utils.randomSecretKey();
  const pk = await ed.getPublicKeyAsync(sk);
  const body = new TextEncoder().encode(opts?.bodyOverride ?? "# Fixture body\n");
  const bodyHash = await hash(body);
  const fileEntries: Array<{ path: string; hash: string }> = [];
  for (const [path, bytes] of Object.entries(opts?.files ?? {})) {
    fileEntries.push({ path, hash: await hash(bytes) });
  }
  const stubSig: SkillSignature = {
    suite: "motebit-jcs-ed25519-b64-v1",
    public_key: bytesToHex(pk),
    value: "AA",
  };
  const unsigned: Omit<SkillEnvelope, "signature"> = {
    spec_version: "1.0",
    skill: { name: "fixture-skill", version: "1.0.0", content_hash: "a".repeat(64) },
    manifest: makeManifest(stubSig),
    body_hash: bodyHash,
    files: fileEntries,
  };
  const envelope = await signSkillEnvelope(unsigned, sk, pk);
  return { envelope, body, files: opts?.files ?? {} };
}

describe("verifySkillBundle — happy path", () => {
  it("returns valid=true on a freshly-built bundle (sig + body + 0 files)", async () => {
    const f = await buildFixture();
    const result = await verifySkillBundle({ envelope: f.envelope, body: f.body });
    expect(result.type).toBe("skill");
    expect(result.valid).toBe(true);
    expect(result.steps.envelope.valid).toBe(true);
    expect(result.steps.envelope.reason).toBe("ok");
    expect(result.steps.body_hash?.valid).toBe(true);
    expect(result.steps.files).toEqual([]);
    expect(result.errors).toBeUndefined();
  });

  it("verifies per-file hashes when envelope.files[] is non-empty", async () => {
    const fileBytes = new TextEncoder().encode("#!/bin/sh\necho hi\n");
    const f = await buildFixture({ files: { "scripts/run.sh": fileBytes } });
    const result = await verifySkillBundle({
      envelope: f.envelope,
      body: f.body,
      files: f.files,
    });
    expect(result.valid).toBe(true);
    expect(result.steps.files).toHaveLength(1);
    expect(result.steps.files[0]!.valid).toBe(true);
    expect(result.steps.files[0]!.reason).toBe("ok");
    expect(result.steps.files[0]!.path).toBe("scripts/run.sh");
  });

  it("populates `signer` and `skill` summary fields", async () => {
    const f = await buildFixture();
    const result = await verifySkillBundle({ envelope: f.envelope, body: f.body });
    expect(result.signer).toBe(f.envelope.signature.public_key);
    expect(result.skill).toBe("fixture-skill@1.0.0");
  });
});

describe("verifySkillBundle — tamper detection", () => {
  it("flags body_hash mismatch when body bytes were swapped post-sign", async () => {
    const f = await buildFixture({ bodyOverride: "# Original\n" });
    const tamperedBody = new TextEncoder().encode("# Tampered\n");
    const result = await verifySkillBundle({ envelope: f.envelope, body: tamperedBody });
    expect(result.valid).toBe(false);
    expect(result.steps.envelope.valid).toBe(true); // envelope itself untouched
    expect(result.steps.body_hash?.valid).toBe(false);
    expect(result.errors?.some((e) => e.path === "body_hash")).toBe(true);
  });

  it("flags envelope-sig failure when an envelope field was tampered post-sign", async () => {
    const f = await buildFixture();
    // Tampering body_hash on the envelope changes the signed canonical
    // bytes; verifySkillEnvelopeDetailed must reject with ed25519_mismatch.
    const tampered: SkillEnvelope = { ...f.envelope, body_hash: "f".repeat(64) };
    const result = await verifySkillBundle({ envelope: tampered, body: f.body });
    expect(result.valid).toBe(false);
    expect(result.steps.envelope.valid).toBe(false);
    expect(result.steps.envelope.reason).toBe("ed25519_mismatch");
  });

  it("flags file_hash_mismatch when a file's bytes were swapped", async () => {
    const original = new TextEncoder().encode("original\n");
    const f = await buildFixture({ files: { "scripts/run.sh": original } });
    const tampered = { "scripts/run.sh": new TextEncoder().encode("tampered\n") };
    const result = await verifySkillBundle({
      envelope: f.envelope,
      body: f.body,
      files: tampered,
    });
    expect(result.valid).toBe(false);
    const fileStep = result.steps.files.find((s) => s.path === "scripts/run.sh");
    expect(fileStep?.valid).toBe(false);
    expect(fileStep?.reason).toBe("hash_mismatch");
  });

  it("flags reason='missing' when envelope declares a file the bundle didn't ship", async () => {
    const f = await buildFixture({
      files: { "scripts/run.sh": new TextEncoder().encode("declared\n") },
    });
    // Re-call without files map — same envelope, no bytes provided.
    const result = await verifySkillBundle({ envelope: f.envelope, body: f.body });
    expect(result.valid).toBe(false);
    const fileStep = result.steps.files.find((s) => s.path === "scripts/run.sh");
    expect(fileStep?.reason).toBe("missing");
    expect(fileStep?.actual).toBeNull();
  });

  it("flags bad_public_key when envelope.signature.public_key is non-hex", async () => {
    const f = await buildFixture();
    const tampered: SkillEnvelope = {
      ...f.envelope,
      signature: { ...f.envelope.signature, public_key: "not-hex!!" },
    };
    const result = await verifySkillBundle({ envelope: tampered, body: f.body });
    expect(result.valid).toBe(false);
    expect(result.steps.envelope.valid).toBe(false);
    expect(result.steps.envelope.reason).toBe("bad_public_key");
  });
});
