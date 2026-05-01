import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryEventStore, EventStore, type EventStoreAdapter } from "../index";
import { EventType } from "@motebit/protocol";
import type { EventLogEntry, MotebitId } from "@motebit/protocol";
import { generateEd25519Keypair, verifyDeletionCertificate } from "@motebit/crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: "motebit-1",
    device_id: "test-device",
    timestamp: Date.now(),
    event_type: EventType.StateUpdated,
    payload: {},
    version_clock: 1,
    tombstoned: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// InMemoryEventStore
// ---------------------------------------------------------------------------

describe("InMemoryEventStore", () => {
  let store: InMemoryEventStore;

  beforeEach(() => {
    store = new InMemoryEventStore();
  });

  it("appends and queries events", async () => {
    const event = makeEvent();
    await store.append(event);
    const results = await store.query({});
    expect(results).toHaveLength(1);
    expect(results[0]!.event_id).toBe(event.event_id);
  });

  it("filters by motebit_id", async () => {
    await store.append(makeEvent({ motebit_id: "motebit-1" }));
    await store.append(makeEvent({ motebit_id: "motebit-2" }));
    const results = await store.query({ motebit_id: "motebit-1" });
    expect(results).toHaveLength(1);
    expect(results[0]!.motebit_id).toBe("motebit-1");
  });

  it("filters by event_types", async () => {
    await store.append(makeEvent({ event_type: EventType.StateUpdated }));
    await store.append(makeEvent({ event_type: EventType.MemoryFormed }));
    await store.append(makeEvent({ event_type: EventType.IdentityCreated }));
    const results = await store.query({
      event_types: [EventType.StateUpdated, EventType.MemoryFormed],
    });
    expect(results).toHaveLength(2);
  });

  it("filters by after_timestamp", async () => {
    await store.append(makeEvent({ timestamp: 100 }));
    await store.append(makeEvent({ timestamp: 200 }));
    await store.append(makeEvent({ timestamp: 300 }));
    const results = await store.query({ after_timestamp: 150 });
    expect(results).toHaveLength(2);
  });

  it("filters by before_timestamp", async () => {
    await store.append(makeEvent({ timestamp: 100 }));
    await store.append(makeEvent({ timestamp: 200 }));
    await store.append(makeEvent({ timestamp: 300 }));
    const results = await store.query({ before_timestamp: 250 });
    expect(results).toHaveLength(2);
  });

  it("filters by after_version_clock", async () => {
    await store.append(makeEvent({ version_clock: 1 }));
    await store.append(makeEvent({ version_clock: 2 }));
    await store.append(makeEvent({ version_clock: 3 }));
    const results = await store.query({ after_version_clock: 1 });
    expect(results).toHaveLength(2);
  });

  it("respects limit", async () => {
    await store.append(makeEvent({ version_clock: 1 }));
    await store.append(makeEvent({ version_clock: 2 }));
    await store.append(makeEvent({ version_clock: 3 }));
    const results = await store.query({ limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("getLatestClock returns 0 for unknown motebit", async () => {
    const clock = await store.getLatestClock("nonexistent");
    expect(clock).toBe(0);
  });

  it("getLatestClock returns the highest version_clock", async () => {
    await store.append(makeEvent({ motebit_id: "m1", version_clock: 3 }));
    await store.append(makeEvent({ motebit_id: "m1", version_clock: 7 }));
    await store.append(makeEvent({ motebit_id: "m1", version_clock: 5 }));
    const clock = await store.getLatestClock("m1");
    expect(clock).toBe(7);
  });

  it("deduplicates events by event_id", async () => {
    const event = makeEvent({ event_id: "dup-1", version_clock: 1 });
    await store.append(event);
    await store.append(event); // same event_id
    const results = await store.query({});
    expect(results).toHaveLength(1);
  });

  it("allows distinct event_ids", async () => {
    await store.append(makeEvent({ event_id: "a", version_clock: 1 }));
    await store.append(makeEvent({ event_id: "b", version_clock: 2 }));
    const results = await store.query({});
    expect(results).toHaveLength(2);
  });

  it("tombstone marks the event", async () => {
    const event = makeEvent({ event_id: "e1", motebit_id: "m1" });
    await store.append(event);
    await store.tombstone("e1", "m1");
    const results = await store.query({});
    expect(results[0]!.tombstoned).toBe(true);
  });

  it("tombstone does nothing for non-existent event", async () => {
    // Should not throw
    await store.tombstone("nonexistent", "m1");
  });
});

// ---------------------------------------------------------------------------
// InMemoryEventStore.appendWithClock
// ---------------------------------------------------------------------------

describe("InMemoryEventStore.appendWithClock", () => {
  let store: InMemoryEventStore;

  beforeEach(() => {
    store = new InMemoryEventStore();
  });

  it("assigns clock 1 for the first event", async () => {
    const clock = await store.appendWithClock({
      event_id: "e1",
      motebit_id: "m1",
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: {},
      tombstoned: false,
    });
    expect(clock).toBe(1);
  });

  it("assigns incrementing clocks", async () => {
    const c1 = await store.appendWithClock({
      event_id: "e1",
      motebit_id: "m1",
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: {},
      tombstoned: false,
    });
    const c2 = await store.appendWithClock({
      event_id: "e2",
      motebit_id: "m1",
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: {},
      tombstoned: false,
    });
    expect(c1).toBe(1);
    expect(c2).toBe(2);
  });

  it("deduplicates on event_id and returns existing clock", async () => {
    const c1 = await store.appendWithClock({
      event_id: "dup",
      motebit_id: "m1",
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: {},
      tombstoned: false,
    });
    const c2 = await store.appendWithClock({
      event_id: "dup",
      motebit_id: "m1",
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: { extra: true },
      tombstoned: false,
    });
    expect(c1).toBe(1);
    expect(c2).toBe(1); // deduplicated, returns existing clock
    expect((await store.query({})).length).toBe(1);
  });

  it("isolates clocks per motebit_id", async () => {
    const c1 = await store.appendWithClock({
      event_id: "e1",
      motebit_id: "m1",
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: {},
      tombstoned: false,
    });
    const c2 = await store.appendWithClock({
      event_id: "e2",
      motebit_id: "m2",
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: {},
      tombstoned: false,
    });
    expect(c1).toBe(1);
    expect(c2).toBe(1); // separate motebit_id starts at 1
  });
});

// ---------------------------------------------------------------------------
// EventStore.appendWithClock
// ---------------------------------------------------------------------------

describe("EventStore.appendWithClock", () => {
  it("delegates to adapter.appendWithClock when available", async () => {
    const eventStore = new EventStore(new InMemoryEventStore());
    const clock = await eventStore.appendWithClock({
      event_id: "e1",
      motebit_id: "m1",
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: {},
      tombstoned: false,
    });
    expect(clock).toBe(1);
  });

  it("rejects empty event_id", async () => {
    const eventStore = new EventStore(new InMemoryEventStore());
    await expect(
      eventStore.appendWithClock({
        event_id: "",
        motebit_id: "m1",
        timestamp: Date.now(),
        event_type: EventType.StateUpdated,
        payload: {},
        tombstoned: false,
      }),
    ).rejects.toThrow("event_id must not be empty");
  });

  it("rejects empty motebit_id", async () => {
    const eventStore = new EventStore(new InMemoryEventStore());
    await expect(
      eventStore.appendWithClock({
        event_id: "e1",
        motebit_id: "",
        timestamp: Date.now(),
        event_type: EventType.StateUpdated,
        payload: {},
        tombstoned: false,
      }),
    ).rejects.toThrow("motebit_id must not be empty");
  });

  it("falls back to getLatestClock+append when adapter lacks appendWithClock", async () => {
    const events: EventLogEntry[] = [];
    const minimal: EventStoreAdapter = {
      append: async (entry) => {
        events.push(entry);
      },
      query: async () => events,
      getLatestClock: async () => events.length,
      tombstone: async () => {},
      // no appendWithClock — forces fallback
    };
    const eventStore = new EventStore(minimal);
    const clock = await eventStore.appendWithClock({
      event_id: "e1",
      motebit_id: "m1",
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: {},
      tombstoned: false,
    });
    expect(clock).toBe(1);
    expect(events.length).toBe(1);
    expect(events[0]!.version_clock).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// EventStore (high-level wrapper)
// ---------------------------------------------------------------------------

describe("EventStore", () => {
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = new EventStore(new InMemoryEventStore());
  });

  it("rejects empty event_id", async () => {
    const event = makeEvent({ event_id: "" });
    await expect(eventStore.append(event)).rejects.toThrow("event_id must not be empty");
  });

  it("rejects empty motebit_id", async () => {
    const event = makeEvent({ motebit_id: "" });
    await expect(eventStore.append(event)).rejects.toThrow("motebit_id must not be empty");
  });

  it("appends valid events", async () => {
    const event = makeEvent();
    await eventStore.append(event);
    const results = await eventStore.query({});
    expect(results).toHaveLength(1);
  });

  it("replay processes events in version_clock order", async () => {
    await eventStore.append(makeEvent({ motebit_id: "m1", version_clock: 3 }));
    await eventStore.append(makeEvent({ motebit_id: "m1", version_clock: 1 }));
    await eventStore.append(makeEvent({ motebit_id: "m1", version_clock: 2 }));

    const order: number[] = [];
    await eventStore.replay("m1", (entry) => {
      order.push(entry.version_clock);
      return Promise.resolve();
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it("replay only processes events for the specified motebit", async () => {
    await eventStore.append(makeEvent({ motebit_id: "m1", version_clock: 1 }));
    await eventStore.append(makeEvent({ motebit_id: "m2", version_clock: 2 }));

    const seen: string[] = [];
    await eventStore.replay("m1", (entry) => {
      seen.push(entry.motebit_id);
      return Promise.resolve();
    });
    expect(seen).toEqual(["m1"]);
  });
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

describe("InMemoryEventStore compaction", () => {
  let store: InMemoryEventStore;

  beforeEach(() => {
    store = new InMemoryEventStore();
  });

  it("countEvents returns correct count", async () => {
    await store.append(makeEvent({ motebit_id: "m1", version_clock: 1 }));
    await store.append(makeEvent({ motebit_id: "m1", version_clock: 2 }));
    await store.append(makeEvent({ motebit_id: "m2", version_clock: 1 }));

    expect(await store.countEvents("m1")).toBe(2);
    expect(await store.countEvents("m2")).toBe(1);
    expect(await store.countEvents("m3")).toBe(0);
  });

  it("compact removes events at or below beforeClock", async () => {
    await store.append(makeEvent({ motebit_id: "m1", version_clock: 1 }));
    await store.append(makeEvent({ motebit_id: "m1", version_clock: 2 }));
    await store.append(makeEvent({ motebit_id: "m1", version_clock: 3 }));
    await store.append(makeEvent({ motebit_id: "m1", version_clock: 4 }));

    const deleted = await store.compact("m1", 2);
    expect(deleted).toBe(2);
    expect(await store.countEvents("m1")).toBe(2);

    const remaining = await store.query({ motebit_id: "m1" });
    expect(remaining.map((e) => e.version_clock)).toEqual([3, 4]);
  });

  it("compact does not affect other motebits", async () => {
    await store.append(makeEvent({ motebit_id: "m1", version_clock: 1 }));
    await store.append(makeEvent({ motebit_id: "m2", version_clock: 1 }));

    await store.compact("m1", 1);
    expect(await store.countEvents("m1")).toBe(0);
    expect(await store.countEvents("m2")).toBe(1);
  });

  it("compact returns 0 when no events match", async () => {
    await store.append(makeEvent({ motebit_id: "m1", version_clock: 5 }));
    const deleted = await store.compact("m1", 2);
    expect(deleted).toBe(0);
  });
});

describe("EventStore compaction passthrough", () => {
  it("compact delegates to adapter", async () => {
    const adapter = new InMemoryEventStore();
    const eventStore = new EventStore(adapter);

    await adapter.append(makeEvent({ motebit_id: "m1", version_clock: 1 }));
    await adapter.append(makeEvent({ motebit_id: "m1", version_clock: 2 }));
    await adapter.append(makeEvent({ motebit_id: "m1", version_clock: 3 }));

    expect(await eventStore.countEvents("m1")).toBe(3);
    const deleted = await eventStore.compact("m1", 1);
    expect(deleted).toBe(1);
    expect(await eventStore.countEvents("m1")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Combined filter composition
// ---------------------------------------------------------------------------

describe("InMemoryEventStore combined filters", () => {
  let store: InMemoryEventStore;

  beforeEach(async () => {
    store = new InMemoryEventStore();
    // 6 events across 2 motebits, 2 types, 3 time windows
    await store.append(
      makeEvent({
        motebit_id: "m1",
        event_type: EventType.StateUpdated,
        timestamp: 100,
        version_clock: 1,
      }),
    );
    await store.append(
      makeEvent({
        motebit_id: "m1",
        event_type: EventType.MemoryFormed,
        timestamp: 200,
        version_clock: 2,
      }),
    );
    await store.append(
      makeEvent({
        motebit_id: "m1",
        event_type: EventType.StateUpdated,
        timestamp: 300,
        version_clock: 3,
      }),
    );
    await store.append(
      makeEvent({
        motebit_id: "m2",
        event_type: EventType.StateUpdated,
        timestamp: 150,
        version_clock: 1,
      }),
    );
    await store.append(
      makeEvent({
        motebit_id: "m2",
        event_type: EventType.MemoryFormed,
        timestamp: 250,
        version_clock: 2,
      }),
    );
    await store.append(
      makeEvent({
        motebit_id: "m1",
        event_type: EventType.ToolUsed,
        timestamp: 400,
        version_clock: 4,
      }),
    );
  });

  it("combines motebit_id + event_types", async () => {
    const results = await store.query({
      motebit_id: "m1",
      event_types: [EventType.StateUpdated],
    });
    expect(results).toHaveLength(2);
    expect(
      results.every((e) => e.motebit_id === "m1" && e.event_type === EventType.StateUpdated),
    ).toBe(true);
  });

  it("combines motebit_id + time range", async () => {
    const results = await store.query({
      motebit_id: "m1",
      after_timestamp: 150,
      before_timestamp: 350,
    });
    expect(results).toHaveLength(2);
    expect(results.map((e) => e.version_clock).sort()).toEqual([2, 3]);
  });

  it("combines motebit_id + event_types + after_version_clock + limit", async () => {
    const results = await store.query({
      motebit_id: "m1",
      event_types: [EventType.StateUpdated, EventType.MemoryFormed, EventType.ToolUsed],
      after_version_clock: 1,
      limit: 2,
    });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.version_clock > 1)).toBe(true);
  });

  it("returns empty when all filters exclude everything", async () => {
    const results = await store.query({
      motebit_id: "m1",
      event_types: [EventType.IdentityCreated], // no m1 events of this type
    });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Adapter contract: minimal adapter (no optional methods)
// ---------------------------------------------------------------------------

describe("EventStore with minimal adapter", () => {
  it("compact returns 0 when adapter lacks compact()", async () => {
    const minimal: EventStoreAdapter = {
      append: async () => {},
      query: async () => [],
      getLatestClock: async () => 0,
      tombstone: async () => {},
      // no compact, no countEvents
    };
    const eventStore = new EventStore(minimal);
    const deleted = await eventStore.compact("m1", 10);
    expect(deleted).toBe(0);
  });

  it("countEvents returns -1 when adapter lacks countEvents()", async () => {
    const minimal: EventStoreAdapter = {
      append: async () => {},
      query: async () => [],
      getLatestClock: async () => 0,
      tombstone: async () => {},
    };
    const eventStore = new EventStore(minimal);
    expect(await eventStore.countEvents("m1")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Replay semantics
// ---------------------------------------------------------------------------

describe("EventStore replay semantics", () => {
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = new EventStore(new InMemoryEventStore());
  });

  it("replay includes tombstoned events (tombstone is a marker, not a delete)", async () => {
    await eventStore.append(makeEvent({ event_id: "e1", motebit_id: "m1", version_clock: 1 }));
    await eventStore.append(makeEvent({ event_id: "e2", motebit_id: "m1", version_clock: 2 }));
    await eventStore.tombstone("e1", "m1");

    const replayed: EventLogEntry[] = [];
    await eventStore.replay("m1", async (entry) => {
      replayed.push(entry);
    });

    expect(replayed).toHaveLength(2);
    expect(replayed[0]!.tombstoned).toBe(true);
    expect(replayed[1]!.tombstoned).toBe(false);
  });

  it("replay on empty store invokes handler zero times", async () => {
    const replayed: EventLogEntry[] = [];
    await eventStore.replay("nonexistent", async (entry) => {
      replayed.push(entry);
    });
    expect(replayed).toHaveLength(0);
  });

  it("replay is stable-sorted by version_clock (insertion order preserved for equal clocks)", async () => {
    // Two events from different devices with the same version_clock
    await eventStore.append(
      makeEvent({ event_id: "a", motebit_id: "m1", device_id: "d1", version_clock: 1 }),
    );
    await eventStore.append(
      makeEvent({ event_id: "b", motebit_id: "m1", device_id: "d2", version_clock: 1 }),
    );

    const ids: string[] = [];
    await eventStore.replay("m1", async (entry) => {
      ids.push(entry.event_id);
    });
    // Both should appear — neither is lost
    expect(ids).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Append immutability
// ---------------------------------------------------------------------------

describe("InMemoryEventStore immutability", () => {
  it("append shallow-copies the entry so external mutation does not affect the log", async () => {
    const store = new InMemoryEventStore();
    const event = makeEvent({ motebit_id: "m1", version_clock: 1 });
    await store.append(event);

    // Mutate the original object after append
    event.version_clock = 999;
    event.motebit_id = "mutated";

    const results = await store.query({});
    expect(results[0]!.version_clock).toBe(1);
    expect(results[0]!.motebit_id).toBe("m1");
  });
});

// ---------------------------------------------------------------------------
// Multi-device interleaving
// ---------------------------------------------------------------------------

describe("multi-device version clock interleaving", () => {
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = new EventStore(new InMemoryEventStore());
  });

  it("getLatestClock reflects the maximum across all devices", async () => {
    await eventStore.append(makeEvent({ motebit_id: "m1", device_id: "d1", version_clock: 3 }));
    await eventStore.append(makeEvent({ motebit_id: "m1", device_id: "d2", version_clock: 7 }));
    await eventStore.append(makeEvent({ motebit_id: "m1", device_id: "d1", version_clock: 5 }));

    expect(await eventStore.getLatestClock("m1")).toBe(7);
  });

  it("replay interleaves events from multiple devices by version_clock", async () => {
    await eventStore.append(
      makeEvent({ event_id: "d1-1", motebit_id: "m1", device_id: "d1", version_clock: 1 }),
    );
    await eventStore.append(
      makeEvent({ event_id: "d2-1", motebit_id: "m1", device_id: "d2", version_clock: 2 }),
    );
    await eventStore.append(
      makeEvent({ event_id: "d1-2", motebit_id: "m1", device_id: "d1", version_clock: 3 }),
    );
    await eventStore.append(
      makeEvent({ event_id: "d2-2", motebit_id: "m1", device_id: "d2", version_clock: 4 }),
    );

    const order: string[] = [];
    await eventStore.replay("m1", async (entry) => {
      order.push(entry.event_id);
    });
    expect(order).toEqual(["d1-1", "d2-1", "d1-2", "d2-2"]);
  });

  it("compact preserves events above the clock regardless of device", async () => {
    await eventStore.append(
      makeEvent({ event_id: "d1-1", motebit_id: "m1", device_id: "d1", version_clock: 1 }),
    );
    await eventStore.append(
      makeEvent({ event_id: "d2-1", motebit_id: "m1", device_id: "d2", version_clock: 2 }),
    );
    await eventStore.append(
      makeEvent({ event_id: "d1-2", motebit_id: "m1", device_id: "d1", version_clock: 3 }),
    );

    const deleted = await eventStore.compact("m1", 2);
    expect(deleted).toBe(2);
    expect(await eventStore.countEvents("m1")).toBe(1);

    const remaining = await eventStore.query({ motebit_id: "m1" });
    expect(remaining[0]!.event_id).toBe("d1-2");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("compact with beforeClock=0 removes nothing", async () => {
    const store = new InMemoryEventStore();
    await store.append(makeEvent({ motebit_id: "m1", version_clock: 1 }));
    const deleted = await store.compact("m1", 0);
    expect(deleted).toBe(0);
    expect(await store.countEvents("m1")).toBe(1);
  });

  it("tombstone requires matching motebit_id — wrong motebit does nothing", async () => {
    const store = new InMemoryEventStore();
    await store.append(makeEvent({ event_id: "e1", motebit_id: "m1" }));
    await store.tombstone("e1", "m2"); // wrong motebit
    const results = await store.query({});
    expect(results[0]!.tombstoned).toBe(false);
  });

  it("deduplication persists across interleaved appends", async () => {
    const store = new InMemoryEventStore();
    await store.append(makeEvent({ event_id: "dup", motebit_id: "m1", version_clock: 1 }));
    await store.append(makeEvent({ event_id: "other", motebit_id: "m1", version_clock: 2 }));
    await store.append(makeEvent({ event_id: "dup", motebit_id: "m1", version_clock: 3 })); // dup, even with different clock
    const results = await store.query({});
    expect(results).toHaveLength(2);
    // The original version_clock is preserved (first write wins)
    expect(results.find((e) => e.event_id === "dup")!.version_clock).toBe(1);
  });

  it("query with empty event_types array returns nothing", async () => {
    const store = new InMemoryEventStore();
    await store.append(makeEvent());
    const results = await store.query({ event_types: [] });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 4a — `append_only_horizon` retention truncation
// ---------------------------------------------------------------------------

describe("InMemoryEventStore.truncateBeforeHorizon", () => {
  it("erases entries with timestamp < horizonTs", async () => {
    const store = new InMemoryEventStore();
    await store.append(makeEvent({ event_id: "old-1", motebit_id: "m1", timestamp: 100 }));
    await store.append(makeEvent({ event_id: "old-2", motebit_id: "m1", timestamp: 200 }));
    await store.append(makeEvent({ event_id: "fresh", motebit_id: "m1", timestamp: 500 }));
    await store.append(makeEvent({ event_id: "other-mote", motebit_id: "m2", timestamp: 50 }));

    const erased = await store.truncateBeforeHorizon("m1", 300);

    expect(erased).toBe(2);
    const remaining = await store.query({});
    expect(remaining.map((e) => e.event_id).sort()).toEqual(["fresh", "other-mote"]);
  });

  it("is whole-prefix-only — never affects entries at or after horizonTs", async () => {
    const store = new InMemoryEventStore();
    await store.append(makeEvent({ motebit_id: "m1", timestamp: 100 }));
    await store.append(makeEvent({ motebit_id: "m1", timestamp: 200 }));

    // horizon EQUAL to an entry's timestamp does not erase that entry.
    const erased = await store.truncateBeforeHorizon("m1", 200);
    expect(erased).toBe(1);
    const remaining = await store.query({ motebit_id: "m1" });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.timestamp).toBe(200);
  });
});

describe("EventStore.advanceHorizon (phase 4a — local-only)", () => {
  it("signs an append_only_horizon cert and truncates the prefix", async () => {
    const adapter = new InMemoryEventStore();
    const store = new EventStore(adapter);
    await adapter.append(makeEvent({ event_id: "a", motebit_id: "m1", timestamp: 100 }));
    await adapter.append(makeEvent({ event_id: "b", motebit_id: "m1", timestamp: 200 }));
    await adapter.append(makeEvent({ event_id: "c", motebit_id: "m1", timestamp: 500 }));

    const { publicKey, privateKey } = await generateEd25519Keypair();

    const { cert, truncatedCount } = await store.advanceHorizon("event-log", 300, {
      subject: { kind: "motebit", motebit_id: "m1" as MotebitId },
      privateKey,
    });

    expect(truncatedCount).toBe(2);
    expect(cert.kind).toBe("append_only_horizon");
    expect(cert.subject.kind).toBe("motebit");
    if (cert.subject.kind === "motebit") {
      expect(cert.subject.motebit_id).toBe("m1");
    }
    expect(cert.horizon_ts).toBe(300);
    expect(cert.witnessed_by).toEqual([]); // local-only — phase 4a

    const verify = await verifyDeletionCertificate(cert, {
      resolveMotebitPublicKey: async (id: string) => (id === "m1" ? publicKey : null),
      resolveOperatorPublicKey: async () => null,
    });
    expect(verify.valid).toBe(true);
    expect(verify.steps.horizon_issuer_signature_valid).toBe(true);
    expect(verify.steps.horizon_witnesses_present_count).toBe(0);

    const remaining = await adapter.query({ motebit_id: "m1" });
    expect(remaining.map((e) => e.event_id)).toEqual(["c"]);
  });

  it("operator-wide horizon advance truncates every supplied motebit's slice", async () => {
    const adapter = new InMemoryEventStore();
    const store = new EventStore(adapter);
    await adapter.append(makeEvent({ event_id: "m1-old", motebit_id: "m1", timestamp: 100 }));
    await adapter.append(makeEvent({ event_id: "m1-new", motebit_id: "m1", timestamp: 500 }));
    await adapter.append(makeEvent({ event_id: "m2-old", motebit_id: "m2", timestamp: 100 }));
    await adapter.append(makeEvent({ event_id: "m2-new", motebit_id: "m2", timestamp: 500 }));
    await adapter.append(makeEvent({ event_id: "m3-old", motebit_id: "m3", timestamp: 100 }));
    // m3 NOT in the operator's motebit set — should survive.

    const { publicKey, privateKey } = await generateEd25519Keypair();
    const { cert, truncatedCount } = await store.advanceHorizon(
      "event-log",
      300,
      { subject: { kind: "operator", operator_id: "op-A" }, privateKey },
      { motebitIdsForOperator: ["m1", "m2"] },
    );

    expect(truncatedCount).toBe(2); // m1-old + m2-old
    expect(cert.subject.kind).toBe("operator");
    if (cert.subject.kind === "operator") {
      expect(cert.subject.operator_id).toBe("op-A");
    }

    const verify = await verifyDeletionCertificate(cert, {
      resolveMotebitPublicKey: async () => null,
      resolveOperatorPublicKey: async (id: string) => (id === "op-A" ? publicKey : null),
    });
    expect(verify.valid).toBe(true);

    const remaining = await adapter.query({});
    expect(remaining.map((e) => e.event_id).sort()).toEqual(["m1-new", "m2-new", "m3-old"]);
  });

  it("operator-wide horizon advance requires motebitIdsForOperator", async () => {
    const adapter = new InMemoryEventStore();
    const store = new EventStore(adapter);
    const { privateKey } = await generateEd25519Keypair();

    await expect(
      store.advanceHorizon("event-log", 300, {
        subject: { kind: "operator", operator_id: "op-A" },
        privateKey,
      }),
    ).rejects.toThrow(/motebitIdsForOperator/);
  });

  it("operator-wide horizon advance accepts an empty motebit set (no-tenant relay)", async () => {
    const adapter = new InMemoryEventStore();
    const store = new EventStore(adapter);
    const { privateKey } = await generateEd25519Keypair();

    const { cert, truncatedCount } = await store.advanceHorizon(
      "event-log",
      300,
      { subject: { kind: "operator", operator_id: "op-A" }, privateKey },
      { motebitIdsForOperator: [] },
    );

    expect(truncatedCount).toBe(0);
    expect(cert.kind).toBe("append_only_horizon");
  });

  it("throws when adapter does not implement truncateBeforeHorizon", async () => {
    // Build an adapter without the optional method to confirm fail-loud.
    const partial: EventStoreAdapter = {
      append: async () => {},
      query: async () => [],
      getLatestClock: async () => 0,
      tombstone: async () => {},
    };
    const store = new EventStore(partial);
    const { privateKey } = await generateEd25519Keypair();

    await expect(
      store.advanceHorizon("event-log", 300, {
        subject: { kind: "motebit", motebit_id: "m1" as MotebitId },
        privateKey,
      }),
    ).rejects.toThrow(/truncateBeforeHorizon/);
  });
});
