import type { StorageAdapters } from "@motebit/runtime";
import { openMotebitDB } from "./idb.js";
import { IdbEventStore } from "./event-store.js";
import { IdbMemoryStorage } from "./memory-storage.js";
import { IdbIdentityStorage } from "./identity-storage.js";
import { IdbAuditLog } from "./audit-log.js";
import { LocalStorageStateSnapshot } from "./state-snapshot.js";
import { IdbConversationStore } from "./conversation-store.js";
import { IdbPlanStore } from "./plan-store.js";
import { IdbAgentTrustStore } from "./agent-trust-store.js";
import { IdbGradientStore } from "./gradient-store.js";

export { openMotebitDB, idbRequest, idbTransaction } from "./idb.js";
export { IdbEventStore } from "./event-store.js";
export { IdbMemoryStorage } from "./memory-storage.js";
export { IdbIdentityStorage } from "./identity-storage.js";
export { IdbAuditLog } from "./audit-log.js";
export { LocalStorageStateSnapshot } from "./state-snapshot.js";
export { IdbConversationStore } from "./conversation-store.js";
export { IdbPlanStore } from "./plan-store.js";
export { IdbAgentTrustStore } from "./agent-trust-store.js";
export { IdbGradientStore } from "./gradient-store.js";
export type { StateSnapshotAdapter } from "./state-snapshot.js";

export async function createBrowserStorage(): Promise<StorageAdapters> {
  const db = await openMotebitDB();
  return {
    eventStore: new IdbEventStore(db),
    memoryStorage: new IdbMemoryStorage(db),
    identityStorage: new IdbIdentityStorage(db),
    auditLog: new IdbAuditLog(db),
    stateSnapshot: new LocalStorageStateSnapshot(),
    conversationStore: new IdbConversationStore(db),
    planStore: new IdbPlanStore(db),
    agentTrustStore: new IdbAgentTrustStore(db),
    gradientStore: new IdbGradientStore(db),
  };
}
