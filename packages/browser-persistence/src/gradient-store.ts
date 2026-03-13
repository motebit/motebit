import type { GradientStoreAdapter, GradientSnapshot } from "@motebit/runtime";
import { idbRequest } from "./idb.js";

/**
 * IDB-backed GradientStore with preload+cache pattern.
 *
 * GradientStoreAdapter has sync methods but IDB is async.
 * Preload snapshots at bootstrap, then serve reads from cache
 * with write-through to IDB (fire-and-forget).
 */
export class IdbGradientStore implements GradientStoreAdapter {
  private _snapshots: GradientSnapshot[] = []; // sorted by timestamp DESC

  constructor(private db: IDBDatabase) {}

  /** Preload gradient snapshots for a motebit. Call before runtime construction. */
  async preload(motebitId: string): Promise<void> {
    const tx = this.db.transaction("gradient_snapshots", "readonly");
    const store = tx.objectStore("gradient_snapshots");
    const index = store.index("motebit_time");
    const range = IDBKeyRange.bound([motebitId, -Infinity], [motebitId, Infinity]);
    const all = (await idbRequest(index.getAll(range))) as GradientSnapshot[];
    this._snapshots = all.sort((a, b) => b.timestamp - a.timestamp);
  }

  save(snapshot: GradientSnapshot): void {
    this._snapshots.unshift(snapshot);
    const tx = this.db.transaction("gradient_snapshots", "readwrite");
    tx.objectStore("gradient_snapshots").add({ ...snapshot });
  }

  latest(motebitId: string): GradientSnapshot | null {
    const match = this._snapshots.find((s) => s.motebit_id === motebitId);
    return match ?? null;
  }

  list(motebitId: string, limit?: number): GradientSnapshot[] {
    const matching = this._snapshots.filter((s) => s.motebit_id === motebitId);
    return limit !== undefined ? matching.slice(0, limit) : matching;
  }
}
