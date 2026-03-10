import { describe, it, expect, beforeEach } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters, AgentTrustStoreAdapter } from "../index";
import { AgentTrustLevel } from "@motebit/sdk";
import type { AgentTrustRecord } from "@motebit/sdk";

// === In-Memory Agent Trust Store ===

class InMemoryAgentTrustStore implements AgentTrustStoreAdapter {
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

function createAdaptersWithTrust(): {
  adapters: PlatformAdapters;
  trustStore: InMemoryAgentTrustStore;
} {
  const trustStore = new InMemoryAgentTrustStore();
  const storage = createInMemoryStorage();
  return {
    adapters: {
      storage: { ...storage, agentTrustStore: trustStore },
      renderer: new NullRenderer(),
    },
    trustStore,
  };
}

describe("MotebitRuntime Agent Trust", () => {
  let runtime: MotebitRuntime;

  beforeEach(() => {
    const { adapters } = createAdaptersWithTrust();
    runtime = new MotebitRuntime({ motebitId: "test-mote", tickRateHz: 0 }, adapters);
  });

  it("records first interaction as FirstContact", async () => {
    const record = await runtime.recordAgentInteraction("remote-mote-1");
    expect(record).not.toBeNull();
    expect(record!.trust_level).toBe(AgentTrustLevel.FirstContact);
    expect(record!.interaction_count).toBe(1);
    expect(record!.motebit_id).toBe("test-mote");
    expect(record!.remote_motebit_id).toBe("remote-mote-1");
  });

  it("bumps interaction_count on repeat interaction", async () => {
    await runtime.recordAgentInteraction("remote-mote-1");
    const second = await runtime.recordAgentInteraction("remote-mote-1");
    expect(second!.interaction_count).toBe(2);
    expect(second!.trust_level).toBe(AgentTrustLevel.FirstContact);
  });

  it("preserves existing trust level on interaction bump", async () => {
    await runtime.recordAgentInteraction("remote-mote-1");
    await runtime.setAgentTrustLevel("remote-mote-1", AgentTrustLevel.Trusted);

    const bumped = await runtime.recordAgentInteraction("remote-mote-1");
    expect(bumped!.trust_level).toBe(AgentTrustLevel.Trusted);
    expect(bumped!.interaction_count).toBe(2);
  });

  it("stores public key on first interaction", async () => {
    const record = await runtime.recordAgentInteraction("remote-mote-1", "ed25519:pubkey123");
    expect(record!.public_key).toBe("ed25519:pubkey123");
  });

  it("getAgentTrust retrieves existing record", async () => {
    await runtime.recordAgentInteraction("remote-mote-1");
    const found = await runtime.getAgentTrust("remote-mote-1");
    expect(found).not.toBeNull();
    expect(found!.remote_motebit_id).toBe("remote-mote-1");
  });

  it("getAgentTrust returns null for unknown agent", async () => {
    const found = await runtime.getAgentTrust("nonexistent");
    expect(found).toBeNull();
  });

  it("listTrustedAgents returns all known agents", async () => {
    await runtime.recordAgentInteraction("remote-1");
    await runtime.recordAgentInteraction("remote-2");
    await runtime.recordAgentInteraction("remote-3");

    const list = await runtime.listTrustedAgents();
    expect(list).toHaveLength(3);
  });

  it("setAgentTrustLevel updates the level", async () => {
    await runtime.recordAgentInteraction("remote-mote-1");
    await runtime.setAgentTrustLevel("remote-mote-1", AgentTrustLevel.Verified);

    const found = await runtime.getAgentTrust("remote-mote-1");
    expect(found!.trust_level).toBe(AgentTrustLevel.Verified);
  });

  it("returns null when no trust store is configured", async () => {
    const noTrustRuntime = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );

    const result = await noTrustRuntime.recordAgentInteraction("remote-1");
    expect(result).toBeNull();

    const list = await noTrustRuntime.listTrustedAgents();
    expect(list).toHaveLength(0);
  });
});

describe("MotebitRuntime bumpTrustFromReceipt", () => {
  const fakeReceipt = (motebitId: string) => ({
    task_id: "task-1",
    motebit_id: motebitId,
    device_id: "dev-1",
    submitted_at: Date.now() - 1000,
    completed_at: Date.now(),
    status: "completed" as const,
    result: "ok",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "abc",
    result_hash: "def",
    signature: "sig123",
  });

  let runtime: MotebitRuntime;
  let trustStore: InMemoryAgentTrustStore;

  beforeEach(() => {
    const result = createAdaptersWithTrust();
    trustStore = result.trustStore;
    runtime = new MotebitRuntime({ motebitId: "test-mote", tickRateHz: 0 }, result.adapters);
  });

  it("creates FirstContact for unknown motebit on verified receipt", async () => {
    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-new"), true);
    const record = await trustStore.getAgentTrust("test-mote", "remote-new");
    expect(record).not.toBeNull();
    expect(record!.trust_level).toBe(AgentTrustLevel.FirstContact);
    expect(record!.interaction_count).toBe(1);
  });

  it("increments interaction_count on repeated verified receipts", async () => {
    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    const record = await trustStore.getAgentTrust("test-mote", "remote-1");
    expect(record!.interaction_count).toBe(3);
  });

  it("promotes FirstContact → Verified after 5 verified interactions", async () => {
    for (let i = 0; i < 5; i++) {
      await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    }
    const record = await trustStore.getAgentTrust("test-mote", "remote-1");
    expect(record!.trust_level).toBe(AgentTrustLevel.Verified);
    expect(record!.interaction_count).toBe(5);
  });

  it("does NOT promote Verified → Trusted", async () => {
    // Create at FirstContact, promote to Verified
    for (let i = 0; i < 5; i++) {
      await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    }
    // More interactions should not promote beyond Verified
    for (let i = 0; i < 10; i++) {
      await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    }
    const record = await trustStore.getAgentTrust("test-mote", "remote-1");
    expect(record!.trust_level).toBe(AgentTrustLevel.Verified);
  });

  it("ignores unverified receipts", async () => {
    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), false);
    const record = await trustStore.getAgentTrust("test-mote", "remote-1");
    expect(record).toBeNull();
  });

  it("does nothing without trust store", async () => {
    const noTrustRuntime = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );
    // Should not throw
    await noTrustRuntime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
  });
});
