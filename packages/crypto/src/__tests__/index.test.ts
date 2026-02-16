import { describe, it, expect } from "vitest";
import {
  generateKey,
  generateNonce,
  encrypt,
  decrypt,
  deriveKey,
  hash,
  createDeletionCertificate,
  secureErase,
} from "../index";

// ---------------------------------------------------------------------------
// generateKey()
// ---------------------------------------------------------------------------

describe("generateKey", () => {
  it("returns a Uint8Array of 32 bytes", () => {
    const key = generateKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("generates different keys on successive calls", () => {
    const a = generateKey();
    const b = generateKey();
    // Extremely unlikely to be equal
    expect(a).not.toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// generateNonce()
// ---------------------------------------------------------------------------

describe("generateNonce", () => {
  it("returns a Uint8Array of 12 bytes", () => {
    const nonce = generateNonce();
    expect(nonce).toBeInstanceOf(Uint8Array);
    expect(nonce.length).toBe(12);
  });

  it("generates different nonces on successive calls", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// encrypt() / decrypt() roundtrip
// ---------------------------------------------------------------------------

describe("encrypt and decrypt", () => {
  it("roundtrips plaintext correctly", async () => {
    const key = generateKey();
    const plaintext = new TextEncoder().encode("Hello, Mote!");
    const encrypted = await encrypt(plaintext, key);

    expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array);
    expect(encrypted.nonce).toBeInstanceOf(Uint8Array);
    expect(encrypted.nonce.length).toBe(12);
    expect(encrypted.tag).toBeInstanceOf(Uint8Array);
    expect(encrypted.tag.length).toBe(16);

    const decrypted = await decrypt(encrypted, key);
    expect(new TextDecoder().decode(decrypted)).toBe("Hello, Mote!");
  });

  it("fails to decrypt with wrong key", async () => {
    const key1 = generateKey();
    const key2 = generateKey();
    const plaintext = new TextEncoder().encode("secret data");
    const encrypted = await encrypt(plaintext, key1);

    await expect(decrypt(encrypted, key2)).rejects.toThrow();
  });

  it("roundtrips empty data", async () => {
    const key = generateKey();
    const plaintext = new Uint8Array(0);
    const encrypted = await encrypt(plaintext, key);
    const decrypted = await decrypt(encrypted, key);
    expect(decrypted.length).toBe(0);
  });

  it("roundtrips large data", async () => {
    const key = generateKey();
    const plaintext = new Uint8Array(10000);
    for (let i = 0; i < plaintext.length; i++) {
      plaintext[i] = i % 256;
    }
    const encrypted = await encrypt(plaintext, key);
    const decrypted = await decrypt(encrypted, key);
    expect(decrypted).toEqual(plaintext);
  });
});

// ---------------------------------------------------------------------------
// deriveKey()
// ---------------------------------------------------------------------------

describe("deriveKey", () => {
  it("produces a 32-byte key", async () => {
    const salt = new Uint8Array(16);
    const derived = await deriveKey("password", salt, 1000);
    expect(derived).toBeInstanceOf(Uint8Array);
    expect(derived.length).toBe(32);
  });

  it("produces deterministic output with same inputs", async () => {
    const salt = new TextEncoder().encode("fixed-salt-value");
    const a = await deriveKey("my-password", salt, 1000);
    const b = await deriveKey("my-password", salt, 1000);
    expect(a).toEqual(b);
  });

  it("produces different output with different passwords", async () => {
    const salt = new TextEncoder().encode("fixed-salt-value");
    const a = await deriveKey("password-a", salt, 1000);
    const b = await deriveKey("password-b", salt, 1000);
    expect(a).not.toEqual(b);
  });

  it("produces different output with different salts", async () => {
    const saltA = new TextEncoder().encode("salt-a");
    const saltB = new TextEncoder().encode("salt-b");
    const a = await deriveKey("same-password", saltA, 1000);
    const b = await deriveKey("same-password", saltB, 1000);
    expect(a).not.toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// hash()
// ---------------------------------------------------------------------------

describe("hash", () => {
  it("produces a hex string of 64 characters (SHA-256)", async () => {
    const data = new TextEncoder().encode("test data");
    const result = await hash(data);
    expect(typeof result).toBe("string");
    expect(result.length).toBe(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it("produces consistent output for the same input", async () => {
    const data = new TextEncoder().encode("hello");
    const a = await hash(data);
    const b = await hash(data);
    expect(a).toBe(b);
  });

  it("produces different output for different inputs", async () => {
    const a = await hash(new TextEncoder().encode("input-a"));
    const b = await hash(new TextEncoder().encode("input-b"));
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// createDeletionCertificate()
// ---------------------------------------------------------------------------

describe("createDeletionCertificate", () => {
  it("creates a valid deletion certificate", async () => {
    const cert = await createDeletionCertificate(
      "node-123",
      "memory",
      "user-456",
    );

    expect(cert.target_id).toBe("node-123");
    expect(cert.target_type).toBe("memory");
    expect(cert.deleted_by).toBe("user-456");
    expect(typeof cert.deleted_at).toBe("number");
    expect(cert.deleted_at).toBeGreaterThan(0);
    expect(typeof cert.tombstone_hash).toBe("string");
    expect(cert.tombstone_hash.length).toBe(64);
  });

  it("creates different hashes for different targets", async () => {
    const certA = await createDeletionCertificate("a", "memory", "user");
    const certB = await createDeletionCertificate("b", "memory", "user");
    expect(certA.tombstone_hash).not.toBe(certB.tombstone_hash);
  });

  it("supports event and identity target types", async () => {
    const eventCert = await createDeletionCertificate("e1", "event", "user");
    expect(eventCert.target_type).toBe("event");

    const idCert = await createDeletionCertificate("i1", "identity", "user");
    expect(idCert.target_type).toBe("identity");
  });
});

// ---------------------------------------------------------------------------
// secureErase()
// ---------------------------------------------------------------------------

describe("secureErase", () => {
  it("zeros the array", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    secureErase(data);
    expect(data.every((b) => b === 0)).toBe(true);
  });

  it("zeros a large array", () => {
    const data = new Uint8Array(1024);
    crypto.getRandomValues(data);
    secureErase(data);
    expect(data.every((b) => b === 0)).toBe(true);
  });
});
