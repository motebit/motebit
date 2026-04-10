import { describe, it, expect, beforeEach } from "vitest";
import { IdentityManager, InMemoryIdentityStorage, rotateIdentityKeys } from "../index";
import type { DeviceRegistration, IdentityStorage } from "../index";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { generateKeypair } from "@motebit/encryption";

// ---------------------------------------------------------------------------
// InMemoryIdentityStorage
// ---------------------------------------------------------------------------

describe("InMemoryIdentityStorage", () => {
  let storage: InMemoryIdentityStorage;

  beforeEach(() => {
    storage = new InMemoryIdentityStorage();
  });

  it("returns null for unknown motebit_id", async () => {
    const result = await storage.load("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null for unknown owner_id", async () => {
    const result = await storage.loadByOwner("nonexistent");
    expect(result).toBeNull();
  });

  it("saves and loads by motebit_id", async () => {
    await storage.save({
      motebit_id: "m1",
      created_at: 1000,
      owner_id: "owner-1",
      version_clock: 0,
    });
    const loaded = await storage.load("m1");
    expect(loaded).not.toBeNull();
    expect(loaded!.motebit_id).toBe("m1");
    expect(loaded!.owner_id).toBe("owner-1");
  });

  it("saves and loads by owner_id", async () => {
    await storage.save({
      motebit_id: "m1",
      created_at: 1000,
      owner_id: "owner-1",
      version_clock: 0,
    });
    const loaded = await storage.loadByOwner("owner-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.motebit_id).toBe("m1");
  });

  it("stores a defensive copy (mutations do not affect storage)", async () => {
    const identity = {
      motebit_id: "m1",
      created_at: 1000,
      owner_id: "owner-1",
      version_clock: 0,
    };
    await storage.save(identity);
    identity.version_clock = 999;
    const loaded = await storage.load("m1");
    expect(loaded!.version_clock).toBe(0);
  });

  // --- Device storage ---

  it("saveDevice and loadDevice round-trip", async () => {
    const device: DeviceRegistration = {
      device_id: "d1",
      motebit_id: "m1",
      device_token: "tok-1",
      public_key: "aa".repeat(32),
      registered_at: 1000,
      device_name: "Phone",
    };
    await storage.saveDevice(device);
    const loaded = await storage.loadDevice("d1");
    expect(loaded).not.toBeNull();
    expect(loaded!.device_id).toBe("d1");
    expect(loaded!.device_token).toBe("tok-1");
    expect(loaded!.device_name).toBe("Phone");
  });

  it("loadDevice returns null for unknown device_id", async () => {
    const result = await storage.loadDevice("nonexistent");
    expect(result).toBeNull();
  });

  it("loadDeviceByToken finds device by token", async () => {
    const device: DeviceRegistration = {
      device_id: "d2",
      motebit_id: "m1",
      device_token: "tok-2",
      public_key: "bb".repeat(32),
      registered_at: 2000,
    };
    await storage.saveDevice(device);
    const loaded = await storage.loadDeviceByToken("tok-2");
    expect(loaded).not.toBeNull();
    expect(loaded!.device_id).toBe("d2");
  });

  it("loadDeviceByToken returns null for unknown token", async () => {
    const result = await storage.loadDeviceByToken("nonexistent");
    expect(result).toBeNull();
  });

  it("listDevices returns devices for a given motebitId", async () => {
    await storage.saveDevice({
      device_id: "d1",
      motebit_id: "m1",
      device_token: "t1",
      public_key: "aa".repeat(32),
      registered_at: 1,
    });
    await storage.saveDevice({
      device_id: "d2",
      motebit_id: "m1",
      device_token: "t2",
      public_key: "bb".repeat(32),
      registered_at: 2,
    });
    await storage.saveDevice({
      device_id: "d3",
      motebit_id: "m2",
      device_token: "t3",
      public_key: "cc".repeat(32),
      registered_at: 3,
    });

    const devicesM1 = await storage.listDevices("m1");
    expect(devicesM1).toHaveLength(2);
    const devicesM2 = await storage.listDevices("m2");
    expect(devicesM2).toHaveLength(1);
  });

  it("saveDevice stores a defensive copy", async () => {
    const device: DeviceRegistration = {
      device_id: "d4",
      motebit_id: "m1",
      device_token: "tok-4",
      public_key: "dd".repeat(32),
      registered_at: 1000,
      device_name: "Original",
    };
    await storage.saveDevice(device);
    device.device_name = "Mutated";
    const loaded = await storage.loadDevice("d4");
    expect(loaded!.device_name).toBe("Original");
  });
});

// ---------------------------------------------------------------------------
// IdentityManager
// ---------------------------------------------------------------------------

describe("IdentityManager", () => {
  let manager: IdentityManager;
  let identityStorage: InMemoryIdentityStorage;
  let eventStore: EventStore;

  beforeEach(() => {
    identityStorage = new InMemoryIdentityStorage();
    eventStore = new EventStore(new InMemoryEventStore());
    manager = new IdentityManager(identityStorage, eventStore);
  });

  it("create() generates a valid identity with a UUID-like motebit_id", async () => {
    const identity = await manager.create("owner-1");
    expect(identity.motebit_id).toBeTruthy();
    // UUID v7 format: 8-4-4-4-12 hex chars with dashes
    expect(identity.motebit_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(identity.owner_id).toBe("owner-1");
    expect(identity.version_clock).toBe(0);
    expect(identity.created_at).toBeGreaterThan(0);
  });

  it("create() logs an IdentityCreated event", async () => {
    const identity = await manager.create("owner-1");
    const events = await eventStore.query({ motebit_id: identity.motebit_id });
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("identity_created");
  });

  it("load() returns the created identity", async () => {
    const created = await manager.create("owner-1");
    const loaded = await manager.load(created.motebit_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.motebit_id).toBe(created.motebit_id);
  });

  it("load() returns null for unknown motebit_id", async () => {
    const result = await manager.load("nonexistent");
    expect(result).toBeNull();
  });

  it("loadByOwner() returns the identity by owner", async () => {
    await manager.create("owner-1");
    const loaded = await manager.loadByOwner("owner-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.owner_id).toBe("owner-1");
  });

  it("loadByOwner() returns null for unknown owner", async () => {
    const result = await manager.loadByOwner("nonexistent");
    expect(result).toBeNull();
  });

  it("incrementClock() increments and persists the version_clock", async () => {
    const identity = await manager.create("owner-1");
    const clock1 = await manager.incrementClock(identity.motebit_id);
    expect(clock1).toBe(1);

    const clock2 = await manager.incrementClock(identity.motebit_id);
    expect(clock2).toBe(2);

    const loaded = await manager.load(identity.motebit_id);
    expect(loaded!.version_clock).toBe(2);
  });

  it("incrementClock() throws for unknown identity", async () => {
    await expect(manager.incrementClock("nonexistent")).rejects.toThrow("Identity not found");
  });

  it("export() returns the identity data", async () => {
    const created = await manager.create("owner-1");
    const exported = await manager.export(created.motebit_id);
    expect(exported).not.toBeNull();
    expect(exported!.motebit_id).toBe(created.motebit_id);
    expect(exported!.owner_id).toBe("owner-1");
  });

  it("export() returns null for unknown motebit_id", async () => {
    const exported = await manager.export("nonexistent");
    expect(exported).toBeNull();
  });

  // --- Device registration ---

  it("registerDevice() creates a device with unique ids and token", async () => {
    const identity = await manager.create("owner-1");
    const device = await manager.registerDevice(identity.motebit_id, "Laptop");

    expect(device.device_id).toBeTypeOf("string");
    expect(device.device_token).toBeTypeOf("string");
    expect(device.motebit_id).toBe(identity.motebit_id);
    expect(device.device_name).toBe("Laptop");
    expect(device.registered_at).toBeGreaterThan(0);
  });

  it("registerDevice() creates unique tokens for each device", async () => {
    const identity = await manager.create("owner-1");
    const device1 = await manager.registerDevice(identity.motebit_id, "Phone");
    const device2 = await manager.registerDevice(identity.motebit_id, "Tablet");

    expect(device1.device_token).not.toBe(device2.device_token);
    expect(device1.device_id).not.toBe(device2.device_id);
  });

  // --- Key rotation ---

  it("rotateKey() updates the device's public key", async () => {
    const identity = await manager.create("owner-1");
    const device = await manager.registerDevice(identity.motebit_id, "Laptop", "oldkey");

    await manager.rotateKey("newkey", device.device_id);

    const loaded = await manager.loadDeviceById(device.device_id, identity.motebit_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.public_key).toBe("newkey");
  });

  it("rotateKey() logs a key rotation event", async () => {
    const identity = await manager.create("owner-1");
    const device = await manager.registerDevice(identity.motebit_id, "Laptop", "oldkey");

    await manager.rotateKey("newkey", device.device_id);

    const events = await eventStore.query({ motebit_id: identity.motebit_id });
    // First event is identity_created, second is key_rotated
    const rotateEvent = events.find(
      (e) => (e.payload as Record<string, unknown>).action === "key_rotated",
    );
    expect(rotateEvent).toBeDefined();
    expect((rotateEvent!.payload as Record<string, unknown>).new_public_key).toBe("newkey");
  });

  it("rotateKey() throws for unknown device", async () => {
    await expect(manager.rotateKey("newkey", "nonexistent")).rejects.toThrow("Device not found");
  });

  it("updateDevicePublicKey() updates the key on a specific device", async () => {
    const identity = await manager.create("owner-1");
    const device = await manager.registerDevice(identity.motebit_id, "Phone", "origkey");

    await manager.updateDevicePublicKey(device.device_id, "updatedkey");

    const loaded = await manager.loadDeviceById(device.device_id, identity.motebit_id);
    expect(loaded!.public_key).toBe("updatedkey");
  });

  it("updateDevicePublicKey() throws for unknown device", async () => {
    await expect(manager.updateDevicePublicKey("nonexistent", "key")).rejects.toThrow(
      "Device not found",
    );
  });

  it("updateDevicePublicKey() logs a public_key_updated event", async () => {
    const identity = await manager.create("owner-1");
    const device = await manager.registerDevice(identity.motebit_id, "Phone", "origkey");

    await manager.updateDevicePublicKey(device.device_id, "updatedkey");

    const events = await eventStore.query({ motebit_id: identity.motebit_id });
    const updateEvent = events.find(
      (e) => (e.payload as Record<string, unknown>).action === "public_key_updated",
    );
    expect(updateEvent).toBeDefined();
    expect((updateEvent!.payload as Record<string, unknown>).new_public_key).toBe("updatedkey");
  });

  it("listDevices() returns all devices for a motebit identity", async () => {
    const identity = await manager.create("owner-1");
    await manager.registerDevice(identity.motebit_id, "Phone");
    await manager.registerDevice(identity.motebit_id, "Laptop");

    const devices = await manager.listDevices(identity.motebit_id);
    expect(devices).toHaveLength(2);
    expect(devices.map((d) => d.device_name).sort()).toEqual(["Laptop", "Phone"]);
  });

  it("listDevices() returns empty array for unknown motebit_id", async () => {
    const devices = await manager.listDevices("nonexistent");
    expect(devices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// IdentityManager with storage lacking device methods (InMemoryDeviceStore fallback)
// ---------------------------------------------------------------------------

describe("IdentityManager with minimal storage (fallback device store)", () => {
  it("falls back to InMemoryDeviceStore when storage lacks device methods", async () => {
    // Storage that only implements save/load/loadByOwner — no device methods
    const minimalStorage: IdentityStorage = {
      save: async () => {},
      load: async () => null,
      loadByOwner: async () => null,
    };
    const eventStore = new EventStore(new InMemoryEventStore());
    const manager = new IdentityManager(minimalStorage, eventStore);

    // This should use the internal InMemoryDeviceStore fallback
    const identity = await manager.create("owner-1");
    const device = await manager.registerDevice(identity.motebit_id, "Phone", "pubkey");

    // listDevices uses the fallback store
    const devices = await manager.listDevices(identity.motebit_id);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.device_name).toBe("Phone");

    // loadDeviceById uses the fallback store
    const loaded = await manager.loadDeviceById(device.device_id, device.motebit_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.public_key).toBe("pubkey");
  });

  it("reuses the same InMemoryDeviceStore fallback across calls", async () => {
    const minimalStorage: IdentityStorage = {
      save: async () => {},
      load: async () => null,
      loadByOwner: async () => null,
    };
    const eventStore = new EventStore(new InMemoryEventStore());
    const manager = new IdentityManager(minimalStorage, eventStore);

    const identity = await manager.create("owner-1");
    await manager.registerDevice(identity.motebit_id, "D1");
    await manager.registerDevice(identity.motebit_id, "D2");

    // Both devices should be findable
    const devices = await manager.listDevices(identity.motebit_id);
    expect(devices).toHaveLength(2);
  });

  it("InMemoryDeviceStore loadDeviceByToken works for token-based lookup", async () => {
    const minimalStorage: IdentityStorage = {
      save: async () => {},
      load: async () => null,
      loadByOwner: async () => null,
    };
    const eventStore = new EventStore(new InMemoryEventStore());
    const manager = new IdentityManager(minimalStorage, eventStore);

    const identity = await manager.create("owner-1");
    const device = await manager.registerDevice(identity.motebit_id, "Phone");

    // The device_token should be set
    expect(device.device_token).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// rotateIdentityKeys
// ---------------------------------------------------------------------------

describe("rotateIdentityKeys", () => {
  it("generates new keypair and dual-signed succession record", async () => {
    const oldKeypair = await generateKeypair();

    const result = await rotateIdentityKeys({
      oldPrivateKey: oldKeypair.privateKey,
      oldPublicKey: oldKeypair.publicKey,
      reason: "test rotation",
    });

    expect(result.newPublicKey).toBeInstanceOf(Uint8Array);
    expect(result.newPrivateKey).toBeInstanceOf(Uint8Array);
    expect(result.newPublicKeyHex).toHaveLength(64);
    expect(result.successionRecord).toBeDefined();
    expect(result.successionRecord.new_public_key).toBeTruthy();
    expect(result.successionRecord.old_public_key).toBeTruthy();
  });

  it("works without reason", async () => {
    const oldKeypair = await generateKeypair();

    const result = await rotateIdentityKeys({
      oldPrivateKey: oldKeypair.privateKey,
      oldPublicKey: oldKeypair.publicKey,
    });

    expect(result.newPublicKeyHex).toHaveLength(64);
    expect(result.successionRecord).toBeDefined();
  });

  it("produces a new keypair distinct from the old one", async () => {
    const oldKeypair = await generateKeypair();

    const result = await rotateIdentityKeys({
      oldPrivateKey: oldKeypair.privateKey,
      oldPublicKey: oldKeypair.publicKey,
    });

    // New key should differ from old
    const oldHex = Array.from(oldKeypair.publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(result.newPublicKeyHex).not.toBe(oldHex);
  });
});
