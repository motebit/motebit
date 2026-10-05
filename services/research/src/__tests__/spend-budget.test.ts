/**
 * Per-task paid-spend budget — the first-party floor law
 * (docs/doctrine/clearing-house-not-thin-waist.md: a first-party worker priced
 * below its metered cost is a subsidized house bot). The Researcher lists at
 * $0.25/task and may loop up to 8 tool calls, each of which can be a PAID
 * web-search hop at $0.05 + the 5% relay fee (52,632 micro). Unbudgeted, eight
 * searches spend 421,056 micro — more than the whole task earns, before a
 * single inference token. The budget caps paid outflow per task, priced from
 * each hop's own quote (the dry-run of the same spend path), fail-soft: an
 * over-budget hop is skipped, never a failed report.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeP2pFeeMicro } from "@motebit/sdk";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

import type {
  AtomAdapter,
  PaidSubDelegate,
  PaidSubDelegateResult,
  ResearchConfig,
  SignedReceipt,
} from "../research.js";
import { research } from "../research.js";
import {
  computePaidSpendBudgetMicro,
  deriveLlmReserveMicro,
  loadConfig,
  DEFAULT_RESEARCH_MARGIN_BPS,
} from "../helpers.js";

/** web-search's coded default listing: $0.05/request = 50,000 micro net. */
const SEARCH_NET_MICRO = 50_000;
const SEARCH_FEE_MICRO = computeP2pFeeMicro(SEARCH_NET_MICRO, 0.05); // 2,632
const SEARCH_OUTFLOW_MICRO = SEARCH_NET_MICRO + SEARCH_FEE_MICRO; // 52,632
/** research's coded default listing: $0.25/task. */
const RESEARCH_PRICE_MICRO = 250_000;

const REPORT = [
  "## Question",
  "The test question, restated.",
  "",
  "## Findings",
  "",
  "The synthesized answer, specific and cited inline [1]. This paragraph",
  "stands in for real findings and carries enough substance to clear the",
  "report shape contract's minimum-length floor for tests.",
  "",
  "## Sources",
  "",
  "[1] Example source — https://example.com/source",
].join("\n");

class NoDirectAdapter implements AtomAdapter {
  calls: string[] = [];
  constructor(private readonly receipt?: SignedReceipt) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async executeTool(qualified: string) {
    this.calls.push(qualified);
    if (this.receipt == null) return { ok: false, error: "no direct path expected" };
    return { ok: true, delegation_receipt: this.receipt };
  }
}

function receipt(n: number, result = "[]"): SignedReceipt {
  return {
    task_id: `atom-task-${n}`,
    motebit_id: "web-search-agent",
    device_id: "d",
    submitted_at: 0,
    completed_at: 1,
    status: "completed",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "",
    result_hash: "",
    result,
    signature: `sig-${n}`,
  } as unknown as SignedReceipt;
}

/**
 * A fake priced web-search market: every LIVE hop settles P2P at the listed
 * price (net + fee, summed into `liveOutflow`); a DRY-RUN hop returns the same
 * quote without paying. `read_url` is unpriced unless `readUrlPriced`.
 */
function fakeMarket(opts: { readUrlPriced?: boolean } = {}) {
  const state = { liveOutflow: 0, liveCalls: 0, quotes: 0 };
  let n = 0;
  const seam: PaidSubDelegate = async (p): Promise<PaidSubDelegateResult> => {
    const priced = p.capability === "web_search" || opts.readUrlPriced === true;
    if (!priced) return { ok: false, code: "worker_not_payable" };
    const settlement = {
      mode: "p2p" as const,
      paidMicro: SEARCH_NET_MICRO,
      feeMicro: SEARCH_FEE_MICRO,
    };
    if ((p as { dryRun?: boolean }).dryRun === true) {
      state.quotes++;
      return { ok: true, settlement };
    }
    state.liveCalls++;
    state.liveOutflow += SEARCH_NET_MICRO + SEARCH_FEE_MICRO;
    n++;
    return { ok: true, receipt: receipt(n), settlement: { ...settlement, txHash: `tx-${n}` } };
  };
  return { state, seam };
}

/** A model loop that wants `k` web searches, one per turn, then writes the report. */
function modelWantsSearches(k: number): void {
  for (let i = 0; i < k; i++) {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: `tu-${i}`, name: "motebit_web_search", input: { query: `q${i}` } },
      ],
    });
  }
  mockCreate.mockResolvedValue({ content: [{ type: "text", text: REPORT }] });
}

