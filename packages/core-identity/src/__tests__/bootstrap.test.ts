import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryIdentityStorage,
  bootstrapIdentity,
  writeRestoredIdentity,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
  type BootstrapResult,
} from "../index";
import { InMemoryEventStore } from "@motebit/event-log";
import { EventType } from "@motebit/protocol";

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

    // The minted motebit_id is the sovereign commitment to the genesis key —
    // a verifier confirms id↔key offline, no operator (the default mint).
    const { verifySovereignBinding } = await import("@motebit/crypto");
    expect(await verifySovereignBinding(result.motebitId, result.publicKeyHex)).toBe(true);

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

    // The orphaned motebit_id is reported back to the caller so the
    // surface UI can offer recovery (restore-from-motebit.md or
    // restore-from-seed). Without this signal, the silent re-mint
    // becomes unrecoverable from the user's perspective — the prior
    // identity, funds, credentials, and trust are gone without notice.
    expect(result.divergedFromMotebitId).toBe("orphaned-divergent-id");
  });

  it("non-divergent paths leave divergedFromMotebitId undefined", async () => {
    // First launch with no prior config
    const first = await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore,
    });
    expect(first.divergedFromMotebitId).toBeUndefined();

    // Second launch with intact keystore
    const second = await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore,
    });
    expect(second.divergedFromMotebitId).toBeUndefined();
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

// ---------------------------------------------------------------------------
// writeRestoredIdentity — born-date fidelity for the restore flow
// ---------------------------------------------------------------------------
//
// Pre-write the identity record + IdentityCreated event so the
// subsequent bootstrap finds them and takes the "loaded" path instead
// of fabricating a fresh event with `timestamp: Date.now()`. The test
// shape locks the post-bootstrap state: the event's timestamp must
// equal the bornAt we passed, not the Date.now() at bootstrap time.

describe("writeRestoredIdentity + bootstrapIdentity (born-date fidelity)", () => {
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

  it("preserves the historical bornAt in the IdentityCreated event after bootstrap reloads", async () => {
    // Simulate the restore flow: caller writes the restored identity
    // FIRST (with the historical bornAt), THEN populates config +
    // keystore. Bootstrap on next launch sees both halves and takes
    // the "loaded" early-return.
    const bornAtMs = Date.parse("2024-11-12T08:30:00.000Z");
    await writeRestoredIdentity({
      identityStorage,
      eventStoreAdapter,
      motebitId: "restored-motebit",
      ownerId: "Web",
      bornAtMs,
    });
    configStore.data = {
      motebit_id: "restored-motebit",
      device_id: "restored-device",
      device_public_key: "aa".repeat(32),
    };
    keyStore.storedKey = "bb".repeat(32);

    const result = await bootstrapIdentity({
      surfaceName: "Web",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore,
    });

    expect(result.isFirstLaunch).toBe(false);
    expect(result.motebitId).toBe("restored-motebit");

    // The event the Sovereign Identity tab queries to render "Born"
    // carries the original 2024 timestamp, not Date.now() from
    // bootstrap.
    const events = await eventStoreAdapter.query({
      motebit_id: "restored-motebit",
      event_types: [EventType.IdentityCreated],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.timestamp).toBe(bornAtMs);
    expect((events[0]!.payload as { restored?: boolean }).restored).toBe(true);
  });

  it("writes the identity record with the historical bornAt", async () => {
    const bornAtMs = Date.parse("2023-06-01T00:00:00.000Z");
    await writeRestoredIdentity({
      identityStorage,
      eventStoreAdapter,
      motebitId: "old-motebit",
      ownerId: "Desktop",
      bornAtMs,
    });
    const loaded = await identityStorage.load("old-motebit");
    expect(loaded).not.toBeNull();
    expect(loaded!.created_at).toBe(bornAtMs);
    expect(loaded!.owner_id).toBe("Desktop");
    expect(loaded!.version_clock).toBe(0);
  });

  it("when used WITHOUT writeRestoredIdentity, bootstrap fabricates a Date.now() timestamp (the legacy lossy path)", async () => {
    // This test locks the existing-asymmetry: the auto-recover path
    // in bootstrap STILL writes Date.now() if the caller didn't
    // pre-write the identity. born-date fidelity is opt-in via
    // `writeRestoredIdentity`; surfaces that don't call it get the
    // legacy "Born just now" behavior.
    const beforeMs = Date.now();
    configStore.data = {
      motebit_id: "no-prewrite-id",
      device_id: "x",
      device_public_key: "aa".repeat(32),
    };
    keyStore.storedKey = "bb".repeat(32);

    await bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore,
      keyStore,
    });

    const events = await eventStoreAdapter.query({
      motebit_id: "no-prewrite-id",
      event_types: [EventType.IdentityCreated],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.timestamp).toBeGreaterThanOrEqual(beforeMs);
  });
});
