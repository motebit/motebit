import { describe, it, expect, beforeEach } from "vitest";
import { createMotebitDatabase, type MotebitDatabase } from "../index.js";
import { AgentTrustLevel, type AgentTrustRecord } from "@motebit/sdk";

describe("SqliteAgentTrustStore", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
  });

  function makeRecord(overrides: Partial<AgentTrustRecord> = {}): AgentTrustRecord {
    return {
      motebit_id: "mote-local",
      remote_motebit_id: "mote-remote-1",
      trust_level: AgentTrustLevel.FirstContact,
      first_seen_at: 1000,
      last_seen_at: 1000,
      interaction_count: 1,
      ...overrides,
    };
  }

  it("sets and gets a trust record", async () => {
    const record = makeRecord();
    await moteDb.agentTrustStore.setAgentTrust(record);

    const found = await moteDb.agentTrustStore.getAgentTrust("mote-local", "mote-remote-1");
    expect(found).not.toBeNull();
    expect(found!.trust_level).toBe(AgentTrustLevel.FirstContact);
    expect(found!.interaction_count).toBe(1);
    expect(found!.first_seen_at).toBe(1000);
  });

  it("returns null for unknown pair", async () => {
    const found = await moteDb.agentTrustStore.getAgentTrust("mote-local", "nonexistent");
    expect(found).toBeNull();
  });

  it("upserts on setAgentTrust (updates existing record)", async () => {
    await moteDb.agentTrustStore.setAgentTrust(makeRecord());
    await moteDb.agentTrustStore.setAgentTrust(
      makeRecord({
        interaction_count: 5,
        last_seen_at: 2000,
        trust_level: AgentTrustLevel.Verified,
      }),
    );

    const found = await moteDb.agentTrustStore.getAgentTrust("mote-local", "mote-remote-1");
    expect(found!.interaction_count).toBe(5);
    expect(found!.last_seen_at).toBe(2000);
    expect(found!.trust_level).toBe(AgentTrustLevel.Verified);
  });

  it("lists all trust records for a motebit", async () => {
    await moteDb.agentTrustStore.setAgentTrust(
      makeRecord({ remote_motebit_id: "r1", last_seen_at: 100 }),
    );
    await moteDb.agentTrustStore.setAgentTrust(
      makeRecord({ remote_motebit_id: "r2", last_seen_at: 200 }),
    );
    await moteDb.agentTrustStore.setAgentTrust(
      makeRecord({ remote_motebit_id: "r3", last_seen_at: 150 }),
    );

    const list = await moteDb.agentTrustStore.listAgentTrust("mote-local");
    expect(list).toHaveLength(3);
    // Should be ordered by last_seen_at DESC
    expect(list[0]!.remote_motebit_id).toBe("r2");
    expect(list[1]!.remote_motebit_id).toBe("r3");
    expect(list[2]!.remote_motebit_id).toBe("r1");
  });

  it("returns empty list for unknown motebit_id", async () => {
    await moteDb.agentTrustStore.setAgentTrust(makeRecord());
    const list = await moteDb.agentTrustStore.listAgentTrust("unknown");
    expect(list).toHaveLength(0);
  });

  it("updates trust level", async () => {
    await moteDb.agentTrustStore.setAgentTrust(makeRecord());
    await moteDb.agentTrustStore.updateTrustLevel(
      "mote-local",
      "mote-remote-1",
      AgentTrustLevel.Trusted,
    );

    const found = await moteDb.agentTrustStore.getAgentTrust("mote-local", "mote-remote-1");
    expect(found!.trust_level).toBe(AgentTrustLevel.Trusted);
    // last_seen_at should be updated
    expect(found!.last_seen_at).toBeGreaterThan(1000);
  });

  it("stores and retrieves public_key and notes", async () => {
    await moteDb.agentTrustStore.setAgentTrust(
      makeRecord({
        public_key: "ed25519:abc123",
        notes: "First met during task delegation",
      }),
    );

    const found = await moteDb.agentTrustStore.getAgentTrust("mote-local", "mote-remote-1");
    expect(found!.public_key).toBe("ed25519:abc123");
    expect(found!.notes).toBe("First met during task delegation");
  });

  it("handles undefined optional fields correctly", async () => {
    await moteDb.agentTrustStore.setAgentTrust(makeRecord());
    const found = await moteDb.agentTrustStore.getAgentTrust("mote-local", "mote-remote-1");
    expect(found!.public_key).toBeUndefined();
    expect(found!.notes).toBeUndefined();
  });

  it("can block an agent", async () => {
    await moteDb.agentTrustStore.setAgentTrust(
      makeRecord({
        trust_level: AgentTrustLevel.Trusted,
      }),
    );
    await moteDb.agentTrustStore.updateTrustLevel(
      "mote-local",
      "mote-remote-1",
      AgentTrustLevel.Blocked,
    );

    const found = await moteDb.agentTrustStore.getAgentTrust("mote-local", "mote-remote-1");
    expect(found!.trust_level).toBe(AgentTrustLevel.Blocked);
  });
});
