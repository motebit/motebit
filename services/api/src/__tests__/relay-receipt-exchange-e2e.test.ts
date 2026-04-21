/**
 * Relay-mediated sovereign receipt exchange — full end-to-end.
 *
 * The integration test for the paved convenience tier. Spins up a
 * REAL relay (in-memory SQLite) with the receipt exchange endpoint
 * registered, constructs TWO real MotebitRuntime instances with
 * `createRelayReceiptExchange` adapters pointing at the same relay,
 * and exercises the full sovereign trust loop across the relay's
 * dumb-pipe routing.
 *
 * Alice (payer) POSTs a request. The relay routes it to Bob's pending
 * queue. Bob's background poll loop picks it up, Bob's runtime signs
 * a SovereignPaymentReceipt, Bob POSTs the response. The relay
 * resolves Alice's pending promise, Alice verifies the signature
 * using only Bob's embedded public key, Alice's trust store reflects
 * FirstContact for Bob.
 *
 * The relay is a **dumb pipe** throughout — it never inspects receipt
 * contents, never verifies signatures, never authorizes anything. It
 * routes messages by motebit ID, nothing more. Same doctrinal role as
 * multi-device sync: legitimate meeting point, not authority.
 *
 * This test uses Hono's in-process `app.request(...)` API via an
 * injected `fetch` function, so no real HTTP listener is started.
 * That makes the test fast and deterministic while exercising the
 * exact same code paths the production adapter uses against a real
 * deployed relay.
 *
 * Spec references:
 *   - settlement-v1.md §3 (foundation law — sovereignty, self-
 *     verifiable receipts, relay-optional, plural rails)
 *   - sovereign-receipt-exchange.ts (the protocol definition)
 *   - receipt-exchange.ts (this relay-side implementation)
 *   - relay-receipt-exchange.ts (this runtime-side adapter)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeypair } from "@motebit/encryption";
import { deriveSolanaAddress } from "@motebit/wallet-solana";
import { AgentTrustLevel } from "@motebit/sdk";
import type { SyncRelay } from "../index.js";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  InMemoryAgentTrustStore,
  createRelayReceiptExchange,
} from "@motebit/runtime";
import type { PlatformAdapters, RelayReceiptExchange } from "@motebit/runtime";
import { API_TOKEN, createTestRelay } from "./test-helpers.js";

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

/**
 * Build a fetch function that routes through Hono's in-process
 * `app.request(...)` API. This skips the OS network stack entirely
 * while exercising the exact same HTTP handlers the production relay
 * runs. Integration tests get production-shape code coverage with
 * test-harness speed.
 *
 * Critically, this wrapper honors the AbortSignal via Promise.race.
 * Hono's app.request does not natively respond to AbortController;
 * without this race, the adapter's close() would be unable to
 * cancel an in-flight long-poll and afterEach hooks would time out.
 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  // Request object
  return input.url;
}

function makeFetchForRelay(relay: SyncRelay): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    // Strip the origin so Hono sees only the path. The adapter uses
    // a placeholder relay URL; we rewrite to the path here.
    const parsedUrl = new URL(url, "http://relay.localhost");
    const pathWithQuery = `${parsedUrl.pathname}${parsedUrl.search}`;

    // Normalize `app.request()`'s return type — Hono types it as
    // `Response | Promise<Response>`; await lifts it uniformly.
    const requestPromise = Promise.resolve(relay.app.request(pathWithQuery, init ?? {}));

    const signal = init?.signal;
    if (!signal) return requestPromise;
    if (signal.aborted) throw new Error("The operation was aborted");

    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => {
        reject(new Error("The operation was aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      requestPromise.then(
        (response: Response) => {
          signal.removeEventListener("abort", onAbort);
          resolve(response);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Relay-mediated sovereign receipt exchange — full e2e", () => {
  let relay: SyncRelay;
  let aliceTransport: RelayReceiptExchange | null = null;
  let bobTransport: RelayReceiptExchange | null = null;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await aliceTransport?.close();
    await bobTransport?.close();
    aliceTransport = null;
    bobTransport = null;
    await relay.close();
  });

  it("closes the full sovereign trust loop via a real relay dumb pipe", async () => {
    // 1. Two motebits with their own Ed25519 identity keys.
    const aliceKp = await generateKeypair();
    const bobKp = await generateKeypair();

    const fetchFn = makeFetchForRelay(relay);
    const RELAY_URL = "http://relay.localhost";

    // 2. Bob's transport — registers as a payee, starts long-polling.
    bobTransport = createRelayReceiptExchange({
      relayUrl: RELAY_URL,
      ownMotebitId: "bob",
      authToken: API_TOKEN,
      fetch: fetchFn,
      // Shorter timeouts so the test finishes quickly. In production
      // these match the relay's defaults (25s poll, 30s exchange).
      pollTimeoutMs: 2_000,
      requestTimeoutMs: 5_000,
      pollRetryDelayMs: 100,
    });

    // 3. Alice's transport — payer-only, no background polling needed.
    //    (Alice could also be a payee if she registered a handler;
    //    for this test she only pays.)
    aliceTransport = createRelayReceiptExchange({
      relayUrl: RELAY_URL,
      ownMotebitId: "alice",
      authToken: API_TOKEN,
      fetch: fetchFn,
      pollTimeoutMs: 2_000,
      requestTimeoutMs: 5_000,
      pollRetryDelayMs: 100,
    });

    // 4. Bob's runtime — signing keys configured, receipt handler
    //    registered at construction time. This also starts Bob's
    //    background poll loop on the transport.
    const bobSetup = createAdaptersWithTrust();
    const bob = new MotebitRuntime(
      {
        motebitId: "bob",
        tickRateHz: 0,
        signingKeys: { privateKey: bobKp.privateKey, publicKey: bobKp.publicKey },
        sovereignReceiptExchange: bobTransport,
      },
      bobSetup.adapters,
    );
    // No Solana RPC rail — balance returns null. Address resolves from
    // signing keys (rail-independent); not what this test is probing.
    expect(await bob.getSolanaBalance()).toBeNull();
    expect(bobTransport.polling).toBe(true); // long-poll loop is live

    // 5. Alice's runtime.
    const aliceSetup = createAdaptersWithTrust();
    const alice = new MotebitRuntime(
      {
        motebitId: "alice",
        tickRateHz: 0,
        signingKeys: { privateKey: aliceKp.privateKey, publicKey: aliceKp.publicKey },
        sovereignReceiptExchange: aliceTransport,
      },
      aliceSetup.adapters,
    );

    // 6. Alice has no prior trust record for Bob.
    expect(await aliceSetup.trustStore.getAgentTrust("alice", "bob")).toBeNull();

    // 7. Alice requests a sovereign receipt from Bob.
    //    Flow: Alice's runtime -> Alice's transport -> POST /exchange ->
    //    relay routes to Bob's pending queue -> Bob's long-poll picks
    //    it up -> Bob's runtime handler signs -> POST /respond ->
    //    relay resolves Alice's promise -> HTTP response -> Alice's
    //    runtime verifies signature -> bumpTrustFromReceipt -> done.
    const now = Date.now();
    const receipt = await alice.requestSovereignReceipt("bob", {
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: "RelayMediatedSovereignTxHash",
      amount_micro: 5_000n,
      asset: "USDC",
      payee_address: deriveSolanaAddress(bobKp.publicKey),
      service_description:
        "Relay-mediated sovereign trust loop full e2e test payload with enough detail to satisfy quality gates.",
      prompt_hash: "sha256:prompt-relay-e2e",
      result_hash: "sha256:result-relay-e2e",
      tools_used: ["web_search", "read_url"],
      submitted_at: now - 2_000,
      completed_at: now,
    });

    // 8. The signed receipt is real, from Bob, bound to the payment.
    expect(receipt.motebit_id).toBe("bob");
    expect(receipt.task_id).toBe("solana:tx:RelayMediatedSovereignTxHash");
    expect(receipt.relay_task_id).toBeUndefined();
    expect(receipt.signature).toBeTruthy();
    expect(receipt.public_key).toBeTruthy();

    // 9. Alice's trust store reflects Bob at FirstContact. The only
    //    shared infrastructure was the relay as dumb pipe — it routed
    //    messages but never inspected them.
    const trust = await aliceSetup.trustStore.getAgentTrust("alice", "bob");
    expect(trust).not.toBeNull();
    expect(trust!.trust_level).toBe(AgentTrustLevel.FirstContact);
    expect(trust!.interaction_count).toBe(1);
    expect(trust!.successful_tasks).toBe(1);
  });

  it("returns a timeout error when no payee is registered for the target", async () => {
    const aliceKp = await generateKeypair();
    const fetchFn = makeFetchForRelay(relay);

    aliceTransport = createRelayReceiptExchange({
      relayUrl: "http://relay.localhost",
      ownMotebitId: "alice",
      authToken: API_TOKEN,
      fetch: fetchFn,
      pollTimeoutMs: 500,
      requestTimeoutMs: 800, // short so the test fails fast
      pollRetryDelayMs: 100,
    });

    const alice = new MotebitRuntime(
      {
        motebitId: "alice",
        tickRateHz: 0,
        signingKeys: { privateKey: aliceKp.privateKey, publicKey: aliceKp.publicKey },
        sovereignReceiptExchange: aliceTransport,
      },
      createAdaptersWithTrust().adapters,
    );

    // No bob transport = no one polling. The request sits in the pending
    // queue until the exchange timeout fires, at which point the relay
    // returns an error response. The runtime throws at the verification
    // layer because the response is an error. Placeholder payee_address
    // is fine here — the test expects rejection on the timeout path
    // before any confused-deputy cross-check matters.
    await expect(
      alice.requestSovereignReceipt("bob", {
        payee_motebit_id: "bob",
        rail: "solana",
        tx_hash: "timeout-tx",
        amount_micro: 1_000n,
        asset: "USDC",
        payee_address: "timeout-path-placeholder",
        service_description: "timeout test",
        prompt_hash: "p",
        result_hash: "r",
        tools_used: [],
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
      }),
    ).rejects.toThrow();
  });

  it("BigInt amount_micro round-trips through the relay", async () => {
    const aliceKp = await generateKeypair();
    const bobKp = await generateKeypair();
    const fetchFn = makeFetchForRelay(relay);
    const RELAY_URL = "http://relay.localhost";

    bobTransport = createRelayReceiptExchange({
      relayUrl: RELAY_URL,
      ownMotebitId: "bob",
      authToken: API_TOKEN,
      fetch: fetchFn,
      pollTimeoutMs: 2_000,
      requestTimeoutMs: 5_000,
      pollRetryDelayMs: 100,
    });
    aliceTransport = createRelayReceiptExchange({
      relayUrl: RELAY_URL,
      ownMotebitId: "alice",
      authToken: API_TOKEN,
      fetch: fetchFn,
      pollTimeoutMs: 2_000,
      requestTimeoutMs: 5_000,
      pollRetryDelayMs: 100,
    });

    const bob = new MotebitRuntime(
      {
        motebitId: "bob",
        tickRateHz: 0,
        signingKeys: { privateKey: bobKp.privateKey, publicKey: bobKp.publicKey },
        sovereignReceiptExchange: bobTransport,
      },
      createAdaptersWithTrust().adapters,
    );
    // No Solana RPC rail — balance returns null. Address resolves from
    // signing keys (rail-independent); not what this test is probing.
    expect(await bob.getSolanaBalance()).toBeNull();

    const alice = new MotebitRuntime(
      {
        motebitId: "alice",
        tickRateHz: 0,
        signingKeys: { privateKey: aliceKp.privateKey, publicKey: aliceKp.publicKey },
        sovereignReceiptExchange: aliceTransport,
      },
      createAdaptersWithTrust().adapters,
    );

    // 2^53 + 1 — lossy as a JSON number, exact as a bigint.
    const bigAmount = 9_007_199_254_740_993n;
    const receipt = await alice.requestSovereignReceipt("bob", {
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: "bigint-relay-tx",
      amount_micro: bigAmount,
      asset: "USDC",
      payee_address: deriveSolanaAddress(bobKp.publicKey),
      service_description: "bigint relay round trip payload",
      prompt_hash: "p",
      result_hash: "r",
      tools_used: [],
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
    });

    // The signed receipt's result string contains the exact amount —
    // proof the bigint survived the JSON round trip through the relay.
    expect(receipt.result).toContain("9007199254740993");
  });

  it("close() stops the poll loop and is idempotent", async () => {
    const bobKp = await generateKeypair();
    const fetchFn = makeFetchForRelay(relay);

    bobTransport = createRelayReceiptExchange({
      relayUrl: "http://relay.localhost",
      ownMotebitId: "bob",
      authToken: API_TOKEN,
      fetch: fetchFn,
      pollTimeoutMs: 500,
      requestTimeoutMs: 1_000,
      pollRetryDelayMs: 100,
    });

    // Polling is lazy — it starts when a handler is registered, not
    // at construction time. Attach a runtime so the handler is set.
    new MotebitRuntime(
      {
        motebitId: "bob",
        tickRateHz: 0,
        signingKeys: { privateKey: bobKp.privateKey, publicKey: bobKp.publicKey },
        sovereignReceiptExchange: bobTransport,
      },
      createAdaptersWithTrust().adapters,
    );
    expect(bobTransport.polling).toBe(true);

    await bobTransport.close();
    expect(bobTransport.polling).toBe(false);

    // Second close is a no-op
    await bobTransport.close();
    expect(bobTransport.polling).toBe(false);
  });
});
