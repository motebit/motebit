import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters, AgentTrustStoreAdapter } from "../index";
import { AgentTrustLevel } from "@motebit/sdk";
import type {
  AgentTrustRecord,
  GradientCredentialSubject,
  TrustCredentialSubject,
  ReputationCredentialSubject,
} from "@motebit/sdk";

// Mock embedText — avoid loading HF pipeline in tests
vi.mock("@motebit/memory-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/memory-graph")>();
  return {
    ...actual,
    embedText: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  };
});

// === Ed25519 key generation for tests ===

async function generateEd25519Keypair(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}> {
  const { generateKeypair } = await import("@motebit/crypto");
  return generateKeypair();
}

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

// === Helpers ===

function createAdaptersWithTrust(signingKeys?: { privateKey: Uint8Array; publicKey: Uint8Array }): {
  adapters: PlatformAdapters;
  trustStore: InMemoryAgentTrustStore;
  config: {
    motebitId: string;
    tickRateHz: number;
    signingKeys?: { privateKey: Uint8Array; publicKey: Uint8Array };
  };
} {
  const trustStore = new InMemoryAgentTrustStore();
  const storage = createInMemoryStorage();
  return {
    adapters: {
      storage: { ...storage, agentTrustStore: trustStore },
      renderer: new NullRenderer(),
    },
    trustStore,
    config: { motebitId: "test-mote", tickRateHz: 0, signingKeys },
  };
}

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

// === Tests ===

describe("Gradient credential issuance during housekeeping", () => {
  it("issues a gradient credential when signing keys are provided", async () => {
    const keys = await generateEd25519Keypair();
    const runtime = new MotebitRuntime(
      { motebitId: "cred-test", tickRateHz: 0, signingKeys: keys },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );

    await runtime.housekeeping();

    const creds = runtime.getIssuedCredentials();
    expect(creds.length).toBeGreaterThanOrEqual(1);

    const gradientCred = creds.find((c) => c.type.includes("AgentGradientCredential"));
    expect(gradientCred).toBeDefined();
    const gradientSubject = gradientCred!.credentialSubject as GradientCredentialSubject & {
      id: string;
    };
    expect(gradientSubject.gradient).toBeGreaterThanOrEqual(0);
    expect(gradientCred!.proof).toBeDefined();
    expect(gradientCred!.proof.type).toBe("DataIntegrityProof");
  });

  it("does not issue gradient credential without signing keys", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "cred-test", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );

    await runtime.housekeeping();

    const creds = runtime.getIssuedCredentials();
    expect(creds).toHaveLength(0);
  });

  it("gradient credential issuance failure does not break housekeeping", async () => {
    const keys = await generateEd25519Keypair();
    const runtime = new MotebitRuntime(
      { motebitId: "cred-test", tickRateHz: 0, signingKeys: keys },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );

    // Mock issueGradientCredential to throw
    vi.spyOn(runtime, "issueGradientCredential").mockRejectedValue(new Error("crypto failure"));

    // Should not throw — housekeeping is best-effort
    await expect(runtime.housekeeping()).resolves.toBeUndefined();
  });

  it("gradient credential is verifiable", async () => {
    const keys = await generateEd25519Keypair();
    const runtime = new MotebitRuntime(
      { motebitId: "cred-test", tickRateHz: 0, signingKeys: keys },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );

    await runtime.housekeeping();

    const creds = runtime.getIssuedCredentials();
    const gradientCred = creds.find((c) => c.type.includes("AgentGradientCredential"));
    expect(gradientCred).toBeDefined();

    const { verifyVerifiableCredential } = await import("@motebit/crypto");
    const valid = await verifyVerifiableCredential(gradientCred!);
    expect(valid).toBe(true);
  });
});

