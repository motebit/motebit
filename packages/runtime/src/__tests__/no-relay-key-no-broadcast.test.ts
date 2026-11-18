/**
 * A session wired WITHOUT a relay key signs nothing and broadcasts nothing on
 * the peer-to-peer path — even with a sovereign wallet present and a priced,
 * P2P-payable worker on offer.
 *
 * The fee leg's treasury derives from the relay's pinned key. A surface that
 * has no key for its relay (the CLI's per-relay record gave none) passes no
 * `relayPublicKey`, and the delegation must then run relay-mode: the wallet
 * is never asked to build a payment, the P2P pre-flight is never read, and
 * the submission carries no payment proof.
 *
 * Driven through the real runtime wiring (`enableInteractiveDelegation`,
 * `enableInvokeCapability` → `selectAndRunDelegation`) with a wallet rail
 * that records every call and a stubbed relay. The relay stub serves
 * EVERYTHING the P2P path needs (signed metadata, a priced p2p worker,
 * eligibility, listing), and a control case with the key present proves the
 * same fixture does reach the broadcast — so "nothing was built" is the
 * guard's doing, not a fixture that could never pay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type {
  AIResponse,
  ContextPack,
  ExecutionReceipt,
  P2pPaymentProof,
  SovereignP2pPaymentRequest,
  SovereignWalletRail,
} from "@motebit/sdk";
import {
  SIGNING_PINNED_HEX,
  isRelayMetadataUrl,
  relayMetadataResponse,
} from "./helpers/signed-relay-metadata.js";
import { runToolHandler } from "./helpers/money-tool-handler.js";

const RELAY = "https://nokey-relay.test";
const ME = "alice-nokey";
const WORKER = "bob-worker";
const WORKER_ADDR = "BobWorkerAddr1111111111111111111111111111111";
const TASK = "task-nokey-1";

function provider(): StreamingProvider {
  const response: AIResponse = {
    text: "ok",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn<(r: AIResponse) => Promise<never[]>>().mockResolvedValue([]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: response.text };
      yield { type: "done" as const, response };
    },
  };
}

function adapters(): PlatformAdapters {
  return { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: provider() };
}

/** A wallet rail that records every call made to it. */
function recordingWallet(): { wallet: SovereignWalletRail; calls: string[] } {
  const calls: string[] = [];
  const wallet = {
    address: "AliceAddr11111111111111111111111111111111111",
    async buildP2pPayment(req: SovereignP2pPaymentRequest): Promise<P2pPaymentProof> {
      calls.push("buildP2pPayment");
      return {
        tx_hash: "tx-should-never-exist",
        chain: "solana",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        to_address: req.workerAddress,
        amount_micro: req.amountMicro,
        fee_to_address: req.treasuryAddress,
        fee_amount_micro: req.feeAmountMicro,
      };
    },
    async send(): Promise<never> {
      calls.push("send");
      throw new Error("send must never be called");
    },
    async getBalance(): Promise<bigint> {
      calls.push("getBalance");
      return 5_000_000n;
    },
    async isAvailable(): Promise<boolean> {
      calls.push("isAvailable");
      return true;
    },
  } as unknown as SovereignWalletRail;
  return { wallet, calls };
}

function receipt(): ExecutionReceipt {
  return {
    task_id: TASK,
    motebit_id: WORKER,
    device_id: "bob-device",
    submitted_at: Date.now() - 1000,
    completed_at: Date.now(),
    status: "completed",
    result: "the worker's answer",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "fake-sig-for-test",
  } as ExecutionReceipt;
}

