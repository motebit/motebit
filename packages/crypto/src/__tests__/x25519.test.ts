import { describe, it, expect } from "vitest";
import {
  generateX25519Keypair,
  x25519SharedSecret,
  deriveKeyTransferKey,
  buildKeyTransferPayload,
  decryptKeyTransfer,
  checkPreTransferBalance,
  generateKeypair,
  bytesToHex,
  base58btcEncode,
  secureErase,
} from "../index.js";

describe("X25519 key exchange", () => {
  it("generates 32-byte keypairs", () => {
    const kp = generateX25519Keypair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it("produces commutative shared secret", () => {
    const a = generateX25519Keypair();
    const b = generateX25519Keypair();
    const sharedAB = x25519SharedSecret(a.privateKey, b.publicKey);
    const sharedBA = x25519SharedSecret(b.privateKey, a.publicKey);
    expect(bytesToHex(sharedAB)).toBe(bytesToHex(sharedBA));
  });

  it("derives deterministic key from same inputs", async () => {
    const a = generateX25519Keypair();
    const b = generateX25519Keypair();
    const shared = x25519SharedSecret(a.privateKey, b.publicKey);
    const key1 = await deriveKeyTransferKey(shared, "ABC123");
    const key2 = await deriveKeyTransferKey(shared, "ABC123");
    expect(bytesToHex(key1)).toBe(bytesToHex(key2));
  });

  it("derives different keys for different pairing codes", async () => {
    const a = generateX25519Keypair();
    const b = generateX25519Keypair();
    const shared = x25519SharedSecret(a.privateKey, b.publicKey);
    const key1 = await deriveKeyTransferKey(shared, "ABC123");
    const key2 = await deriveKeyTransferKey(shared, "XYZ789");
    expect(bytesToHex(key1)).not.toBe(bytesToHex(key2));
  });

  it("normalizes pairing code case", async () => {
    const a = generateX25519Keypair();
    const b = generateX25519Keypair();
    const shared = x25519SharedSecret(a.privateKey, b.publicKey);
    const key1 = await deriveKeyTransferKey(shared, "abc123");
    const key2 = await deriveKeyTransferKey(shared, "ABC123");
    expect(bytesToHex(key1)).toBe(bytesToHex(key2));
  });
});

describe("Key transfer round-trip", () => {
  it("encrypts and decrypts identity seed correctly", async () => {
    const identity = await generateKeypair();
    const deviceB = generateX25519Keypair();
    const pairingCode = "ABC123";

    const payload = await buildKeyTransferPayload(
      identity.privateKey,
      bytesToHex(identity.publicKey),
      deviceB.publicKey,
      pairingCode,
    );

    expect(payload.x25519_pubkey).toHaveLength(64);
    expect(payload.encrypted_seed).toBeTruthy();
    expect(payload.nonce).toHaveLength(24);
    expect(payload.tag).toHaveLength(32);
    expect(payload.identity_pubkey_check).toBe(bytesToHex(identity.publicKey));

    const decrypted = await decryptKeyTransfer(payload, deviceB.privateKey, pairingCode);
    expect(bytesToHex(decrypted)).toBe(bytesToHex(identity.privateKey));
    secureErase(decrypted);
  });

  it("fails with wrong pairing code", async () => {
    const identity = await generateKeypair();
    const deviceB = generateX25519Keypair();

    const payload = await buildKeyTransferPayload(
      identity.privateKey,
      bytesToHex(identity.publicKey),
      deviceB.publicKey,
      "ABC123",
    );

    await expect(decryptKeyTransfer(payload, deviceB.privateKey, "WRONG1")).rejects.toThrow();
  });

  it("fails with wrong ephemeral key", async () => {
    const identity = await generateKeypair();
    const deviceB = generateX25519Keypair();
    const wrongKey = generateX25519Keypair();

    const payload = await buildKeyTransferPayload(
      identity.privateKey,
      bytesToHex(identity.publicKey),
      deviceB.publicKey,
      "ABC123",
    );

    await expect(decryptKeyTransfer(payload, wrongKey.privateKey, "ABC123")).rejects.toThrow();
  });

  it("fails with tampered ciphertext", async () => {
    const identity = await generateKeypair();
    const deviceB = generateX25519Keypair();

    const payload = await buildKeyTransferPayload(
      identity.privateKey,
      bytesToHex(identity.publicKey),
      deviceB.publicKey,
      "ABC123",
    );

    // Tamper with encrypted_seed
    const tampered = {
      ...payload,
      encrypted_seed: payload.encrypted_seed.replace(/^.{2}/, "ff"),
    };

    await expect(decryptKeyTransfer(tampered, deviceB.privateKey, "ABC123")).rejects.toThrow();
  });

  it("fails with wrong identity_pubkey_check", async () => {
    const identity = await generateKeypair();
    const other = await generateKeypair();
    const deviceB = generateX25519Keypair();

    const payload = await buildKeyTransferPayload(
      identity.privateKey,
      bytesToHex(other.publicKey), // wrong pubkey check
      deviceB.publicKey,
      "ABC123",
    );

    await expect(decryptKeyTransfer(payload, deviceB.privateKey, "ABC123")).rejects.toThrow(
      "derived pubkey does not match",
    );
  });
});

describe("Pre-transfer wallet safety check", () => {
  it("derives different Solana addresses for different seeds", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    // checkPreTransferBalance with an unreachable RPC URL — balances default to 0
    const result = await checkPreTransferBalance(a.privateKey, b.privateKey, "http://127.0.0.1:1");
    expect(result.oldAddress).toBeTruthy();
    expect(result.newAddress).toBeTruthy();
    expect(result.oldAddress).not.toBe(result.newAddress);
    expect(result.solLamports).toBe(0n);
    expect(result.tokenAccountCount).toBe(0);
    expect(result.hasAnyValue).toBe(false);
  });

  it("derives Solana address as base58 of public key", async () => {
    const kp = await generateKeypair();
    const expectedAddress = base58btcEncode(kp.publicKey);
    const result = await checkPreTransferBalance(
      kp.privateKey,
      kp.privateKey,
      "http://127.0.0.1:1",
    );
    expect(result.oldAddress).toBe(expectedAddress);
  });

  it("returns no value when same address (no-op case)", async () => {
    const kp = await generateKeypair();
    const result = await checkPreTransferBalance(kp.privateKey, kp.privateKey);
    expect(result.hasAnyValue).toBe(false);
  });
});
