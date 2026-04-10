/**
 * End-to-end sovereign trust loop — the load-bearing test for the
 * sovereignty thesis.
 *
 * Two MotebitRuntime instances share an InMemoryReceiptExchangeHub.
 * Alice pays Bob (off-stage — simulated by picking a tx_hash), Alice
 * requests a sovereign receipt from Bob via the hub, Bob signs and
 * returns it, Alice verifies the signature using only the embedded
 * public key, Alice's local trust store reflects the interaction.
 *
 * At no point does any relay exist. The only shared infrastructure
 * between the two runtimes is the in-memory hub — which is literally
 * two function pointers, no network, no authority, no third party.
 *
 * If this test passes, the sovereign trust loop closes end-to-end in
 * production code for the first time. Every primitive involved
 * (identity, wallet derivation, payment, receipt signing, signature
 * verification, trust accumulation, local routing graph update) has
 * been shipped; this test proves they compose into a working whole.
 *
 * Spec references:
 *   - settlement-v1.md §3 (foundation law)
 *   - settlement-v1.md §7 (sovereign payment receipt format)
 *   - sovereign-receipt-exchange.ts (the protocol definition)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeypair } from "@motebit/encryption";
import { AgentTrustLevel } from "@motebit/sdk";

import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  InMemoryAgentTrustStore,
  InMemoryReceiptExchangeHub,
} from "../index.js";
import type { PlatformAdapters } from "../index.js";

// ── Fixtures ──────────────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────

describe("Sovereign trust loop — end to end, no relay", () => {
  let hub: InMemoryReceiptExchangeHub;

  beforeEach(() => {
    hub = new InMemoryReceiptExchangeHub();
  });

  afterEach(() => {
    hub.disconnect("alice");
    hub.disconnect("bob");
  });

  it("closes the full loop: pay → request → sign → verify → trust update", async () => {
    // 1. Two motebits, each with its own identity keypair.
    const aliceKp = await generateKeypair();
    const bobKp = await generateKeypair();

    // 2. Alice (the payer) runtime. Has signing keys and the hub
    //    adapter so it can request receipts.
    const aliceSetup = createAdaptersWithTrust();
    const alice = new MotebitRuntime(
      {
        motebitId: "alice",
        tickRateHz: 0,
        signingKeys: { privateKey: aliceKp.privateKey, publicKey: aliceKp.publicKey },
        sovereignReceiptExchange: hub.adapterFor("alice"),
      },
      aliceSetup.adapters,
    );

    // 3. Bob (the payee) runtime. Has signing keys and the hub adapter
    //    so it can sign incoming receipt requests. The runtime registers
    //    its handler at construction time — Bob is immediately ready.
    const bobSetup = createAdaptersWithTrust();
    const bob = new MotebitRuntime(
      {
        motebitId: "bob",
        tickRateHz: 0,
        signingKeys: { privateKey: bobKp.privateKey, publicKey: bobKp.publicKey },
        sovereignReceiptExchange: hub.adapterFor("bob"),
      },
      bobSetup.adapters,
    );
    // Unused reference but needed so bob's handler stays registered
    // through the test. TypeScript would otherwise mark it unused.
    expect(bob.getSolanaAddress()).toBeNull(); // no solana config

    // 4. Alice has never interacted with Bob before. Trust store is empty.
    expect(await aliceSetup.trustStore.getAgentTrust("alice", "bob")).toBeNull();

    // 5. Alice "pays" Bob — in a real flow this would be a wallet-solana
    //    send call producing an onchain tx hash. For the test, we use a
    //    fixed hash that stands in for the real onchain proof.
    const mockTxHash = "5JxYzPaymentFromAliceToBob";

    // 6. Alice requests the receipt from Bob via the hub transport.
    //    The runtime (a) sends the request, (b) receives Bob's signed
    //    response, (c) verifies the signature using Bob's embedded
    //    public key, (d) feeds the verified receipt into the trust loop.
    const now = Date.now();
    const verifiedReceipt = await alice.requestSovereignReceipt("bob", {
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: mockTxHash,
      amount_micro: 5_000n,
      asset: "USDC",
      payee_address: "BobSolanaAddressNotYetSet",
      service_description:
        "Search query rendered with verifiable result and tool usage producing meaningful content for the user.",
      prompt_hash: "sha256:prompt-alice-to-bob",
      result_hash: "sha256:result-bob-to-alice",
      tools_used: ["web_search", "read_url"],
      submitted_at: now - 2_000,
      completed_at: now,
    });

    // 7. The receipt is real, structurally valid, bound to the payment.
    expect(verifiedReceipt.motebit_id).toBe("bob");
    expect(verifiedReceipt.task_id).toBe("solana:tx:5JxYzPaymentFromAliceToBob");
    expect(verifiedReceipt.relay_task_id).toBeUndefined();
    expect(verifiedReceipt.public_key).toBeTruthy();
    expect(verifiedReceipt.signature).toBeTruthy();

    // 8. Alice's local trust store now has a record for Bob. FirstContact
    //    is the trust level at first interaction — this is the moment
    //    the sovereign loop closes and Alice learns to trust Bob locally.
    const trustRecord = await aliceSetup.trustStore.getAgentTrust("alice", "bob");
    expect(trustRecord).not.toBeNull();
    expect(trustRecord!.trust_level).toBe(AgentTrustLevel.FirstContact);
    expect(trustRecord!.interaction_count).toBe(1);
    expect(trustRecord!.successful_tasks).toBe(1);
    expect(trustRecord!.remote_motebit_id).toBe("bob");

    // 9. Alice's local routing graph has a new edge to Bob, so
    //    future delegation decisions can consider Bob without any
    //    relay or registry lookup.
    const graph = alice.getAgentGraph();
    const snapshot = await graph.getGraphSnapshot();
    const edge = snapshot.edges.find((e) => e.to === "bob");
    expect(edge).toBeDefined();
  });

  it("rejects a request when the payee does not have signing keys", async () => {
    const aliceKp = await generateKeypair();

    // Alice is the payer — has keys.
    const alice = new MotebitRuntime(
      {
        motebitId: "alice",
        tickRateHz: 0,
        signingKeys: { privateKey: aliceKp.privateKey, publicKey: aliceKp.publicKey },
        sovereignReceiptExchange: hub.adapterFor("alice"),
      },
      createAdaptersWithTrust().adapters,
    );

    // Bob has NO signing keys. He can still register as a handler (via
    // the hub adapter) but cannot actually sign anything. The runtime
    // returns an error response instead of a receipt.
    const bobUnsigned = new MotebitRuntime(
      {
        motebitId: "bob",
        tickRateHz: 0,
        sovereignReceiptExchange: hub.adapterFor("bob"),
      },
      createAdaptersWithTrust().adapters,
    );
    expect(bobUnsigned.getSolanaAddress()).toBeNull();

    await expect(
      alice.requestSovereignReceipt("bob", {
        payee_motebit_id: "bob",
        rail: "solana",
        tx_hash: "tx",
        amount_micro: 1_000n,
        asset: "USDC",
        payee_address: "addr",
        service_description: "service",
        prompt_hash: "p",
        result_hash: "r",
        tools_used: [],
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
      }),
    ).rejects.toThrow(/No signing keys/);
  });

  it("rejects a request addressed to a different motebit (confused deputy defense)", async () => {
    const aliceKp = await generateKeypair();
    const bobKp = await generateKeypair();

    const alice = new MotebitRuntime(
      {
        motebitId: "alice",
        tickRateHz: 0,
        signingKeys: { privateKey: aliceKp.privateKey, publicKey: aliceKp.publicKey },
        sovereignReceiptExchange: hub.adapterFor("alice"),
      },
      createAdaptersWithTrust().adapters,
    );
    const bob = new MotebitRuntime(
      {
        motebitId: "bob",
        tickRateHz: 0,
        signingKeys: { privateKey: bobKp.privateKey, publicKey: bobKp.publicKey },
        sovereignReceiptExchange: hub.adapterFor("bob"),
      },
      createAdaptersWithTrust().adapters,
    );
    expect(bob.getSolanaAddress()).toBeNull();

    // Alice addresses the request to "bob" (the hub routes on this)
    // but puts payee_motebit_id: "eve" in the payload. Bob's handler
    // must reject because the payload is not addressed to him.
    await expect(
      alice.requestSovereignReceipt("bob", {
        payee_motebit_id: "eve", // <-- mismatch
        rail: "solana",
        tx_hash: "tx",
        amount_micro: 1_000n,
        asset: "USDC",
        payee_address: "addr",
        service_description: "service",
        prompt_hash: "p",
        result_hash: "r",
        tools_used: [],
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
      }),
    ).rejects.toThrow(/address_mismatch/);
  });

  it("throws when no receipt exchange transport is configured", async () => {
    const aliceKp = await generateKeypair();
    const alice = new MotebitRuntime(
      {
        motebitId: "alice",
        tickRateHz: 0,
        signingKeys: { privateKey: aliceKp.privateKey, publicKey: aliceKp.publicKey },
        // NO sovereignReceiptExchange configured
      },
      createAdaptersWithTrust().adapters,
    );

    await expect(
      alice.requestSovereignReceipt("bob", {
        payee_motebit_id: "bob",
        rail: "solana",
        tx_hash: "tx",
        amount_micro: 1_000n,
        asset: "USDC",
        payee_address: "addr",
        service_description: "service",
        prompt_hash: "p",
        result_hash: "r",
        tools_used: [],
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
      }),
    ).rejects.toThrow(/transport not configured/);
  });
});

describe("InMemoryReceiptExchangeHub", () => {
  it("routes requests to the correct motebit handler", async () => {
    const hub = new InMemoryReceiptExchangeHub();
    const aliceAdapter = hub.adapterFor("alice");
    const bobAdapter = hub.adapterFor("bob");

    bobAdapter.onIncomingRequest(async (req) => ({
      error: { code: "unknown", message: `bob saw ${req.tx_hash}` },
    }));

    const response = await aliceAdapter.request("bob", {
      payer_motebit_id: "alice",
      payer_device_id: "dev-1",
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: "test-tx",
      amount_micro: 1n,
      asset: "USDC",
      payee_address: "addr",
      service_description: "s",
      prompt_hash: "p",
      result_hash: "r",
      tools_used: [],
      submitted_at: 0,
      completed_at: 0,
    });

    expect(response.error?.message).toContain("bob saw test-tx");
  });

  it("returns an error response when no handler is registered for the target", async () => {
    const hub = new InMemoryReceiptExchangeHub();
    const aliceAdapter = hub.adapterFor("alice");

    const response = await aliceAdapter.request("nobody", {
      payer_motebit_id: "alice",
      payer_device_id: "dev-1",
      payee_motebit_id: "nobody",
      rail: "solana",
      tx_hash: "tx",
      amount_micro: 1n,
      asset: "USDC",
      payee_address: "addr",
      service_description: "s",
      prompt_hash: "p",
      result_hash: "r",
      tools_used: [],
      submitted_at: 0,
      completed_at: 0,
    });

    expect(response.error?.code).toBe("unknown");
    expect(response.error?.message).toContain("No handler registered");
  });

  it("catches handler exceptions and returns an error response", async () => {
    const hub = new InMemoryReceiptExchangeHub();
    const aliceAdapter = hub.adapterFor("alice");
    const bobAdapter = hub.adapterFor("bob");

    bobAdapter.onIncomingRequest(async () => {
      throw new Error("bob's handler exploded");
    });

    const response = await aliceAdapter.request("bob", {
      payer_motebit_id: "alice",
      payer_device_id: "dev-1",
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: "tx",
      amount_micro: 1n,
      asset: "USDC",
      payee_address: "addr",
      service_description: "s",
      prompt_hash: "p",
      result_hash: "r",
      tools_used: [],
      submitted_at: 0,
      completed_at: 0,
    });

    expect(response.error?.code).toBe("unknown");
    expect(response.error?.message).toContain("bob's handler exploded");
  });
});
