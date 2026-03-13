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
