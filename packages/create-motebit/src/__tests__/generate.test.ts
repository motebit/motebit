import { describe, it, expect } from "vitest";
import { verify } from "@motebit/verify";
import { generateIdentity, GOVERNANCE_PRESETS, toHex, fromHex, decrypt } from "../generate.js";
import type { TrustMode } from "../generate.js";

describe("generateIdentity", () => {
  it("produces a motebit.md that passes @motebit/verify", async () => {
    const result = await generateIdentity({
      name: "test-agent",
      trustMode: "guarded",
      passphrase: "test-passphrase-123",
    });

    const verification = await verify(result.identityFileContent);
    expect(verification.valid).toBe(true);
    expect(verification.identity).not.toBeNull();
    expect(verification.identity!.motebit_id).toBe(result.motebitId);
    expect(verification.identity!.identity.public_key).toBe(result.publicKeyHex);
  });

  it("generates UUID v7 identifiers (version 7, variant 10)", async () => {
    const result = await generateIdentity({
      name: "test",
      trustMode: "guarded",
      passphrase: "pw",
    });

    // Standard UUID format
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(result.motebitId).toMatch(uuidPattern);
    expect(result.deviceId).toMatch(uuidPattern);

    // Version nibble (char 15, 0-indexed in the hex without dashes) should be '7'
    expect(result.motebitId[14]).toBe("7");
    expect(result.deviceId[14]).toBe("7");

    // Variant nibble (char 20 in the formatted string) should be 8, 9, a, or b
    expect(result.motebitId[19]).toMatch(/[89ab]/);
    expect(result.deviceId[19]).toMatch(/[89ab]/);
  });

  it("generates unique motebit_id and device_id per call", async () => {
    const a = await generateIdentity({
      name: "agent-a",
      trustMode: "guarded",
      passphrase: "pass-a",
    });
    const b = await generateIdentity({
      name: "agent-b",
      trustMode: "guarded",
      passphrase: "pass-b",
    });

    expect(a.motebitId).not.toBe(b.motebitId);
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
  });

  it("public key in identity file matches the returned publicKeyHex", async () => {
    const result = await generateIdentity({
      name: "test",
      trustMode: "minimal",
      passphrase: "pw",
    });

    const verification = await verify(result.identityFileContent);
    expect(verification.identity!.identity.public_key).toBe(result.publicKeyHex);
  });

  it("encrypted key round-trips with correct passphrase", async () => {
    const passphrase = "round-trip-test-passphrase";
    const result = await generateIdentity({
      name: "test",
      trustMode: "guarded",
      passphrase,
    });

    // Decrypt the encrypted key
    const enc = result.encryptedKey;
    const salt = fromHex(enc.salt);
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(passphrase) as BufferSource,
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt as BufferSource, iterations: 600_000, hash: "SHA-256" },
      keyMaterial,
      256,
    );
    const key = new Uint8Array(bits);

    const plaintext = await decrypt(
      {
        ciphertext: fromHex(enc.ciphertext),
        nonce: fromHex(enc.nonce),
        tag: fromHex(enc.tag),
      },
      key,
    );

    const decryptedHex = new TextDecoder().decode(plaintext);
    // The decrypted value should be a valid hex string (64 chars for Ed25519 private key)
    expect(decryptedHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each<TrustMode>(["minimal", "guarded", "full"])(
    "governance preset for '%s' is correct",
    async (mode) => {
      const result = await generateIdentity({
        name: "test",
        trustMode: mode,
        passphrase: "pw",
      });

      const verification = await verify(result.identityFileContent);
      const gov = verification.identity!.governance;
      const expected = GOVERNANCE_PRESETS[mode];

      expect(gov.trust_mode).toBe(mode);
      expect(gov.max_risk_auto).toBe(expected.max_risk_auto);
      expect(gov.require_approval_above).toBe(expected.require_approval_above);
      expect(gov.deny_above).toBe(expected.deny_above);
    },
  );

  it("identity file contains spec version", async () => {
    const result = await generateIdentity({
      name: "test",
      trustMode: "guarded",
      passphrase: "pw",
    });

    expect(result.identityFileContent).toContain("motebit/identity@1.0");
  });

  it("identity file contains device entry", async () => {
    const result = await generateIdentity({
      name: "my-agent",
      trustMode: "guarded",
      passphrase: "pw",
    });

    const verification = await verify(result.identityFileContent);
    expect(verification.identity!.devices).toHaveLength(1);
    expect(verification.identity!.devices[0]!.device_id).toBe(result.deviceId);
    expect(verification.identity!.devices[0]!.name).toBe("my-agent");
    expect(verification.identity!.devices[0]!.public_key).toBe(result.publicKeyHex);
  });

  it("encrypted key fields are hex strings", async () => {
    const result = await generateIdentity({
      name: "test",
      trustMode: "guarded",
      passphrase: "pw",
    });

    const hexPattern = /^[0-9a-f]+$/;
    expect(result.encryptedKey.ciphertext).toMatch(hexPattern);
    expect(result.encryptedKey.nonce).toMatch(hexPattern);
    expect(result.encryptedKey.tag).toMatch(hexPattern);
    expect(result.encryptedKey.salt).toMatch(hexPattern);
    // Nonce is 12 bytes = 24 hex chars
    expect(result.encryptedKey.nonce).toHaveLength(24);
    // Salt is 16 bytes = 32 hex chars (NIST SP 800-132: >= 128 bits)
    expect(result.encryptedKey.salt).toHaveLength(32);
    // Tag is 16 bytes = 32 hex chars
    expect(result.encryptedKey.tag).toHaveLength(32);
  });
});

describe("service identity generation", () => {
  it("produces a service motebit.md that passes verification", async () => {
    const result = await generateIdentity({
      name: "flight-search",
      trustMode: "guarded",
      passphrase: "test-passphrase",
      service: {
        type: "service",
        service_name: "Flight Search",
        service_description: "Search and book flights across major airlines",
        capabilities: ["flight_search", "flight_booking"],
        service_url: "https://flights.example.com",
      },
    });

    const verification = await verify(result.identityFileContent);
    expect(verification.valid).toBe(true);
    expect(verification.identity!.type).toBe("service");
    expect(verification.identity!.service_name).toBe("Flight Search");
    expect(verification.identity!.service_description).toBe(
      "Search and book flights across major airlines",
    );
    expect(verification.identity!.capabilities).toEqual(["flight_search", "flight_booking"]);
    expect(verification.identity!.service_url).toBe("https://flights.example.com");
  });

  it("uses service governance presets with higher max_risk_auto", async () => {
    const result = await generateIdentity({
      name: "test-service",
      trustMode: "guarded",
      passphrase: "pw",
      service: {
        type: "service",
        service_name: "Test Service",
        service_description: "A test service",
      },
    });

    const verification = await verify(result.identityFileContent);
    expect(verification.identity!.governance.max_risk_auto).toBe("R2_WRITE");
    expect(verification.identity!.governance.require_approval_above).toBe("R2_WRITE");
  });

  it("personal identity is unchanged when service is not provided", async () => {
    const result = await generateIdentity({
      name: "personal-agent",
      trustMode: "guarded",
      passphrase: "pw",
    });

    const verification = await verify(result.identityFileContent);
    expect(verification.identity!.type).toBeUndefined();
    expect(verification.identity!.service_name).toBeUndefined();
    expect(verification.identity!.governance.max_risk_auto).toBe("R1_DRAFT");
  });
});

describe("toHex / fromHex round-trip", () => {
  it("round-trips correctly", () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const hex = toHex(original);
    expect(hex).toBe("00017f80ff");
    const back = fromHex(hex);
    expect(back).toEqual(original);
  });
});