interface RelayLog {
  requests: string[];
  submits: Array<Record<string, unknown>>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const originalFetch = globalThis.fetch;
let log: RelayLog;

beforeEach(() => {
  log = { requests: [], submits: [] };
  // A relay that offers a priced, P2P-payable worker and answers every read
  // the P2P path makes. Nothing leaves the process.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(RELAY)) throw new Error(`unexpected network call: ${url}`);
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    log.requests.push(`${method} ${path}`);
    if (isRelayMetadataUrl(url)) return relayMetadataResponse();
    if (path === "/api/v1/agents/discover") {
      return json(200, {
        agents: [
          {
            motebit_id: WORKER,
            capabilities: ["web_search"],
            settlement_address: WORKER_ADDR,
            settlement_modes: "relay,p2p",
            pricing: [{ capability: "web_search", unit_cost: 0.05 }],
          },
        ],
      });
    }
    if (path.endsWith("/p2p-eligibility")) {
      // The CURRENT relay's answer for a priced worker
      // (services/relay/src/agents.ts, the `p2p-eligibility` handler):
      // { allowed, reason, expected_amount_micro, expected_fee_micro,
      // settlement_address }. With the amounts the client pays without
      // reading any signed relay document — so only the relay KEY decides
      // whether, and to whose treasury, a payment is built. This package
      // cannot depend on the relay; the CLI's
      // `p2p-eligibility-fixture-shape.test.ts` pins this shape to the real
      // handler. $0.05 → 50000 micro; fee computeP2pFeeMicro(50000, 0.05) = 2632.
      return json(200, {
        allowed: true,
        reason: "caller not identified — advisory only",
        expected_amount_micro: 50_000,
        expected_fee_micro: 2_632,
        settlement_address: WORKER_ADDR,
      });
    }
    if (path.endsWith("/listing")) {
      return json(200, { pricing: [{ capability: "web_search", unit_cost: 0.05 }] });
    }
    if (method === "POST" && path === `/agent/${ME}/task`) {
      log.submits.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return json(201, { task_id: TASK, status: "pending" });
    }
    if (method === "GET" && path === `/agent/${ME}/task/${TASK}`) {
      return json(200, { task: { status: "completed" }, receipt: receipt() });
    }
    return json(404, {});
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function runtimeWith(wallet: SovereignWalletRail): MotebitRuntime {
  return new MotebitRuntime({ motebitId: ME, tickRateHz: 0, solanaWallet: wallet }, adapters());
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

const PRICED_TASK = { prompt: "search the web", required_capabilities: ["web_search"] };

describe("no relay key: a priced cross-agent task signs and broadcasts nothing", () => {
  it("control: WITH the relay key, the same wallet and relay DO build the payment (the fixture can pay)", async () => {
    const { wallet, calls } = recordingWallet();
    const runtime = runtimeWith(wallet);
    runtime.enableInteractiveDelegation({
      syncUrl: RELAY,
      authToken: async () => "test-token",
      relayPublicKey: SIGNING_PINNED_HEX,
      acknowledgeNoHistoryRisk: true,
    });

    await runToolHandler(runtime.getToolRegistry(), "delegate_to_agent", PRICED_TASK);

    expect(calls.filter((c) => c === "buildP2pPayment")).toHaveLength(1);
    expect(log.submits).toHaveLength(1);
    expect(log.submits[0]!["settlement_mode"]).toBe("p2p");
    expect(log.submits[0]!["payment_proof"]).toBeDefined();
  });

  it("delegate_to_agent (the AI-loop door): relay-mode, zero wallet calls, no P2P read, no payment proof", async () => {
    const { wallet, calls } = recordingWallet();
    const runtime = runtimeWith(wallet);
    // The session has a wallet and opts into paying new agents — everything
    // the P2P path needs EXCEPT a key for this relay.
    runtime.enableInteractiveDelegation({
      syncUrl: RELAY,
      authToken: async () => "test-token",
      acknowledgeNoHistoryRisk: true,
    });

    const result = await runToolHandler(
      runtime.getToolRegistry(),
      "delegate_to_agent",
      PRICED_TASK,
    );

    // Nothing was signed or broadcast: the wallet was never touched.
    expect(calls).toEqual([]);
    // The P2P path was never entered: no fee-rate read, no eligibility read.
    expect(log.requests.filter((r) => r.includes("/p2p-eligibility"))).toEqual([]);
    expect(log.requests.filter((r) => r.includes("/.well-known/motebit.json"))).toEqual([]);
    // The delegation ran relay-mode: one submission, with no payment in it.
    expect(log.submits).toHaveLength(1);
    expect(log.submits[0]!["payment_proof"]).toBeUndefined();
    expect(log.submits[0]!["settlement_mode"]).not.toBe("p2p");
    expect(log.submits[0]!["target_agent"]).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("invokeCapability (the deterministic door): relay-mode, zero wallet calls, no payment proof", async () => {
    const { wallet, calls } = recordingWallet();
    const runtime = runtimeWith(wallet);
    runtime.enableInvokeCapability({
      syncUrl: RELAY,
      authToken: async () => "test-token",
      acknowledgeNoHistoryRisk: true,
      timeoutMs: 3_000,
    });

    await collect(runtime.invokeCapability("web_search", "search the web"));

    expect(calls).toEqual([]);
    expect(log.requests.filter((r) => r.includes("/p2p-eligibility"))).toEqual([]);
    expect(log.submits).toHaveLength(1);
    expect(log.submits[0]!["payment_proof"]).toBeUndefined();
    expect(log.submits[0]!["settlement_mode"]).not.toBe("p2p");
  });

  it("a pinned hire (a named worker) with no relay key fails closed: nothing submitted, nothing built", async () => {
    const { wallet, calls } = recordingWallet();
    const runtime = runtimeWith(wallet);
    runtime.enableInvokeCapability({
      syncUrl: RELAY,
      authToken: async () => "test-token",
      acknowledgeNoHistoryRisk: true,
      timeoutMs: 3_000,
    });

    await collect(
      runtime.invokeCapability("web_search", "search the web", { targetWorkerId: WORKER }),
    );

    expect(calls).toEqual([]);
    expect(log.submits).toEqual([]);
  });
});
