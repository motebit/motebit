import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256, signSkillEnvelope, bytesToHex } from "@motebit/encryption";
import type {
  SkillEnvelope,
  SkillManifest,
  SkillRegistryBundle,
  SkillSignature,
} from "@motebit/sdk";
import { verifyBundleLocally } from "../skill-bundle-verifier";

if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

async function makeKeypair(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey };
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function makeManifest(sig: SkillSignature): SkillManifest {
  return {
    name: "example-skill",
    description: "Walks through the example procedure.",
    version: "1.0.0",
    platforms: ["macos", "linux"],
    metadata: { author: "Jane Doe", category: "software-development", tags: ["example"] },
    motebit: {
      spec_version: "1.0",
      sensitivity: "none",
      hardware_attestation: { required: false, minimum_score: 0 },
      signature: sig,
    },
  };
}

async function buildSignedBundle(opts: {
  bodyText?: string;
  files?: Record<string, Uint8Array>;
}): Promise<{
  bundle: SkillRegistryBundle;
  publicKey: Uint8Array;
}> {
  const { privateKey, publicKey } = await makeKeypair();
  const body = new TextEncoder().encode(opts.bodyText ?? "# Example\n\nbody.\n");
  const bodyHash = bytesToHex(await sha256(body));
  const fileEntries: Array<{ path: string; hash: string }> = [];
  for (const [path, bytes] of Object.entries(opts.files ?? {})) {
    fileEntries.push({ path, hash: bytesToHex(await sha256(bytes)) });
  }
  // Stub manifest signature first — the envelope-sign primitive doesn't
  // touch the nested manifest's signature; envelope binding is independent.
  const stubSig: SkillSignature = {
    suite: "motebit-jcs-ed25519-b64-v1",
    public_key: bytesToHex(publicKey),
    value: "AA",
  };
  const unsigned: Omit<SkillEnvelope, "signature"> = {
    spec_version: "1.0",
    skill: { name: "example-skill", version: "1.0.0", content_hash: "a".repeat(64) },
    manifest: makeManifest(stubSig),
    body_hash: bodyHash,
    files: fileEntries,
  };
  const envelope = await signSkillEnvelope(unsigned, privateKey, publicKey);
  const filesB64: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(opts.files ?? {})) {
    filesB64[path] = bytesToBase64(bytes);
  }
  const bundle: SkillRegistryBundle = {
    submitter_motebit_id: "did:key:z-test",
    envelope,
    body: bytesToBase64(body),
    files: Object.keys(filesB64).length > 0 ? filesB64 : undefined,
    submitted_at: 0,
    featured: false,
  };
  return { bundle, publicKey };
}

describe("verifyBundleLocally", () => {
  it("returns ok=true on a freshly-signed bundle", async () => {
    const { bundle } = await buildSignedBundle({});
    const result = await verifyBundleLocally(bundle);
    expect(result.ok).toBe(true);
    expect(result.outcome.kind).toBe("verified");
    expect(result.steps.envelope.ok).toBe(true);
    expect(result.steps.bodyHash.ok).toBe(true);
    expect(result.steps.files).toEqual([]);
  });

  it("verifies file hashes when bundle ships auxiliary files", async () => {
    const fileBytes = new TextEncoder().encode("#!/bin/sh\necho hello\n");
    const { bundle } = await buildSignedBundle({ files: { "scripts/run.sh": fileBytes } });
    const result = await verifyBundleLocally(bundle);
    expect(result.ok).toBe(true);
    expect(result.steps.files).toHaveLength(1);
    expect(result.steps.files[0]!.ok).toBe(true);
    expect(result.steps.files[0]!.path).toBe("scripts/run.sh");
  });

  it("flags body_hash mismatch when the bundle body bytes were swapped post-sign", async () => {
    const { bundle } = await buildSignedBundle({ bodyText: "# Original\n" });
    const tamperedBody = bytesToBase64(new TextEncoder().encode("# Tampered\n"));
    const tampered: SkillRegistryBundle = { ...bundle, body: tamperedBody };
    const result = await verifyBundleLocally(tampered);
    expect(result.ok).toBe(false);
    expect(result.outcome.kind).toBe("body_hash_mismatch");
    expect(result.steps.envelope.ok).toBe(true); // envelope itself untouched
    expect(result.steps.bodyHash.ok).toBe(false);
  });

  it("flags envelope failure when the signature doesn't match", async () => {
    const { bundle } = await buildSignedBundle({});
    // Tamper with the envelope's body_hash field: this changes the signed
    // canonical bytes, so verifySkillEnvelopeDetailed must reject.
    const tampered: SkillRegistryBundle = {
      ...bundle,
      envelope: { ...bundle.envelope, body_hash: "f".repeat(64) },
    };
    const result = await verifyBundleLocally(tampered);
    expect(result.ok).toBe(false);
    expect(result.outcome.kind).toBe("envelope_failed");
    if (result.outcome.kind === "envelope_failed") {
      expect(result.outcome.reason).toBe("ed25519_mismatch");
    }
  });

  it("flags file_hash_mismatch when an auxiliary file's bytes were swapped", async () => {
    const original = new TextEncoder().encode("original\n");
    const { bundle } = await buildSignedBundle({ files: { "scripts/run.sh": original } });
    const tamperedFiles = { ...(bundle.files ?? {}) };
    tamperedFiles["scripts/run.sh"] = bytesToBase64(new TextEncoder().encode("tampered\n"));
    const tampered: SkillRegistryBundle = { ...bundle, files: tamperedFiles };
    const result = await verifyBundleLocally(tampered);
    expect(result.ok).toBe(false);
    expect(result.outcome.kind).toBe("file_hash_mismatch");
    if (result.outcome.kind === "file_hash_mismatch") {
      expect(result.outcome.path).toBe("scripts/run.sh");
    }
  });

  it("flags missing-file when the envelope declares a file but the bundle didn't ship it", async () => {
    const original = new TextEncoder().encode("declared\n");
    const { bundle } = await buildSignedBundle({ files: { "scripts/run.sh": original } });
    const stripped: SkillRegistryBundle = { ...bundle, files: {} };
    const result = await verifyBundleLocally(stripped);
    expect(result.ok).toBe(false);
    expect(result.steps.files[0]!.ok).toBe(false);
    expect(result.steps.files[0]!.actual).toBeNull();
  });
});