describe("Trust credential issuance on trust transitions", () => {
  it("issues a trust credential when trust level transitions", async () => {
    const keys = await generateEd25519Keypair();
    const { adapters, config } = createAdaptersWithTrust(keys);
    const runtime = new MotebitRuntime(config, adapters);

    // 5 verified receipts triggers FirstContact -> Verified transition
    for (let i = 0; i < 5; i++) {
      await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    }

    const creds = runtime.getIssuedCredentials();
    const trustCred = creds.find((c) => c.type.includes("AgentTrustCredential"));
    expect(trustCred).toBeDefined();
    const trustSubject = trustCred!.credentialSubject as TrustCredentialSubject & { id: string };
    expect(trustSubject.trust_level).toBe(AgentTrustLevel.Verified);
    expect(trustSubject.interaction_count).toBe(5);
    expect(trustCred!.proof).toBeDefined();
  });

  it("does not issue trust credential without signing keys", async () => {
    const { adapters, config } = createAdaptersWithTrust();
    const runtime = new MotebitRuntime(config, adapters);

    for (let i = 0; i < 5; i++) {
      await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    }

    const creds = runtime.getIssuedCredentials();
    const trustCred = creds.find((c) => c.type.includes("AgentTrustCredential"));
    expect(trustCred).toBeUndefined();
  });

  it("does not issue trust credential when no level transition occurs", async () => {
    const keys = await generateEd25519Keypair();
    const { adapters, config } = createAdaptersWithTrust(keys);
    const runtime = new MotebitRuntime(config, adapters);

    // Only 2 interactions — no transition from FirstContact
    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);

    const creds = runtime.getIssuedCredentials();
    const trustCred = creds.find((c) => c.type.includes("AgentTrustCredential"));
    expect(trustCred).toBeUndefined();
  });

  it("trust credential issuance failure does not break trust bumping", async () => {
    const { trustStore } = createAdaptersWithTrust();

    // Use invalid keys that will cause signing to fail.
    const badKeyRuntime = new MotebitRuntime(
      {
        motebitId: "test-mote",
        tickRateHz: 0,
        signingKeys: {
          privateKey: new Uint8Array(1), // Invalid — too short
          publicKey: new Uint8Array(1),
        },
      },
      {
        storage: { ...createInMemoryStorage(), agentTrustStore: trustStore },
        renderer: new NullRenderer(),
      },
    );

    // 5 receipts to trigger transition
    for (let i = 0; i < 5; i++) {
      await badKeyRuntime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    }

    // Trust record should still be saved despite credential issuance failure
    const record = await trustStore.getAgentTrust("test-mote", "remote-1");
    expect(record).not.toBeNull();
    expect(record!.trust_level).toBe(AgentTrustLevel.Verified);
    expect(record!.interaction_count).toBe(5);
  });

  it("trust credential is verifiable", async () => {
    const keys = await generateEd25519Keypair();
    const { adapters, config } = createAdaptersWithTrust(keys);
    const runtime = new MotebitRuntime(config, adapters);

    for (let i = 0; i < 5; i++) {
      await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    }

    const creds = runtime.getIssuedCredentials();
    const trustCred = creds.find((c) => c.type.includes("AgentTrustCredential"));
    expect(trustCred).toBeDefined();

    const { verifyVerifiableCredential } = await import("@motebit/crypto");
    const valid = await verifyVerifiableCredential(trustCred!);
    expect(valid).toBe(true);
  });
});

describe("Peer reputation credential issuance on verified receipts", () => {
  it("issues a reputation credential on verified completed receipt", async () => {
    const keys = await generateEd25519Keypair();
    const { adapters, config } = createAdaptersWithTrust(keys);
    const runtime = new MotebitRuntime(config, adapters);

    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);

    const creds = runtime.getIssuedCredentials();
    const repCred = creds.find((c) => c.type.includes("AgentReputationCredential"));
    expect(repCred).toBeDefined();
    const repSubject = repCred!.credentialSubject as ReputationCredentialSubject & { id: string };
    expect(repSubject.success_rate).toBe(1.0);
    expect(repSubject.task_count).toBe(1);
    expect(repCred!.proof).toBeDefined();
    expect(repCred!.proof.type).toBe("DataIntegrityProof");
  });

  it("does not issue reputation credential without signing keys", async () => {
    const { adapters, config } = createAdaptersWithTrust();
    const runtime = new MotebitRuntime(config, adapters);

    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);

    const creds = runtime.getIssuedCredentials();
    const repCred = creds.find((c) => c.type.includes("AgentReputationCredential"));
    expect(repCred).toBeUndefined();
  });

  it("does not issue reputation credential for failed receipt", async () => {
    const keys = await generateEd25519Keypair();
    const { adapters, config } = createAdaptersWithTrust(keys);
    const runtime = new MotebitRuntime(config, adapters);

    const failedReceipt = { ...fakeReceipt("remote-1"), status: "failed" as const };
    await runtime.bumpTrustFromReceipt(failedReceipt, true);

    const creds = runtime.getIssuedCredentials();
    const repCred = creds.find((c) => c.type.includes("AgentReputationCredential"));
    expect(repCred).toBeUndefined();
  });

  it("reputation credential is verifiable via @motebit/crypto", async () => {
    const keys = await generateEd25519Keypair();
    const { adapters, config } = createAdaptersWithTrust(keys);
    const runtime = new MotebitRuntime(config, adapters);

    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);

    const creds = runtime.getIssuedCredentials();
    const repCred = creds.find((c) => c.type.includes("AgentReputationCredential"));
    expect(repCred).toBeDefined();

    const { verifyVerifiableCredential } = await import("@motebit/crypto");
    const valid = await verifyVerifiableCredential(repCred!);
    expect(valid).toBe(true);
  });

  it("reputation credential failure does not break trust record saving", async () => {
    const { trustStore } = createAdaptersWithTrust();

    // Use invalid keys that will cause signing to fail.
    const badKeyRuntime = new MotebitRuntime(
      {
        motebitId: "test-mote",
        tickRateHz: 0,
        signingKeys: {
          privateKey: new Uint8Array(1), // Invalid — too short
          publicKey: new Uint8Array(1),
        },
      },
      {
        storage: { ...createInMemoryStorage(), agentTrustStore: trustStore },
        renderer: new NullRenderer(),
      },
    );

    await badKeyRuntime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);

    // Trust record should still be saved despite credential issuance failure
    const record = await trustStore.getAgentTrust("test-mote", "remote-1");
    expect(record).not.toBeNull();
    expect(record!.interaction_count).toBe(1);
    expect(record!.successful_tasks).toBe(1);
  });

  it("issues reputation credential on every completed receipt (not just transitions)", async () => {
    const keys = await generateEd25519Keypair();
    const { adapters, config } = createAdaptersWithTrust(keys);
    const runtime = new MotebitRuntime(config, adapters);

    // 3 receipts — all should produce reputation credentials
    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);

    const creds = runtime.getIssuedCredentials();
    const repCreds = creds.filter((c) => c.type.includes("AgentReputationCredential"));
    expect(repCreds).toHaveLength(3);
  });
});

