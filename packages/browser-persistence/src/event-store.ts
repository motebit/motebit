import type { EventLogEntry, EventType } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import { idbRequest } from "./idb.js";

export class IdbEventStore implements EventStoreAdapter {
  constructor(private db: IDBDatabase) {}

  async append(entry: EventLogEntry): Promise<void> {
    const tx = this.db.transaction("events", "readwrite");
    const store = tx.objectStore("events");
    try {
      await idbRequest(store.add(entry));
    } catch (err: unknown) {
      // Idempotency: ignore ConstraintError (duplicate event_id)
      if (err instanceof DOMException && err.name === "ConstraintError") return;
      throw err;
    }
  }

  async query(filter: EventFilter): Promise<EventLogEntry[]> {
    const tx = this.db.transaction("events", "readonly");
    const store = tx.objectStore("events");

    let results: EventLogEntry[];

    if (filter.motebit_id !== undefined) {
      // Use motebit_time index to get all events for this motebit
      const index = store.index("motebit_time");
      const range = IDBKeyRange.bound(
        [filter.motebit_id, -Infinity],
        [filter.motebit_id, Infinity],
      );
      results = await idbRequest(index.getAll(range));
    } else {
      results = await idbRequest(store.getAll());
    }

    // JS-side filtering (events bounded by compaction, so full-scan is fine)
    if (filter.event_types !== undefined) {
      const types = new Set<EventType>(filter.event_types);
      results = results.filter((e) => types.has(e.event_type));
    }
    if (filter.after_timestamp !== undefined) {
      results = results.filter((e) => e.timestamp > filter.after_timestamp!);
    }
    if (filter.before_timestamp !== undefined) {
      results = results.filter((e) => e.timestamp < filter.before_timestamp!);
    }
    if (filter.after_version_clock !== undefined) {
      results = results.filter((e) => e.version_clock > filter.after_version_clock!);
    }
    if (filter.limit !== undefined) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  async getLatestClock(motebitId: string): Promise<number> {
    const tx = this.db.transaction("events", "readonly");
    const store = tx.objectStore("events");
    const index = store.index("motebit_clock");

    // Open cursor in reverse direction on [motebit_id, version_clock]
    const range = IDBKeyRange.bound(
      [motebitId, -Infinity],
      [motebitId, Infinity],
    );

    return new Promise((resolve, reject) => {
      const req = index.openCursor(range, "prev");
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          resolve((cursor.value as EventLogEntry).version_clock);
        } else {
          resolve(0);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async tombstone(eventId: string, _motebitId: string): Promise<void> {
    const tx = this.db.transaction("events", "readwrite");
    const store = tx.objectStore("events");
    const entry = await idbRequest(store.get(eventId)) as EventLogEntry | undefined;
    if (entry) {
      entry.tombstoned = true;
      await idbRequest(store.put(entry));
    }
  }

  async compact(motebitId: string, beforeClock: number): Promise<number> {
    const tx = this.db.transaction("events", "readwrite");
    const store = tx.objectStore("events");
    const index = store.index("motebit_clock");
    const range = IDBKeyRange.bound(
      [motebitId, -Infinity],
      [motebitId, beforeClock],
    );

    let deleted = 0;
    return new Promise((resolve, reject) => {
      const req = index.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          resolve(deleted);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async countEvents(motebitId: string): Promise<number> {
    const tx = this.db.transaction("events", "readonly");
    const store = tx.objectStore("events");
    const index = store.index("motebit_time");
    const range = IDBKeyRange.bound(
      [motebitId, -Infinity],
      [motebitId, Infinity],
    );
    return idbRequest(index.count(range));
  }
}
