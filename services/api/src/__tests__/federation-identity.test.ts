/**
 * Relay identity encryption tests — verifies AES-256-GCM encryption at rest
 * for the Ed25519 private key, backward-compatible plaintext mode, and error
 * handling for wrong/missing passphrases.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createFederationTables,
  initRelayIdentity,
  bytesToHex,
  isEncryptedFormat,
} from "../federation.js";
import { openMotebitDatabase } from "@motebit/persistence";

describe("Relay Identity Encryption", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeEach(async () => {
    const moteDb = await openMotebitDatabase(":memory:");
    db = moteDb.db;
    createFederationTables(db);
    // initRelayIdentity needs agent_registry for some queries but not for identity itself;
    // create a minimal stub table so the DB doesn't error if needed.
    db.exec(
      "CREATE TABLE IF NOT EXISTS agent_registry (motebit_id TEXT PRIMARY KEY, expires_at INTEGER)",
    );
  });

  it("stores key as plaintext hex without passphrase (backward compat)", async () => {
    const identity = await initRelayIdentity(db);
    expect(identity.relayMotebitId).toBeTruthy();
    expect(identity.publicKey).toBeInstanceOf(Uint8Array);
    expect(identity.privateKey).toBeInstanceOf(Uint8Array);

    // Check raw DB value — should be pure hex, no colons
    const row = db.prepare("SELECT private_key_hex FROM relay_identity LIMIT 1").get() as {
      private_key_hex: string;
    };
    expect(isEncryptedFormat(row.private_key_hex)).toBe(false);
    expect(row.private_key_hex).toMatch(/^[0-9a-f]+$/);
  });

  it("stores encrypted value with `:` separators when passphrase is provided", async () => {
    const passphrase = "test-passphrase-for-encryption";
    const identity = await initRelayIdentity(db, passphrase);
    expect(identity.relayMotebitId).toBeTruthy();

    const row = db.prepare("SELECT private_key_hex FROM relay_identity LIMIT 1").get() as {
      private_key_hex: string;
    };
    expect(isEncryptedFormat(row.private_key_hex)).toBe(true);
    const parts = row.private_key_hex.split(":");
    expect(parts).toHaveLength(3);
    // Each part should be hex
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("round-trips correctly: encrypt on first boot, decrypt on reload", async () => {
    const passphrase = "round-trip-test-passphrase";

    // First boot — generates and encrypts
    const identity1 = await initRelayIdentity(db, passphrase);

    // Second call — loads and decrypts from DB
    const identity2 = await initRelayIdentity(db, passphrase);

    expect(identity2.relayMotebitId).toBe(identity1.relayMotebitId);
    expect(identity2.publicKeyHex).toBe(identity1.publicKeyHex);
    expect(identity2.did).toBe(identity1.did);
    expect(bytesToHex(identity2.publicKey)).toBe(bytesToHex(identity1.publicKey));
    expect(bytesToHex(identity2.privateKey)).toBe(bytesToHex(identity1.privateKey));
  });

  it("wrong passphrase fails to decrypt", async () => {
    const passphrase = "correct-passphrase";
    await initRelayIdentity(db, passphrase);

    // Attempt to load with wrong passphrase — should throw
    await expect(initRelayIdentity(db, "wrong-passphrase")).rejects.toThrow();
  });

  it("encrypted key without passphrase throws descriptive error", async () => {
    const passphrase = "some-passphrase";
    await initRelayIdentity(db, passphrase);

    // Attempt to load without passphrase — should throw with helpful message
    await expect(initRelayIdentity(db)).rejects.toThrow(
      "Relay private key is encrypted but no passphrase provided",
    );
  });

  it("key persists across calls (same identity returned)", async () => {
    // Without passphrase
    const id1 = await initRelayIdentity(db);
    const id2 = await initRelayIdentity(db);

    expect(id2.relayMotebitId).toBe(id1.relayMotebitId);
    expect(id2.publicKeyHex).toBe(id1.publicKeyHex);
    expect(bytesToHex(id2.privateKey)).toBe(bytesToHex(id1.privateKey));
  });
});
