import { describe, it, expect } from "vitest";
import {
  generateKey,
  generateNonce,
  generateSalt,
  encrypt,
  decrypt,
  deriveKey,
  deriveSyncEncryptionKey,
  hash,
  createDeletionCertificate,
  secureErase,
  generateKeypair,
  sign,
  verify,
  createSignedToken,
  verifySignedToken,
  signExecutionReceipt,
  verifyExecutionReceipt,
  signSovereignPaymentReceipt,
  verifyReceiptChain,
  signKeySuccession,
  verifyKeySuccession,
  signGuardianRecoverySuccession,
  signGuardianRevocation,
  verifyGuardianRevocation,
  verifySuccessionChain,
  didKeyToPublicKey,
  type SignedTokenPayload,
  type SignableReceipt,
  type KnownKeys,
  base58btcEncode,
  hexToBytes,
  publicKeyToDidKey,
  hexPublicKeyToDidKey,
  bytesToHex,
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
// generateSalt()
// ---------------------------------------------------------------------------

describe("generateSalt", () => {
  it("returns a Uint8Array of 16 bytes", () => {
    const salt = generateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(16);
  });

  it("generates different salts on successive calls", () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a).not.toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// encrypt() / decrypt() roundtrip
// ---------------------------------------------------------------------------

describe("encrypt and decrypt", () => {
  it("roundtrips plaintext correctly", async () => {
    const key = generateKey();
    const plaintext = new TextEncoder().encode("Hello, Motebit!");
    const encrypted = await encrypt(plaintext, key);

    expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array);
    expect(encrypted.nonce).toBeInstanceOf(Uint8Array);
    expect(encrypted.nonce.length).toBe(12);
    expect(encrypted.tag).toBeInstanceOf(Uint8Array);
    expect(encrypted.tag.length).toBe(16);

    const decrypted = await decrypt(encrypted, key);
    expect(new TextDecoder().decode(decrypted)).toBe("Hello, Motebit!");
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
// deriveSyncEncryptionKey()
// ---------------------------------------------------------------------------

describe("deriveSyncEncryptionKey", () => {
  it("produces a 32-byte key", async () => {
    const kp = await generateKeypair();
    const derived = await deriveSyncEncryptionKey(kp.privateKey);
    expect(derived).toBeInstanceOf(Uint8Array);
    expect(derived.length).toBe(32);
  });

  it("is deterministic — same private key produces same output", async () => {
    const kp = await generateKeypair();
    const a = await deriveSyncEncryptionKey(kp.privateKey);
    const b = await deriveSyncEncryptionKey(kp.privateKey);
    expect(a).toEqual(b);
  });

  it("different private keys produce different output", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const a = await deriveSyncEncryptionKey(kpA.privateKey);
    const b = await deriveSyncEncryptionKey(kpB.privateKey);
    expect(a).not.toEqual(b);
  });

  it("round-trips through encrypt/decrypt", async () => {
    const kp = await generateKeypair();
    const key = await deriveSyncEncryptionKey(kp.privateKey);
    const plaintext = new TextEncoder().encode("sync payload");
    const encrypted = await encrypt(plaintext, key);
    const decrypted = await decrypt(encrypted, key);
    expect(new TextDecoder().decode(decrypted)).toBe("sync payload");
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
    const cert = await createDeletionCertificate("node-123", "memory", "user-456");

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

// ---------------------------------------------------------------------------
// Ed25519: generateKeypair()
// ---------------------------------------------------------------------------

describe("generateKeypair", () => {
  it("returns 32-byte keys", async () => {
    const kp = await generateKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it("generates different keypairs on successive calls", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    expect(a.publicKey).not.toEqual(b.publicKey);
    expect(a.privateKey).not.toEqual(b.privateKey);
  });
});

// ---------------------------------------------------------------------------
// Ed25519: sign() / verify()
// ---------------------------------------------------------------------------

describe("sign and verify", () => {
  it("round-trips correctly", async () => {
    const kp = await generateKeypair();
    const message = new TextEncoder().encode("Hello, Ed25519!");
    const sig = await sign(message, kp.privateKey);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
    const valid = await verify(sig, message, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("rejects tampered message", async () => {
    const kp = await generateKeypair();
    const message = new TextEncoder().encode("Original message");
    const sig = await sign(message, kp.privateKey);
    const tampered = new TextEncoder().encode("Tampered message");
    const valid = await verify(sig, tampered, kp.publicKey);
    expect(valid).toBe(false);
  });

  it("rejects signature verified with wrong public key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const message = new TextEncoder().encode("test");
    const sig = await sign(message, kpA.privateKey);
    const valid = await verify(sig, message, kpB.publicKey);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Signed Tokens
// ---------------------------------------------------------------------------

describe("createSignedToken / verifySignedToken", () => {
  it("round-trips correctly", async () => {
    const kp = await generateKeypair();
    const payload: SignedTokenPayload = {
      mid: "mote-123",
      did: "device-456",
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
      aud: "sync",
    };
    const token = await createSignedToken(payload, kp.privateKey);
    expect(typeof token).toBe("string");
    expect(token).toContain(".");

    const result = await verifySignedToken(token, kp.publicKey);
    expect(result).not.toBeNull();
    expect(result!.mid).toBe("mote-123");
    expect(result!.did).toBe("device-456");
    expect(result!.aud).toBe("sync");
  });

  it("round-trips with audience claim preserved", async () => {
    const kp = await generateKeypair();
    const payload: SignedTokenPayload = {
      mid: "mote-123",
      did: "device-456",
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
      aud: "task:submit",
    };
    const token = await createSignedToken(payload, kp.privateKey);
    const result = await verifySignedToken(token, kp.publicKey);
    expect(result).not.toBeNull();
    expect(result!.aud).toBe("task:submit");
  });

  it("rejects tokens without audience binding (cross-endpoint replay prevention)", async () => {
    const kp = await generateKeypair();
    // Intentionally omit aud to test runtime guard against malformed payloads
    const payload = {
      mid: "mote-123",
      did: "device-456",
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
    } as SignedTokenPayload;
    const token = await createSignedToken(payload, kp.privateKey);
    const result = await verifySignedToken(token, kp.publicKey);
    expect(result).toBeNull();
  });

  it("rejects expired token", async () => {
    const kp = await generateKeypair();
    const payload: SignedTokenPayload = {
      mid: "mote-123",
      did: "device-456",
      iat: Date.now() - 10 * 60 * 1000,
      exp: Date.now() - 1, // Already expired
      jti: crypto.randomUUID(),
      aud: "sync",
    };
    const token = await createSignedToken(payload, kp.privateKey);
    const result = await verifySignedToken(token, kp.publicKey);
    expect(result).toBeNull();
  });

  it("rejects invalid signature (wrong key)", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const payload: SignedTokenPayload = {
      mid: "mote-123",
      did: "device-456",
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
      aud: "sync",
    };
    const token = await createSignedToken(payload, kpA.privateKey);
    const result = await verifySignedToken(token, kpB.publicKey);
    expect(result).toBeNull();
  });

  it("rejects malformed token (no dot)", async () => {
    const kp = await generateKeypair();
    const result = await verifySignedToken("nodothere", kp.publicKey);
    expect(result).toBeNull();
  });

  it("rejects token without jti (replay attack protection)", async () => {
    const kp = await generateKeypair();
    // Intentionally omit jti and aud to test runtime guard against malformed payloads
    const payload = {
      mid: "mote-123",
      did: "device-456",
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000,
    } as SignedTokenPayload;
    const token = await createSignedToken(payload, kp.privateKey);
    const result = await verifySignedToken(token, kp.publicKey);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Execution Receipt Signing
// ---------------------------------------------------------------------------

describe("signExecutionReceipt / verifyExecutionReceipt", () => {
  function makeReceipt(): Omit<SignableReceipt, "signature"> {
    return {
      task_id: "task-001",
      motebit_id: "mote-123",
      device_id: "device-456",
      submitted_at: 1700000000000,
      completed_at: 1700000060000,
      status: "completed",
      result: "Task completed successfully",
      tools_used: ["search", "calculate"],
      memories_formed: 2,
      prompt_hash: "a".repeat(64),
      result_hash: "b".repeat(64),
    };
  }

  it("round-trips correctly (sign → verify = true)", async () => {
    const kp = await generateKeypair();
    const receipt = makeReceipt();
    const signed = await signExecutionReceipt(receipt, kp.privateKey);

    expect(signed.signature).toBeTruthy();
    expect(signed.task_id).toBe("task-001");

    const valid = await verifyExecutionReceipt(signed, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("detects tampering (modify result → verify = false)", async () => {
    const kp = await generateKeypair();
    const receipt = makeReceipt();
    const signed = await signExecutionReceipt(receipt, kp.privateKey);

    const tampered: SignableReceipt = { ...signed, result: "TAMPERED" };
    const valid = await verifyExecutionReceipt(tampered, kp.publicKey);
    expect(valid).toBe(false);
  });

  it("rejects wrong key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const receipt = makeReceipt();
    const signed = await signExecutionReceipt(receipt, kpA.privateKey);

    const valid = await verifyExecutionReceipt(signed, kpB.publicKey);
    expect(valid).toBe(false);
  });

  it("is deterministic (same receipt → same signature)", async () => {
    const kp = await generateKeypair();
    const receipt = makeReceipt();
    const signed1 = await signExecutionReceipt(receipt, kp.privateKey);
    const signed2 = await signExecutionReceipt(receipt, kp.privateKey);

    expect(signed1.signature).toBe(signed2.signature);
  });

  it("round-trips with delegation_receipts present", async () => {
    const kp = await generateKeypair();
    const delegationReceipt: SignableReceipt = {
      ...makeReceipt(),
      task_id: "delegated-001",
      signature: "delegate-sig",
    };
    const receipt = {
      ...makeReceipt(),
      delegation_receipts: [delegationReceipt],
    };
    const signed = await signExecutionReceipt(receipt, kp.privateKey);

    expect(signed.delegation_receipts).toHaveLength(1);
    expect(signed.delegation_receipts![0]!.task_id).toBe("delegated-001");

    const valid = await verifyExecutionReceipt(signed, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("backward compat: receipt without delegation_receipts still verifies", async () => {
    const kp = await generateKeypair();
    const receipt = makeReceipt(); // no delegation_receipts field
    const signed = await signExecutionReceipt(receipt, kp.privateKey);

    expect(signed.delegation_receipts).toBeUndefined();
    const valid = await verifyExecutionReceipt(signed, kp.publicKey);
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyReceiptChain()
// ---------------------------------------------------------------------------

describe("verifyReceiptChain", () => {
  function makeReceipt(
    overrides?: Partial<Omit<SignableReceipt, "signature">>,
  ): Omit<SignableReceipt, "signature"> {
    return {
      task_id: "task-001",
      motebit_id: "mote-123",
      device_id: "device-456",
      submitted_at: 1700000000000,
      completed_at: 1700000060000,
      status: "completed",
      result: "Task completed successfully",
      tools_used: ["search", "calculate"],
      memories_formed: 2,
      prompt_hash: "a".repeat(64),
      result_hash: "b".repeat(64),
      ...overrides,
    };
  }

  it("single receipt verifies", async () => {
    const kp = await generateKeypair();
    const signed = await signExecutionReceipt(makeReceipt(), kp.privateKey);

    const knownKeys: KnownKeys = new Map([["mote-123", kp.publicKey]]);
    const result = await verifyReceiptChain(signed, knownKeys);

    expect(result.task_id).toBe("task-001");
    expect(result.motebit_id).toBe("mote-123");
    expect(result.verified).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.delegations).toEqual([]);
  });

  it("single receipt fails with wrong key", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const signed = await signExecutionReceipt(makeReceipt(), kpA.privateKey);

    const knownKeys: KnownKeys = new Map([["mote-123", kpB.publicKey]]);
    const result = await verifyReceiptChain(signed, knownKeys);

    expect(result.verified).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.delegations).toEqual([]);
  });

  it("unknown motebit_id", async () => {
    const kp = await generateKeypair();
    const signed = await signExecutionReceipt(makeReceipt(), kp.privateKey);

    const knownKeys: KnownKeys = new Map(); // empty — no known keys
    const result = await verifyReceiptChain(signed, knownKeys);

    expect(result.verified).toBe(false);
    expect(result.error).toBe("unknown motebit_id");
    expect(result.delegations).toEqual([]);
  });

  it("two-level chain — both verify", async () => {
    const parentKp = await generateKeypair();
    const childKp = await generateKeypair();

    // Sign the child (delegation) receipt first
    const childSigned = await signExecutionReceipt(
      makeReceipt({ task_id: "delegated-001", motebit_id: "mote-child" }),
      childKp.privateKey,
    );

    // Sign the parent receipt with the delegation included
    const parentSigned = await signExecutionReceipt(
      {
        ...makeReceipt({ task_id: "parent-001", motebit_id: "mote-parent" }),
        delegation_receipts: [childSigned],
      },
      parentKp.privateKey,
    );

    const knownKeys: KnownKeys = new Map([
      ["mote-parent", parentKp.publicKey],
      ["mote-child", childKp.publicKey],
    ]);
    const result = await verifyReceiptChain(parentSigned, knownKeys);

    expect(result.task_id).toBe("parent-001");
    expect(result.verified).toBe(true);
    expect(result.delegations).toHaveLength(1);
    expect(result.delegations[0]!.task_id).toBe("delegated-001");
    expect(result.delegations[0]!.motebit_id).toBe("mote-child");
    expect(result.delegations[0]!.verified).toBe(true);
    expect(result.delegations[0]!.delegations).toEqual([]);
  });

  it("chain where parent verifies but delegation fails", async () => {
    const parentKp = await generateKeypair();
    const childKp = await generateKeypair();

    // Sign child receipt
    const childSigned = await signExecutionReceipt(
      makeReceipt({ task_id: "delegated-002", motebit_id: "mote-unknown-child" }),
      childKp.privateKey,
    );

    // Sign parent receipt with delegation
    const parentSigned = await signExecutionReceipt(
      {
        ...makeReceipt({ task_id: "parent-002", motebit_id: "mote-parent" }),
        delegation_receipts: [childSigned],
      },
      parentKp.privateKey,
    );

    // Only parent key is known — child's motebit_id is missing from knownKeys
    const knownKeys: KnownKeys = new Map([["mote-parent", parentKp.publicKey]]);
    const result = await verifyReceiptChain(parentSigned, knownKeys);

    expect(result.verified).toBe(true);
    expect(result.delegations).toHaveLength(1);
    expect(result.delegations[0]!.verified).toBe(false);
    expect(result.delegations[0]!.error).toBe("unknown motebit_id");
  });

  it("verifies using embedded public_key when not in knownKeys", async () => {
    const kp = await generateKeypair();
    const receiptWithKey = { ...makeReceipt(), public_key: bytesToHex(kp.publicKey) };
    const signed = await signExecutionReceipt(receiptWithKey, kp.privateKey);

    // Empty knownKeys — verification falls back to receipt.public_key
    const knownKeys: KnownKeys = new Map();
    const result = await verifyReceiptChain(signed, knownKeys);

    expect(result.verified).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("empty delegation_receipts still verifies with empty delegations array", async () => {
    const kp = await generateKeypair();
    const signed = await signExecutionReceipt(
      { ...makeReceipt(), delegation_receipts: [] },
      kp.privateKey,
    );

    const knownKeys: KnownKeys = new Map([["mote-123", kp.publicKey]]);
    const result = await verifyReceiptChain(signed, knownKeys);

    expect(result.verified).toBe(true);
    expect(result.delegations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// did:key — W3C DID derivation from Ed25519 public keys
// ---------------------------------------------------------------------------

describe("base58btcEncode", () => {
  it("encodes empty bytes as empty string", () => {
    expect(base58btcEncode(new Uint8Array(0))).toBe("");
  });

  it("encodes leading zeros as '1' characters", () => {
    const result = base58btcEncode(new Uint8Array([0, 0, 0, 1]));
    expect(result.startsWith("111")).toBe(true);
    expect(result).toBe("1112");
  });

  it("encodes a known byte sequence correctly", () => {
    // "Hello" in base58btc = "9Ajdvzr"
    const hello = new TextEncoder().encode("Hello");
    expect(base58btcEncode(hello)).toBe("9Ajdvzr");
  });
});

describe("hexToBytes", () => {
  it("converts hex string to Uint8Array", () => {
    const bytes = hexToBytes("deadbeef");
    expect(bytes).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("handles all-zero hex", () => {
    const bytes = hexToBytes("00000000");
    expect(bytes).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it("handles empty string", () => {
    const bytes = hexToBytes("");
    expect(bytes.length).toBe(0);
  });
});

describe("publicKeyToDidKey", () => {
  it("produces a did:key URI starting with did:key:z", async () => {
    const kp = await generateKeypair();
    const did = publicKeyToDidKey(kp.publicKey);
    expect(did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("is deterministic — same key produces same DID", async () => {
    const kp = await generateKeypair();
    const a = publicKeyToDidKey(kp.publicKey);
    const b = publicKeyToDidKey(kp.publicKey);
    expect(a).toBe(b);
  });

  it("different keys produce different DIDs", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    expect(publicKeyToDidKey(kpA.publicKey)).not.toBe(publicKeyToDidKey(kpB.publicKey));
  });

  it("rejects non-32-byte input", () => {
    expect(() => publicKeyToDidKey(new Uint8Array(16))).toThrow("32 bytes");
    expect(() => publicKeyToDidKey(new Uint8Array(64))).toThrow("32 bytes");
  });

  it("matches known test vector", () => {
    // Test vector: 32 zero bytes → known did:key
    // Multicodec prefix ed01 + 32 zero bytes → base58btc
    const zeroKey = new Uint8Array(32);
    const did = publicKeyToDidKey(zeroKey);
    expect(did).toMatch(/^did:key:z/);
    // The prefix bytes (0xed, 0x01) followed by 32 zeros should produce a consistent result
    const prefixed = new Uint8Array(34);
    prefixed[0] = 0xed;
    prefixed[1] = 0x01;
    expect(did).toBe(`did:key:z${base58btcEncode(prefixed)}`);
  });
});

describe("hexPublicKeyToDidKey", () => {
  it("converts hex public key to did:key", async () => {
    const kp = await generateKeypair();
    const hex = Array.from(kp.publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const didFromHex = hexPublicKeyToDidKey(hex);
    const didFromBytes = publicKeyToDidKey(kp.publicKey);
    expect(didFromHex).toBe(didFromBytes);
  });
});

// ---------------------------------------------------------------------------
// signKeySuccession / verifyKeySuccession
// ---------------------------------------------------------------------------

describe("signKeySuccession", () => {
  it("creates a valid succession record signed by both keys", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
      "routine rotation",
    );

    expect(record.old_public_key).toHaveLength(64);
    expect(record.new_public_key).toHaveLength(64);
    expect(record.old_key_signature).toHaveLength(128);
    expect(record.new_key_signature).toHaveLength(128);
    expect(record.reason).toBe("routine rotation");
    expect(record.timestamp).toBeTypeOf("number");
  });

  it("creates a record without reason", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
    );

    expect(record.reason).toBeUndefined();
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(true);
  });
});

describe("verifyKeySuccession", () => {
  it("verifies a valid succession record", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
      "compromise",
    );

    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(true);
  });

  it("rejects a record with tampered new_public_key", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
    );

    // Tamper with the new public key
    record.new_public_key = "ff".repeat(32);
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(false);
  });

  it("rejects a record with tampered old_key_signature", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
    );

    // Tamper with old key signature
    record.old_key_signature = "aa".repeat(64);
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(false);
  });

  it("rejects a record with tampered new_key_signature", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
    );

    // Tamper with new key signature
    record.new_key_signature = "bb".repeat(64);
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(false);
  });

  it("rejects a record with tampered timestamp", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      newKp.publicKey,
      oldKp.publicKey,
    );

    record.timestamp = record.timestamp + 1;
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(false);
  });

  it("returns false for invalid hex in public keys (catch block)", async () => {
    const record = {
      old_public_key: "not-valid-hex",
      new_public_key: "also-not-valid-hex",
      timestamp: Date.now(),
      old_key_signature: "aa".repeat(64),
      new_key_signature: "bb".repeat(64),
    };
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// didKeyToPublicKey error paths (index.ts lines 278-284)
// ---------------------------------------------------------------------------

describe("didKeyToPublicKey error paths", () => {
  it("rejects did:key with wrong multicodec prefix", () => {
    // Build a did:key with wrong prefix bytes (0x00, 0x00 instead of 0xed, 0x01)
    const fakeBytes = new Uint8Array(34);
    fakeBytes[0] = 0x00;
    fakeBytes[1] = 0x00;
    const encoded = `did:key:z${base58btcEncode(fakeBytes)}`;
    expect(() => didKeyToPublicKey(encoded)).toThrow("multicodec prefix");
  });

  it("rejects did:key with wrong decoded length", () => {
    // Build a did:key with only 20 bytes instead of 34
    const shortBytes = new Uint8Array(20);
    const encoded = `did:key:z${base58btcEncode(shortBytes)}`;
    expect(() => didKeyToPublicKey(encoded)).toThrow("expected 34 bytes");
  });
});

// ---------------------------------------------------------------------------
// verify() catch block (index.ts lines 361-362)
// ---------------------------------------------------------------------------

describe("verify error handling", () => {
  it("returns false when signature bytes are malformed (not 64 bytes)", async () => {
    const kp = await generateKeypair();
    const message = new TextEncoder().encode("test");
    // Pass a too-short signature — @noble/ed25519 will throw
    const badSig = new Uint8Array(10);
    const valid = await verify(badSig, message, kp.publicKey);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifySignedToken error paths (index.ts lines 419-420, 429-430)
// ---------------------------------------------------------------------------

describe("verifySignedToken error paths", () => {
  it("returns null when base64url payload is invalid (decode error)", async () => {
    const kp = await generateKeypair();
    // "!!!" is not valid base64url — atob will throw
    const result = await verifySignedToken("!!!.!!!", kp.publicKey);
    expect(result).toBeNull();
  });

  it("returns null when payload is valid base64 but not valid JSON", async () => {
    const kp = await generateKeypair();
    // Create a token where the payload is valid base64url but not JSON,
    // and the signature is valid for that payload
    const notJson = new TextEncoder().encode("this is not json");
    const payloadB64 = btoa(String.fromCharCode(...notJson))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const sig = await sign(notJson, kp.privateKey);
    const sigB64 = btoa(String.fromCharCode(...sig))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const token = `${payloadB64}.${sigB64}`;
    const result = await verifySignedToken(token, kp.publicKey);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyExecutionReceipt catch block (index.ts lines 518-519)
// ---------------------------------------------------------------------------

describe("verifyExecutionReceipt error paths", () => {
  it("returns false when signature is not valid base64url", async () => {
    const kp = await generateKeypair();
    const receipt: SignableReceipt = {
      task_id: "task-001",
      motebit_id: "mote-123",
      device_id: "device-456",
      submitted_at: 1700000000000,
      completed_at: 1700000060000,
      status: "completed",
      result: "ok",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "a".repeat(64),
      result_hash: "b".repeat(64),
      signature: "!!!not-valid-base64!!!",
    };
    const valid = await verifyExecutionReceipt(receipt, kp.publicKey);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guardian Recovery Succession (§3.8.3)
// ---------------------------------------------------------------------------

describe("signGuardianRecoverySuccession", () => {
  it("creates a valid guardian recovery record", async () => {
    const guardianKp = await generateKeypair();
    const oldKp = await generateKeypair(); // compromised key
    const newKp = await generateKeypair();

    const record = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
    );

    expect(record.recovery).toBe(true);
    expect(record.reason).toBe("guardian_recovery");
    expect(record.guardian_signature).toHaveLength(128);
    expect(record.new_key_signature).toHaveLength(128);
    expect(record.old_key_signature).toBeUndefined();
  });

  it("uses custom reason when provided", async () => {
    const guardianKp = await generateKeypair();
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
      "guardian_recovery: employee departure",
    );

    expect(record.reason).toBe("guardian_recovery: employee departure");
  });

  it("verifies with correct guardian public key", async () => {
    const guardianKp = await generateKeypair();
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
    );

    const guardianPubHex = bytesToHex(guardianKp.publicKey);
    const valid = await verifyKeySuccession(record, guardianPubHex);
    expect(valid).toBe(true);
  });

  it("rejects with wrong guardian public key", async () => {
    const guardianKp = await generateKeypair();
    const wrongGuardianKp = await generateKeypair();
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
    );

    const wrongPubHex = bytesToHex(wrongGuardianKp.publicKey);
    const valid = await verifyKeySuccession(record, wrongPubHex);
    expect(valid).toBe(false);
  });

  it("rejects guardian recovery when no guardian key provided", async () => {
    const guardianKp = await generateKeypair();
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
    );

    // No guardian key provided — must reject
    const valid = await verifyKeySuccession(record);
    expect(valid).toBe(false);
  });

  it("rejects when guardian_signature is tampered", async () => {
    const guardianKp = await generateKeypair();
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    const record = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
    );

    record.guardian_signature = "aa".repeat(64);
    const guardianPubHex = bytesToHex(guardianKp.publicKey);
    const valid = await verifyKeySuccession(record, guardianPubHex);
    expect(valid).toBe(false);
  });
});

describe("verifySuccessionChain with guardian recovery", () => {
  it("verifies a mixed chain: normal rotation → guardian recovery", async () => {
    const guardianKp = await generateKeypair();
    const kp1 = await generateKeypair(); // genesis
    const kp2 = await generateKeypair(); // normal rotation target
    const kp3 = await generateKeypair(); // guardian recovery target

    // Step 1: normal rotation kp1 → kp2
    const normalRecord = await signKeySuccession(
      kp1.privateKey,
      kp2.privateKey,
      kp2.publicKey,
      kp1.publicKey,
      "routine rotation",
    );

    // Small delay to ensure timestamp ordering
    await new Promise((r) => setTimeout(r, 5));

    // Step 2: guardian recovery kp2 → kp3 (kp2 compromised)
    const recoveryRecord = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      kp3.privateKey,
      kp2.publicKey,
      kp3.publicKey,
    );

    const guardianPubHex = bytesToHex(guardianKp.publicKey);

    const result = await verifySuccessionChain([normalRecord, recoveryRecord], guardianPubHex);

    expect(result.valid).toBe(true);
    expect(result.genesis_public_key).toBe(bytesToHex(kp1.publicKey));
    expect(result.current_public_key).toBe(bytesToHex(kp3.publicKey));
    expect(result.length).toBe(2);
  });

  it("rejects guardian recovery in chain without guardian key", async () => {
    const guardianKp = await generateKeypair();
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();

    const recoveryRecord = await signGuardianRecoverySuccession(
      guardianKp.privateKey,
      kp2.privateKey,
      kp1.publicKey,
      kp2.publicKey,
    );

    const result = await verifySuccessionChain([recoveryRecord]);
    expect(result.valid).toBe(false);
    expect(result.error?.message).toContain("guardian recovery but no guardian public key");
  });

  it("guardian key must not equal identity key", async () => {
    // This is a policy invariant: guardian.public_key !== identity.public_key
    // Enforced at identity generation, not chain verification — but let's verify
    // that a self-signed "guardian recovery" is still cryptographically valid
    // (the policy check happens at a higher layer)
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();

    // "Guardian" is actually kp1 itself — cryptographically valid but policy-invalid
    const record = await signGuardianRecoverySuccession(
      kp1.privateKey, // using identity key as guardian
      kp2.privateKey,
      kp1.publicKey,
      kp2.publicKey,
    );

    const pubHex = bytesToHex(kp1.publicKey);
    const valid = await verifyKeySuccession(record, pubHex);
    // Cryptographically valid — policy layer rejects this, not crypto
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guardian Revocation (§3.3.2) — dual authorization
// ---------------------------------------------------------------------------

describe("signGuardianRevocation + verifyGuardianRevocation", () => {
  it("creates and verifies a dual-signed revocation", async () => {
    const identityKp = await generateKeypair();
    const guardianKp = await generateKeypair();

    const revocation = await signGuardianRevocation(identityKp.privateKey, guardianKp.privateKey);

    expect(revocation.identity_signature).toHaveLength(128);
    expect(revocation.guardian_signature).toHaveLength(128);
    expect(revocation.timestamp).toBeTypeOf("number");

    const valid = await verifyGuardianRevocation(
      revocation,
      bytesToHex(identityKp.publicKey),
      bytesToHex(guardianKp.publicKey),
    );
    expect(valid).toBe(true);
  });

  it("rejects with wrong identity key", async () => {
    const identityKp = await generateKeypair();
    const guardianKp = await generateKeypair();
    const wrongKp = await generateKeypair();

    const revocation = await signGuardianRevocation(identityKp.privateKey, guardianKp.privateKey);

    const valid = await verifyGuardianRevocation(
      revocation,
      bytesToHex(wrongKp.publicKey), // wrong identity key
      bytesToHex(guardianKp.publicKey),
    );
    expect(valid).toBe(false);
  });

  it("rejects with wrong guardian key", async () => {
    const identityKp = await generateKeypair();
    const guardianKp = await generateKeypair();
    const wrongKp = await generateKeypair();

    const revocation = await signGuardianRevocation(identityKp.privateKey, guardianKp.privateKey);

    const valid = await verifyGuardianRevocation(
      revocation,
      bytesToHex(identityKp.publicKey),
      bytesToHex(wrongKp.publicKey), // wrong guardian key
    );
    expect(valid).toBe(false);
  });

  it("rejects tampered timestamp", async () => {
    const identityKp = await generateKeypair();
    const guardianKp = await generateKeypair();

    const revocation = await signGuardianRevocation(identityKp.privateKey, guardianKp.privateKey);

    const tampered = { ...revocation, timestamp: revocation.timestamp + 1 };
    const valid = await verifyGuardianRevocation(
      tampered,
      bytesToHex(identityKp.publicKey),
      bytesToHex(guardianKp.publicKey),
    );
    expect(valid).toBe(false);
  });

  it("uses provided timestamp", async () => {
    const identityKp = await generateKeypair();
    const guardianKp = await generateKeypair();
    const ts = 1700000000000;

    const revocation = await signGuardianRevocation(
      identityKp.privateKey,
      guardianKp.privateKey,
      ts,
    );

    expect(revocation.timestamp).toBe(ts);

    const valid = await verifyGuardianRevocation(
      revocation,
      bytesToHex(identityKp.publicKey),
      bytesToHex(guardianKp.publicKey),
    );
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// signSovereignPaymentReceipt() — sovereign trust signal, no relay involved
// ---------------------------------------------------------------------------

describe("signSovereignPaymentReceipt", () => {
  it("produces a verifiable ExecutionReceipt anchored to an onchain tx", async () => {
    const payeeKp = await generateKeypair();

    const receipt = await signSovereignPaymentReceipt(
      {
        payee_motebit_id: "payee-mote",
        payee_device_id: "payee-device",
        payer_motebit_id: "payer-mote",
        rail: "solana",
        tx_hash: "5JxYzExampleSolanaTxSignature",
        amount_micro: 5_000n,
        asset: "USDC",
        service_description: "search query",
        prompt_hash: "sha256:prompt",
        result_hash: "sha256:result",
        submitted_at: 1_700_000_000_000,
        completed_at: 1_700_000_001_000,
      },
      payeeKp.privateKey,
      payeeKp.publicKey,
    );

    // task_id anchors the trust signal to a globally unique onchain payment
    expect(receipt.task_id).toBe("solana:tx:5JxYzExampleSolanaTxSignature");
    // sovereign rail — no relay binding
    expect(receipt.relay_task_id).toBeUndefined();
    expect(receipt.motebit_id).toBe("payee-mote");
    expect(receipt.status).toBe("completed");
    expect(receipt.signature).toBeTruthy();

    // The signature must verify against the embedded public key — no relay
    // lookup, no registry, no third party. Self-contained trust artifact.
    const valid = await verifyExecutionReceipt(receipt, payeeKp.publicKey);
    expect(valid).toBe(true);
  });

  it("tampering with the amount breaks verification", async () => {
    const payeeKp = await generateKeypair();
    const receipt = await signSovereignPaymentReceipt(
      {
        payee_motebit_id: "payee",
        payee_device_id: "device",
        payer_motebit_id: "payer",
        rail: "solana",
        tx_hash: "txhash",
        amount_micro: 5_000n,
        asset: "USDC",
        service_description: "service",
        prompt_hash: "h1",
        result_hash: "h2",
        submitted_at: 1,
        completed_at: 2,
      },
      payeeKp.privateKey,
      payeeKp.publicKey,
    );

    // Forge a higher amount in the result string after signing
    const tampered = {
      ...receipt,
      result: receipt.result.replace("5000", "999999999"),
    };
    const valid = await verifyExecutionReceipt(tampered, payeeKp.publicKey);
    expect(valid).toBe(false);
  });

  it("a different signer cannot produce a valid receipt for the same payment", async () => {
    const payeeKp = await generateKeypair();
    const attackerKp = await generateKeypair();

    const real = await signSovereignPaymentReceipt(
      {
        payee_motebit_id: "payee",
        payee_device_id: "device",
        payer_motebit_id: "payer",
        rail: "solana",
        tx_hash: "txhash",
        amount_micro: 1_000n,
        asset: "USDC",
        service_description: "service",
        prompt_hash: "h1",
        result_hash: "h2",
        submitted_at: 1,
        completed_at: 2,
      },
      payeeKp.privateKey,
      payeeKp.publicKey,
    );

    // Attacker can't validate the real receipt against their own pubkey
    const validAgainstAttacker = await verifyExecutionReceipt(real, attackerKp.publicKey);
    expect(validAgainstAttacker).toBe(false);
  });

  it("works with an empty tools_used array by default", async () => {
    const payeeKp = await generateKeypair();
    const receipt = await signSovereignPaymentReceipt(
      {
        payee_motebit_id: "p",
        payee_device_id: "d",
        payer_motebit_id: "x",
        rail: "solana",
        tx_hash: "h",
        amount_micro: 1n,
        asset: "USDC",
        service_description: "s",
        prompt_hash: "ph",
        result_hash: "rh",
        submitted_at: 0,
        completed_at: 0,
      },
      payeeKp.privateKey,
      payeeKp.publicKey,
    );
    expect(receipt.tools_used).toEqual([]);
  });
});
