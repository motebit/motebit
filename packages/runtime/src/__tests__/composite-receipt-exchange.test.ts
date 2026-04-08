/**
 * Composite receipt exchange tests — dual-transport routing.
 *
 * Two categories:
 *
 * 1. **Routing semantics** — small unit tests against mock adapters
 *    that prove the fallback behavior is correct:
 *    - first-adapter success returns immediately
 *    - "unknown" error falls back to next adapter
 *    - payee-level errors (e.g., address_mismatch) DO NOT fall back
 *    - all adapters failing returns the last error
 *    - empty adapter list returns a clear error
 *    - handler registration propagates to all wrapped adapters
 *
 * 2. **End-to-end through composite** — the load-bearing integration
 *    test: two InMemoryReceiptExchangeHubs, a composite wrapping both,
 *    and a full sovereign trust loop that succeeds because one of the
 *    hubs reaches Bob even when the other doesn't.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeypair } from "@motebit/crypto";
import { AgentTrustLevel } from "@motebit/sdk";

import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  InMemoryAgentTrustStore,
  InMemoryReceiptExchangeHub,
  createCompositeReceiptExchange,
} from "../index.js";
import type {
  PlatformAdapters,
  SovereignReceiptExchangeAdapter,
  SovereignReceiptRequest,
  SovereignReceiptResponse,
} from "../index.js";

// ── Mock adapters ─────────────────────────────────────────────────────

function makeMockAdapter(
  response: SovereignReceiptResponse,
): SovereignReceiptExchangeAdapter & { calls: number } {
  const mock = {
    calls: 0,
    async request(
      _payeeMotebitId: string,
      _req: SovereignReceiptRequest,
    ): Promise<SovereignReceiptResponse> {
      mock.calls++;
      return response;
    },
    onIncomingRequest: vi.fn(),
  };
  return mock;
}

function makeFakeReceipt(): NonNullable<SovereignReceiptResponse["receipt"]> {
  return {
    task_id: "solana:tx:fake",
    motebit_id: "bob",
    device_id: "dev-1",
    submitted_at: 1_000,
    completed_at: 2_000,
    status: "completed",
    result: "ok",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    public_key: "00",
    signature: "sig",
  };
}

// ── Routing semantics tests ───────────────────────────────────────────

describe("CompositeReceiptExchange — routing semantics", () => {
  it("returns the first adapter's receipt when it succeeds", async () => {
    const receipt = makeFakeReceipt();
    const first = makeMockAdapter({ receipt });
    const second = makeMockAdapter({ receipt: makeFakeReceipt() });

    const composite = createCompositeReceiptExchange([first, second]);
    const response = await composite.request("bob", {} as SovereignReceiptRequest);

    expect(response.receipt).toBe(receipt);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0); // second never called
  });

  it("falls back to the next adapter on 'unknown' error", async () => {
    const first = makeMockAdapter({
      error: { code: "unknown", message: "network unreachable" },
    });
    const secondReceipt = makeFakeReceipt();
    const second = makeMockAdapter({ receipt: secondReceipt });

    const composite = createCompositeReceiptExchange([first, second]);
    const response = await composite.request("bob", {} as SovereignReceiptRequest);

    expect(response.receipt).toBe(secondReceipt);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  it("does NOT fall back on payee-level 'address_mismatch' error", async () => {
    const first = makeMockAdapter({
      error: { code: "address_mismatch", message: "wrong payee" },
    });
    const second = makeMockAdapter({ receipt: makeFakeReceipt() });

    const composite = createCompositeReceiptExchange([first, second]);
    const response = await composite.request("bob", {} as SovereignReceiptRequest);

    // First adapter's error is returned, second is never called
    expect(response.error?.code).toBe("address_mismatch");
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);
  });

  it("does NOT fall back on 'payment_not_verified'", async () => {
    const first = makeMockAdapter({
      error: { code: "payment_not_verified", message: "onchain check failed" },
    });
    const second = makeMockAdapter({ receipt: makeFakeReceipt() });

    const composite = createCompositeReceiptExchange([first, second]);
    const response = await composite.request("bob", {} as SovereignReceiptRequest);

    expect(response.error?.code).toBe("payment_not_verified");
    expect(second.calls).toBe(0);
  });

  it("does NOT fall back on 'duplicate_request'", async () => {
    const first = makeMockAdapter({
      error: { code: "duplicate_request", message: "already seen" },
    });
    const second = makeMockAdapter({ receipt: makeFakeReceipt() });

    const composite = createCompositeReceiptExchange([first, second]);
    const response = await composite.request("bob", {} as SovereignReceiptRequest);

    expect(response.error?.code).toBe("duplicate_request");
    expect(second.calls).toBe(0);
  });

  it("does NOT fall back on 'service_not_rendered'", async () => {
    const first = makeMockAdapter({
      error: { code: "service_not_rendered", message: "work not done" },
    });
    const second = makeMockAdapter({ receipt: makeFakeReceipt() });

    const composite = createCompositeReceiptExchange([first, second]);
    const response = await composite.request("bob", {} as SovereignReceiptRequest);

    expect(response.error?.code).toBe("service_not_rendered");
    expect(second.calls).toBe(0);
  });

  it("tries all adapters on 'unknown' errors and returns the last one's error", async () => {
    const first = makeMockAdapter({
      error: { code: "unknown", message: "first timeout" },
    });
    const second = makeMockAdapter({
      error: { code: "unknown", message: "second timeout" },
    });
    const third = makeMockAdapter({
      error: { code: "unknown", message: "third refused" },
    });

    const composite = createCompositeReceiptExchange([first, second, third]);
    const response = await composite.request("bob", {} as SovereignReceiptRequest);

    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
    expect(third.calls).toBe(1);
    expect(response.error?.code).toBe("unknown");
    expect(response.error?.message).toContain("third refused");
  });

  it("returns a clear error when the adapter list is empty", async () => {
    const composite = createCompositeReceiptExchange([]);
    const response = await composite.request("bob", {} as SovereignReceiptRequest);

    expect(response.error?.code).toBe("unknown");
    expect(response.error?.message).toContain("No transports configured");
  });

  it("treats a response with neither receipt nor error as a protocol violation and falls back", async () => {
    const broken = makeMockAdapter({} as SovereignReceiptResponse);
    const goodReceipt = makeFakeReceipt();
    const good = makeMockAdapter({ receipt: goodReceipt });

    const composite = createCompositeReceiptExchange([broken, good]);
    const response = await composite.request("bob", {} as SovereignReceiptRequest);

    expect(response.receipt).toBe(goodReceipt);
    expect(broken.calls).toBe(1);
    expect(good.calls).toBe(1);
  });

  it("registers the handler on every wrapped adapter", () => {
    const first = makeMockAdapter({ receipt: makeFakeReceipt() });
    const second = makeMockAdapter({ receipt: makeFakeReceipt() });
    const third = makeMockAdapter({ receipt: makeFakeReceipt() });

    const composite = createCompositeReceiptExchange([first, second, third]);

    const handler = async (): Promise<SovereignReceiptResponse> => ({
      receipt: makeFakeReceipt(),
    });
    composite.onIncomingRequest(handler);

    expect(first.onIncomingRequest).toHaveBeenCalledWith(handler);
    expect(second.onIncomingRequest).toHaveBeenCalledWith(handler);
    expect(third.onIncomingRequest).toHaveBeenCalledWith(handler);
  });

  it("exposes the wrapped adapters in order for diagnostics", () => {
    const first = makeMockAdapter({ receipt: makeFakeReceipt() });
    const second = makeMockAdapter({ receipt: makeFakeReceipt() });

    const composite = createCompositeReceiptExchange([first, second]);
    expect(composite.adapters.length).toBe(2);
    expect(composite.adapters[0]).toBe(first);
    expect(composite.adapters[1]).toBe(second);
  });
});

// ── End-to-end sovereign trust loop through composite ────────────────

describe("CompositeReceiptExchange — end-to-end trust loop", () => {
  let hubA: InMemoryReceiptExchangeHub;
  let hubB: InMemoryReceiptExchangeHub;

  beforeEach(() => {
    hubA = new InMemoryReceiptExchangeHub();
    hubB = new InMemoryReceiptExchangeHub();
  });

  afterEach(() => {
    hubA.disconnect("alice");
    hubA.disconnect("bob");
    hubB.disconnect("alice");
    hubB.disconnect("bob");
  });

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

  it("closes the full trust loop when the first transport fails and the second succeeds", async () => {
    const aliceKp = await generateKeypair();
    const bobKp = await generateKeypair();

    // Alice's composite wraps BOTH hubs. Hub A has no handler for Bob
    // (simulating a transport that can't reach the payee). Hub B has
    // Bob's handler, so the composite falls back to it and succeeds.
    const aliceComposite = createCompositeReceiptExchange([
      hubA.adapterFor("alice"),
      hubB.adapterFor("alice"),
    ]);

    // Bob only attaches via hub B — hub A won't have his handler.
    const bobSetup = createAdaptersWithTrust();
    const bob = new MotebitRuntime(
      {
        motebitId: "bob",
        tickRateHz: 0,
        signingKeys: { privateKey: bobKp.privateKey, publicKey: bobKp.publicKey },
        sovereignReceiptExchange: hubB.adapterFor("bob"),
      },
      bobSetup.adapters,
    );
    expect(bob.getSolanaAddress()).toBeNull();

    const aliceSetup = createAdaptersWithTrust();
    const alice = new MotebitRuntime(
      {
        motebitId: "alice",
        tickRateHz: 0,
        signingKeys: { privateKey: aliceKp.privateKey, publicKey: aliceKp.publicKey },
        sovereignReceiptExchange: aliceComposite,
      },
      aliceSetup.adapters,
    );

    expect(await aliceSetup.trustStore.getAgentTrust("alice", "bob")).toBeNull();

    // The composite should:
    //   1. Try hub A → error (no handler for bob) → code: "unknown"
    //   2. Fall back to hub B → Bob signs → receipt returned
    //   3. Alice verifies → trust store updated
    const now = Date.now();
    const receipt = await alice.requestSovereignReceipt("bob", {
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: "composite-e2e-tx",
      amount_micro: 5_000n,
      asset: "USDC",
      payee_address: "addr",
      service_description:
        "Composite adapter end-to-end sovereign trust loop fallback test payload.",
      prompt_hash: "sha256:prompt",
      result_hash: "sha256:result",
      tools_used: ["web_search"],
      submitted_at: now - 2_000,
      completed_at: now,
    });

    expect(receipt.motebit_id).toBe("bob");
    expect(receipt.signature).toBeTruthy();

    const trust = await aliceSetup.trustStore.getAgentTrust("alice", "bob");
    expect(trust).not.toBeNull();
    expect(trust!.trust_level).toBe(AgentTrustLevel.FirstContact);
    expect(trust!.interaction_count).toBe(1);
  });

  it("receives incoming requests from any wrapped adapter", async () => {
    // Bob's composite wraps BOTH hubs. Alice reaches Bob via hub A;
    // Charlie reaches Bob via hub B. Both requests should be routed
    // to Bob's runtime handler — the composite broadcasts the
    // handler registration to every wrapped adapter.
    const aliceKp = await generateKeypair();
    const bobKp = await generateKeypair();

    const bobComposite = createCompositeReceiptExchange([
      hubA.adapterFor("bob"),
      hubB.adapterFor("bob"),
    ]);

    const bobSetup = createAdaptersWithTrust();
    new MotebitRuntime(
      {
        motebitId: "bob",
        tickRateHz: 0,
        signingKeys: { privateKey: bobKp.privateKey, publicKey: bobKp.publicKey },
        sovereignReceiptExchange: bobComposite,
      },
      bobSetup.adapters,
    );

    // Alice pays via hub A.
    const aliceFromHubA = new MotebitRuntime(
      {
        motebitId: "alice",
        tickRateHz: 0,
        signingKeys: { privateKey: aliceKp.privateKey, publicKey: aliceKp.publicKey },
        sovereignReceiptExchange: hubA.adapterFor("alice"),
      },
      createAdaptersWithTrust().adapters,
    );

    const receiptViaA = await aliceFromHubA.requestSovereignReceipt("bob", {
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: "via-hub-a",
      amount_micro: 1_000n,
      asset: "USDC",
      payee_address: "addr",
      service_description: "request routed through hub A",
      prompt_hash: "p",
      result_hash: "r",
      tools_used: [],
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
    });

    expect(receiptViaA.motebit_id).toBe("bob");
    expect(receiptViaA.task_id).toBe("solana:tx:via-hub-a");

    // Charlie pays via hub B — same Bob handles it via the composite.
    const charlieKp = await generateKeypair();
    const charlieFromHubB = new MotebitRuntime(
      {
        motebitId: "charlie",
        tickRateHz: 0,
        signingKeys: { privateKey: charlieKp.privateKey, publicKey: charlieKp.publicKey },
        sovereignReceiptExchange: hubB.adapterFor("charlie"),
      },
      createAdaptersWithTrust().adapters,
    );

    const receiptViaB = await charlieFromHubB.requestSovereignReceipt("bob", {
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: "via-hub-b",
      amount_micro: 1_000n,
      asset: "USDC",
      payee_address: "addr",
      service_description: "request routed through hub B",
      prompt_hash: "p",
      result_hash: "r",
      tools_used: [],
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
    });

    expect(receiptViaB.motebit_id).toBe("bob");
    expect(receiptViaB.task_id).toBe("solana:tx:via-hub-b");

    // Both requests routed to the same Bob runtime, proving the
    // composite's onIncomingRequest broadcast is working.

    hubB.disconnect("charlie");
  });
});
