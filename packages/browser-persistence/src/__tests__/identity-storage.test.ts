import { describe, it, expect, beforeEach } from "vitest";
import type { MotebitIdentity } from "@motebit/sdk";
import type { DeviceRegistration } from "@motebit/core-identity";
import { openMotebitDB } from "../idb.js";
import { IdbIdentityStorage } from "../identity-storage.js";

describe("IdbIdentityStorage", () => {
  let storage: IdbIdentityStorage;

  beforeEach(async () => {
    const db = await openMotebitDB(`test-identity-${crypto.randomUUID()}`);
    storage = new IdbIdentityStorage(db);
  });

  function makeIdentity(overrides: Partial<MotebitIdentity> = {}): MotebitIdentity {
    return {
      motebit_id: crypto.randomUUID(),
      created_at: Date.now(),
      owner_id: "owner-1",
      version_clock: 0,
      ...overrides,
    };
  }

  function makeDevice(overrides: Partial<DeviceRegistration> = {}): DeviceRegistration {
    return {
      device_id: crypto.randomUUID(),
      motebit_id: "mote-1",
      device_token: crypto.randomUUID(),
      public_key: "abcd1234",
      registered_at: Date.now(),
      ...overrides,
    };
  }

  it("saves and loads an identity", async () => {
    const id = makeIdentity();
    await storage.save(id);
    const loaded = await storage.load(id.motebit_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.owner_id).toBe("owner-1");
  });

  it("returns null for missing identity", async () => {
    const loaded = await storage.load("missing");
    expect(loaded).toBeNull();
  });

  it("loads by owner_id", async () => {
    const id = makeIdentity({ owner_id: "special-owner" });
    await storage.save(id);
    const loaded = await storage.loadByOwner("special-owner");
    expect(loaded).not.toBeNull();
    expect(loaded!.motebit_id).toBe(id.motebit_id);
  });

  it("returns null for missing owner", async () => {
    const loaded = await storage.loadByOwner("missing-owner");
    expect(loaded).toBeNull();
  });

  it("upserts identity (put)", async () => {
    const id = makeIdentity({ version_clock: 0 });
    await storage.save(id);
    await storage.save({ ...id, version_clock: 5 });
    const loaded = await storage.load(id.motebit_id);
    expect(loaded!.version_clock).toBe(5);
  });

  // Device CRUD
  it("saves and loads a device", async () => {
    const dev = makeDevice();
    await storage.saveDevice(dev);
    const loaded = await storage.loadDevice(dev.device_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.public_key).toBe("abcd1234");
  });

  it("returns null for missing device", async () => {
    const loaded = await storage.loadDevice("missing");
    expect(loaded).toBeNull();
  });

  it("loads device by token", async () => {
    const dev = makeDevice({ device_token: "unique-token" });
    await storage.saveDevice(dev);
    const loaded = await storage.loadDeviceByToken("unique-token");
    expect(loaded).not.toBeNull();
    expect(loaded!.device_id).toBe(dev.device_id);
  });

  it("returns null for missing device token", async () => {
    const loaded = await storage.loadDeviceByToken("missing-token");
    expect(loaded).toBeNull();
  });

  it("lists devices for a motebit", async () => {
    await storage.saveDevice(makeDevice({ motebit_id: "mote-1" }));
    await storage.saveDevice(makeDevice({ motebit_id: "mote-1" }));
    await storage.saveDevice(makeDevice({ motebit_id: "mote-2" }));

    const devices = await storage.listDevices("mote-1");
    expect(devices).toHaveLength(2);
  });
});
