import type { EventLogEntry } from "@motebit/sdk";
export type { EventFilter, EventStoreAdapter } from "@motebit/sdk";
import type { EventFilter, EventStoreAdapter } from "@motebit/sdk";

// === In-Memory Adapter (for testing and lightweight use) ===

export class InMemoryEventStore implements EventStoreAdapter {
  private events: EventLogEntry[] = [];
  private seenIds = new Set<string>();

  append(entry: EventLogEntry): Promise<void> {
    // Deduplicate on event_id — prevents replay attacks
    if (this.seenIds.has(entry.event_id)) {
      return Promise.resolve();
    }
    this.seenIds.add(entry.event_id);
    // Event log is append-only — no updates, no deletes
    this.events.push({ ...entry });
    return Promise.resolve();
  }

  query(filter: EventFilter): Promise<EventLogEntry[]> {
    let results = [...this.events];

    if (filter.motebit_id !== undefined) {
      results = results.filter((e) => e.motebit_id === filter.motebit_id);
    }
    if (filter.event_types !== undefined) {
      results = results.filter((e) => filter.event_types!.includes(e.event_type));
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

    return Promise.resolve(results);
  }

  getLatestClock(motebitId: string): Promise<number> {
    const moteEvents = this.events.filter((e) => e.motebit_id === motebitId);
    if (moteEvents.length === 0) return Promise.resolve(0);
    return Promise.resolve(Math.max(...moteEvents.map((e) => e.version_clock)));
  }

  tombstone(eventId: string, motebitId: string): Promise<void> {
    const event = this.events.find((e) => e.event_id === eventId && e.motebit_id === motebitId);
    if (event !== undefined) {
      // Tombstone is a marker, not a delete — the event stays in the log
      event.tombstoned = true;
    }
    return Promise.resolve();
  }

  compact(motebitId: string, beforeClock: number): Promise<number> {
    const before = this.events.length;
    this.events = this.events.filter(
      (e) => e.motebit_id !== motebitId || e.version_clock > beforeClock,
    );
    return Promise.resolve(before - this.events.length);
  }

  countEvents(motebitId: string): Promise<number> {
    return Promise.resolve(this.events.filter((e) => e.motebit_id === motebitId).length);
  }
}

// === Event Store (high-level API) ===

export class EventStore {
  constructor(private adapter: EventStoreAdapter) {}

  async append(entry: EventLogEntry): Promise<void> {
    if (entry.event_id === "") {
      throw new Error("event_id must not be empty");
    }
    if (entry.motebit_id === "") {
      throw new Error("motebit_id must not be empty");
    }
    return this.adapter.append(entry);
  }

  async query(filter: EventFilter): Promise<EventLogEntry[]> {
    return this.adapter.query(filter);
  }

  async getLatestClock(motebitId: string): Promise<number> {
    return this.adapter.getLatestClock(motebitId);
  }

  async tombstone(eventId: string, motebitId: string): Promise<void> {
    return this.adapter.tombstone(eventId, motebitId);
  }

  /**
   * Replay events in order — useful for rebuilding derived state.
   */
  async replay(motebitId: string, handler: (entry: EventLogEntry) => Promise<void>): Promise<void> {
    const events = await this.adapter.query({ motebit_id: motebitId });
    const sorted = events.sort((a, b) => a.version_clock - b.version_clock);
    for (const event of sorted) {
      await handler(event);
    }
  }

  /**
   * Delete events with version_clock <= beforeClock.
   * Safe only after a state snapshot at that clock has been persisted.
   */
  async compact(motebitId: string, beforeClock: number): Promise<number> {
    if (!this.adapter.compact) return 0;
    return this.adapter.compact(motebitId, beforeClock);
  }

  /**
   * Count total events for a motebit.
   */
  async countEvents(motebitId: string): Promise<number> {
    if (!this.adapter.countEvents) return -1;
    return this.adapter.countEvents(motebitId);
  }
}