function config(over: Partial<ResearchConfig>): ResearchConfig {
  return {
    anthropicApiKey: "sk-ant-test",
    webSearchUrl: "http://ws.test/mcp",
    readUrlUrl: "http://ru.test/mcp",
    callerMotebitId: "motebit-research",
    callerDeviceId: "research-service",
    callerPrivateKey: new Uint8Array(32),
    maxToolCalls: 8,
    adapterFactory: () => new NoDirectAdapter(),
    ...over,
  };
}

const DEFAULT_BUDGET = computePaidSpendBudgetMicro({
  unitCostMicro: RESEARCH_PRICE_MICRO,
  marginBps: DEFAULT_RESEARCH_MARGIN_BPS,
  llmReserveMicro: deriveLlmReserveMicro(8),
});

describe("research — per-task paid-spend budget", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("the measured default: 8 × $0.05 searches would cost more than the $0.25 task earns", () => {
    // The problem statement, pinned as arithmetic so a price change re-opens it.
    expect(SEARCH_OUTFLOW_MICRO).toBe(52_632);
    expect(8 * SEARCH_OUTFLOW_MICRO).toBeGreaterThan(RESEARCH_PRICE_MICRO);
    // Reserve derivation (helpers.ts) at the default 8-call cap, Sonnet 4.6 list.
    expect(deriveLlmReserveMicro(8)).toBe(171_300);
    // 250,000 − 12,500 (5% margin) − 171,300 = 66,200 ⇒ exactly one paid search.
    expect(DEFAULT_BUDGET).toBe(66_200);
  });

  it("a model that wants 8 paid searches spends ≤ budget and still delivers a report", async () => {
    const market = fakeMarket();
    modelWantsSearches(8);

    const result = await research(
      "question",
      config({ paidSubDelegate: market.seam, paidSpendBudgetMicro: DEFAULT_BUDGET }),
    );

    expect(market.state.liveOutflow).toBeLessThanOrEqual(DEFAULT_BUDGET);
    expect(market.state.liveOutflow).toBeLessThan(RESEARCH_PRICE_MICRO);
    expect(market.state.liveCalls).toBe(1);
    expect(result.search_count).toBe(1);
    expect(result.sub_settlements).toHaveLength(1);
    expect(result.paid_spend_micro).toBe(SEARCH_OUTFLOW_MICRO);
    expect(result.paid_budget_micro).toBe(DEFAULT_BUDGET);
    expect(result.report).toBe(REPORT);
    // The skipped hops told the model why, without failing the turn.
    const toolResults = mockCreate.mock.calls
      .flatMap((c) => (c[0] as { messages: Array<{ content: unknown }> }).messages)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b: { type?: string }) => b.type === "tool_result") as Array<{
      content: string;
      is_error?: boolean;
    }>;
    expect(toolResults.some((b) => /budget/i.test(b.content) && b.is_error !== true)).toBe(true);
  });

  it("budget exactly one call: the first hop is paid, the second is skipped", async () => {
    const market = fakeMarket();
    modelWantsSearches(3);
    const result = await research(
      "question",
      config({ paidSubDelegate: market.seam, paidSpendBudgetMicro: SEARCH_OUTFLOW_MICRO }),
    );
    expect(market.state.liveCalls).toBe(1);
    expect(market.state.liveOutflow).toBe(SEARCH_OUTFLOW_MICRO);
    expect(result.paid_spend_micro).toBe(SEARCH_OUTFLOW_MICRO);
    expect(result.report).toBe(REPORT);
  });

  it("budget below one call ⇒ zero paid calls, report still delivered", async () => {
    const market = fakeMarket();
    modelWantsSearches(2);
    const result = await research(
      "question",
      config({ paidSubDelegate: market.seam, paidSpendBudgetMicro: SEARCH_OUTFLOW_MICRO - 1 }),
    );
    expect(market.state.liveCalls).toBe(0);
    expect(result.paid_spend_micro).toBe(0);
    expect(result.search_count).toBe(0);
    expect(result.report).toBe(REPORT);
  });

  it("zero-cost tools are unaffected: unpriced read_url and recall_self run with a zero budget", async () => {
    const market = fakeMarket();
    const read = receipt(99, "page text");
    const ru = new NoDirectAdapter(read);
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "r1", name: "motebit_recall_self", input: { query: "motebit" } },
          {
            type: "tool_use",
            id: "u1",
            name: "motebit_read_url",
            input: { url: "https://example.com/source" },
          },
        ],
      })
      .mockResolvedValue({ content: [{ type: "text", text: REPORT }] });

    const result = await research(
      "question",
      config({
        paidSubDelegate: market.seam,
        paidSpendBudgetMicro: 0,
        adapterFactory: ({ name }) => (name === "read-url" ? ru : new NoDirectAdapter()),
      }),
    );
    expect(result.recall_self_count).toBe(1);
    expect(result.fetch_count).toBe(1);
    expect(ru.calls).toEqual(["read-url__motebit_task"]);
    expect(market.state.liveCalls).toBe(0);
    expect(result.paid_spend_micro).toBe(0);
  });

  it("a priced read_url draws on the same budget as search", async () => {
    const market = fakeMarket({ readUrlPriced: true });
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "s", name: "motebit_web_search", input: { query: "q" } }],
      })
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "u", name: "motebit_read_url", input: { url: "https://x.test" } },
        ],
      })
      .mockResolvedValue({ content: [{ type: "text", text: REPORT }] });
    const result = await research(
      "question",
      config({ paidSubDelegate: market.seam, paidSpendBudgetMicro: SEARCH_OUTFLOW_MICRO }),
    );
    expect(market.state.liveCalls).toBe(1);
    expect(result.search_count).toBe(1);
    expect(result.fetch_count).toBe(0);
  });

  it("prices each hop from its quote, not a constant: a cheaper atom affords more hops", async () => {
    let live = 0;
    const cheap: PaidSubDelegate = async (p) => {
      const settlement = { mode: "p2p" as const, paidMicro: 3_000, feeMicro: 158 };
      if (p.dryRun === true) return { ok: true, settlement };
      live++;
      return { ok: true, receipt: receipt(live), settlement };
    };
    modelWantsSearches(8);
    const result = await research(
      "question",
      config({ paidSubDelegate: cheap, paidSpendBudgetMicro: DEFAULT_BUDGET }),
    );
    expect(live).toBe(8);
    expect(result.paid_spend_micro).toBe(8 * 3_158);
  });

  it("a quote that is not-payable falls back to the free direct path without a live attempt", async () => {
    let live = 0;
    const seam: PaidSubDelegate = async (p) => {
      if (p.dryRun === true) return { ok: false, code: "no_routing" };
      live++;
      return { ok: false, code: "no_routing" };
    };
    const ws = new NoDirectAdapter(receipt(7));
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "s", name: "motebit_web_search", input: { query: "q" } }],
      })
      .mockResolvedValue({ content: [{ type: "text", text: REPORT }] });
    const result = await research(
      "question",
      config({
        paidSubDelegate: seam,
        paidSpendBudgetMicro: DEFAULT_BUDGET,
        adapterFactory: ({ name }) => (name === "web-search" ? ws : new NoDirectAdapter()),
      }),
    );
    expect(live).toBe(0);
    expect(ws.calls).toEqual(["web-search__motebit_task"]);
    expect(result.search_count).toBe(1);
  });

  it("a quote refused for a real payment reason surfaces the code and pays nothing", async () => {
    let live = 0;
    const seam: PaidSubDelegate = async (p) => {
      if (p.dryRun === true) return { ok: false, code: "money_meter_denied" };
      live++;
      return { ok: true, receipt: receipt(1) };
    };
    modelWantsSearches(1);
    const result = await research(
      "question",
      config({ paidSubDelegate: seam, paidSpendBudgetMicro: DEFAULT_BUDGET }),
    );
    expect(live).toBe(0);
    expect(result.search_count).toBe(0);
    const second = mockCreate.mock.calls[1]![0] as { messages: Array<{ content: unknown }> };
    const last = second.messages[second.messages.length - 1]!.content as Array<{
      content: string;
      is_error?: boolean;
    }>;
    expect(last[0]!.content).toContain("money_meter_denied");
    expect(last[0]!.is_error).toBe(true);
  });

  it("a quote with no code is treated as a real refusal (unknown)", async () => {
    const seam: PaidSubDelegate = async () => ({ ok: false });
    modelWantsSearches(1);
    const result = await research(
      "question",
      config({ paidSubDelegate: seam, paidSpendBudgetMicro: DEFAULT_BUDGET }),
    );
    expect(result.search_count).toBe(0);
  });

  it("a quote with no price is fail-closed: the hop is skipped, never paid blind", async () => {
    let live = 0;
    const seam: PaidSubDelegate = async (p) => {
      if (p.dryRun === true) return { ok: true, settlement: { mode: "p2p" } };
      live++;
      return { ok: true, receipt: receipt(1) };
    };
    modelWantsSearches(1);
    const result = await research(
      "question",
      config({ paidSubDelegate: seam, paidSpendBudgetMicro: DEFAULT_BUDGET }),
    );
    expect(live).toBe(0);
    expect(result.paid_spend_micro).toBe(0);
  });

  it("a live hop with no settlement fact is charged at its quote", async () => {
    const seam: PaidSubDelegate = async (p) => {
      if (p.dryRun === true)
        return { ok: true, settlement: { mode: "p2p", paidMicro: 10_000, feeMicro: 527 } };
      return { ok: true, receipt: receipt(1) };
    };
    modelWantsSearches(1);
    const result = await research(
      "question",
      config({ paidSubDelegate: seam, paidSpendBudgetMicro: DEFAULT_BUDGET }),
    );
    expect(result.paid_spend_micro).toBe(10_527);
  });

  it("a pinned target is quoted pinned, and a fee-less quote charges the worker leg alone", async () => {
    const seen: Array<{ targetWorkerId?: string; dryRun?: boolean }> = [];
    const seam: PaidSubDelegate = async (p) => {
      seen.push({ targetWorkerId: p.targetWorkerId, dryRun: p.dryRun });
      const settlement = { mode: "p2p" as const, paidMicro: 20_000 };
      if (p.dryRun === true) return { ok: true, settlement };
      return { ok: true, receipt: receipt(1), settlement };
    };
    modelWantsSearches(1);
    const result = await research(
      "question",
      config({
        paidSubDelegate: seam,
        paidSpendBudgetMicro: DEFAULT_BUDGET,
        webSearchTargetId: "web-search-agent",
      }),
    );
    expect(seen).toEqual([
      { targetWorkerId: "web-search-agent", dryRun: true },
      { targetWorkerId: "web-search-agent", dryRun: undefined },
    ]);
    expect(result.paid_spend_micro).toBe(20_000);
  });

  it("unbudgeted (no paidSpendBudgetMicro) keeps the pre-budget behaviour: no quotes, spend still counted", async () => {
    const market = fakeMarket();
    modelWantsSearches(2);
    const result = await research("question", config({ paidSubDelegate: market.seam }));
    expect(market.state.quotes).toBe(0);
    expect(market.state.liveCalls).toBe(2);
    expect(result.paid_spend_micro).toBe(2 * SEARCH_OUTFLOW_MICRO);
    expect(result.paid_budget_micro).toBeNull();
  });
});

