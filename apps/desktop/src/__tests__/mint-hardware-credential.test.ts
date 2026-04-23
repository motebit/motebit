/**
 * Tests for desktop's `mintHardwareCredential` — the composer that
 * stitches mint-attestation + credential-signing into a single
 * verifiable artifact.
 *
 * End-to-end guarantee: the resulting credential round-trips through
 * `@motebit/crypto`'s `verify()` dispatcher with `valid: true` AND
 * `result.hardware_attestation.platform === "secure_enclave"` when the
 * Rust bridge returns a real SE receipt. When the bridge is absent or
 * errors, the credential still round-trips but the attestation falls
 * back to `platform: "software"` truthfully.
 */
import { describe, expect, it, beforeAll } from "vitest";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

import { verify } from "@motebit/crypto";
import { canonicalJson, toBase64Url } from "@motebit/crypto";

import { mintHardwareCredential } from "../mint-hardware-credential.js";
import type { InvokeFn } from "../tauri-storage.js";

beforeAll(() => {
  if (!ed.hashes.sha512) {
    ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
  }
});

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function makeIdentity(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
}> {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, publicKeyHex: toHex(publicKey) };
}

function makeInvoke(
  impl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): InvokeFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return impl as any;
}

/**
 * Simulate the Rust SE bridge: given the canonical body the TS side
 * would send for signing, generate an in-process P-256 keypair,
 * canonicalize body with the derived key, sign with sha256, and
 * return the same `{ body_base64, signature_der_base64 }` shape the
 * real Rust command emits. Lets us exercise the SE path without
 * needing macOS Vision / Security framework at test time.
 */
function simulateSeMint(args: {
  motebitId: string;
  deviceId: string;
  identityPublicKeyHex: string;
  attestedAt: number;
}): { body_base64: string; signature_der_base64: string } {
  const sePrivate = p256.utils.randomPrivateKey();
  const sePublicBytes = p256.getPublicKey(sePrivate, true);
  const sePublicHex = toHex(sePublicBytes);

  const bodyJson = canonicalJson({
    version: "1",
    algorithm: "ecdsa-p256-sha256",
    motebit_id: args.motebitId,
    device_id: args.deviceId,
    identity_public_key: args.identityPublicKeyHex.toLowerCase(),
    se_public_key: sePublicHex,
    attested_at: args.attestedAt,
  });
  const bodyBytes = new TextEncoder().encode(bodyJson);
  const digest = sha256(bodyBytes);
  const sig = p256.sign(digest, sePrivate, { prehash: false });
  const sigDer = sig.toDERRawBytes();

  return {
    body_base64: toBase64Url(bodyBytes),
    signature_der_base64: toBase64Url(sigDer),
  };
}

