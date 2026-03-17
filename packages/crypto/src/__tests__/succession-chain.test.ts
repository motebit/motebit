import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  signKeySuccession,
  verifySuccessionChain,
  bytesToHex,
  type KeySuccessionRecord,
} from "../index";

// Helper: create a succession record with a specific timestamp
async function createSuccessionRecord(
  oldKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array },
  newKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array },
  reason?: string,
): Promise<KeySuccessionRecord> {
  return signKeySuccession(
    oldKeyPair.privateKey,
    newKeyPair.privateKey,
    newKeyPair.publicKey,
    oldKeyPair.publicKey,
    reason,
  );
}

describe("verifySuccessionChain", () => {
  it("verifies a valid chain of 3 records (A→B→C→D)", async () => {
    const keyA = await generateKeypair();
    const keyB = await generateKeypair();
    const keyC = await generateKeypair();
    const keyD = await generateKeypair();

    // Build chain with explicit timestamps to guarantee ordering
    const chain = await buildOrderedChain(
      [keyA, keyB, keyC, keyD],
      ["rotation-1", "rotation-2", "rotation-3"],
    );

    const result = await verifySuccessionChain(chain);

    expect(result.valid).toBe(true);
    expect(result.genesis_public_key).toBe(bytesToHex(keyA.publicKey));
    expect(result.current_public_key).toBe(bytesToHex(keyD.publicKey));
    expect(result.length).toBe(3);
    expect(result.error).toBeUndefined();
  });

  it("verifies a single record chain", async () => {
    const keyA = await generateKeypair();
    const keyB = await generateKeypair();

    const record = await createSuccessionRecord(keyA, keyB, "single rotation");
    const result = await verifySuccessionChain([record]);

    expect(result.valid).toBe(true);
    expect(result.genesis_public_key).toBe(bytesToHex(keyA.publicKey));
    expect(result.current_public_key).toBe(bytesToHex(keyB.publicKey));
    expect(result.length).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it("returns invalid for an empty chain", async () => {
    const result = await verifySuccessionChain([]);

    expect(result.valid).toBe(false);
    expect(result.genesis_public_key).toBe("");
    expect(result.current_public_key).toBe("");
    expect(result.length).toBe(0);
    expect(result.error).toEqual({ index: 0, message: "Empty succession chain" });
  });

  it("detects a broken link (new_public_key mismatch)", async () => {
    const keyA = await generateKeypair();
    const keyB = await generateKeypair();
    const keyC = await generateKeypair();
    const keyD = await generateKeypair();

    // Record 0: A→B (valid), Record 1: D→C (valid signatures, but D !== B — broken link)
    const chainWithBrokenLink = [
      await createSuccessionRecordWithTimestamp(keyA, keyB, 1000, "rot-1"),
      await createSuccessionRecordWithTimestamp(keyD, keyC, 2000, "rot-2"),
    ];

    const result = await verifySuccessionChain(chainWithBrokenLink);

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.index).toBe(1);
    expect(result.error!.message).toContain("Chain break");
  });

  it("detects temporal ordering violation", async () => {
    const keyA = await generateKeypair();
    const keyB = await generateKeypair();
    const keyC = await generateKeypair();

    // Create two records where the second has an earlier timestamp
    const rec1 = await createSuccessionRecordWithTimestamp(keyA, keyB, 2000, "rot-1");
    const rec2 = await createSuccessionRecordWithTimestamp(keyB, keyC, 1000, "rot-2"); // earlier!

    const result = await verifySuccessionChain([rec1, rec2]);

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.index).toBe(1);
    expect(result.error!.message).toContain("Temporal ordering violation");
  });

  it("detects an invalid signature in chain", async () => {
    const keyA = await generateKeypair();
    const keyB = await generateKeypair();
    const keyC = await generateKeypair();

    const chain = await buildOrderedChain([keyA, keyB, keyC], ["rot-1", "rot-2"]);

    // Corrupt the signature of the second record
    chain[1] = {
      ...chain[1]!,
      old_key_signature: "00".repeat(64), // invalid signature bytes
    };

    const result = await verifySuccessionChain(chain);

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.index).toBe(1);
    expect(result.error!.message).toContain("invalid signature");
  });
});

// === Helpers ===

/**
 * Build a chain of succession records with guaranteed temporal ordering.
 * Keys array has N+1 entries for N records.
 */
async function buildOrderedChain(
  keys: { publicKey: Uint8Array; privateKey: Uint8Array }[],
  reasons: string[],
): Promise<KeySuccessionRecord[]> {
  const chain: KeySuccessionRecord[] = [];
  const baseTime = 1000;

  for (let i = 0; i < keys.length - 1; i++) {
    const record = await createSuccessionRecordWithTimestamp(
      keys[i]!,
      keys[i + 1]!,
      baseTime + i * 1000,
      reasons[i],
    );
    chain.push(record);
  }

  return chain;
}

/**
 * Create a succession record with a specific timestamp by signing the canonical
 * payload directly (since signKeySuccession uses Date.now()).
 */
async function createSuccessionRecordWithTimestamp(
  oldKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array },
  newKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array },
  timestamp: number,
  reason?: string,
): Promise<KeySuccessionRecord> {
  // We need to import sign and canonicalJson to create records with specific timestamps
  const { sign, canonicalJson, bytesToHex } = await import("../index");

  const oldPublicKeyHex = bytesToHex(oldKeyPair.publicKey);
  const newPublicKeyHex = bytesToHex(newKeyPair.publicKey);

  const obj: Record<string, unknown> = {
    old_public_key: oldPublicKeyHex,
    new_public_key: newPublicKeyHex,
    timestamp,
  };
  if (reason !== undefined) {
    obj.reason = reason;
  }
  const payload = canonicalJson(obj);
  const message = new TextEncoder().encode(payload);

  const oldSig = await sign(message, oldKeyPair.privateKey);
  const newSig = await sign(message, newKeyPair.privateKey);

  return {
    old_public_key: oldPublicKeyHex,
    new_public_key: newPublicKeyHex,
    timestamp,
    ...(reason !== undefined ? { reason } : {}),
    old_key_signature: bytesToHex(oldSig),
    new_key_signature: bytesToHex(newSig),
  };
}
