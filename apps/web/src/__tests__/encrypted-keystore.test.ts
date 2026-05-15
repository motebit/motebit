/**
 * EncryptedKeyStore tests — WebCrypto + IndexedDB key storage.
 * fake-indexeddb provides IDB; Node.js crypto.subtle provides WebCrypto.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EncryptedKeyStore } from "../encrypted-keystore.js";

beforeEach(() => {
  localStorage.clear();
  indexedDB.deleteDatabase("motebit-keystore");
});

describe("EncryptedKeyStore", () => {
  it("stores and loads a private key", async () => {
    const store = new EncryptedKeyStore();
    const testKey = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

    await store.storePrivateKey(testKey);
    const loaded = await store.loadPrivateKey();

    expect(loaded).toBe(testKey);
  });

  it("returns null when no key stored", async () => {
    const store = new EncryptedKeyStore();
    const loaded = await store.loadPrivateKey();
    expect(loaded).toBeNull();
  });

  it("overwrites existing key on second store", async () => {
    const store = new EncryptedKeyStore();
    const key1 = "aaaa" + "0".repeat(60);
    const key2 = "bbbb" + "0".repeat(60);

    await store.storePrivateKey(key1);
    await store.storePrivateKey(key2);

    const loaded = await store.loadPrivateKey();
    expect(loaded).toBe(key2);
  });

  it("persists across store instances", async () => {
    const store1 = new EncryptedKeyStore();
    const testKey = "ff".repeat(32);

    await store1.storePrivateKey(testKey);

    const store2 = new EncryptedKeyStore();
    const loaded = await store2.loadPrivateKey();
    expect(loaded).toBe(testKey);
  });
});

describe("EncryptedKeyStore.hasPrivateKey", () => {
  // The probe is the consumer-facing primitive that
  // `bootstrapIdentity`'s divergent-state guard reads. False with
  // config-present is what fires the divergence recovery banner. Tests
  // here lock the contract: `false` for absent, `true` for present,
  // never throws. See [[feedback_sovereignty_primitives_audit_consumers]]
  // for the audit checklist that gated the re-exposure of this method.

  it("returns false on a fresh store (no key written)", async () => {
    const store = new EncryptedKeyStore();
    expect(await store.hasPrivateKey()).toBe(false);
  });

  it("returns true after a key has been stored", async () => {
    const store = new EncryptedKeyStore();
    const testKey = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    await store.storePrivateKey(testKey);
    expect(await store.hasPrivateKey()).toBe(true);
  });

  it("agrees with loadPrivateKey across a fresh-store round trip", async () => {
    const store = new EncryptedKeyStore();
    expect(await store.hasPrivateKey()).toBe(false);
    expect(await store.loadPrivateKey()).toBeNull();

    await store.storePrivateKey("cd".repeat(32));
    expect(await store.hasPrivateKey()).toBe(true);
    expect(await store.loadPrivateKey()).toBe("cd".repeat(32));
  });

  it("survives a second store instance — probe sees the persisted key", async () => {
    const store1 = new EncryptedKeyStore();
    await store1.storePrivateKey("ee".repeat(32));

    const store2 = new EncryptedKeyStore();
    expect(await store2.hasPrivateKey()).toBe(true);
  });
});
