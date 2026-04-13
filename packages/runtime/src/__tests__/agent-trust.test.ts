import { describe, it, expect, beforeEach } from "vitest";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  InMemoryAgentTrustStore,
} from "../index";
import type { PlatformAdapters } from "../index";
import { AgentTrustLevel } from "@motebit/sdk";

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

  it("uses default in-memory trust store when none explicitly provided", async () => {
    const defaultRuntime = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );

    const result = await defaultRuntime.recordAgentInteraction("remote-1");
    expect(result).not.toBeNull();
    expect(result!.trust_level).toBe(AgentTrustLevel.FirstContact);

    const list = await defaultRuntime.listTrustedAgents();
    expect(list).toHaveLength(1);
  });
});

describe("MotebitRuntime bumpTrustFromReceipt", () => {
  const fakeReceipt = (motebitId: string) => ({
    task_id: "task-1",
    motebit_id: motebitId,
    device_id: "dev-1",
    submitted_at: Date.now() - 2000,
    completed_at: Date.now(),
    status: "completed" as const,
    result:
      "The search returned relevant results about the requested topic with detailed information and supporting context for the user query.",
    tools_used: ["web_search", "read_url"],
    memories_formed: 0,
    prompt_hash: "abc",
    result_hash: "def",
    suite: "motebit-jcs-ed25519-b64-v1" as const,
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

  it("accumulates trust with default in-memory store", async () => {
    const defaultRuntime = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );
    await defaultRuntime.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    const record = await defaultRuntime.getAgentTrust("remote-1");
    expect(record).not.toBeNull();
    expect(record!.trust_level).toBe(AgentTrustLevel.FirstContact);
    expect(record!.interaction_count).toBe(1);
  });

  it("credential-blended trust affects graph edge weight", async () => {
    const keys = await (async () => {
      const { generateKeypair } = await import("@motebit/encryption");
      return generateKeypair();
    })();
    const { adapters } = createAdaptersWithTrust();
    const rt = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0, signingKeys: keys },
      adapters,
    );

    // Bump trust 3 times — builds trust record + issues 3 reputation credentials
    await rt.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    await rt.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);
    await rt.bumpTrustFromReceipt(fakeReceipt("remote-1"), true);

    // Credentials should have been issued
    const creds = rt.getIssuedCredentials();
    const repCreds = creds.filter((c) => c.type.includes("AgentReputationCredential"));
    expect(repCreds.length).toBe(3);

    // Get the graph — should incorporate credential evidence
    const mgr = rt.getAgentGraph();
    expect(mgr).not.toBeNull();
    const snapshot = await mgr.getGraphSnapshot();
    expect(snapshot.nodes.length).toBeGreaterThanOrEqual(2);
    const edge = snapshot.edges.find((e) => e.to === "remote-1");
    expect(edge).toBeDefined();
    // Trust should be at least the static FirstContact score (0.3)
    expect(edge!.weight.trust).toBeGreaterThanOrEqual(0.3);
  });
});

// ---------------------------------------------------------------------------
// Sovereign trust loop — proves trust closes end-to-end without the relay
// ---------------------------------------------------------------------------
//
// This is the load-bearing test for the sovereign-stack thesis. It exercises
// the full payment → receipt → verification → trust accumulation loop with
// zero relay involvement. If this test passes, the trust layer joins every
// other layer in offering a free, sovereign path.
//
// Flow:
//   1. Payee constructs a sovereign payment receipt for an onchain payment
//   2. Payee signs it with their own Ed25519 identity key
//   3. Payer verifies the signature (using only the embedded public key)
//   4. Payer feeds the verified receipt into bumpTrustFromReceipt
//   5. Payer's local trust store reflects the new trust signal
//
// At no point does any relay get contacted, queried, or trusted.

