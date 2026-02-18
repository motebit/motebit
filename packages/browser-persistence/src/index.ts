import type { StorageAdapters } from "@motebit/runtime";
import { openMotebitDB } from "./idb.js";
import { IdbEventStore } from "./event-store.js";
import { IdbMemoryStorage } from "./memory-storage.js";
import { IdbIdentityStorage } from "./identity-storage.js";
import { IdbAuditLog } from "./audit-log.js";
import { LocalStorageStateSnapshot } from "./state-snapshot.js";

export { openMotebitDB, idbRequest, idbTransaction } from "./idb.js";
export { IdbEventStore } from "./event-store.js";
export { IdbMemoryStorage } from "./memory-storage.js";
export { IdbIdentityStorage } from "./identity-storage.js";
export { IdbAuditLog } from "./audit-log.js";
export { LocalStorageStateSnapshot } from "./state-snapshot.js";
export type { StateSnapshotAdapter } from "./state-snapshot.js";

export async function createBrowserStorage(): Promise<StorageAdapters> {
  const db = await openMotebitDB();
  return {
    eventStore: new IdbEventStore(db),
    memoryStorage: new IdbMemoryStorage(db),
    identityStorage: new IdbIdentityStorage(db),
    auditLog: new IdbAuditLog(db),
    stateSnapshot: new LocalStorageStateSnapshot(),
  };
}
