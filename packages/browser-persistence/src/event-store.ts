import type { EventLogEntry, EventType } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import { idbRequest } from "./idb.js";

/** Undecryptable-event rows kept per sync cursor key (#868; spec memory-delta §3.6). */
export const SKIPPED_SYNC_EVENTS_KEPT = 1000;

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
      results = (await idbRequest(index.getAll(range))) as EventLogEntry[];
    } else {
      results = (await idbRequest(store.getAll())) as EventLogEntry[];
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

  async appendWithClock(entry: Omit<EventLogEntry, "version_clock">): Promise<number> {
    // IDB transactions are serialized per store, so read-then-write within
    // a single readwrite transaction is atomic.
    const tx = this.db.transaction("events", "readwrite");
    const store = tx.objectStore("events");
    const index = store.index("motebit_clock");
    const range = IDBKeyRange.bound([entry.motebit_id, -Infinity], [entry.motebit_id, Infinity]);

    const latestClock = await new Promise<number>((resolve, reject) => {
      const req = index.openCursor(range, "prev");
      req.onsuccess = () => {
        const cursor = req.result;
        resolve(cursor ? (cursor.value as EventLogEntry).version_clock : 0);
      };
      req.onerror = () => reject(req.error ?? new Error("IDB cursor request failed"));
    });

    const clock = latestClock + 1;
    const fullEntry = { ...entry, version_clock: clock };
    try {
      await idbRequest(store.add(fullEntry));
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "ConstraintError") return latestClock;
      throw err;
    }
    return clock;
  }

  async getLatestClock(motebitId: string): Promise<number> {
    const tx = this.db.transaction("events", "readonly");
    const store = tx.objectStore("events");
    const index = store.index("motebit_clock");

    // Open cursor in reverse direction on [motebit_id, version_clock]
    const range = IDBKeyRange.bound([motebitId, -Infinity], [motebitId, Infinity]);

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
      req.onerror = () => reject(req.error ?? new Error("IDB cursor request failed"));
    });
  }

  /** The event-sync pull cursor (#868; IDB v9) — a `SyncSeqCursorStore`. */
  async getSyncSeqCursor(key: string): Promise<number | null> {
    const tx = this.db.transaction("sync_seq_cursors", "readonly");
    const row = (await idbRequest(tx.objectStore("sync_seq_cursors").get(key))) as
      { cursor_key: string; seq: number } | undefined;
    return typeof row?.seq === "number" ? row.seq : null;
  }

  /**
   * Record a pulled event the sync stream moved past because it could not
   * be decrypted (#868, IDB v9). One readwrite transaction: the row (once per
   * event_id), the running total, and the prune to the newest
   * `SKIPPED_SYNC_EVENTS_KEPT` rows for this cursor key.
   */
  async recordSkippedSyncEvent(
    key: string,
    skipped: { event_id: string; seq: number | null; reason: string; detail?: string },
  ): Promise<void> {
    const tx = this.db.transaction(["sync_skipped_events", "sync_skipped_totals"], "readwrite");
    const rows = tx.objectStore("sync_skipped_events");
    const totals = tx.objectStore("sync_skipped_totals");
    const held = await idbRequest(rows.index("key_event").getKey([key, skipped.event_id]));
    if (held !== undefined) return;
    await idbRequest(
      rows.add({
        cursor_key: key,
        event_id: skipped.event_id,
        seq: skipped.seq,
        reason: skipped.reason,
        detail: skipped.detail ?? null,
        recorded_at: Date.now(),
      }),
    );
    const prior = (await idbRequest(totals.get(key))) as { total: number } | undefined;
    await idbRequest(totals.put({ cursor_key: key, total: (prior?.total ?? 0) + 1 }));
    const count = await idbRequest(rows.index("cursor_key").count(key));
    let excess = count - SKIPPED_SYNC_EVENTS_KEPT;
    if (excess <= 0) return;
    // Oldest first: an index cursor over equal keys walks primary keys
    // (insertion order) ascending.
    await new Promise<void>((resolve, reject) => {
      const req = rows.index("cursor_key").openCursor(IDBKeyRange.only(key));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || excess <= 0) return resolve();
        cursor.delete();
        excess--;
        cursor.continue();
      };
      req.onerror = () => reject(req.error ?? new Error("IDB prune failed"));
    });
  }

  /** Every undecryptable skip recorded for `key`, including rows since pruned (#868). */
  async countSkippedSyncEvents(key: string): Promise<number> {
    const tx = this.db.transaction("sync_skipped_totals", "readonly");
    const row = (await idbRequest(tx.objectStore("sync_skipped_totals").get(key))) as
      { total: number } | undefined;
    return row?.total ?? 0;
  }

  /** The kept skipped-event rows for one relay stream, oldest first (#868). */
  async listSkippedSyncEvents(
    key: string,
  ): Promise<Array<{ event_id: string; seq: number | null; reason: string }>> {
    const tx = this.db.transaction("sync_skipped_events", "readonly");
    const rows = (await idbRequest(
      tx.objectStore("sync_skipped_events").index("cursor_key").getAll(IDBKeyRange.only(key)),
    )) as Array<{ event_id: string; seq: number | null; reason: string }>;
    return rows.map(({ event_id, seq, reason }) => ({ event_id, seq, reason }));
  }

  /**
   * Which of `eventIds` this store holds — one key lookup per id in a single
   * read transaction, never a `getAll` of the log (#868).
   */
  async getHeldEventIds(eventIds: readonly string[]): Promise<Set<string>> {
    const held = new Set<string>();
    if (eventIds.length === 0) return held;
    const tx = this.db.transaction("events", "readonly");
    const store = tx.objectStore("events");
    await Promise.all(
      eventIds.map(async (id) => {
        const key = await idbRequest(store.getKey(id));
        if (key !== undefined) held.add(id);
      }),
    );
    return held;
  }

  /** Cursor keys starting with `prefix` (#962: compaction reads every relay stream's push cursor). */
  async listSyncSeqCursorKeys(prefix: string): Promise<string[]> {
    const tx = this.db.transaction("sync_seq_cursors", "readonly");
    const keys = await idbRequest(tx.objectStore("sync_seq_cursors").getAllKeys());
    return keys.filter((k): k is string => typeof k === "string" && k.startsWith(prefix));
  }

  async setSyncSeqCursor(key: string, seq: number): Promise<void> {
    const tx = this.db.transaction("sync_seq_cursors", "readwrite");
    await idbRequest(
      tx.objectStore("sync_seq_cursors").put({ cursor_key: key, seq, updated_at: Date.now() }),
    );
  }

  async tombstone(eventId: string, _motebitId: string): Promise<void> {
    const tx = this.db.transaction("events", "readwrite");
    const store = tx.objectStore("events");
    const entry = (await idbRequest(store.get(eventId))) as EventLogEntry | undefined;
    if (entry) {
      entry.tombstoned = true;
      await idbRequest(store.put(entry));
    }
  }

  async compact(motebitId: string, beforeClock: number): Promise<number> {
    const tx = this.db.transaction("events", "readwrite");
    const store = tx.objectStore("events");
    const index = store.index("motebit_clock");
    const range = IDBKeyRange.bound([motebitId, -Infinity], [motebitId, beforeClock]);

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
      req.onerror = () => reject(req.error ?? new Error("IDB compact request failed"));
    });
  }

  async truncateBeforeHorizon(motebitId: string, horizonTs: number): Promise<number> {
    // `append_only_horizon` whole-prefix truncation. IDB has no native
    // index on (motebit_id, timestamp), so we scan the motebit's slice
    // via the existing `motebit_clock` index then filter by timestamp.
    // Strict less-than per the cert's "entries BEFORE horizon" claim.
    const tx = this.db.transaction("events", "readwrite");
    const store = tx.objectStore("events");
    const index = store.index("motebit_clock");
    const range = IDBKeyRange.bound([motebitId, -Infinity], [motebitId, Infinity]);

    let deleted = 0;
    return new Promise((resolve, reject) => {
      const req = index.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const entry = cursor.value as EventLogEntry;
          if (entry.timestamp < horizonTs) {
            cursor.delete();
            deleted++;
          }
          cursor.continue();
        } else {
          resolve(deleted);
        }
      };
      req.onerror = () =>
        reject(req.error ?? new Error("IDB truncateBeforeHorizon request failed"));
    });
  }

  async countEvents(motebitId: string): Promise<number> {
    const tx = this.db.transaction("events", "readonly");
    const store = tx.objectStore("events");
    const index = store.index("motebit_time");
    const range = IDBKeyRange.bound([motebitId, -Infinity], [motebitId, Infinity]);
    return idbRequest(index.count(range));
  }
}
