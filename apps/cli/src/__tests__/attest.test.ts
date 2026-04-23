/**
 * Tests for `motebit attest` — the pure credential-building helper.
 *
 * The full `handleAttest` handler loads the CLI config, prompts for a
 * passphrase, opens the persistence DB, and writes to stdout/file.
 * The pure-signing core is factored out as
 * `buildAttestationCredential(input)` so these tests exercise the
 * credential shape + signing round-trip without touching the
 * bootstrap machinery.
 *
 * End-to-end guarantee: a credential produced by this helper round-
 * trips through `@motebit/crypto`'s unified `verify()` dispatcher,
 * which in turn pipes the `credentialSubject.hardware_attestation`
 * claim through `verifyHardwareAttestationClaim`. The verifier CLI's
 * `formatHuman` consumes the result to show `hardware: software ✗`
 * (software sentinel — truthfully reports "no hardware channel").
 */
import { describe, expect, it, beforeAll } from "vitest";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import { verify } from "@motebit/crypto";

import { buildAttestationCredential } from "../subcommands/attest.js";

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

async function makeKeypair(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
}> {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, publicKeyHex: toHex(publicKey) };
}

describe("buildAttestationCredential", () => {
  it("produces a VerifiableCredential with the expected envelope shape", async () => {
    const kp = await makeKeypair();
    const cred = await buildAttestationCredential({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      publicKeyHex: kp.publicKeyHex,
      now: 1_700_000_000_000,
    });
    expect(cred.type).toEqual(["VerifiableCredential", "AgentTrustCredential"]);
    expect(cred.issuer).toMatch(/^did:key:z/);
    expect(cred.credentialSubject.id).toBe(cred.issuer); // self-attestation
    expect(cred.validFrom).toBe("2023-11-14T22:13:20.000Z");
    expect(cred["@context"]).toContain("https://www.w3.org/ns/credentials/v2");
  });

  it("embeds a software-custody hardware_attestation claim", async () => {
    const kp = await makeKeypair();
    const cred = await buildAttestationCredential({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      publicKeyHex: kp.publicKeyHex,
      now: Date.now(),
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("software");
    expect(cred.credentialSubject.hardware_attestation.key_exported).toBe(false);
  });

  it("lowercases the identity_public_key to preserve binding-check match", async () => {
    const kp = await makeKeypair();
    // Pass uppercase to prove normalization.
    const cred = await buildAttestationCredential({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      publicKeyHex: kp.publicKeyHex.toUpperCase(),
      now: Date.now(),
    });
    expect(cred.credentialSubject.identity_public_key).toBe(kp.publicKeyHex.toLowerCase());
  });

  it("stamps attested_at with the caller-supplied clock", async () => {
    const kp = await makeKeypair();
    const fixed = 1_234_567_890_000;
    const cred = await buildAttestationCredential({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      publicKeyHex: kp.publicKeyHex,
      now: fixed,
    });
    expect(cred.credentialSubject.attested_at).toBe(fixed);
  });

  it("attaches an eddsa-jcs-2022 DataIntegrity proof", async () => {
    const kp = await makeKeypair();
    const cred = await buildAttestationCredential({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      publicKeyHex: kp.publicKeyHex,
      now: Date.now(),
    });
    expect(cred.proof.type).toBe("DataIntegrityProof");
    expect(cred.proof.cryptosuite).toBe("eddsa-jcs-2022");
    expect(cred.proof.proofPurpose).toBe("assertionMethod");
    expect(cred.proof.proofValue.length).toBeGreaterThan(0);
  });

  it("verifies through @motebit/crypto's verify() dispatcher — round-trip", async () => {
    const kp = await makeKeypair();
    const cred = await buildAttestationCredential({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      publicKeyHex: kp.publicKeyHex,
      now: Date.now(),
    });
    const result = await verify(cred);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(true);
  });

  it("round-trip populates hardware_attestation on the verify result (software=invalid)", async () => {
    // Software sentinels are truthfully reported as `valid: false` in the
    // hardware-verification channel — no hardware evidence was offered, so
    // the verifier honestly says "no hardware channel." The credential's
    // own signature IS valid; the ancillary hardware channel is not.
    const kp = await makeKeypair();
    const cred = await buildAttestationCredential({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      publicKeyHex: kp.publicKeyHex,
      now: Date.now(),
    });
    const result = await verify(cred);
    if (result.type !== "credential") throw new Error("expected credential");
    expect(result.valid).toBe(true);
    expect(result.hardware_attestation).toBeDefined();
    expect(result.hardware_attestation?.platform).toBe("software");
    expect(result.hardware_attestation?.valid).toBe(false);
    expect(result.hardware_attestation?.errors[0]?.message).toContain("no-hardware sentinel");
  });

  it("round-trip survives JSON serialization (stdout → motebit-verify pipe shape)", async () => {
    const kp = await makeKeypair();
    const cred = await buildAttestationCredential({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      publicKeyHex: kp.publicKeyHex,
      now: Date.now(),
    });
    const json = JSON.stringify(cred);
    const reparsed = JSON.parse(json) as typeof cred;
    const result = await verify(reparsed);
    expect(result.valid).toBe(true);
  });

  it("tampering with the subject invalidates the proof", async () => {
    const kp = await makeKeypair();
    const cred = await buildAttestationCredential({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      publicKeyHex: kp.publicKeyHex,
      now: Date.now(),
    });
    const tampered = {
      ...cred,
      credentialSubject: {
        ...cred.credentialSubject,
        identity_public_key: "0".repeat(64), // different key → binding doesn't hold
      },
    };
    const result = await verify(tampered);
    expect(result.valid).toBe(false);
  });
});
