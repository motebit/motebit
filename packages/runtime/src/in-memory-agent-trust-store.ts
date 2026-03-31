/**
 * InMemoryAgentTrustStore — default in-memory implementation of AgentTrustStoreAdapter.
 *
 * Used as the default when no persistent store (SQLite) is provided.
 * Trust records accumulate in memory for the lifetime of the process.
 * For trust that survives restarts, pass a SqliteAgentTrustStore from @motebit/persistence.
 */

import { AgentTrustLevel } from "@motebit/sdk";
import type { AgentTrustRecord, AgentTrustStoreAdapter } from "@motebit/sdk";

export class InMemoryAgentTrustStore implements AgentTrustStoreAdapter {
  private records = new Map<string, AgentTrustRecord>();

  private key(motebitId: string, remoteMotebitId: string): string {
    return `${motebitId}::${remoteMotebitId}`;
  }

  async getAgentTrust(
    motebitId: string,
    remoteMotebitId: string,
  ): Promise<AgentTrustRecord | null> {
    return this.records.get(this.key(motebitId, remoteMotebitId)) ?? null;
  }

  async setAgentTrust(record: AgentTrustRecord): Promise<void> {
    this.records.set(this.key(record.motebit_id, record.remote_motebit_id), { ...record });
  }

  async listAgentTrust(motebitId: string): Promise<AgentTrustRecord[]> {
    const result: AgentTrustRecord[] = [];
    for (const r of this.records.values()) {
      if (r.motebit_id === motebitId) result.push({ ...r });
    }
    return result.sort((a, b) => b.last_seen_at - a.last_seen_at);
  }

  async updateTrustLevel(
    motebitId: string,
    remoteMotebitId: string,
    level: AgentTrustLevel,
  ): Promise<void> {
    const existing = this.records.get(this.key(motebitId, remoteMotebitId));
    if (existing) {
      existing.trust_level = level;
      existing.last_seen_at = Date.now();
    }
  }
}
