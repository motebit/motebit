import { describe, it, expect, beforeEach } from "vitest";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { openMotebitDB } from "../idb.js";
import { IdbEventStore, SKIPPED_SYNC_EVENTS_KEPT } from "../event-store.js";

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

  it("keeps the event-sync seq cursor per relay stream, beside the events (#868, v9)", async () => {
    const name = `test-cursor-${crypto.randomUUID()}`;
    const s1 = new IdbEventStore(await openMotebitDB(name));
    const a = "http://relay.one#mote-1";
    expect(await s1.getSyncSeqCursor(a)).toBeNull();
    await s1.setSyncSeqCursor(a, 4);
    await s1.setSyncSeqCursor(a, 11);
    await s1.setSyncSeqCursor("http://relay.two#mote-1", 2);
    // A new page load opens the database again and reads the same cursor.
    const s2 = new IdbEventStore(await openMotebitDB(name));
    expect(await s2.getSyncSeqCursor(a)).toBe(11);
    expect(await s2.getSyncSeqCursor("http://relay.two#mote-1")).toBe(2);
  });

  it("answers which event_ids it holds by key, and records skipped sync events (#868, v9)", async () => {
    await store.append(makeEvent({ event_id: "held-1" }));
    await store.append(makeEvent({ event_id: "held-2" }));
    const held = await store.getHeldEventIds(["held-1", "absent", "held-2"]);
    expect([...held].sort()).toEqual(["held-1", "held-2"]);
    expect(await store.getHeldEventIds([])).toEqual(new Set());
    await expect(
      store.recordSkippedSyncEvent("k", { event_id: "x", seq: 2, reason: "undecryptable" }),
    ).resolves.toBeUndefined();
  });

  it("bounds the skipped-event record: N+5 skips leave the newest N rows and a total of N+5 (#868)", async () => {
    const N = SKIPPED_SYNC_EVENTS_KEPT;
    for (let i = 1; i <= N + 5; i++) {
      await store.recordSkippedSyncEvent("k", {
        event_id: `x${i}`,
        seq: i,
        reason: "undecryptable",
      });
    }
    await store.recordSkippedSyncEvent("k", {
      event_id: `x${N + 5}`,
      seq: N + 5,
      reason: "undecryptable",
    });
    const rows = await store.listSkippedSyncEvents("k");
    expect(rows).toHaveLength(N);
    expect(rows[0]!.event_id).toBe("x6");
    expect(await store.countSkippedSyncEvents("k")).toBe(N + 5);
  });

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
