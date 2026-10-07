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
import { memoryTaskSpend } from "@motebit/molecule-runner";
import type { TaskSpend } from "@motebit/molecule-runner";

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
  paidSpendBudgetConfigError,
  parseUnitCostMicro,
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
    "MOTEBIT_RESEARCH_CEILING_MICRO",
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

  // The lifetime ceiling is signed into the molecule's own grant; `parseInt`
  // read "" as NaN (canonicalized to null — the grant still verified) and
  // "12abc" as 12. A set value must be a plain non-negative integer.
  it.each(["", "NaN", "Infinity", "-1", "1.5", "abc", "12abc", String(2 ** 53)])(
    "MOTEBIT_RESEARCH_CEILING_MICRO=%j refuses the boot",
    (raw) => {
      process.env["MOTEBIT_RESEARCH_CEILING_MICRO"] = raw;
      expect(() => loadConfig()).toThrow("MOTEBIT_RESEARCH_CEILING_MICRO");
    },
  );

  it("the ceiling keeps its $1 default when unset", () => {
    expect(loadConfig().ceilingMicro).toBe(1_000_000);
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

  it("invalid overrides refuse the boot — never silently a default, never NaN", () => {
    process.env["MOTEBIT_RESEARCH_LLM_RESERVE_MICRO"] = "-5";
    process.env["MOTEBIT_RESEARCH_MARGIN_BPS"] = "lots";
    const c = loadConfig();
    expect(paidSpendBudgetConfigError({ unitCostRaw: undefined, ...c })).toMatch(
      /MOTEBIT_RESEARCH_MARGIN_BPS/,
    );
    process.env["MOTEBIT_RESEARCH_MARGIN_BPS"] = "500";
    expect(paidSpendBudgetConfigError({ unitCostRaw: undefined, ...loadConfig() })).toMatch(
      /MOTEBIT_RESEARCH_LLM_RESERVE_MICRO/,
    );
  });

  it("a margin of 100% or more refuses the boot", () => {
    process.env["MOTEBIT_RESEARCH_MARGIN_BPS"] = "10000";
    expect(paidSpendBudgetConfigError({ unitCostRaw: undefined, ...loadConfig() })).toMatch(
      /MARGIN_BPS/,
    );
  });

  it("an empty reserve override means the derived default (the .env.example shape)", () => {
    process.env["MOTEBIT_RESEARCH_LLM_RESERVE_MICRO"] = "";
    const c = loadConfig();
    expect(c.llmReserveMicro).toBe(deriveLlmReserveMicro(8));
    expect(paidSpendBudgetConfigError({ unitCostRaw: undefined, ...c })).toBeNull();
  });

  it("a non-numeric MOTEBIT_MAX_TOOL_CALLS refuses the boot (it fed a NaN reserve)", () => {
    process.env["MOTEBIT_MAX_TOOL_CALLS"] = "many";
    expect(paidSpendBudgetConfigError({ unitCostRaw: undefined, ...loadConfig() })).toMatch(
      /MAX_TOOL_CALLS/,
    );
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

/**
 * Cold-review probes (three violations of THE invariant: per task, money that
 * LEFT the wallet for sub-hops ≤ the paid-spend budget). Each executes
 * research() against a stub seam that behaves like the runtime.
 */
describe("paid-spend budget — money that left the wallet is bounded", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  /** A market whose live hops PAY and then fail delivery (post-broadcast timeout). */
  function paidThenTimeoutMarket() {
    const state = { liveCalls: 0, outflow: 0 };
    const seam: PaidSubDelegate = async (p) => {
      const settlement = {
        mode: "p2p" as const,
        paidMicro: SEARCH_NET_MICRO,
        feeMicro: SEARCH_FEE_MICRO,
      };
      if (p.dryRun === true) return { ok: true, settlement };
      state.liveCalls++;
      state.outflow += SEARCH_OUTFLOW_MICRO;
      return {
        ok: false,
        code: "timeout",
        settledPayment: {
          txHash: `tx-${state.liveCalls}`,
          paidMicro: SEARCH_NET_MICRO,
          feeMicro: SEARCH_FEE_MICRO,
          taskId: `t-${state.liveCalls}`,
        },
      };
    };
    return { state, seam };
  }

  it("probe 1 (unbudgeted): 4 paid-then-timed-out hops are COUNTED — 210,528 out, 210,528 reported", async () => {
    const m = paidThenTimeoutMarket();
    modelWantsSearches(4);
    const result = await research("question", config({ paidSubDelegate: m.seam }));
    expect(m.state.outflow).toBe(4 * SEARCH_OUTFLOW_MICRO);
    expect(result.paid_spend_micro).toBe(m.state.outflow);
    expect(result.search_count).toBe(0); // paid, but nothing delivered
  });

  it("probe 1 (budgeted): a paid-then-timed-out hop draws on the budget — the next hop is skipped", async () => {
    const m = paidThenTimeoutMarket();
    modelWantsSearches(4);
    const result = await research(
      "question",
      config({ paidSubDelegate: m.seam, paidSpendBudgetMicro: DEFAULT_BUDGET }),
    );
    expect(m.state.liveCalls).toBe(1);
    expect(m.state.outflow).toBeLessThanOrEqual(DEFAULT_BUDGET);
    expect(result.paid_spend_micro).toBe(SEARCH_OUTFLOW_MICRO);
    expect(result.report).toBe(REPORT);
  });

  it("probe 1: an UNCONFIRMED payment and extra transactions count as money out", async () => {
    let live = 0;
    const seam: PaidSubDelegate = async (p) => {
      if (p.dryRun === true)
        return { ok: true, settlement: { mode: "p2p", paidMicro: 10_000, feeMicro: 527 } };
      live++;
      return {
        ok: false,
        code: "payment_status_unknown",
        unconfirmedPayment: { paidMicro: 10_000, feeMicro: 527 },
        extraPayments: [{ txHash: "x", status: "unconfirmed" }],
      };
    };
    modelWantsSearches(1);
    const result = await research("question", config({ paidSubDelegate: seam }));
    expect(live).toBe(1);
    expect(result.paid_spend_micro).toBe(2 * 10_527);
  });

  /**
   * The seam as the runtime behaves: the live call resolves its OWN worker /
   * price (here: the market repriced 50× since the quote) and refuses before
   * signing when that exceeds `maxTotalMicro`.
   */
  function repricingMarket() {
    const state = {
      outflow: 0,
      live: [] as Array<{ targetWorkerId?: string; maxTotalMicro?: number }>,
    };
    const seam: PaidSubDelegate = async (p) => {
      if (p.dryRun === true)
        return {
          ok: true,
          workerMotebitId: "cheap-worker",
          settlement: { mode: "p2p", paidMicro: 10_000, feeMicro: 527 },
        };
      state.live.push({ targetWorkerId: p.targetWorkerId, maxTotalMicro: p.maxTotalMicro });
      const resolved = 500_000 + 26_316; // 526,316
      if (p.maxTotalMicro != null && resolved > p.maxTotalMicro) {
        return { ok: false, code: "budget_exceeded" }; // refused pre-sign: nothing moved
      }
      state.outflow += resolved;
      return {
        ok: true,
        receipt: receipt(1),
        settlement: { mode: "p2p", paidMicro: 500_000, feeMicro: 26_316, txHash: "tx" },
      };
    };
    return { state, seam };
  }

  it("probe 2: a live price above the remaining budget is refused BEFORE money moves (quote 10,527, live 526,316)", async () => {
    const m = repricingMarket();
    modelWantsSearches(1);
    const result = await research(
      "question",
      config({ paidSubDelegate: m.seam, paidSpendBudgetMicro: DEFAULT_BUDGET }),
    );
    expect(m.state.outflow).toBe(0);
    expect(result.paid_spend_micro).toBe(0);
    // The live call carried the remaining budget as a hard ceiling, pinned to the quoted worker.
    expect(m.state.live).toEqual([
      { targetWorkerId: "cheap-worker", maxTotalMicro: DEFAULT_BUDGET },
    ]);
    expect(result.report).toBe(REPORT);
  });

  it("probe 2: the ceiling is the REMAINING budget, not the whole budget", async () => {
    const seen: Array<number | undefined> = [];
    const seam: PaidSubDelegate = async (p) => {
      const settlement = { mode: "p2p" as const, paidMicro: 20_000, feeMicro: 1_053 };
      if (p.dryRun === true) return { ok: true, settlement };
      seen.push(p.maxTotalMicro);
      return { ok: true, receipt: receipt(seen.length), settlement };
    };
    modelWantsSearches(2);
    await research(
      "question",
      config({ paidSubDelegate: seam, paidSpendBudgetMicro: DEFAULT_BUDGET }),
    );
    expect(seen).toEqual([DEFAULT_BUDGET, DEFAULT_BUDGET - 21_053]);
  });

  it("probe 2: a configured target keeps its pin (the quote never overrides the operator)", async () => {
    const m = repricingMarket();
    modelWantsSearches(1);
    await research(
      "question",
      config({
        paidSubDelegate: m.seam,
        paidSpendBudgetMicro: DEFAULT_BUDGET,
        webSearchTargetId: "web-search-agent",
      }),
    );
    expect(m.state.live[0]!.targetWorkerId).toBe("web-search-agent");
  });

  it("probe 3: a NaN budget is ZERO paid hops, never unbounded (MOTEBIT_UNIT_COST=abc)", async () => {
    const market = fakeMarket();
    modelWantsSearches(8);
    const result = await research(
      "question",
      config({ paidSubDelegate: market.seam, paidSpendBudgetMicro: Number.NaN }),
    );
    expect(market.state.liveCalls).toBe(0);
    expect(market.state.liveOutflow).toBe(0);
    expect(result.paid_spend_micro).toBe(0);
    expect(result.report).toBe(REPORT);
  });

  it("probe 3: the budget computation never yields NaN, and boot refuses a non-numeric unit cost", () => {
    expect(parseUnitCostMicro("abc")).toBeNull();
    expect(parseUnitCostMicro("-0.25")).toBeNull();
    expect(parseUnitCostMicro(undefined)).toBe(250_000);
    expect(parseUnitCostMicro("0.25")).toBe(250_000);
    expect(
      paidSpendBudgetConfigError({
        unitCostRaw: "abc",
        maxToolCalls: 8,
        marginBps: 500,
        llmReserveMicro: 171_300,
      }),
    ).toMatch(/MOTEBIT_UNIT_COST/);
    expect(
      computePaidSpendBudgetMicro({
        unitCostMicro: Number.NaN,
        marginBps: 500,
        llmReserveMicro: 0,
      }),
    ).toBe(0);
  });

  it("one response with more tool_uses than maxToolCalls dispatches at most maxToolCalls", async () => {
    const market = fakeMarket();
    mockCreate
      .mockResolvedValueOnce({
        content: Array.from({ length: 12 }, (_, i) => ({
          type: "tool_use",
          id: `tu-${i}`,
          name: "motebit_web_search",
          input: { query: `q${i}` },
        })),
      })
      .mockResolvedValue({ content: [{ type: "text", text: REPORT }] });
    const result = await research("question", config({ paidSubDelegate: market.seam }));
    expect(market.state.liveCalls).toBe(8);
    expect(result.search_count).toBe(8);
  });
});

describe("paid-spend budget — ledger and seam failures degrade conservatively", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockCreate.mockReset();
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  /** The tool_result blocks the model was shown, in order. */
  function toolResults(): Array<{ content: string; is_error?: boolean }> {
    return mockCreate.mock.calls
      .flatMap((c) => (c[0] as { messages: Array<{ content: unknown }> }).messages)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b: { type?: string }) => b.type === "tool_result") as Array<{
      content: string;
      is_error?: boolean;
    }>;
  }

  it("a ledger whose reserve throws (a non-Error) reserves nothing: the hop is skipped, never paid", async () => {
    const market = fakeMarket();
    modelWantsSearches(1);
    const ledger: TaskSpend = {
      reserve: () => {
        throw "ledger unreadable"; // eslint-disable-line @typescript-eslint/only-throw-error
      },
      settle: () => {},
      committedMicro: () => 0,
    };
    const result = await research(
      "question",
      config({
        paidSubDelegate: market.seam,
        paidSpendBudgetMicro: DEFAULT_BUDGET,
        paidSpendLedger: ledger,
      }),
    );
    expect(market.state.quotes).toBe(1);
    expect(market.state.liveCalls).toBe(0);
    expect(result.paid_spend_micro).toBe(0);
    expect(logs.some((l) => l.includes("spend ledger reserve FAILED: ledger unreadable"))).toBe(
      true,
    );
    expect(toolResults()[0]!.content).toMatch(/paid-call budget is exhausted/);
    expect(result.report).toBe(REPORT);
  });

  it("a ledger whose settle throws keeps the hold charged in full: the next hop is skipped", async () => {
    const market = fakeMarket();
    modelWantsSearches(2);
    const inner = memoryTaskSpend();
    const ledger: TaskSpend = {
      reserve: (b, m) => inner.reserve(b, m),
      settle: () => {
        throw new Error("ledger write failed");
      },
      committedMicro: () => inner.committedMicro(),
    };
    const result = await research(
      "question",
      config({
        paidSubDelegate: market.seam,
        paidSpendBudgetMicro: DEFAULT_BUDGET,
        paidSpendLedger: ledger,
      }),
    );
    // The first hop was paid and delivered; its unsettled hold still holds the
    // whole remainder, so the second hop finds no budget left.
    expect(market.state.liveCalls).toBe(1);
    expect(result.search_count).toBe(1);
    expect(result.paid_spend_micro).toBe(SEARCH_OUTFLOW_MICRO);
    expect(inner.committedMicro()).toBe(DEFAULT_BUDGET);
    expect(logs.some((l) => l.includes("spend ledger settle FAILED: ledger write failed"))).toBe(
      true,
    );
    expect(toolResults().at(-1)!.content).toMatch(/paid-call budget is exhausted/);
  });

  it("unbudgeted: a settle that throws a non-Error never breaks the hop, and spend is still reported", async () => {
    const market = fakeMarket();
    modelWantsSearches(2);
    const ledger: TaskSpend = {
      reserve: () => null,
      settle: () => {
        throw "settle refused"; // eslint-disable-line @typescript-eslint/only-throw-error
      },
      committedMicro: () => 0,
    };
    const result = await research(
      "question",
      config({ paidSubDelegate: market.seam, paidSpendLedger: ledger }),
    );
    expect(market.state.liveCalls).toBe(2);
    expect(result.search_count).toBe(2);
    expect(result.paid_spend_micro).toBe(2 * SEARCH_OUTFLOW_MICRO);
    expect(
      logs.filter((l) => l.includes("spend ledger settle FAILED: settle refused")),
    ).toHaveLength(2);
  });

  it("unbudgeted, unreadable ledger: a paid-then-failed hop with no code reports this run's own spend", async () => {
    modelWantsSearches(1);
    const seam: PaidSubDelegate = async () => ({
      ok: false,
      settledPayment: {
        txHash: "tx-1",
        paidMicro: SEARCH_NET_MICRO,
        feeMicro: SEARCH_FEE_MICRO,
        taskId: "t-1",
      },
    });
    const inner = memoryTaskSpend();
    const ledger: TaskSpend = {
      reserve: (b, m) => inner.reserve(b, m),
      settle: (h, a) => inner.settle(h, a),
      committedMicro: () => {
        throw new Error("ledger unreadable");
      },
    };
    const result = await research(
      "question",
      config({ paidSubDelegate: seam, paidSpendLedger: ledger }),
    );
    // No budget to fall back on: the committed figure is this run's own outflow,
    // and the log carries no "/budget" suffix.
    const line = logs.find((l) => l.includes("paid-then-FAILED"));
    expect(line).toContain(
      `code=unknown moved=${SEARCH_OUTFLOW_MICRO} spent=${SEARCH_OUTFLOW_MICRO}`,
    );
    expect(line).not.toMatch(/spent=\d+\//);
    expect(toolResults()[0]).toEqual(
      expect.objectContaining({
        content: "paid delegation to motebit_web_search was paid but did not deliver (unknown)",
        is_error: true,
      }),
    );
    expect(result.paid_spend_micro).toBe(SEARCH_OUTFLOW_MICRO);
    expect(inner.committedMicro()).toBe(SEARCH_OUTFLOW_MICRO);
  });

  it("unbudgeted: a live hop refused budget_exceeded before money moved reports no remaining ceiling", async () => {
    modelWantsSearches(1);
    const seam: PaidSubDelegate = async () => ({ ok: false, code: "budget_exceeded" });
    const result = await research("question", config({ paidSubDelegate: seam }));
    expect(
      logs.some((l) => l.includes("BUDGET REFUSED pre-sign") && l.includes("remaining=unbudgeted")),
    ).toBe(true);
    expect(toolResults()[0]!.content).toMatch(/price exceeds what remains/);
    expect(result.paid_spend_micro).toBe(0);
  });

  it("unbudgeted: a live seam that throws charges nothing it cannot attribute and propagates", async () => {
    modelWantsSearches(1);
    const seam: PaidSubDelegate = async () => {
      throw new Error("transport exploded");
    };
    const settle = vi.fn();
    const ledger: TaskSpend = { reserve: () => null, settle, committedMicro: () => 0 };
    await expect(
      research("question", config({ paidSubDelegate: seam, paidSpendLedger: ledger })),
    ).rejects.toThrow("transport exploded");
    // No hold was taken and no amount is known: nothing is written to the ledger.
    expect(settle).not.toHaveBeenCalled();
  });

  it("a unit cost too large for an exact integer micro amount refuses the boot", () => {
    // 1e11 USD ⇒ 1e17 micro, past Number.MAX_SAFE_INTEGER: not representable exactly.
    expect(parseUnitCostMicro("100000000000")).toBeNull();
    expect(
      paidSpendBudgetConfigError({
        unitCostRaw: "100000000000",
        maxToolCalls: 8,
        marginBps: 500,
        llmReserveMicro: 171_300,
      }),
    ).toMatch(/MOTEBIT_UNIT_COST/);
  });
});
