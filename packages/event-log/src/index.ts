import type { EventLogEntry, DeletionCertificate, HorizonSubject } from "@motebit/protocol";
export type { EventFilter, EventStoreAdapter } from "@motebit/protocol";
import type { EventFilter, EventStoreAdapter } from "@motebit/protocol";
import { signHorizonCertAsIssuer } from "@motebit/crypto";

/**
 * Signer for an `append_only_horizon` deletion certificate. Whichever
 * authority advances the horizon (per-motebit subject or operator-wide)
 * provides the corresponding identity key. Decision 8 of
 * docs/doctrine/retention-policy.md.
 */
export interface HorizonSigner {
  readonly subject: HorizonSubject;
  readonly privateKey: Uint8Array;
}

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

  appendWithClock(entry: Omit<EventLogEntry, "version_clock">): Promise<number> {
    if (this.seenIds.has(entry.event_id)) {
      // Already exists — return existing clock (seenIds guarantees the event is in the array)
      const existing = this.events.find((e) => e.event_id === entry.event_id)!;
      return Promise.resolve(existing.version_clock);
    }
    const moteEvents = this.events.filter((e) => e.motebit_id === entry.motebit_id);
    const clock =
      moteEvents.length === 0 ? 1 : Math.max(...moteEvents.map((e) => e.version_clock)) + 1;
    this.seenIds.add(entry.event_id);
    this.events.push({ ...entry, version_clock: clock });
    return Promise.resolve(clock);
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

  truncateBeforeHorizon(motebitId: string, horizonTs: number): Promise<number> {
    // Whole-prefix truncation per `append_only_horizon` semantics.
    // Entries with `timestamp < horizonTs` are unrecoverable after
    // this returns; the seenIds replay-defense set DOES NOT clear, so
    // resurfacing a truncated event_id still fails the dedup check.
    const before = this.events.length;
    this.events = this.events.filter((e) => e.motebit_id !== motebitId || e.timestamp >= horizonTs);
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
   * Atomically assign the next version_clock and append.
   * Eliminates the getLatestClock() + clock+1 race condition.
   */
  async appendWithClock(entry: Omit<EventLogEntry, "version_clock">): Promise<number> {
    if (entry.event_id === "") {
      throw new Error("event_id must not be empty");
    }
    if (entry.motebit_id === "") {
      throw new Error("motebit_id must not be empty");
    }
    if (this.adapter.appendWithClock) {
      return this.adapter.appendWithClock(entry);
    }
    // Fallback for adapters that don't implement appendWithClock (non-atomic)
    const clock = await this.adapter.getLatestClock(entry.motebit_id);
    const assigned = clock + 1;
    await this.adapter.append({ ...entry, version_clock: assigned } as EventLogEntry);
    return assigned;
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

  /**
   * Advance the event-log horizon. Whole-prefix retention truncation
   * for an `append_only_horizon`-shaped store, per
   * docs/doctrine/retention-policy.md §"Decision 4" + §"Decision 8".
   *
   * Two subject kinds (decision 8):
   *   - `motebit`: per-motebit horizon advance, signed by the motebit's
   *     identity key. Truncates only that motebit's slice of the log.
   *   - `operator`: operator-wide horizon advance, signed by the
   *     operator key. Iterates `motebitIdsForOperator` (caller-supplied)
   *     and truncates each. The relay's federation peer set determines
   *     `witness_required`; for no-peer deployments the witness array
   *     is empty and the manifest derives `witness_required = false`.
   *
   * Phase 4b ships per-motebit + operator-wide for no-peer deployments.
   * Federation co-witness solicitation (witness array populated +
   * `federation_graph_anchor` Merkle root) is phase 4b-3 — the wire
   * format spec for cross-relay solicitation lives at services/relay.
   *
   * Order is load-bearing: sign FIRST, truncate AFTER. The signed cert
   * references `horizon_ts`; truncation is the storage commitment to
   * that cert. Truncation before signing would leave a window where
   * entries are gone but no cert exists to attest it.
   *
   * Returns the signed cert and the total count of erased entries
   * (sum across motebits for operator-wide advances).
   */
  async advanceHorizon(
    storeId: string,
    horizonTs: number,
    signer: HorizonSigner,
    options?: {
      /**
       * Required when `signer.subject.kind === "operator"`. The list of
       * motebit ids whose log-slices the operator-wide horizon advance
       * truncates. The caller (typically `services/relay`) computes
       * this from the relay's tenant set at `horizon_ts`.
       */
      readonly motebitIdsForOperator?: readonly string[];
    },
  ): Promise<{
    cert: Extract<DeletionCertificate, { kind: "append_only_horizon" }>;
    truncatedCount: number;
  }> {
    if (!this.adapter.truncateBeforeHorizon) {
      throw new Error(
        "EventStore.advanceHorizon: adapter does not implement truncateBeforeHorizon",
      );
    }

    const cert = await signHorizonCertAsIssuer(
      {
        kind: "append_only_horizon",
        subject: signer.subject,
        store_id: storeId,
        horizon_ts: horizonTs,
        witnessed_by: [],
        issued_at: Date.now(),
      },
      signer.privateKey,
    );

    let truncatedCount = 0;
    if (signer.subject.kind === "motebit") {
      truncatedCount = await this.adapter.truncateBeforeHorizon(
        signer.subject.motebit_id as string,
        horizonTs,
      );
    } else {
      // Operator-wide: caller supplies the motebit set the operator
      // hosts at `horizon_ts`. Empty list is permitted (no-tenant relay)
      // — the cert is still signed and represents the operator's
      // commitment to truncate any future tenants' pre-horizon entries.
      const ids = options?.motebitIdsForOperator;
      if (ids === undefined) {
        throw new Error(
          "EventStore.advanceHorizon: operator-wide subject requires `motebitIdsForOperator`",
        );
      }
      for (const id of ids) {
        truncatedCount += await this.adapter.truncateBeforeHorizon(id, horizonTs);
      }
    }

    return { cert, truncatedCount };
  }
}