describe("MotebitRuntime sovereign trust loop (no relay)", () => {
  it("a payee can mint a trust signal for a payer via signed onchain payment receipt", async () => {
    const { generateKeypair, signSovereignPaymentReceipt, verifyExecutionReceipt } =
      await import("@motebit/encryption");

    // 1. Payer (the motebit running this runtime) and payee (a remote
    //    counterparty paid via wallet-solana). Each owns its own Ed25519
    //    identity key — no shared infrastructure.
    const payeeKp = await generateKeypair();
    const PAYER_ID = "test-mote";
    const PAYEE_ID = "remote-payee";

    const { adapters, trustStore } = createAdaptersWithTrust();
    const runtime = new MotebitRuntime({ motebitId: PAYER_ID, tickRateHz: 0 }, adapters);

    // 2. Payee constructs and signs a sovereign payment receipt for an
    //    (imagined) Solana USDC transfer. The tx_hash anchors the receipt
    //    to a globally unique onchain proof.
    const receipt = await signSovereignPaymentReceipt(
      {
        payee_motebit_id: PAYEE_ID,
        payee_device_id: "remote-device",
        payer_motebit_id: PAYER_ID,
        rail: "solana",
        tx_hash: "5JxYzExampleSolanaTxSignature",
        amount_micro: 5_000n,
        asset: "USDC",
        service_description:
          "Search query rendered with verifiable result and tool usage producing meaningful content for the user.",
        prompt_hash: "sha256:prompt",
        result_hash: "sha256:result",
        tools_used: ["web_search", "read_url"],
        submitted_at: Date.now() - 2_000,
        completed_at: Date.now(),
      },
      payeeKp.privateKey,
      payeeKp.publicKey,
    );

    // Sanity: receipt is sovereign (no relay binding)
    expect(receipt.relay_task_id).toBeUndefined();
    expect(receipt.task_id).toBe("solana:tx:5JxYzExampleSolanaTxSignature");

    // 3. Payer verifies the signature using ONLY the embedded public key.
    //    No relay, no registry, no third party.
    const valid = await verifyExecutionReceipt(receipt, payeeKp.publicKey);
    expect(valid).toBe(true);

    // 4. Payer feeds the verified receipt into the trust loop.
    await runtime.bumpTrustFromReceipt(receipt, true);

    // 5. Payer's local trust store reflects the new trust signal.
    const record = await trustStore.getAgentTrust(PAYER_ID, PAYEE_ID);
    expect(record).not.toBeNull();
    expect(record!.trust_level).toBe(AgentTrustLevel.FirstContact);
    expect(record!.interaction_count).toBe(1);
    expect(record!.successful_tasks).toBe(1);

    // The local agent graph also picks up the new edge — routing decisions
    // can now use this counterparty without ever consulting a relay.
    const graph = runtime.getAgentGraph();
    const snapshot = await graph!.getGraphSnapshot();
    const edge = snapshot.edges.find((e) => e.to === PAYEE_ID);
    expect(edge).toBeDefined();
  });

  it("an unverified sovereign receipt does not affect trust (fail-closed)", async () => {
    const { generateKeypair, signSovereignPaymentReceipt } = await import("@motebit/encryption");

    const payeeKp = await generateKeypair();
    const { adapters, trustStore } = createAdaptersWithTrust();
    const runtime = new MotebitRuntime({ motebitId: "test-mote", tickRateHz: 0 }, adapters);

    const receipt = await signSovereignPaymentReceipt(
      {
        payee_motebit_id: "remote",
        payee_device_id: "device",
        payer_motebit_id: "test-mote",
        rail: "solana",
        tx_hash: "tx",
        amount_micro: 1_000n,
        asset: "USDC",
        service_description: "service",
        prompt_hash: "p",
        result_hash: "r",
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
      },
      payeeKp.privateKey,
      payeeKp.publicKey,
    );

    // Caller passes verified=false — the receipt is well-formed but the
    // payer chose not to trust it. Trust must NOT be updated.
    await runtime.bumpTrustFromReceipt(receipt, false);
    const record = await trustStore.getAgentTrust("test-mote", "remote");
    expect(record).toBeNull();
  });
});