describe("Sybil defense — self-delegation credential suppression", () => {
  it("does not issue reputation credential when delegator === worker", async () => {
    const keys = await generateEd25519Keypair();
    const { adapters, config } = createAdaptersWithTrust(keys);
    const runtime = new MotebitRuntime(config, adapters);

    // Self-delegation: motebitId delegates to itself
    const selfReceipt = fakeReceipt(config.motebitId);
    await runtime.bumpTrustFromReceipt(selfReceipt, true);

    const creds = runtime.getIssuedCredentials();
    const repCreds = creds.filter((c) => c.type.includes("AgentReputationCredential"));
    expect(repCreds).toHaveLength(0);
  });

  it("still issues reputation credential for genuine delegation", async () => {
    const keys = await generateEd25519Keypair();
    const { adapters, config } = createAdaptersWithTrust(keys);
    const runtime = new MotebitRuntime(config, adapters);

    // Real delegation: different agent
    await runtime.bumpTrustFromReceipt(fakeReceipt("remote-agent"), true);

    const creds = runtime.getIssuedCredentials();
    const repCreds = creds.filter((c) => c.type.includes("AgentReputationCredential"));
    expect(repCreds).toHaveLength(1);
  });

  it("still updates trust record for self-delegation (just no credential)", async () => {
    const keys = await generateEd25519Keypair();
    const { adapters, trustStore, config } = createAdaptersWithTrust(keys);
    const runtime = new MotebitRuntime(config, adapters);

    await runtime.bumpTrustFromReceipt(fakeReceipt(config.motebitId), true);

    // Trust record should still exist
    const record = await trustStore.getAgentTrust(config.motebitId, config.motebitId);
    expect(record).not.toBeNull();
    expect(record!.interaction_count).toBe(1);
    expect(record!.successful_tasks).toBe(1);
  });
});

describe("Credential cache management", () => {
  it("getIssuedCredentials returns a copy", async () => {
    const keys = await generateEd25519Keypair();
    const runtime = new MotebitRuntime(
      { motebitId: "cred-test", tickRateHz: 0, signingKeys: keys },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );

    await runtime.housekeeping();

    const creds1 = runtime.getIssuedCredentials();
    const creds2 = runtime.getIssuedCredentials();
    expect(creds1).not.toBe(creds2); // Different array instances
    expect(creds1).toEqual(creds2);
  });

  it("clearIssuedCredentials empties the cache", async () => {
    const keys = await generateEd25519Keypair();
    const runtime = new MotebitRuntime(
      { motebitId: "cred-test", tickRateHz: 0, signingKeys: keys },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );

    await runtime.housekeeping();
    expect(runtime.getIssuedCredentials().length).toBeGreaterThan(0);

    runtime.clearIssuedCredentials();
    expect(runtime.getIssuedCredentials()).toHaveLength(0);
  });

  it("credentials accumulate across multiple housekeeping runs", async () => {
    const keys = await generateEd25519Keypair();
    const runtime = new MotebitRuntime(
      { motebitId: "cred-test", tickRateHz: 0, signingKeys: keys },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );

    await runtime.housekeeping();
    await runtime.housekeeping();

    const creds = runtime.getIssuedCredentials();
    const gradientCreds = creds.filter((c) => c.type.includes("AgentGradientCredential"));
    expect(gradientCreds.length).toBe(2);
  });
});
