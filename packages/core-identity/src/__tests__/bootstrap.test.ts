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

  read() {
    return Promise.resolve(this.data);
  }

  write(state: { motebit_id: string; device_id: string; device_public_key: string }) {
    this.data = { ...state };
    return Promise.resolve();
  }
}

// --- In-memory key store for testing ---

class TestKeyStore implements BootstrapKeyStore {
  storedKey: string | null = null;

  storePrivateKey(privKeyHex: string) {
    this.storedKey = privKeyHex;
    return Promise.resolve();
  }

  hasPrivateKey() {
    return Promise.resolve(this.storedKey != null && this.storedKey !== "");
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
    // Use a counting key store so we can verify storePrivateKey isn't
    // called again without clearing storedKey (clearing would simulate
    // divergent state, which the new contract correctly recovers from
    // by re-minting — see the divergent-state test below).
    class CountingKeyStore implements BootstrapKeyStore {
      storedKey: string | null = null;
      storeCalls = 0;
      storePrivateKey(privKeyHex: string) {
        this.storeCalls++;
        this.storedKey = privKeyHex;
        return Promise.resolve();
      }
      hasPrivateKey() {
        return Promise.resolve(this.storedKey != null && this.storedKey !== "");
      }
    }
    const counting = new CountingKeyStore();

    // First launch
    const first = await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore: counting,
    });
    expect(counting.storeCalls).toBe(1);

    // Second launch — config AND keystore both have the identity
    const second = await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore: counting,
    });

    expect(second.isFirstLaunch).toBe(false);
    expect(second.motebitId).toBe(first.motebitId);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.publicKeyHex).toBe(first.publicKeyHex);

    // storePrivateKey should NOT have been called again — returning user
    expect(counting.storeCalls).toBe(1);
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

  it("config exists but DB missing (keystore intact): re-creates in DB with SAME motebit_id, returns existing config", async () => {
    // Simulate: config has identity data and keystore has the matching
    // private key, but the identity DB is missing the row (e.g. the user
    // copied config.json + keychain entry between machines but the DB
    // file stayed behind, or the DB was wiped). Recovery path: restore
    // the identity row in the DB under the EXISTING motebit_id — do NOT
    // mint a new one.
    configStore.data = {
      motebit_id: "orphaned-id",
      device_id: "old-device",
      device_public_key: "aa".repeat(32),
    };
    // Pre-populate keystore so the divergent-state guard doesn't fire —
    // this is the "keypair exists, DB missing" scenario, NOT the
    // "keypair missing, DB missing" scenario (that's the divergent case
    // below, which re-mints).
    keyStore.storedKey = "ab".repeat(32);

    const result = await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore,
    });

    // Recovery path: re-create identity in DB, return existing config
    expect(result.isFirstLaunch).toBe(false);
    expect(result.motebitId).toBe("orphaned-id");
    expect(result.deviceId).toBe("old-device");
    expect(result.publicKeyHex).toBe("aa".repeat(32));

    // DB identity must have the SAME motebit_id as config (not a new one)
    const dbIdentity = await identityStorage.load("orphaned-id");
    expect(dbIdentity).not.toBeNull();
    expect(dbIdentity!.motebit_id).toBe("orphaned-id");
    expect(dbIdentity!.owner_id).toBe("test");
  });

  it("divergent state: config has identity but keystore is empty → treats as first launch, mints fresh keypair, overwrites config", async () => {
    // Simulate: config was populated by some prior step (e.g. CLI onboarding,
    // or a previous bootstrap that crashed mid-write) but the keystore
    // never got the private key. Holding only the public half is dead
    // state — the private key can't be recovered. Fresh mint is the only
    // clean path.
    configStore.data = {
      motebit_id: "orphaned-divergent-id",
      device_id: "orphaned-device",
      device_public_key: "bb".repeat(32),
    };
    expect(keyStore.storedKey).toBeNull();

    const result = await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore,
    });

    // Fresh mint — NOT the orphaned identity
    expect(result.isFirstLaunch).toBe(true);
    expect(result.motebitId).not.toBe("orphaned-divergent-id");
    expect(result.publicKeyHex).not.toBe("bb".repeat(32));
    expect(result.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);

    // Keystore now holds the new private key
    expect(keyStore.storedKey).toMatch(/^[0-9a-f]{64}$/);

    // Config has been overwritten with the new identity's public key
    expect(configStore.data!.motebit_id).toBe(result.motebitId);
    expect(configStore.data!.device_public_key).toBe(result.publicKeyHex);
    expect(configStore.data!.device_id).toBe(result.deviceId);

    // The new identity exists in the DB (and the orphan does not)
    const loaded = await identityStorage.load(result.motebitId);
    expect(loaded).not.toBeNull();
    const orphan = await identityStorage.load("orphaned-divergent-id");
    expect(orphan).toBeNull();
  });

  it("legacy keystore without hasPrivateKey: pre-2026-04-23 behavior preserved (trusts config)", async () => {
    // Older surfaces that implemented BootstrapKeyStore before hasPrivateKey
    // was added: the method is undefined. bootstrapIdentity must keep
    // treating config-present as "returning user" without the probe,
    // matching the behavior those surfaces were tested against.
    class LegacyKeyStore implements BootstrapKeyStore {
      storedKey: string | null = null;
      storePrivateKey(privKeyHex: string) {
        this.storedKey = privKeyHex;
        return Promise.resolve();
      }
      // No hasPrivateKey method
    }
    const legacyKeys = new LegacyKeyStore();

    configStore.data = {
      motebit_id: "pre-hasprivatekey-id",
      device_id: "pre-device",
      device_public_key: "cc".repeat(32),
    };

    const result = await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore: legacyKeys,
    });

    // Returning-user path, even though keystore is empty — the legacy
    // contract had no way to check, so we trust the config.
    expect(result.isFirstLaunch).toBe(false);
    expect(result.motebitId).toBe("pre-hasprivatekey-id");
    expect(result.publicKeyHex).toBe("cc".repeat(32));
    expect(legacyKeys.storedKey).toBeNull();
  });

  it("config exists (keystore intact) but DB missing and no public key: still restores identity", async () => {
    // Edge case: config written by older version without device_public_key,
    // keystore still has the private key (so the divergent-state guard
    // doesn't trip). The old-version restoration path should still work.
    configStore.data = {
      motebit_id: "orphaned-id-2",
      device_id: "old-device-2",
      device_public_key: "",
    };
    keyStore.storedKey = "cd".repeat(32);

    const result = await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore,
    });

    expect(result.isFirstLaunch).toBe(false);
    expect(result.motebitId).toBe("orphaned-id-2");

    const dbIdentity = await identityStorage.load("orphaned-id-2");
    expect(dbIdentity).not.toBeNull();
    expect(dbIdentity!.motebit_id).toBe("orphaned-id-2");
  });
});
