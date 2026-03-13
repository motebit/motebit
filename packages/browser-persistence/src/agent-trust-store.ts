import type { AgentTrustStoreAdapter } from "@motebit/runtime";
import type { AgentTrustRecord, AgentTrustLevel } from "@motebit/sdk";
import { idbRequest } from "./idb.js";

/**
 * IDB-backed AgentTrustStore.
 *
 * All AgentTrustStoreAdapter methods are async, so direct IDB reads/writes
 * are fine — no cache needed.
 */
export class IdbAgentTrustStore implements AgentTrustStoreAdapter {
  constructor(private db: IDBDatabase) {}

  async getAgentTrust(
    motebitId: string,
    remoteMotebitId: string,
  ): Promise<AgentTrustRecord | null> {
    const tx = this.db.transaction("agent_trust", "readonly");
    const store = tx.objectStore("agent_trust");
    const result = await idbRequest(store.get([motebitId, remoteMotebitId]));
    return (result as AgentTrustRecord | undefined) ?? null;
  }

  async setAgentTrust(record: AgentTrustRecord): Promise<void> {
    const tx = this.db.transaction("agent_trust", "readwrite");
    tx.objectStore("agent_trust").put({ ...record });
  }

  async listAgentTrust(motebitId: string): Promise<AgentTrustRecord[]> {
    const tx = this.db.transaction("agent_trust", "readonly");
    const store = tx.objectStore("agent_trust");
    const index = store.index("motebit_id");
    const records = (await idbRequest(index.getAll(motebitId))) as AgentTrustRecord[];
    return records.sort((a, b) => b.last_seen_at - a.last_seen_at);
  }

  async updateTrustLevel(
    motebitId: string,
    remoteMotebitId: string,
    level: AgentTrustLevel,
  ): Promise<void> {
    const tx = this.db.transaction("agent_trust", "readwrite");
    const store = tx.objectStore("agent_trust");
    const existing = (await idbRequest(
      store.get([motebitId, remoteMotebitId]),
    )) as AgentTrustRecord | undefined;
    if (!existing) return;
    existing.trust_level = level;
    store.put(existing);
  }
}
