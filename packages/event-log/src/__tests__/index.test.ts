import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryEventStore, EventStore } from "../index";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";

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
    await store.append(
      makeEvent({ event_type: EventType.StateUpdated }),
    );
    await store.append(
      makeEvent({ event_type: EventType.MemoryFormed }),
    );
    await store.append(
      makeEvent({ event_type: EventType.IdentityCreated }),
    );
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
// EventStore (high-level wrapper)
// ---------------------------------------------------------------------------

describe("EventStore", () => {
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = new EventStore(new InMemoryEventStore());
  });

  it("rejects empty event_id", async () => {
    const event = makeEvent({ event_id: "" });
    await expect(eventStore.append(event)).rejects.toThrow(
      "event_id must not be empty",
    );
  });

  it("rejects empty motebit_id", async () => {
    const event = makeEvent({ motebit_id: "" });
    await expect(eventStore.append(event)).rejects.toThrow(
      "motebit_id must not be empty",
    );
  });

  it("appends valid events", async () => {
    const event = makeEvent();
    await eventStore.append(event);
    const results = await eventStore.query({});
    expect(results).toHaveLength(1);
  });

  it("replay processes events in version_clock order", async () => {
    await eventStore.append(
      makeEvent({ motebit_id: "m1", version_clock: 3 }),
    );
    await eventStore.append(
      makeEvent({ motebit_id: "m1", version_clock: 1 }),
    );
    await eventStore.append(
      makeEvent({ motebit_id: "m1", version_clock: 2 }),
    );

    const order: number[] = [];
    await eventStore.replay("m1", (entry) => {
      order.push(entry.version_clock);
      return Promise.resolve();
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it("replay only processes events for the specified motebit", async () => {
    await eventStore.append(
      makeEvent({ motebit_id: "m1", version_clock: 1 }),
    );
    await eventStore.append(
      makeEvent({ motebit_id: "m2", version_clock: 2 }),
    );

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