describe("paid-spend budget configuration", () => {
  const KEYS = [
    "MOTEBIT_RESEARCH_MARGIN_BPS",
    "MOTEBIT_RESEARCH_LLM_RESERVE_MICRO",
    "MOTEBIT_MAX_TOOL_CALLS",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults: 5% margin and the reserve derived from the tool-call cap", () => {
    const c = loadConfig();
    expect(c.marginBps).toBe(500);
    expect(c.llmReserveMicro).toBe(deriveLlmReserveMicro(8));
  });

  it("override env: a smaller measured reserve affords more paid hops", async () => {
    process.env["MOTEBIT_RESEARCH_LLM_RESERVE_MICRO"] = "50000";
    process.env["MOTEBIT_RESEARCH_MARGIN_BPS"] = "1000";
    const c = loadConfig();
    expect(c.llmReserveMicro).toBe(50_000);
    expect(c.marginBps).toBe(1_000);
    // 250,000 − 25,000 − 50,000 = 175,000 ⇒ three hops (157,896), not four (210,528).
    const budget = computePaidSpendBudgetMicro({
      unitCostMicro: RESEARCH_PRICE_MICRO,
      marginBps: c.marginBps,
      llmReserveMicro: c.llmReserveMicro,
    });
    expect(budget).toBe(175_000);
    mockCreate.mockReset();
    const market = fakeMarket();
    modelWantsSearches(8);
    await research(
      "question",
      config({ paidSubDelegate: market.seam, paidSpendBudgetMicro: budget }),
    );
    expect(market.state.liveCalls).toBe(3);
  });

  it("the reserve follows MOTEBIT_MAX_TOOL_CALLS when not overridden", () => {
    process.env["MOTEBIT_MAX_TOOL_CALLS"] = "4";
    expect(loadConfig().llmReserveMicro).toBe(deriveLlmReserveMicro(4));
  });

  it("invalid overrides fall back to the safe defaults", () => {
    process.env["MOTEBIT_RESEARCH_LLM_RESERVE_MICRO"] = "-5";
    process.env["MOTEBIT_RESEARCH_MARGIN_BPS"] = "lots";
    const c = loadConfig();
    expect(c.llmReserveMicro).toBe(deriveLlmReserveMicro(8));
    expect(c.marginBps).toBe(500);
  });

  it("a margin of 100% or more is refused back to the default", () => {
    process.env["MOTEBIT_RESEARCH_MARGIN_BPS"] = "10000";
    expect(loadConfig().marginBps).toBe(500);
  });

  it("a budget that would go negative clamps to zero (zero paid calls)", () => {
    expect(
      computePaidSpendBudgetMicro({
        unitCostMicro: 100_000,
        marginBps: 500,
        llmReserveMicro: 171_300,
      }),
    ).toBe(0);
  });
});
