/**
 * HTTP direct receipt exchange — cross-process integration test.
 *
 * Spins up TWO real HTTP servers on dynamically-assigned ports,
 * constructs two MotebitRuntime instances pointing at each other via
 * the HTTP transport, and runs the full sovereign trust loop end to
 * end. Requests cross a real `fetch` call to a real HTTP server; the
 * server routes into the runtime's handler; the signed receipt comes
 * back over the same HTTP connection.
 *
 * This is the first test where two MotebitRuntime instances transact
 * sovereignly across a real network boundary. If this test passes,
 * deploying two motebits to two different machines and having them
 * exchange signed receipts with zero relay involvement is a matter
 * of configuration, not engineering.
 *
 * Spec references:
 *   - settlement-v1.md §3 (foundation law — sovereignty, self-
 *     verifiable receipts, relay-optional, plural rails)
 *   - sovereign-receipt-exchange.ts (the protocol definition)
 *   - http-receipt-exchange.ts (this test's transport)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeypair } from "@motebit/encryption";
import { deriveSolanaAddress } from "@motebit/wallet-solana";
import { AgentTrustLevel } from "@motebit/sdk";

import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  InMemoryAgentTrustStore,
  createHttpReceiptExchange,
  type HttpReceiptExchange,
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

// Use port 0 to let the OS assign a free port. After listen() resolves,
// the adapter's `baseUrl` reflects the actual port so peers can be
// registered with the correct URL.
const EPHEMERAL_PORT = 0;

// ── Tests ─────────────────────────────────────────────────────────────

describe("HTTP direct receipt exchange — cross-process sovereign loop", () => {
  let aliceTransport: HttpReceiptExchange | null = null;
  let bobTransport: HttpReceiptExchange | null = null;

  beforeEach(() => {
    aliceTransport = null;
    bobTransport = null;
  });

  afterEach(async () => {
    await aliceTransport?.close();
    await bobTransport?.close();
  });

  it("closes the full sovereign trust loop over real HTTP", async () => {
    // 1. Two motebits, each with its own identity keypair.
    const aliceKp = await generateKeypair();
    const bobKp = await generateKeypair();

    // 2. Bob's transport spins up a real HTTP server on an ephemeral
    //    port. Once `createHttpReceiptExchange` resolves, the server
    //    is listening and `bobTransport.baseUrl` reflects the actual
    //    URL the OS assigned.
    bobTransport = await createHttpReceiptExchange({
      server: { port: EPHEMERAL_PORT },
    });
    expect(bobTransport.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // 3. Alice's transport is client-only (no server) and knows Bob's
    //    URL. In production, discovery would provide the URL; in this
    //    test we hand it in directly.
    aliceTransport = await createHttpReceiptExchange({
      peers: { bob: bobTransport.baseUrl! },
    });

    // 4. Bob's runtime with signing keys and the server transport.
    //    Handler registration happens at construction time.
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
    // No Solana RPC rail wired — balance query returns null. The address
    // itself resolves from signing keys (new behavior: address is
    // rail-independent); that's not what this test is probing.
    expect(await bob.getSolanaBalance()).toBeNull();

    // 5. Alice's runtime with signing keys and the client transport.
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

    // 6. Alice has never interacted with Bob. Trust store empty.
    expect(await aliceSetup.trustStore.getAgentTrust("alice", "bob")).toBeNull();

    // 7. Alice requests a sovereign receipt from Bob. This is a real
    //    HTTP POST across a real socket, through Node's http server,
    //    into Bob's runtime handler, back through the server, across
    //    the socket, into Alice's runtime, which verifies the
    //    signature and updates the trust store.
    const now = Date.now();
    const receipt = await alice.requestSovereignReceipt("bob", {
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: "CrossProcessTxHashDemoOnly",
      amount_micro: 5_000n,
      asset: "USDC",
      // Bob's address resolves from signing keys (rail-independent).
      payee_address: bob.getSolanaAddress()!,
      service_description:
        "Cross-process sovereign trust loop integration test payload with enough detail to satisfy quality thresholds.",
      prompt_hash: "sha256:prompt-http-integration",
      result_hash: "sha256:result-http-integration",
      tools_used: ["web_search"],
      submitted_at: now - 2_000,
      completed_at: now,
    });

    // 8. The receipt is real and Bob-signed.
    expect(receipt.motebit_id).toBe("bob");
    expect(receipt.task_id).toBe("solana:tx:CrossProcessTxHashDemoOnly");
    expect(receipt.relay_task_id).toBeUndefined();
    expect(receipt.signature).toBeTruthy();
    expect(receipt.public_key).toBeTruthy();

    // 9. Alice's trust store reflects Bob at FirstContact.
    const trust = await aliceSetup.trustStore.getAgentTrust("alice", "bob");
    expect(trust).not.toBeNull();
    expect(trust!.trust_level).toBe(AgentTrustLevel.FirstContact);
    expect(trust!.interaction_count).toBe(1);
    expect(trust!.successful_tasks).toBe(1);
  });

  it("returns an error when the peer URL is not registered", async () => {
    const aliceKp = await generateKeypair();
    aliceTransport = await createHttpReceiptExchange({
      peers: {}, // empty — bob is not registered
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
    ).rejects.toThrow(/No peer registered/);
  });

  it("returns an error when the server is unreachable", async () => {
    const aliceKp = await generateKeypair();
    aliceTransport = await createHttpReceiptExchange({
      // Point at a port no one is listening on. OS will reject the
      // connection almost immediately — faster than the 30s timeout.
      peers: { bob: "http://127.0.0.1:1" },
      timeoutMs: 2_000,
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
    ).rejects.toThrow();
  });

  it("registerPeer updates the peer map on the fly", async () => {
    bobTransport = await createHttpReceiptExchange({
      server: { port: EPHEMERAL_PORT },
    });
    aliceTransport = await createHttpReceiptExchange({});
    // No peers at construction time
    aliceTransport.registerPeer("bob", bobTransport.baseUrl!);

    const aliceKp = await generateKeypair();
    const bobKp = await generateKeypair();

    const bob = new MotebitRuntime(
      {
        motebitId: "bob",
        tickRateHz: 0,
        signingKeys: { privateKey: bobKp.privateKey, publicKey: bobKp.publicKey },
        sovereignReceiptExchange: bobTransport,
      },
      createAdaptersWithTrust().adapters,
    );
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

    const receipt = await alice.requestSovereignReceipt("bob", {
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: "dynamic-peer-tx",
      amount_micro: 1_000n,
      asset: "USDC",
      payee_address: deriveSolanaAddress(bobKp.publicKey),
      service_description: "dynamic peer registration test payload",
      prompt_hash: "p",
      result_hash: "r",
      tools_used: [],
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
    });

    expect(receipt.motebit_id).toBe("bob");
  });

  it("close() is idempotent and releases the port", async () => {
    bobTransport = await createHttpReceiptExchange({
      server: { port: EPHEMERAL_PORT },
    });
    expect(bobTransport.baseUrl).not.toBeNull();

    await bobTransport.close();
    expect(bobTransport.baseUrl).toBeNull();

    // Second close is a no-op
    await bobTransport.close();
    expect(bobTransport.baseUrl).toBeNull();
  });

  it("bigint amount_micro round-trips through JSON", async () => {
    // Large bigints (> Number.MAX_SAFE_INTEGER) must survive the wire.
    // 9,007,199,254,740,993 is 2^53 + 1, which loses precision if
    // serialized as a JSON number. The custom replacer/reviver keeps it.
    bobTransport = await createHttpReceiptExchange({
      server: { port: EPHEMERAL_PORT },
    });
    aliceTransport = await createHttpReceiptExchange({
      peers: { bob: bobTransport.baseUrl! },
    });

    const aliceKp = await generateKeypair();
    const bobKp = await generateKeypair();

    const bob = new MotebitRuntime(
      {
        motebitId: "bob",
        tickRateHz: 0,
        signingKeys: { privateKey: bobKp.privateKey, publicKey: bobKp.publicKey },
        sovereignReceiptExchange: bobTransport,
      },
      createAdaptersWithTrust().adapters,
    );
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

    const bigAmount = 9_007_199_254_740_993n; // 2^53 + 1, lossy as a number
    const receipt = await alice.requestSovereignReceipt("bob", {
      payee_motebit_id: "bob",
      rail: "solana",
      tx_hash: "bigint-round-trip-tx",
      amount_micro: bigAmount,
      asset: "USDC",
      payee_address: deriveSolanaAddress(bobKp.publicKey),
      service_description: "big amount round trip test payload",
      prompt_hash: "p",
      result_hash: "r",
      tools_used: [],
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
    });

    // The signed receipt's `result` field contains the exact amount
    // string — which will include the full bigint value if and only
    // if the bigint survived the JSON round trip intact.
    expect(receipt.result).toContain("9007199254740993");
  });
});
