/**
 * Tests for web's `mintHardwareCredential` — the composer that stitches
 * WebAuthn mint + credential-signing into a single verifiable artifact.
 *
 * End-to-end guarantees:
 *   1. Cascade WebAuthn → software: when the injected native fake
 *      reports `available: false`, the VC falls through to
 *      `platform: "software"` truthfully.
 *   2. When `create` throws (user cancels biometrics, timeout, no
 *      platform authenticator), the cascade falls back to software —
 *      never surfaces the error, never emits a false hardware claim.
 *   3. When `create` returns a well-formed attestation-object +
 *      clientDataJSON receipt, the `platform: "webauthn"` claim is
 *      emitted and the `attestation_receipt` is the two-segment
 *      base64url shape the verifier expects.
 *   4. The resulting VC round-trips through `@motebit/crypto`'s
 *      `verify()` envelope dispatcher (outer eddsa-jcs-2022 proof is
 *      valid).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import { verify } from "@motebit/crypto";

import {
  mintHardwareCredential,
  defaultWebAuthn,
  type NativeWebAuthn,
} from "../mint-hardware-credential.js";

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

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("web mintHardwareCredential — WebAuthn unavailable fallback", () => {
  it("emits platform:'software' when the native reports unavailable", async () => {
    const id = await makeIdentity();
    const native: NativeWebAuthn = {
      available: () => false,
      create: () => {
        throw new Error("should not be called");
      },
    };
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot_test",
      deviceId: "dev_test",
      rpId: "motebit.com",
      native,
      now: () => 1_700_000_000_000,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("software");
    expect(cred.credentialSubject.hardware_attestation.key_exported).toBe(false);
  });

  it("emits platform:'software' when the native throws during create", async () => {
    const id = await makeIdentity();
    const native: NativeWebAuthn = {
      available: () => true,
      create: async () => {
        throw new Error("user cancelled biometric prompt");
      },
    };
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot_test",
      deviceId: "dev_test",
      rpId: "motebit.com",
      native,
      now: () => 1_700_000_000_000,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("software");
  });

  it("software-fallback credential round-trips through verify() (outer proof valid)", async () => {
    const id = await makeIdentity();
    const native: NativeWebAuthn = {
      available: () => false,
      create: () => {
        throw new Error("unreachable");
      },
    };
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot_test",
      deviceId: "dev_test",
      rpId: "motebit.com",
      native,
      now: () => Date.now(),
    });
    const result = await verify(cred);
    expect(result.valid).toBe(true);
    if (result.type !== "credential") throw new Error("expected credential");
    expect(result.hardware_attestation?.platform).toBe("software");
  });
});

describe("web mintHardwareCredential — WebAuthn happy path", () => {
  it("emits platform:'webauthn' with 2-part receipt when native create succeeds", async () => {
    const id = await makeIdentity();
    const createSpy = vi.fn(async () => ({
      attestation_object_base64: toBase64Url(new Uint8Array([0x01, 0x02, 0x03])),
      client_data_json_base64: toBase64Url(new TextEncoder().encode("{}")),
    }));
    const native: NativeWebAuthn = {
      available: () => true,
      create: createSpy,
    };
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "01234567-89ab-cdef-0123-456789abcdef",
      deviceId: "dev-1",
      rpId: "motebit.com",
      native,
      now: () => 1_700_000_000_000,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("webauthn");
    expect(cred.credentialSubject.hardware_attestation.attestation_receipt).toBeDefined();
    expect(cred.credentialSubject.hardware_attestation.attestation_receipt!.split(".").length).toBe(
      2,
    );
    expect(createSpy).toHaveBeenCalledOnce();
    // Delegates the challenge as SHA256(canonical body) — 32 bytes.
    const args = createSpy.mock.calls[0]![0] as { challenge: Uint8Array };
    expect(args.challenge.length).toBe(32);
  });

  it("passes the correct rpId + rpName to the native create call", async () => {
    const id = await makeIdentity();
    const createSpy = vi.fn(async () => ({
      attestation_object_base64: toBase64Url(new Uint8Array([0x01])),
      client_data_json_base64: toBase64Url(new TextEncoder().encode("{}")),
    }));
    const native: NativeWebAuthn = { available: () => true, create: createSpy };
    await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      rpId: "motebit.com",
      rpName: "Motebit Test",
      native,
    });
    const callArgs = createSpy.mock.calls[0]![0] as {
      rpId: string;
      rpName: string;
      userId: Uint8Array;
    };
    expect(callArgs.rpId).toBe("motebit.com");
    expect(callArgs.rpName).toBe("Motebit Test");
  });

  it("defaults rpName to 'Motebit' when unspecified", async () => {
    const id = await makeIdentity();
    const createSpy = vi.fn(async () => ({
      attestation_object_base64: toBase64Url(new Uint8Array([0x01])),
      client_data_json_base64: toBase64Url(new TextEncoder().encode("{}")),
    }));
    const native: NativeWebAuthn = { available: () => true, create: createSpy };
    await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      rpId: "motebit.com",
      native,
    });
    const callArgs = createSpy.mock.calls[0]![0] as { rpName: string };
    expect(callArgs.rpName).toBe("Motebit");
  });
});

describe("web mintHardwareCredential — envelope shape", () => {
  it("self-attestation: issuer === subject.id === did:key of public key", async () => {
    const id = await makeIdentity();
    const native: NativeWebAuthn = { available: () => false, create: async () => ({}) as never };
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      rpId: "motebit.com",
      native,
    });
    expect(cred.issuer).toMatch(/^did:key:z/);
    expect(cred.credentialSubject.id).toBe(cred.issuer);
  });

  it("type array includes VerifiableCredential + AgentTrustCredential", async () => {
    const id = await makeIdentity();
    const native: NativeWebAuthn = { available: () => false, create: async () => ({}) as never };
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      rpId: "motebit.com",
      native,
    });
    expect(cred.type).toEqual(["VerifiableCredential", "AgentTrustCredential"]);
  });

  it("proof is eddsa-jcs-2022", async () => {
    const id = await makeIdentity();
    const native: NativeWebAuthn = { available: () => false, create: async () => ({}) as never };
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      rpId: "motebit.com",
      native,
    });
    expect(cred.proof.cryptosuite).toBe("eddsa-jcs-2022");
    expect(cred.proof.type).toBe("DataIntegrityProof");
  });

  it("identity_public_key normalized to lowercase", async () => {
    const id = await makeIdentity();
    const native: NativeWebAuthn = { available: () => false, create: async () => ({}) as never };
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex.toUpperCase(),
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      rpId: "motebit.com",
      native,
    });
    expect(cred.credentialSubject.identity_public_key).toBe(id.publicKeyHex.toLowerCase());
  });
});

describe("web mintHardwareCredential — default native (SSR safety)", () => {
  it("defaultWebAuthn reports unavailable when navigator.credentials is missing (Node SSR)", () => {
    // In the vitest/Node environment, `navigator` has no `.credentials`
    // API. The default native must report unavailable so SSR code paths
    // fall back to software cleanly.
    expect(defaultWebAuthn.available()).toBe(false);
  });

  it("mint call uses defaultWebAuthn when no native is supplied and falls to software", async () => {
    const id = await makeIdentity();
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      rpId: "motebit.com",
      // no `native` — uses defaultWebAuthn
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("software");
  });
});
