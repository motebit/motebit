import { describe, it, expect, beforeEach } from "vitest";
import {
  IdentityManager,
  InMemoryIdentityStorage,
} from "../index";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";

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
    await expect(manager.incrementClock("nonexistent")).rejects.toThrow(
      "Identity not found",
    );
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
});