describe("mintHardwareCredential — SE happy path", () => {
  it("produces a credential with platform:'secure_enclave' when the bridge signs", async () => {
    const id = await makeIdentity();
    const invoke = makeInvoke(async (cmd, args) => {
      if (cmd === "se_available") return true;
      if (cmd === "se_mint_attestation") {
        return simulateSeMint({
          motebitId: args!.motebitId as string,
          deviceId: args!.deviceId as string,
          identityPublicKeyHex: args!.identityPublicKeyHex as string,
          attestedAt: args!.attestedAt as number,
        });
      }
      throw new Error(`unexpected: ${cmd}`);
    });
    const cred = await mintHardwareCredential({
      invoke,
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "01234567-89ab-cdef-0123-456789abcdef",
      deviceId: "dev-1",
      now: () => 1_700_000_000_000,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("secure_enclave");
    expect(cred.credentialSubject.hardware_attestation.attestation_receipt).toMatch(/\./);
  });

  it("SE credential verifies end-to-end — hardware: secure_enclave ✓", async () => {
    const id = await makeIdentity();
    const invoke = makeInvoke(async (cmd, args) => {
      if (cmd === "se_available") return true;
      if (cmd === "se_mint_attestation") {
        return simulateSeMint({
          motebitId: args!.motebitId as string,
          deviceId: args!.deviceId as string,
          identityPublicKeyHex: args!.identityPublicKeyHex as string,
          attestedAt: args!.attestedAt as number,
        });
      }
      throw new Error(`unexpected: ${cmd}`);
    });
    const cred = await mintHardwareCredential({
      invoke,
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "01234567-89ab-cdef-0123-456789abcdef",
      deviceId: "dev-1",
      now: () => Date.now(),
    });
    const result = await verify(cred);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(true);
    if (result.type !== "credential") throw new Error("expected credential");
    expect(result.hardware_attestation).toBeDefined();
    expect(result.hardware_attestation!.valid).toBe(true);
    expect(result.hardware_attestation!.platform).toBe("secure_enclave");
  });
});

describe("mintHardwareCredential — SE unavailable fallback", () => {
  it("emits platform:'software' when seAvailable returns false", async () => {
    const id = await makeIdentity();
    const invoke = makeInvoke(async (cmd) => {
      if (cmd === "se_available") return false;
      throw new Error(`unexpected call to ${cmd} — SE should be skipped`);
    });
    const cred = await mintHardwareCredential({
      invoke,
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot_test",
      deviceId: "dev_test",
      now: () => 1_700_000_000_000,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("software");
    expect(cred.credentialSubject.hardware_attestation.key_exported).toBe(false);
  });

  it("software-fallback credential still verifies — hardware: software ✗ (truthful)", async () => {
    const id = await makeIdentity();
    const invoke = makeInvoke(async (cmd) => {
      if (cmd === "se_available") return false;
      throw new Error(`unexpected call to ${cmd}`);
    });
    const cred = await mintHardwareCredential({
      invoke,
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot_test",
      deviceId: "dev_test",
      now: () => Date.now(),
    });
    const result = await verify(cred);
    expect(result.valid).toBe(true);
    if (result.type !== "credential") throw new Error("expected credential");
    expect(result.hardware_attestation?.platform).toBe("software");
    expect(result.hardware_attestation?.valid).toBe(false); // software sentinel = no hw channel
  });
});

describe("mintHardwareCredential — envelope shape", () => {
  it("self-attestation: issuer === subject.id === did:key of public key", async () => {
    const id = await makeIdentity();
    const invoke = makeInvoke(async () => false); // SE unavailable
    const cred = await mintHardwareCredential({
      invoke,
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
    });
    expect(cred.issuer).toMatch(/^did:key:z/);
    expect(cred.credentialSubject.id).toBe(cred.issuer);
  });

  it("type array includes VerifiableCredential + AgentTrustCredential", async () => {
    const id = await makeIdentity();
    const invoke = makeInvoke(async () => false);
    const cred = await mintHardwareCredential({
      invoke,
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
    });
    expect(cred.type).toEqual(["VerifiableCredential", "AgentTrustCredential"]);
  });

  it("proof is eddsa-jcs-2022", async () => {
    const id = await makeIdentity();
    const invoke = makeInvoke(async () => false);
    const cred = await mintHardwareCredential({
      invoke,
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
    });
    expect(cred.proof.cryptosuite).toBe("eddsa-jcs-2022");
    expect(cred.proof.type).toBe("DataIntegrityProof");
  });

  it("identity_public_key normalized to lowercase", async () => {
    const id = await makeIdentity();
    const invoke = makeInvoke(async () => false);
    const cred = await mintHardwareCredential({
      invoke,
      identityPublicKeyHex: id.publicKeyHex.toUpperCase(),
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
    });
    expect(cred.credentialSubject.identity_public_key).toBe(id.publicKeyHex.toLowerCase());
  });
});

describe("mintHardwareCredential — JSON roundtrip", () => {
  it("serializes + re-parses + re-verifies (stdout → motebit-verify pipe shape)", async () => {
    const id = await makeIdentity();
    const invoke = makeInvoke(async (cmd, args) => {
      if (cmd === "se_available") return true;
      if (cmd === "se_mint_attestation") {
        return simulateSeMint({
          motebitId: args!.motebitId as string,
          deviceId: args!.deviceId as string,
          identityPublicKeyHex: args!.identityPublicKeyHex as string,
          attestedAt: args!.attestedAt as number,
        });
      }
      return undefined;
    });
    const cred = await mintHardwareCredential({
      invoke,
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
    });
    const reparsed = JSON.parse(JSON.stringify(cred)) as typeof cred;
    const result = await verify(reparsed);
    expect(result.valid).toBe(true);
    if (result.type !== "credential") throw new Error("expected credential");
    expect(result.hardware_attestation?.valid).toBe(true);
    expect(result.hardware_attestation?.platform).toBe("secure_enclave");
  });
});
