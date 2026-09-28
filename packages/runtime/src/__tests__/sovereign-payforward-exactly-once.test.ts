/**
 * #887 — composition: the runtime's pay-forward adapter reaches the wallet's
 * read-only send confirmation AND the runtime's durable paid-intent ledger.
 *
 * The planner adapter proves the law against injected fakes; this proves the
 * deployed wiring (`MotebitRuntime.createSovereignDelegationAdapter`) hands
 * it the real `SolanaWalletRail` (whose `confirmSend` resolves a lost send
 * response) and the same `PaidIntentLedger` the relay paths write — so a
 * paid, unretrieved pay-forward task locks the next hire of that worker
 * before any money moves.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  SolanaRpcAdapter,
  SendUsdcArgs,
  OutgoingTransferQuery,
  OutgoingTransferLookup,
} from "@motebit/wallet-solana";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index.js";

// Pay-forward is disabled in production (#887 — see sovereign-pay-forward-gate.ts);
// this file proves the wiring that re-enabling would switch on, so it flips the
// gate for this module graph only. The disabled gate has its own test.
vi.mock("../sovereign-pay-forward-gate.js", async (orig) => ({
  ...(await orig<typeof import("../sovereign-pay-forward-gate.js")>()),
  SOVEREIGN_PAY_FORWARD_ENABLED: true,
}));
import type { PlanStep } from "@motebit/sdk";
import { StepStatus, asPlanId } from "@motebit/sdk";

const WORKER = { id: "worker-a", addr: "AddrA", url: "https://a.test/mcp" };
const OTHER = { id: "worker-b", addr: "AddrB", url: "https://b.test/mcp" };

function step(): PlanStep {
  return {
    step_id: "s1",
    plan_id: asPlanId("p1"),
    ordinal: 0,
    description: "research",
    prompt: "find it",
    depends_on: [],
    optional: false,
    status: StepStatus.Pending,
    required_capabilities: ["web_search"] as unknown as PlanStep["required_capabilities"],
    result_summary: null,
    error_message: null,
    tool_calls_made: 0,
    started_at: null,
    completed_at: null,
    retry_count: 0,
    updated_at: 0,
  };
}

/** Every worker's `motebit_task` hangs until the adapter's timeout aborts it. */
function stubNetwork(toolCalls: string[]): void {
  const json = (body: unknown, headers?: Record<string, string>): Response =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(headers ?? {}),
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }) as unknown as Response;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/v1/market/candidates")) {
        return Promise.resolve(
          json({
            candidates: [WORKER, OTHER].map((w) => ({
              motebit_id: w.id,
              composite: 0.9,
              endpoint_url: w.url,
              pay_to_address: w.addr,
              pricing: [
                { capability: "web_search", unit_cost: 250_000, currency: "USD", per: "task" },
              ],
              is_online: true,
            })),
          }),
        );
      }
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as {
        method?: string;
        id?: number;
      };
      if (body.method === "initialize") {
        return Promise.resolve(json({ id: body.id, result: {} }, { "mcp-session-id": "s" }));
      }
      if (body.method === "notifications/initialized") return Promise.resolve(json({}));
      toolCalls.push(url);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#887 runtime pay-forward — confirmation + durable ledger are wired", () => {
  it("a lost send response is confirmed onchain, a timed-out task is recorded as owed, and the next hire of that worker is refused before paying", async () => {
    const landed: Array<{ to: string; amount: bigint; sig: string }> = [];
    const adapter: SolanaRpcAdapter = {
      ownAddress: "PayerAddr",
      getUsdcBalance: vi.fn().mockResolvedValue(10_000_000n),
      getUsdcBalanceOf: vi.fn().mockResolvedValue(0n),
      getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
      // The transfer LANDS, then the confirmation response is lost.
      sendUsdc: vi.fn((args: SendUsdcArgs) => {
        const sig = `sig-${landed.length + 1}`;
        landed.push({ to: args.toAddress, amount: args.microAmount, sig });
        return Promise.reject(new Error("confirmation timed out"));
      }),
      sendUsdcBatch: vi.fn().mockResolvedValue([]),
      getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
      isReachable: vi.fn().mockResolvedValue(true),
      findOutgoingTransfer: vi.fn((q: OutgoingTransferQuery): Promise<OutgoingTransferLookup> => {
        const hits = landed.filter(
          (l) =>
            l.to === q.toAddress &&
            l.amount === q.microAmount &&
            !(q.excludeSignatures ?? []).includes(l.sig),
        );
        return Promise.resolve(
          hits.length === 1
            ? { status: "found", signature: hits[0]!.sig }
            : { status: "not_found" },
        );
      }),
    };
    const { SolanaWalletRail } = await import("@motebit/wallet-solana");
    const { generateKeypair } = await import("@motebit/encryption");
    const runtime = new MotebitRuntime(
      {
        motebitId: "delegator",
        tickRateHz: 0,
        signingKeys: await generateKeypair(),
        solanaWallet: new SolanaWalletRail(adapter),
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );
    const toolCalls: string[] = [];
    stubNetwork(toolCalls);

    const sovereign = runtime.createSovereignDelegationAdapter("https://relay.test")!;
    expect(sovereign).not.toBeNull();

    await expect(sovereign.delegateStep(step(), 30)).rejects.toThrow(
      /^Paid, result not retrieved \(tx sig-1, worker worker-a\)/,
    );
    expect(landed).toHaveLength(1);
    expect(toolCalls).toEqual([WORKER.url]);

    // The runtime's own ledger holds it — the same one /result reads.
    const owed = runtime.outstandingPaidResults();
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({
      workerMotebitId: WORKER.id,
      capability: "web_search",
      txHash: "sig-1",
      taskId: `sovereign:${WORKER.id}:sig-1`,
      paidMicro: 250_000,
    });

    // A second hire of the same work is refused BEFORE any money moves.
    await expect(sovereign.delegateStep(step(), 30)).rejects.toThrow(/Refused before payment/);
    expect(landed).toHaveLength(1);
    expect(adapter.sendUsdc).toHaveBeenCalledTimes(1);
  });
});
