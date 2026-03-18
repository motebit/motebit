/**
 * E2E golden-path smoke test:
 *   generate identity -> verify -> decrypt private key -> confirm key match -> validate UUID v7
 *
 * Self-contained: no filesystem, no DB, no network.
 */

import { describe, it, expect } from "vitest";
import { verify } from "@motebit/verify";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { generateIdentity, fromHex, toHex, decrypt } from "../generate.js";

// @noble/ed25519 v3 requires explicit SHA-512 binding
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

describe("golden path: generate -> verify -> decrypt -> match", () => {
  const TEST_PARAMS = {
    name: "golden-test-agent",
    trustMode: "guarded" as const,
    passphrase: "golden-path-passphrase-42",
  };

  it("full round-trip: generate, verify, decrypt, and confirm key match", async () => {
    // Step 1: Generate identity
    const result = await generateIdentity(TEST_PARAMS);

    expect(result.motebitId).toBeTruthy();
    expect(result.deviceId).toBeTruthy();
    expect(result.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(result.identityFileContent).toContain("motebit/identity@1.0");

    // Step 2: Verify the generated motebit.md using @motebit/verify
    const verification = await verify(result.identityFileContent);

    expect(verification.valid).toBe(true);
    expect(verification.errors).toBeUndefined();
    expect(verification.identity).not.toBeNull();
    expect(verification.identity!.motebit_id).toBe(result.motebitId);
    expect(verification.identity!.identity.algorithm).toBe("Ed25519");
    expect(verification.identity!.identity.public_key).toBe(result.publicKeyHex);
    expect(verification.identity!.governance.trust_mode).toBe("guarded");
    expect(verification.identity!.devices).toHaveLength(1);
    expect(verification.identity!.devices[0]!.device_id).toBe(result.deviceId);
    expect(verification.identity!.devices[0]!.name).toBe(TEST_PARAMS.name);

    // Step 3: Decrypt the encrypted private key using the passphrase (PBKDF2 + AES-GCM)
    const enc = result.encryptedKey;
    const salt = fromHex(enc.salt);

    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(TEST_PARAMS.passphrase) as BufferSource,
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt as BufferSource,
        iterations: Number(process.env["MOTEBIT_PBKDF2_ITERATIONS"] ?? 600_000),
        hash: "SHA-256",
      },
      keyMaterial,
      256,
    );
    const derivedKey = new Uint8Array(bits);

    const plaintext = await decrypt(
      {
        ciphertext: fromHex(enc.ciphertext),
        nonce: fromHex(enc.nonce),
        tag: fromHex(enc.tag),
      },
      derivedKey,
    );

    const decryptedPrivateKeyHex = new TextDecoder().decode(plaintext);
    expect(decryptedPrivateKeyHex).toMatch(/^[0-9a-f]{64}$/);

    // Step 4: Verify the decrypted private key produces the same public key
    const privateKeyBytes = fromHex(decryptedPrivateKeyHex);
    const derivedPublicKey = await ed.getPublicKeyAsync(privateKeyBytes);
    const derivedPublicKeyHex = toHex(derivedPublicKey);

    expect(derivedPublicKeyHex).toBe(result.publicKeyHex);
    expect(derivedPublicKeyHex).toBe(verification.identity!.identity.public_key);

    // Step 5: Verify motebit_id is a valid UUID v7 (timestamp-based)
    // UUID v7 has version nibble 7 in position 13 and variant bits 10xx in position 19.
    const uuidV7Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(result.motebitId).toMatch(uuidV7Regex);
    expect(result.deviceId).toMatch(uuidV7Regex);

    // Verify the timestamp portion is recent (within the last minute)
    const timestampHex = result.motebitId.replace(/-/g, "").slice(0, 12);
    const timestampMs = parseInt(timestampHex, 16);
    const now = Date.now();
    expect(timestampMs).toBeGreaterThan(now - 60_000);
    expect(timestampMs).toBeLessThanOrEqual(now);
  });

  it("wrong passphrase fails to decrypt", async () => {
    const result = await generateIdentity(TEST_PARAMS);

    const enc = result.encryptedKey;
    const salt = fromHex(enc.salt);

    // Derive key with wrong passphrase
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("wrong-passphrase") as BufferSource,
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt as BufferSource,
        iterations: Number(process.env["MOTEBIT_PBKDF2_ITERATIONS"] ?? 600_000),
        hash: "SHA-256",
      },
      keyMaterial,
      256,
    );
    const wrongKey = new Uint8Array(bits);

    await expect(
      decrypt(
        {
          ciphertext: fromHex(enc.ciphertext),
          nonce: fromHex(enc.nonce),
          tag: fromHex(enc.tag),
        },
        wrongKey,
      ),
    ).rejects.toThrow();
  });

  it("tampered identity file fails verification", async () => {
    const result = await generateIdentity(TEST_PARAMS);

    // Tamper with the identity file content — change the trust mode
    const tampered = result.identityFileContent.replace("guarded", "full");

    const verification = await verify(tampered);
    expect(verification.valid).toBe(false);
    expect(verification.errors).toBeDefined();
  });
});
