import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryIdentityStorage,
  bootstrapIdentity,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
  type BootstrapResult,
} from "../index";
import { InMemoryEventStore } from "@motebit/event-log";

// --- In-memory config store for testing ---

class TestConfigStore implements BootstrapConfigStore {
  data: { motebit_id: string; device_id: string; device_public_key: string } | null = null;

  async read() {
    return this.data;
  }

  async write(state: { motebit_id: string; device_id: string; device_public_key: string }) {
    this.data = { ...state };
  }
}

// --- In-memory key store for testing ---

class TestKeyStore implements BootstrapKeyStore {
  storedKey: string | null = null;

  async storePrivateKey(privKeyHex: string) {
    this.storedKey = privKeyHex;
  }
}

describe("bootstrapIdentity", () => {
  let identityStorage: InMemoryIdentityStorage;
  let eventStoreAdapter: InMemoryEventStore;
  let configStore: TestConfigStore;
  let keyStore: TestKeyStore;

  beforeEach(() => {
    identityStorage = new InMemoryIdentityStorage();
    eventStoreAdapter = new InMemoryEventStore();
    configStore = new TestConfigStore();
    keyStore = new TestKeyStore();
  });

  it("first launch: creates identity, stores key, writes config, returns isFirstLaunch=true", async () => {
    const result = await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore,
    });

    expect(result.isFirstLaunch).toBe(true);
    expect(result.motebitId).toBeTruthy();
    expect(result.deviceId).toBeTruthy();
    expect(result.publicKeyHex).toBeTruthy();
    // 32-byte Ed25519 public key = 64 hex chars
    expect(result.publicKeyHex).toHaveLength(64);

    // Key store should have received the private key
    expect(keyStore.storedKey).toBeTruthy();
    expect(keyStore.storedKey).toHaveLength(64); // 32-byte Ed25519 private key

    // Config store should have been written
    expect(configStore.data).not.toBeNull();
    expect(configStore.data!.motebit_id).toBe(result.motebitId);
    expect(configStore.data!.device_id).toBe(result.deviceId);
    expect(configStore.data!.device_public_key).toBe(result.publicKeyHex);

    // Identity should exist in the DB
    const loaded = await identityStorage.load(result.motebitId);
    expect(loaded).not.toBeNull();
  });

  it("second launch: reads config, returns isFirstLaunch=false, does not overwrite key", async () => {
    // First launch
    const first = await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore,
    });

    // Reset key store to verify it's not called again
    keyStore.storedKey = null;

    // Second launch — config already has identity
    const second = await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore,
    });

    expect(second.isFirstLaunch).toBe(false);
    expect(second.motebitId).toBe(first.motebitId);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.publicKeyHex).toBe(first.publicKeyHex);

    // Key store should NOT have been called
    expect(keyStore.storedKey).toBeNull();
  });

  it("different surface names produce the same canonical identity shape", async () => {
    // Simulate two independent surfaces bootstrapping with different adapters
    const surfaces = ["cli", "Desktop", "Mobile", "Spatial"];
    const results: BootstrapResult[] = [];

    for (const surface of surfaces) {
      // Each surface gets its own isolated storage (as in production)
      const storage = new InMemoryIdentityStorage();
      const events = new InMemoryEventStore();
      const config = new TestConfigStore();
      const keys = new TestKeyStore();

      const result = await bootstrapIdentity({
        surfaceName: surface,
        identityStorage: storage,
        eventStoreAdapter: events,
        configStore: config,
        keyStore: keys,
      });

      results.push(result);

      // Every surface produces the same canonical fields
      // UUID v7: 8-4-4-4-12 hex with dashes
      expect(result.motebitId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      // 32-byte Ed25519 public key = 64 hex chars, lowercase
      expect(result.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
      // Device ID is a UUID
      expect(result.deviceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.isFirstLaunch).toBe(true);

      // Config was written with all three canonical fields
      expect(config.data).not.toBeNull();
      expect(config.data!.motebit_id).toBe(result.motebitId);
      expect(config.data!.device_id).toBe(result.deviceId);
      expect(config.data!.device_public_key).toBe(result.publicKeyHex);

      // Key store received a 32-byte private key
      expect(keys.storedKey).toMatch(/^[0-9a-f]{64}$/);

      // Identity was persisted in the DB with correct owner
      const identity = await storage.load(result.motebitId);
      expect(identity).not.toBeNull();
      expect(identity!.owner_id).toBe(surface);
      expect(identity!.version_clock).toBe(0);
    }

    // All results are unique (different identities, different keys)
    const ids = results.map((r) => r.motebitId);
    expect(new Set(ids).size).toBe(surfaces.length);
    const keys = results.map((r) => r.publicKeyHex);
    expect(new Set(keys).size).toBe(surfaces.length);
  });

  it("config exists but DB missing: re-creates in DB, returns isFirstLaunch=true", async () => {
    // Simulate: config has identity data but DB is empty (e.g. DB was wiped)
    configStore.data = {
      motebit_id: "orphaned-id",
      device_id: "old-device",
      device_public_key: "aa".repeat(32),
    };

    const result = await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore,
    });

    // Should create a new identity since the old one couldn't be verified
    expect(result.isFirstLaunch).toBe(true);
    expect(result.motebitId).toBeTruthy();
    // The new identity should be in the DB
    const loaded = await identityStorage.load(result.motebitId);
    expect(loaded).not.toBeNull();
    // Key should have been stored
    expect(keyStore.storedKey).toBeTruthy();
  });
});
