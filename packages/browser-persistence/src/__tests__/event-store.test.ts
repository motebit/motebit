import { describe, it, expect, beforeEach } from "vitest";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { openMotebitDB } from "../idb.js";
import { IdbEventStore } from "../event-store.js";

describe("IdbEventStore", () => {
  let store: IdbEventStore;

  beforeEach(async () => {
    const db = await openMotebitDB(`test-events-${crypto.randomUUID()}`);
    store = new IdbEventStore(db);
  });

  function makeEvent(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
    return {
      event_id: crypto.randomUUID(),
      motebit_id: "mote-1",
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: {},
      version_clock: 1,
      tombstoned: false,
      ...overrides,
    };
  }

  it("appends and queries events", async () => {
    const e1 = makeEvent({ version_clock: 1 });
    const e2 = makeEvent({ version_clock: 2 });
    await store.append(e1);
    await store.append(e2);

    const results = await store.query({ motebit_id: "mote-1" });
    expect(results).toHaveLength(2);
  });

  it("handles idempotent dedup on duplicate event_id", async () => {
    const e = makeEvent();
    await store.append(e);
    await store.append(e); // should not throw
    const results = await store.query({ motebit_id: "mote-1" });
    expect(results).toHaveLength(1);
  });

  it("filters by event_types", async () => {
    await store.append(makeEvent({ event_type: EventType.StateUpdated, version_clock: 1 }));
    await store.append(makeEvent({ event_type: EventType.MemoryFormed, version_clock: 2 }));

    const results = await store.query({
      motebit_id: "mote-1",
      event_types: [EventType.MemoryFormed],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.event_type).toBe(EventType.MemoryFormed);
  });

  it("filters by timestamp range", async () => {
    await store.append(makeEvent({ timestamp: 100, version_clock: 1 }));
    await store.append(makeEvent({ timestamp: 200, version_clock: 2 }));
    await store.append(makeEvent({ timestamp: 300, version_clock: 3 }));

    const results = await store.query({
      motebit_id: "mote-1",
      after_timestamp: 100,
      before_timestamp: 300,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.timestamp).toBe(200);
  });

  it("filters by after_version_clock", async () => {
    await store.append(makeEvent({ version_clock: 1 }));
    await store.append(makeEvent({ version_clock: 2 }));
    await store.append(makeEvent({ version_clock: 3 }));

    const results = await store.query({
      motebit_id: "mote-1",
      after_version_clock: 1,
    });
    expect(results).toHaveLength(2);
  });

  it("applies limit", async () => {
    await store.append(makeEvent({ version_clock: 1 }));
    await store.append(makeEvent({ version_clock: 2 }));
    await store.append(makeEvent({ version_clock: 3 }));

    const results = await store.query({ motebit_id: "mote-1", limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("tombstones an event", async () => {
    const e = makeEvent();
    await store.append(e);
    await store.tombstone(e.event_id, "mote-1");

    const results = await store.query({ motebit_id: "mote-1" });
    expect(results[0]!.tombstoned).toBe(true);
  });

  it("compacts events below a clock", async () => {
    await store.append(makeEvent({ version_clock: 1 }));
    await store.append(makeEvent({ version_clock: 2 }));
    await store.append(makeEvent({ version_clock: 3 }));

    const deleted = await store.compact("mote-1", 2);
    expect(deleted).toBe(2);

    const remaining = await store.query({ motebit_id: "mote-1" });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.version_clock).toBe(3);
  });

  it("counts events", async () => {
    await store.append(makeEvent({ version_clock: 1 }));
    await store.append(makeEvent({ version_clock: 2 }));

    const count = await store.countEvents("mote-1");
    expect(count).toBe(2);
  });

  it("getLatestClock returns highest version_clock", async () => {
    await store.append(makeEvent({ version_clock: 5 }));
    await store.append(makeEvent({ version_clock: 3 }));
    await store.append(makeEvent({ version_clock: 10 }));

    const clock = await store.getLatestClock("mote-1");
    expect(clock).toBe(10);
  });

  it("getLatestClock returns 0 for no events", async () => {
    const clock = await store.getLatestClock("mote-missing");
    expect(clock).toBe(0);
  });

  it("isolates events by motebit_id", async () => {
    await store.append(makeEvent({ motebit_id: "mote-1", version_clock: 1 }));
    await store.append(makeEvent({ motebit_id: "mote-2", version_clock: 1 }));

    const results = await store.query({ motebit_id: "mote-1" });
    expect(results).toHaveLength(1);
  });
});
