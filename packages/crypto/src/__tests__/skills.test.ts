import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import type { SkillEnvelope, SkillManifest } from "@motebit/protocol";

import {
  canonicalizeSkillManifestBytes,
  canonicalizeSkillEnvelopeBytes,
  signSkillManifest,
  signSkillEnvelope,
  verifySkillManifest,
  verifySkillManifestDetailed,
  verifySkillEnvelope,
  verifySkillEnvelopeDetailed,
} from "../index";

if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeKeypair() {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey };
}

function makeUnsignedManifest(): Omit<SkillManifest, "motebit"> & {
  motebit: Omit<SkillManifest["motebit"], "signature">;
} {
  return {
    name: "example-skill",
    description: "Walks through the example procedure.",
    version: "1.0.0",
    platforms: ["macos", "linux"],
    metadata: {
      author: "Jane Doe",
      category: "software-development",
      tags: ["example", "test"],
    },
    motebit: {
      spec_version: "1.0",
      sensitivity: "none",
      hardware_attestation: { required: false, minimum_score: 0 },
    },
  };
}

const BODY = new TextEncoder().encode(
  "# Example Skill\n\n## When to Use\n\nWhen the test fires.\n\n## Procedure\n\n1. Step one.\n2. Step two.\n",
);

// ---------------------------------------------------------------------------
// Manifest round-trip + tamper detection
// ---------------------------------------------------------------------------

describe("verifySkillManifest", () => {
  it("round-trip: signed manifest verifies under its own key", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const signed = await signSkillManifest(makeUnsignedManifest(), privateKey, publicKey, BODY);
    expect(signed.motebit.signature).toBeDefined();
    expect(signed.motebit.signature?.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(signed.motebit.signature?.public_key).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifySkillManifest(signed, BODY, publicKey)).toBe(true);
  });

  it("fails with `no_signature` when manifest is unsigned", async () => {
    const { publicKey } = await makeKeypair();
    const unsigned = makeUnsignedManifest() as SkillManifest;
    const detail = await verifySkillManifestDetailed(unsigned, BODY, publicKey);
    expect(detail).toEqual({ valid: false, reason: "no_signature" });
  });

  it("fails with `wrong_suite` when suite doesn't match v1", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const signed = await signSkillManifest(makeUnsignedManifest(), privateKey, publicKey, BODY);
    const tampered: SkillManifest = {
      ...signed,
      motebit: {
        ...signed.motebit,
        signature: { ...signed.motebit.signature!, suite: "eddsa-jcs-2022" },
      },
    };
    const detail = await verifySkillManifestDetailed(tampered, BODY, publicKey);
    expect(detail).toEqual({ valid: false, reason: "wrong_suite" });
  });

  it("fails with `bad_public_key` when supplied key doesn't match signature.public_key", async () => {
    const signer = await makeKeypair();
    const other = await makeKeypair();
    const signed = await signSkillManifest(
      makeUnsignedManifest(),
      signer.privateKey,
      signer.publicKey,
      BODY,
    );
    const detail = await verifySkillManifestDetailed(signed, BODY, other.publicKey);
    expect(detail).toEqual({ valid: false, reason: "bad_public_key" });
  });

  it("fails with `bad_signature_value` when value isn't valid base64url", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const signed = await signSkillManifest(makeUnsignedManifest(), privateKey, publicKey, BODY);
    const tampered: SkillManifest = {
      ...signed,
      motebit: {
        ...signed.motebit,
        signature: { ...signed.motebit.signature!, value: "!!!not-base64url!!!" },
      },
    };
    const detail = await verifySkillManifestDetailed(tampered, BODY, publicKey);
    expect(detail).toEqual({ valid: false, reason: "bad_signature_value" });
  });

  it("fails with `ed25519_mismatch` when body bytes are tampered post-sign", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const signed = await signSkillManifest(makeUnsignedManifest(), privateKey, publicKey, BODY);
    const tamperedBody = new TextEncoder().encode("# Tampered\n");
    const detail = await verifySkillManifestDetailed(signed, tamperedBody, publicKey);
    expect(detail).toEqual({ valid: false, reason: "ed25519_mismatch" });
  });

  it("fails with `ed25519_mismatch` when manifest field is tampered post-sign", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const signed = await signSkillManifest(makeUnsignedManifest(), privateKey, publicKey, BODY);
    const tampered: SkillManifest = { ...signed, name: "evil-skill" };
    const detail = await verifySkillManifestDetailed(tampered, BODY, publicKey);
    expect(detail).toEqual({ valid: false, reason: "ed25519_mismatch" });
  });
});

