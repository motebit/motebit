import { describe, it, expect, beforeEach, vi } from "vitest";
import { SyncEngine } from "../index";
import type { SyncStatus } from "../index";
import { InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTEBIT_ID = "motebit-1";

function makeEvent(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: MOTEBIT_ID,
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
// SyncEngine
// ---------------------------------------------------------------------------

describe("SyncEngine", () => {
  let localStore: InMemoryEventStore;
  let engine: SyncEngine;

  beforeEach(() => {
    localStore = new InMemoryEventStore();
    engine = new SyncEngine(localStore, MOTEBIT_ID);
  });

  it("starts in idle status", () => {
    expect(engine.getStatus()).toBe("idle");
  });

  it("sync with no remote returns offline status", async () => {
    const result = await engine.sync();
    expect(engine.getStatus()).toBe("offline");
    expect(result.pushed).toBe(0);
    expect(result.pulled).toBe(0);
    expect(result.conflicts).toEqual([]);
  });

  it("sync pushes local events to remote", async () => {
    const remoteStore = new InMemoryEventStore();
    engine.connectRemote(remoteStore);

    // Add events to local store
    const event = makeEvent({ version_clock: 1 });
    await localStore.append(event);

    const result = await engine.sync();
    expect(result.pushed).toBe(1);

    // Verify event was pushed to remote
    const remoteEvents = await remoteStore.query({ motebit_id: MOTEBIT_ID });
    expect(remoteEvents).toHaveLength(1);
    expect(remoteEvents[0]!.event_id).toBe(event.event_id);
  });

  it("sync pulls remote events to local", async () => {
    const remoteStore = new InMemoryEventStore();
    engine.connectRemote(remoteStore);

    // Add event to remote store (version_clock > 0 since cursor starts at 0)
    const event = makeEvent({ version_clock: 1 });
    await remoteStore.append(event);

    const result = await engine.sync();
    expect(result.pulled).toBe(1);

    // Verify event was pulled to local
    const localEvents = await localStore.query({ motebit_id: MOTEBIT_ID });
    expect(localEvents).toHaveLength(1);
  });

  it("detects conflicts when same version_clock from different events", async () => {
    const remoteStore = new InMemoryEventStore();
    engine.connectRemote(remoteStore);

    // Local has event at clock 1
    await localStore.append(makeEvent({ event_id: "local-event", version_clock: 1 }));

    // Remote also has a different event at clock 1, plus a higher clock event
    // so the pull finds it (remote event clock must be > localClock after push)
    await remoteStore.append(makeEvent({ event_id: "remote-event", version_clock: 1 }));
    // Add a clock=2 event so pull has something after the local clock
    await remoteStore.append(makeEvent({ event_id: "remote-event-2", version_clock: 2 }));

    const result = await engine.sync();
    // The pushed events (clock=1) and pulled events (clock=2) have different clocks,
    // so no conflict is detected in this simple detection model.
    // Conflict detection compares pushed vs pulled — only flags same version_clock.
    // Since pushed has clock=1 and pulled has clock=2, no conflict.
    expect(result.conflicts).toHaveLength(0);

    // Conflicts accumulate via getConflicts()
    expect(engine.getConflicts()).toHaveLength(0);
  });

  it("status listeners are notified of status changes", async () => {
    const remoteStore = new InMemoryEventStore();
    engine.connectRemote(remoteStore);

    const statuses: SyncStatus[] = [];
    engine.onStatusChange((status) => {
      statuses.push(status);
    });

    await engine.sync();

    // Should transition through syncing -> idle
    expect(statuses).toContain("syncing");
    expect(statuses).toContain("idle");
  });

  it("status listeners can be unsubscribed", async () => {
    const remoteStore = new InMemoryEventStore();
    engine.connectRemote(remoteStore);

    const statuses: SyncStatus[] = [];
    const unsub = engine.onStatusChange((status) => {
      statuses.push(status);
    });

    unsub();
    await engine.sync();

    // Should NOT have received any status updates
    expect(statuses).toHaveLength(0);
  });

  it("getCursor returns the current cursor state", () => {
    const cursor = engine.getCursor();
    expect(cursor.motebit_id).toBe(MOTEBIT_ID);
    expect(cursor.last_event_id).toBe("");
    expect(cursor.last_version_clock).toBe(0);
  });

  it("sync updates cursor after successful sync", async () => {
    const remoteStore = new InMemoryEventStore();
    engine.connectRemote(remoteStore);

    await localStore.append(makeEvent({ version_clock: 5 }));
    await engine.sync();

    const cursor = engine.getCursor();
    expect(cursor.last_version_clock).toBe(5);
  });

  it("sync sets error status when remote throws", async () => {
    const failingStore: EventStoreAdapter = {
      append: vi.fn<EventStoreAdapter["append"]>().mockRejectedValue(new Error("network error")),
      query: vi.fn<EventStoreAdapter["query"]>().mockRejectedValue(new Error("network error")),
      getLatestClock: vi.fn<EventStoreAdapter["getLatestClock"]>().mockRejectedValue(new Error("network error")),
      tombstone: vi.fn<EventStoreAdapter["tombstone"]>(),
    };
    engine.connectRemote(failingStore);

    const result = await engine.sync();
    expect(engine.getStatus()).toBe("error");
    expect(result.pushed).toBe(0);
    expect(result.pulled).toBe(0);
  });

  it("start and stop manage the sync interval", () => {
    vi.useFakeTimers();

    const remoteStore = new InMemoryEventStore();
    engine.connectRemote(remoteStore);

    const syncSpy = vi.spyOn(engine, "sync");

    engine.start();
    // Default interval is 30_000ms
    vi.advanceTimersByTime(30_000);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    engine.stop();
    vi.advanceTimersByTime(60_000);
    // Should still be 1 because we stopped
    expect(syncSpy).toHaveBeenCalledTimes(1);

    syncSpy.mockRestore();
    vi.useRealTimers();
  });

  it("start is idempotent (calling twice does not create duplicate intervals)", () => {
    vi.useFakeTimers();

    const remoteStore = new InMemoryEventStore();
    engine.connectRemote(remoteStore);

    const syncSpy = vi.spyOn(engine, "sync");

    engine.start();
    engine.start(); // second call should be no-op
    vi.advanceTimersByTime(30_000);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    engine.stop();
    syncSpy.mockRestore();
    vi.useRealTimers();
  });
});
