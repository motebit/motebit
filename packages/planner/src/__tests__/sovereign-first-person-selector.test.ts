/**
 * Sovereign pay-forward adapter — first-person worker routing.
 *
 * The relay's `/api/v1/market/candidates` order is the RELAY's ranking
 * (`graphRankCandidates(asMotebitId("relay"), …)`), not the delegator's. Taking
 * `candidates[0]` would hand the hire — and the irreversible payment — to a
 * global score, which docs/doctrine/first-person-worker-routing.md refuses.
 * The adapter must rank the discovered set with the delegator's OWN injected
 * selector; the relay's order is only the input set, never the choice.
 *
 * The path is dormant (SOVEREIGN_PAY_FORWARD_ENABLED=false, #887); this locks
 * the routing before the gate is ever lifted.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { SovereignDelegationAdapter } from "../sovereign-delegation-adapter.js";
import type { SovereignDelegationConfig } from "../sovereign-delegation-adapter.js";
import type { PlanStep, ExecutionReceipt } from "@motebit/sdk";
import { StepStatus, asPlanId } from "@motebit/sdk";

function makeStep(): PlanStep {
  return {
    step_id: "step-1",
    plan_id: asPlanId("plan-1"),
    ordinal: 0,
    description: "test step",
    prompt: "do the thing",
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
    updated_at: Date.now(),
  };
}

const candidate = (id: string, composite: number) => ({
  motebit_id: id,
  composite,
  endpoint_url: `https://${id}.test/mcp`,
  pay_to_address: `${id}-addr`,
  pricing: [{ capability: "web_search", unit_cost: 500000, currency: "USD", per: "task" }],
  is_online: true,
});

/** Relay lists carol FIRST (its global favorite) and bob LAST. */
function stubDiscoveryThenMcp(receiptFor: (id: string) => ExecutionReceipt) {
  let paidId = "";
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/api/v1/market/candidates")) {
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            candidates: [candidate("carol", 0.99), candidate("dave", 0.5), candidate("bob", 0.1)],
          }),
      } as unknown as Response;
    }
    paidId = new URL(url).hostname.split(".")[0]!;
    return {
      ok: true,
      headers: new Headers({ "mcp-session-id": "sess-1" }),
      json: () =>
        Promise.resolve({
          id: 2,
          result: {
            protocolVersion: "2025-03-26",
            content: [{ type: "text", text: JSON.stringify(receiptFor(paidId)) }],
          },
        }),
      text: () => Promise.resolve(""),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function receipt(id: string): ExecutionReceipt {
  return {
    task_id: "t",
    motebit_id: id,
    public_key: "ab".repeat(32),
    device_id: "d",
    submitted_at: Date.now() - 1000,
    completed_at: Date.now(),
    status: "completed",
    result: "ok",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "a",
    result_hash: "b",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "s",
  } as ExecutionReceipt;
}

function baseConfig(): Omit<SovereignDelegationConfig, "selectWorker"> {
  return {
    discoveryUrl: "https://relay.test",
    motebitId: "agent-alice",
    deviceId: "device-alice",
    signingKeys: { privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) },
    walletRail: {
      send: vi.fn().mockResolvedValue({ signature: "tx-hash-123" }),
      chain: "solana",
      asset: "USDC",
    },
    mintAudienceToken: vi.fn().mockResolvedValue({ token: "mock-token" }),
    verifyReceipt: vi.fn().mockResolvedValue(true),
    hexToBytes: vi.fn().mockReturnValue(new Uint8Array(32)),
    hash: vi.fn().mockResolvedValue("hash-abc"),
    sleep: () => Promise.resolve(),
  };
}

describe("SovereignDelegationAdapter — first-person worker selection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pays the delegator's first-person choice even when the relay lists it LAST", async () => {
    stubDiscoveryThenMcp(receipt);
    const selectWorker = vi.fn(
      (cands: ReadonlyArray<{ motebit_id: string }>) =>
        cands.find((c) => c.motebit_id === "bob")?.motebit_id ?? null,
    );
    const config = { ...baseConfig(), selectWorker };
    const adapter = new SovereignDelegationAdapter(config);

    const result = await adapter.delegateStep(makeStep(), 30000);

    // The selector saw the WHOLE admissible set (the relay's order is input only).
    expect(selectWorker).toHaveBeenCalledTimes(1);
    const seen = selectWorker.mock.calls[0]![0].map((c) => c.motebit_id).sort();
    expect(seen).toEqual(["bob", "carol", "dave"]);
    // The money went to bob — never to the relay's favorite.
    expect(config.walletRail.send).toHaveBeenCalledTimes(1);
    expect((config.walletRail.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("bob-addr");
    expect(result.receipt.motebit_id).toBe("bob");
  });

  it("passes the step's capability and the listed unit cost to the selector", async () => {
    stubDiscoveryThenMcp(receipt);
    const selectWorker = vi.fn(
      (
        cands: ReadonlyArray<{ motebit_id: string; unitCost?: number }>,
        _ctx?: { capability: string },
      ) => cands[cands.length - 1]!.motebit_id,
    );
    const adapter = new SovereignDelegationAdapter({ ...baseConfig(), selectWorker });
    await adapter.delegateStep(makeStep(), 30000);
    expect(selectWorker.mock.calls[0]![1]).toEqual({ capability: "web_search" });
    expect(selectWorker.mock.calls[0]![0].every((c) => c.unitCost === 500000)).toBe(true);
  });

  it("never falls back to the relay's order: a selector that chooses nobody pays nobody", async () => {
    stubDiscoveryThenMcp(receipt);
    const config = { ...baseConfig(), selectWorker: vi.fn(() => null) };
    const adapter = new SovereignDelegationAdapter(config);
    await expect(adapter.delegateStep(makeStep(), 30000)).rejects.toThrow(/first-person/i);
    expect(config.walletRail.send).not.toHaveBeenCalled();
  });

  it("never pays an id the selector invented outside the discovered set", async () => {
    stubDiscoveryThenMcp(receipt);
    const config = { ...baseConfig(), selectWorker: vi.fn(() => "mallory") };
    const adapter = new SovereignDelegationAdapter(config);
    await expect(adapter.delegateStep(makeStep(), 30000)).rejects.toThrow(/first-person/i);
    expect(config.walletRail.send).not.toHaveBeenCalled();
  });

  it("cannot be constructed without a selector (type-level AND at runtime for untyped callers)", () => {
    expect(
      () =>
        // @ts-expect-error — selectWorker is REQUIRED: no relay-ranked default exists.
        new SovereignDelegationAdapter(baseConfig()),
    ).toThrow(/selectWorker/);
  });
});
