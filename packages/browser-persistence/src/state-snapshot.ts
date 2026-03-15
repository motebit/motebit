/**
 * localStorage-backed StateSnapshotAdapter.
 *
 * The StateSnapshotAdapter interface is synchronous — IndexedDB can't back it.
 * Uses localStorage instead.
 */

import type { StateSnapshotAdapter } from "@motebit/sdk";
export type { StateSnapshotAdapter } from "@motebit/sdk";

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
    return raw != null && raw !== "" ? Number(raw) : 0;
  }
}
