/**
 * localStorage-backed StateSnapshotAdapter.
 *
 * The StateSnapshotAdapter interface is synchronous — IndexedDB can't back it.
 * Uses localStorage instead. Declares the interface locally (3 methods) to
 * avoid depending on @motebit/runtime. TypeScript structural typing makes
 * it compatible.
 */

export interface StateSnapshotAdapter {
  saveState(motebitId: string, stateJson: string, versionClock?: number): void;
  loadState(motebitId: string): string | null;
  getSnapshotClock?(motebitId: string): number;
}

const STATE_PREFIX = "motebit:state:";
const CLOCK_PREFIX = "motebit:state_clock:";

export class LocalStorageStateSnapshot implements StateSnapshotAdapter {
  saveState(motebitId: string, stateJson: string, versionClock?: number): void {
    localStorage.setItem(STATE_PREFIX + motebitId, stateJson);
    if (versionClock !== undefined) {
      localStorage.setItem(CLOCK_PREFIX + motebitId, String(versionClock));
    }
  }

  loadState(motebitId: string): string | null {
    return localStorage.getItem(STATE_PREFIX + motebitId);
  }

  getSnapshotClock(motebitId: string): number {
    const raw = localStorage.getItem(CLOCK_PREFIX + motebitId);
    return raw ? Number(raw) : 0;
  }
}
