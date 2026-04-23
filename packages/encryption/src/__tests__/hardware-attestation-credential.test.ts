import { describe, it, expect } from "vitest";
import type { HardwareAttestationClaim } from "@motebit/protocol";
import { generateKeypair } from "../index";
import { composeHardwareAttestationCredential } from "../hardware-attestation-credential";
import { verifyVerifiableCredential } from "../credentials";

// ---------------------------------------------------------------------------
// composeHardwareAttestationCredential
// ---------------------------------------------------------------------------
//
// Direct unit tests for the canonical composer. The CLI, desktop, and mobile
// `mint-hardware-credential` surfaces all delegate here; their integration
// tests cover the downstream behavior but cross-package coverage doesn't
// count. These tests pin the envelope shape, the subject fields, the
// self-attestation binding, and the proof validity.

function makeClaim(overrides: Partial<HardwareAttestationClaim> = {}): HardwareAttestationClaim {
  return {
    platform: "software",
    key_exported: false,
    ...overrides,
  };
}

describe("composeHardwareAttestationCredential", () => {
  it("produces a VerifiableCredential with the W3C envelope shape", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const publicKeyHex = Array.from(publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const cred = await composeHardwareAttestationCredential({
      publicKey,
      publicKeyHex,
      privateKey,
      hardwareAttestation: makeClaim(),
      now: 1_700_000_000_000,
    });
    expect(cred["@context"]).toEqual([
      "https://www.w3.org/ns/credentials/v2",
      "https://motebit.com/ns/credentials/v1",
    ]);
    expect(cred.type).toEqual(["VerifiableCredential", "AgentTrustCredential"]);
    expect(cred.issuer).toMatch(/^did:key:z/);
    expect(cred.validFrom).toBe("2023-11-14T22:13:20.000Z");
  });

  it("self-attestation: issuer === subject.id === did:key of public key", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const publicKeyHex = Array.from(publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const cred = await composeHardwareAttestationCredential({
      publicKey,
      publicKeyHex,
      privateKey,
      hardwareAttestation: makeClaim(),
      now: Date.now(),
    });
    expect(cred.credentialSubject.id).toBe(cred.issuer);
  });

  it("lowercases identity_public_key — binding-check normalization", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const publicKeyHex = Array.from(publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const cred = await composeHardwareAttestationCredential({
      publicKey,
      publicKeyHex: publicKeyHex.toUpperCase(),
      privateKey,
      hardwareAttestation: makeClaim(),
      now: Date.now(),
    });
    expect(cred.credentialSubject.identity_public_key).toBe(publicKeyHex.toLowerCase());
  });

  it("stamps attested_at with the caller's clock", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const publicKeyHex = Array.from(publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const fixed = 1_234_567_890_000;
    const cred = await composeHardwareAttestationCredential({
      publicKey,
      publicKeyHex,
      privateKey,
      hardwareAttestation: makeClaim(),
      now: fixed,
    });
    expect(cred.credentialSubject.attested_at).toBe(fixed);
  });

  it("embeds the hardware_attestation claim verbatim (software)", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const publicKeyHex = Array.from(publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const cred = await composeHardwareAttestationCredential({
      publicKey,
      publicKeyHex,
      privateKey,
      hardwareAttestation: makeClaim(),
      now: Date.now(),
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("software");
    expect(cred.credentialSubject.hardware_attestation.key_exported).toBe(false);
  });

  it("embeds the hardware_attestation claim verbatim (device_check with receipt)", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const publicKeyHex = Array.from(publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const claim: HardwareAttestationClaim = {
      platform: "device_check",
      key_exported: false,
      attestation_receipt: "att-obj.key-id.client-data-hash",
    };
    const cred = await composeHardwareAttestationCredential({
      publicKey,
      publicKeyHex,
      privateKey,
      hardwareAttestation: claim,
      now: Date.now(),
    });
    expect(cred.credentialSubject.hardware_attestation).toEqual(claim);
  });

  it("attaches an eddsa-jcs-2022 DataIntegrity proof", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const publicKeyHex = Array.from(publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const cred = await composeHardwareAttestationCredential({
      publicKey,
      publicKeyHex,
      privateKey,
      hardwareAttestation: makeClaim(),
      now: Date.now(),
    });
    expect(cred.proof.type).toBe("DataIntegrityProof");
    expect(cred.proof.cryptosuite).toBe("eddsa-jcs-2022");
    expect(cred.proof.proofPurpose).toBe("assertionMethod");
    expect(cred.proof.proofValue.length).toBeGreaterThan(0);
  });

  it("round-trips through verifyVerifiableCredential — proof verifies", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const publicKeyHex = Array.from(publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const cred = await composeHardwareAttestationCredential({
      publicKey,
      publicKeyHex,
      privateKey,
      hardwareAttestation: makeClaim(),
      now: Date.now(),
    });
    const valid = await verifyVerifiableCredential(cred);
    expect(valid).toBe(true);
  });

  it("tampering with identity_public_key breaks the proof", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const publicKeyHex = Array.from(publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const cred = await composeHardwareAttestationCredential({
      publicKey,
      publicKeyHex,
      privateKey,
      hardwareAttestation: makeClaim(),
      now: Date.now(),
    });
    const tampered = {
      ...cred,
      credentialSubject: {
        ...cred.credentialSubject,
        identity_public_key: "0".repeat(64),
      },
    };
    const valid = await verifyVerifiableCredential(tampered);
    expect(valid).toBe(false);
  });

  it("JSON-serialization roundtrip preserves verifiability", async () => {
    const { publicKey, privateKey } = await generateKeypair();
    const publicKeyHex = Array.from(publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const cred = await composeHardwareAttestationCredential({
      publicKey,
      publicKeyHex,
      privateKey,
      hardwareAttestation: makeClaim(),
      now: Date.now(),
    });
    const reparsed = JSON.parse(JSON.stringify(cred)) as typeof cred;
    const valid = await verifyVerifiableCredential(reparsed);
    expect(valid).toBe(true);
  });
});