// ---------------------------------------------------------------------------
// Envelope round-trip
// ---------------------------------------------------------------------------

describe("verifySkillEnvelope", () => {
  it("round-trip: signed envelope verifies under its own key", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const signedManifest = await signSkillManifest(
      makeUnsignedManifest(),
      privateKey,
      publicKey,
      BODY,
    );
    const unsignedEnvelope: Omit<SkillEnvelope, "signature"> = {
      spec_version: "1.0",
      skill: {
        name: signedManifest.name,
        version: signedManifest.version,
        content_hash: "a".repeat(64),
      },
      manifest: signedManifest,
      body_hash: "b".repeat(64),
      files: [{ path: "scripts/run.sh", hash: "c".repeat(64) }],
    };
    const signed = await signSkillEnvelope(unsignedEnvelope, privateKey, publicKey);
    expect(await verifySkillEnvelope(signed, publicKey)).toBe(true);
  });

  it("fails with `ed25519_mismatch` when nested manifest is swapped post-sign", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const signedManifest = await signSkillManifest(
      makeUnsignedManifest(),
      privateKey,
      publicKey,
      BODY,
    );
    const unsignedEnvelope: Omit<SkillEnvelope, "signature"> = {
      spec_version: "1.0",
      skill: {
        name: signedManifest.name,
        version: signedManifest.version,
        content_hash: "a".repeat(64),
      },
      manifest: signedManifest,
      body_hash: "b".repeat(64),
      files: [],
    };
    const signed = await signSkillEnvelope(unsignedEnvelope, privateKey, publicKey);
    const tamperedNested: SkillManifest = { ...signedManifest, version: "9.9.9" };
    const tampered: SkillEnvelope = { ...signed, manifest: tamperedNested };
    const detail = await verifySkillEnvelopeDetailed(tampered, publicKey);
    expect(detail).toEqual({ valid: false, reason: "ed25519_mismatch" });
  });
});

// ---------------------------------------------------------------------------
// Canonicalization determinism
// ---------------------------------------------------------------------------

describe("canonicalizeSkillManifestBytes", () => {
  it("is deterministic — same inputs produce identical bytes", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const signed = await signSkillManifest(makeUnsignedManifest(), privateKey, publicKey, BODY);
    const a = canonicalizeSkillManifestBytes(signed, BODY);
    const b = canonicalizeSkillManifestBytes(signed, BODY);
    expect(a).toEqual(b);
  });

  it("strips signature.value but preserves suite and public_key in canonical form", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const signed = await signSkillManifest(makeUnsignedManifest(), privateKey, publicKey, BODY);
    const bytes = canonicalizeSkillManifestBytes(signed, BODY);
    const text = new TextDecoder().decode(bytes);
    const sig = signed.motebit.signature!;
    expect(text).not.toContain(sig.value);
    expect(text).toContain(sig.suite);
    expect(text).toContain(sig.public_key);
  });
});

describe("canonicalizeSkillEnvelopeBytes", () => {
  it("strips envelope signature.value while preserving suite and public_key", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const signedManifest = await signSkillManifest(
      makeUnsignedManifest(),
      privateKey,
      publicKey,
      BODY,
    );
    const unsigned: Omit<SkillEnvelope, "signature"> = {
      spec_version: "1.0",
      skill: {
        name: signedManifest.name,
        version: signedManifest.version,
        content_hash: "a".repeat(64),
      },
      manifest: signedManifest,
      body_hash: "b".repeat(64),
      files: [],
    };
    const signed = await signSkillEnvelope(unsigned, privateKey, publicKey);
    const text = new TextDecoder().decode(canonicalizeSkillEnvelopeBytes(signed));
    expect(text).not.toContain(signed.signature.value);
    expect(text).toContain(signed.signature.suite);
    expect(text).toContain(signed.signature.public_key);
  });
});
