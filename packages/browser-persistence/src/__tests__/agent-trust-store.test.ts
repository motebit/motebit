import { describe, it, expect, beforeEach } from "vitest";
import { openMotebitDB } from "../idb.js";
import { IdbAgentTrustStore } from "../agent-trust-store.js";
import { AgentTrustLevel } from "@motebit/sdk";
import type { AgentTrustRecord, MotebitId } from "@motebit/sdk";

describe("IdbAgentTrustStore", () => {
  let store: IdbAgentTrustStore;
  const motebitId = "m-local" as MotebitId;

  function makeRecord(remoteMotebitId: string, overrides: Partial<AgentTrustRecord> = {}): AgentTrustRecord {
    return {
      motebit_id: motebitId,
      remote_motebit_id: remoteMotebitId as MotebitId,
      trust_level: AgentTrustLevel.FirstContact,
      first_seen_at: Date.now(),
      last_seen_at: Date.now(),
      interaction_count: 1,
      ...overrides,
    };
  }

  beforeEach(async () => {
    const db = await openMotebitDB(`test-agent-trust-${crypto.randomUUID()}`);
    store = new IdbAgentTrustStore(db);
  });

  it("sets and gets agent trust", async () => {
    const record = makeRecord("m-remote-1");
    await store.setAgentTrust(record);
    const loaded = await store.getAgentTrust(motebitId, "m-remote-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.remote_motebit_id).toBe("m-remote-1");
    expect(loaded!.trust_level).toBe(AgentTrustLevel.FirstContact);
  });

  it("returns null for missing trust record", async () => {
    const loaded = await store.getAgentTrust(motebitId, "nonexistent");
    expect(loaded).toBeNull();
  });

  it("lists trust records sorted by last_seen_at DESC", async () => {
    const r1 = makeRecord("m-remote-a", { last_seen_at: 1000 });
    const r2 = makeRecord("m-remote-b", { last_seen_at: 3000 });
    const r3 = makeRecord("m-remote-c", { last_seen_at: 2000 });
    await store.setAgentTrust(r1);
    await store.setAgentTrust(r2);
    await store.setAgentTrust(r3);

    const list = await store.listAgentTrust(motebitId);
    expect(list).toHaveLength(3);
    expect(list[0]!.remote_motebit_id).toBe("m-remote-b");
    expect(list[1]!.remote_motebit_id).toBe("m-remote-c");
    expect(list[2]!.remote_motebit_id).toBe("m-remote-a");
  });

  it("updates trust level", async () => {
    const record = makeRecord("m-remote-1");
    await store.setAgentTrust(record);
    await store.updateTrustLevel(motebitId, "m-remote-1", AgentTrustLevel.Verified);

    const loaded = await store.getAgentTrust(motebitId, "m-remote-1");
    expect(loaded!.trust_level).toBe(AgentTrustLevel.Verified);
  });

  it("updateTrustLevel is a no-op for missing record", async () => {
    // Should not throw
    await store.updateTrustLevel(motebitId, "nonexistent", AgentTrustLevel.Blocked);
  });

  it("overwrites existing record with setAgentTrust", async () => {
    const record = makeRecord("m-remote-1", { interaction_count: 1 });
    await store.setAgentTrust(record);
    record.interaction_count = 5;
    record.trust_level = AgentTrustLevel.Verified;
    await store.setAgentTrust(record);

    const loaded = await store.getAgentTrust(motebitId, "m-remote-1");
    expect(loaded!.interaction_count).toBe(5);
    expect(loaded!.trust_level).toBe(AgentTrustLevel.Verified);
  });

  it("isolates by motebit ID", async () => {
    const r1 = makeRecord("m-remote-1");
    await store.setAgentTrust(r1);

    const otherMotebit = "m-other" as MotebitId;
    const r2 = makeRecord("m-remote-1", { motebit_id: otherMotebit });
    await store.setAgentTrust(r2);

    const list = await store.listAgentTrust(motebitId);
    expect(list).toHaveLength(1);
    expect(list[0]!.motebit_id).toBe(motebitId);
  });
});
