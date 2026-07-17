import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

// Capture constructor args for the default McpClientAdapter factory — lets us
// verify that when no adapterFactory is injected, research wires up real
// McpClientAdapter instances with the caller's motebit identity.
const mcpConstructorCalls: Array<Record<string, unknown>> = [];
vi.mock("@motebit/mcp-client", () => ({
  McpClientAdapter: class MockMcpClientAdapter {
    constructor(config: Record<string, unknown>) {
      mcpConstructorCalls.push(config);
    }
    async connect() {}
    async disconnect() {}
    async executeTool() {
      return { ok: true };
    }
    getAndResetDelegationReceipts() {
      return [];
    }
  },
}));

import type { AdapterFactory, AtomAdapter, ResearchConfig, SignedReceipt } from "../research.js";
import { research } from "../research.js";

/**
 * In-memory AtomAdapter — the injectable test seam. Mirrors
 * `McpClientAdapter`'s contract: connect/disconnect lifecycle, `executeTool`
 * pretends to run a motebit_task and queues a receipt for the next drain.
 *
 * By substituting this for the real adapter, we exercise the research turn's
 * citation-accumulation logic without spinning up an MCP server — the
 * receipt-capture primitive itself is covered by mcp-client's own tests.
 */
class StubAtomAdapter implements AtomAdapter {
  private pending: SignedReceipt[] = [];
  public connected = 0;
  public disconnected = 0;
  public calls: { qualified: string; args: Record<string, unknown> }[] = [];

  constructor(private readonly queue: SignedReceipt[]) {}

  async connect(): Promise<void> {
    this.connected++;
  }

  async disconnect(): Promise<void> {
    this.disconnected++;
  }

  async executeTool(qualified: string, args: Record<string, unknown>) {
    this.calls.push({ qualified, args });
    if (this.queue.length > 0) {
      const receipt = this.queue.shift()!;
      this.pending.push(receipt);
      return { ok: true, data: JSON.stringify(receipt) };
    }
    return { ok: false, error: "no receipt queued" };
  }

  getAndResetDelegationReceipts(): SignedReceipt[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

function makeFactory(byAtom: Map<string, StubAtomAdapter>): AdapterFactory {
  return ({ name }) => {
    const a = byAtom.get(name);
    if (a == null) throw new Error(`no stub adapter registered for ${name}`);
    return a;
  };
}

function makeReceipt(
  overrides: Partial<SignedReceipt> & { result: unknown; signature: string },
): SignedReceipt {
  return {
    task_id: "task-stub",
    motebit_id: "atom-stub",
    device_id: "device-stub",
    submitted_at: 0,
    completed_at: Date.now(),
    status: "completed",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "",
    result_hash: "",
    ...overrides,
  } as SignedReceipt;
}

const baseConfig: ResearchConfig = {
  anthropicApiKey: "sk-ant-test",
  webSearchUrl: "http://web-search.test/mcp",
  readUrlUrl: "http://read-url.test/mcp",
  callerMotebitId: "motebit-research",
  callerDeviceId: "research-service",
  callerPrivateKey: new Uint8Array(32),
  maxToolCalls: 8,
};

describe("research — cryptographic citation chain (via mcp-client)", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("connects and disconnects both atom adapters even on early return", async () => {
    const ws = new StubAtomAdapter([]);
    const ru = new StubAtomAdapter([]);
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Direct answer, no tools needed." }],
    });

    const result = await research("2+2?", {
      ...baseConfig,
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
    });

    expect(result.report).toBe("Direct answer, no tools needed.");
    expect(result.delegation_receipts).toEqual([]);
    expect(ws.connected).toBe(1);
    expect(ws.disconnected).toBe(1);
    expect(ru.connected).toBe(1);
    expect(ru.disconnected).toBe(1);
  });

  it("chains a single search receipt into delegation_receipts", async () => {
    const receipt = makeReceipt({
      task_id: "search-1",
      motebit_id: "web-search-agent",
      result: JSON.stringify([{ title: "R", url: "https://a.example.com" }]),
      signature: "sig-search-1",
    });
    const ws = new StubAtomAdapter([receipt]);
    const ru = new StubAtomAdapter([]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Synthesized." }] });

    const result = await research("question", {
      ...baseConfig,
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
    });

    expect(result.search_count).toBe(1);
    expect(result.fetch_count).toBe(0);
    expect(result.delegation_receipts).toHaveLength(1);
    expect(result.delegation_receipts[0]!.signature).toBe("sig-search-1");
    expect(ws.calls[0]).toMatchObject({
      qualified: "web-search__motebit_task",
      args: { prompt: "q" },
    });
  });

  // === Inc 2b: paid sub-delegation (priced atom → P2P, unpriced → direct) ===

  it("Inc 2b: a priced atom is paid via paidSubDelegate; its receipt chains, the direct adapter is NOT called", async () => {
    const paidReceipt = makeReceipt({
      task_id: "paid-search-1",
      motebit_id: "web-search-agent",
      result: JSON.stringify([{ title: "R", url: "https://a.example.com" }]),
      signature: "sig-paid-1",
    });
    const ws = new StubAtomAdapter([]); // direct path must NOT be taken
    const ru = new StubAtomAdapter([]);
    const paidCalls: Array<{ capability: string; targetWorkerId?: string }> = [];

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Synthesized." }] });

    const result = await research("question", {
      ...baseConfig,
      webSearchTargetId: "web-search-agent",
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
      paidSubDelegate: async (p) => {
        paidCalls.push({ capability: p.capability, targetWorkerId: p.targetWorkerId });
        return {
          ok: true,
          receipt: paidReceipt,
          settlement: { mode: "p2p", txHash: "tx-abc", paidMicro: 2000, feeMicro: 100 },
        };
      },
    });

    expect(result.search_count).toBe(1);
    expect(result.delegation_receipts).toHaveLength(1);
    expect(result.delegation_receipts[0]!.signature).toBe("sig-paid-1");
    // The paid seam was used, pinning the atom by motebit_id + capability.
    expect(paidCalls).toEqual([{ capability: "web_search", targetWorkerId: "web-search-agent" }]);
    // The free direct-MCP path was NOT taken.
    expect(ws.calls).toHaveLength(0);
    // Self-attested money fact: the molecule records the paid hop (mode + onchain
    // tx + amounts, linked to the atom receipt) so its P2P claim is verifiable.
    expect(result.sub_settlements).toEqual([
      {
        capability: "web_search",
        task_id: "paid-search-1",
        mode: "p2p",
        tx_hash: "tx-abc",
        paid_micro: 2000,
        fee_micro: 100,
      },
    ]);
  });

  it("Inc 3: UNPINNED — a priced atom is still paid, WITHOUT a target (the runtime ranks the market)", async () => {
    const paidReceipt = makeReceipt({
      task_id: "paid-search-2",
      motebit_id: "ranked-agent",
      result: JSON.stringify([{ title: "R", url: "https://a.example.com" }]),
      signature: "sig-paid-2",
    });
    const ws = new StubAtomAdapter([]);
    const ru = new StubAtomAdapter([]);
    const paidCalls: Array<{ capability: string; targetWorkerId?: string }> = [];

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Synthesized." }] });

    const result = await research("question", {
      ...baseConfig,
      // NO webSearchTargetId — unpinned: the paid seam is still attempted, and the
      // runtime's first-person ranker chooses among discovered providers.
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
      paidSubDelegate: async (p) => {
        paidCalls.push({ capability: p.capability, targetWorkerId: p.targetWorkerId });
        return { ok: true, receipt: paidReceipt, settlement: { mode: "p2p", txHash: "tx-ranked" } };
      },
    });

    expect(result.delegation_receipts).toHaveLength(1);
    expect(result.delegation_receipts[0]!.signature).toBe("sig-paid-2");
    // The paid seam ran with NO pinned target — the market ranks.
    expect(paidCalls).toHaveLength(1);
    expect(paidCalls[0]!.capability).toBe("web_search");
    expect(paidCalls[0]!.targetWorkerId).toBeUndefined();
    expect(ws.calls).toHaveLength(0);
    // A P2P hop with an onchain tx is self-attested even when unpinned — this is
    // exactly the fact conformance asserts to prove the market settled.
    expect(result.sub_settlements).toEqual([
      { capability: "web_search", task_id: "paid-search-2", mode: "p2p", tx_hash: "tx-ranked" },
    ]);
  });

  it("records a relay-mode sub-hop with only the fields present (no onchain tx) — it does NOT count as a p2p hop", async () => {
    // A paid hop that settled via the relay ledger carries `mode: "relay"` and no
    // onchain facts; a receipt may also lack a task_id. The molecule records the
    // minimal fact truthfully (every optional field omitted when absent), and the
    // conformance filter (mode==="p2p" && tx_hash) correctly excludes it.
    const relayReceipt = makeReceipt({
      task_id: undefined as unknown as string,
      motebit_id: "relay-settled-agent",
      result: JSON.stringify([{ title: "R", url: "https://a.example.com" }]),
      signature: "sig-relay-1",
    });
    const ws = new StubAtomAdapter([]);
    const ru = new StubAtomAdapter([]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Synthesized." }] });

    const result = await research("question", {
      ...baseConfig,
      webSearchTargetId: "relay-settled-agent",
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
      paidSubDelegate: async () => ({
        ok: true,
        receipt: relayReceipt,
        settlement: { mode: "relay" },
      }),
    });

    // Minimal fact: mode only, no task_id / tx_hash / amounts (all omitted, not null).
    expect(result.sub_settlements).toEqual([{ capability: "web_search", mode: "relay" }]);
  });

  it("a paid hop that reports no settlement chains its receipt but records no sub-settlement", async () => {
    // Backward-compat: a spend handle that returns ok+receipt but omits the
    // settlement fact. The receipt still chains; sub_settlements stays empty (a
    // missing fact is never fabricated into a p2p claim).
    const paidReceipt = makeReceipt({
      task_id: "paid-nofact-1",
      motebit_id: "web-search-agent",
      result: JSON.stringify([{ title: "R", url: "https://a.example.com" }]),
      signature: "sig-nofact-1",
    });
    const ws = new StubAtomAdapter([]);
    const ru = new StubAtomAdapter([]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Synthesized." }] });

    const result = await research("question", {
      ...baseConfig,
      webSearchTargetId: "web-search-agent",
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
      paidSubDelegate: async () => ({ ok: true, receipt: paidReceipt }),
    });

    expect(result.delegation_receipts).toHaveLength(1);
    expect(result.delegation_receipts[0]!.signature).toBe("sig-nofact-1");
    expect(result.sub_settlements).toEqual([]);
  });

  it("Inc 2b: an unpriced atom (worker_not_payable) falls back to the direct MCP call", async () => {
    const directReceipt = makeReceipt({
      task_id: "direct-1",
      motebit_id: "web-search-agent",
      result: JSON.stringify([{ title: "R", url: "https://a.example.com" }]),
      signature: "sig-direct-1",
    });
    const ws = new StubAtomAdapter([directReceipt]);
    const ru = new StubAtomAdapter([]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Synthesized." }] });

    const result = await research("question", {
      ...baseConfig,
      webSearchTargetId: "web-search-agent",
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
      paidSubDelegate: async () => ({ ok: false, code: "worker_not_payable" }),
    });

    expect(result.search_count).toBe(1);
    expect(result.delegation_receipts[0]!.signature).toBe("sig-direct-1");
    // Fell back to the direct adapter (the atom is free).
    expect(ws.calls).toHaveLength(1);
    // The negative case the conformance guardrail catches: external atom work
    // happened (search_count=1) but NOTHING settled P2P. `sub_settlements` is
    // empty — so a molecule that regressed to free direct-MCP for a PRICED atom
    // would be detectable, not silently green. (Here the atom is genuinely free.)
    expect(result.sub_settlements).toEqual([]);
  });

  it("Inc 2b: a real payment failure (money_meter_denied) errors the tool and does NOT do the work for free", async () => {
    const ws = new StubAtomAdapter([makeReceipt({ result: "x", signature: "s" })]); // must NOT be used
    const ru = new StubAtomAdapter([]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Gave up." }] });

    const result = await research("question", {
      ...baseConfig,
      webSearchTargetId: "web-search-agent",
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
      paidSubDelegate: async () => ({ ok: false, code: "money_meter_denied" }),
    });

    // No free work: the direct adapter was never called, no receipt chained.
    expect(ws.calls).toHaveLength(0);
    expect(result.delegation_receipts).toHaveLength(0);
    expect(result.search_count).toBe(0);
  });

  it("Inc 2b: a paid failure with NO code is treated as a real failure (unknown), not a fallback", async () => {
    const ws = new StubAtomAdapter([makeReceipt({ result: "x", signature: "s" })]); // must NOT be used
    const ru = new StubAtomAdapter([]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Gave up." }] });

    const result = await research("question", {
      ...baseConfig,
      webSearchTargetId: "web-search-agent",
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
      paidSubDelegate: async () => ({ ok: false }), // no code ⇒ unknown ⇒ real failure
    });

    expect(ws.calls).toHaveLength(0);
    expect(result.delegation_receipts).toHaveLength(0);
    expect(result.search_count).toBe(0);
  });

  it("Inc 2b: a paid ok WITHOUT a receipt errors the tool (defensive — never chain a phantom edge)", async () => {
    const ws = new StubAtomAdapter([makeReceipt({ result: "x", signature: "s" })]); // must NOT be used
    const ru = new StubAtomAdapter([]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Gave up." }] });

    const result = await research("question", {
      ...baseConfig,
      webSearchTargetId: "web-search-agent",
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
      paidSubDelegate: async () => ({ ok: true }), // ok but no receipt
    });

    expect(ws.calls).toHaveLength(0);
    expect(result.delegation_receipts).toHaveLength(0);
    expect(result.search_count).toBe(0);
  });

  it("chains a single fetch receipt", async () => {
    const receipt = makeReceipt({
      task_id: "fetch-1",
      motebit_id: "read-url-agent",
      result: "Page contents.",
      signature: "sig-fetch-1",
    });
    const ws = new StubAtomAdapter([]);
    const ru = new StubAtomAdapter([receipt]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "motebit_read_url",
            input: { url: "https://a.example.com" },
          },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Read." }] });

    const result = await research("read this", {
      ...baseConfig,
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
    });

    expect(result.fetch_count).toBe(1);
    expect(result.delegation_receipts[0]!.signature).toBe("sig-fetch-1");
    expect(ru.calls[0]).toMatchObject({
      qualified: "read-url__motebit_task",
      args: { prompt: "https://a.example.com" },
    });
  });

  it("composes multiple hops into an ordered receipt chain", async () => {
    const s1 = makeReceipt({ task_id: "s1", result: "[]", signature: "sig-s1" });
    const s2 = makeReceipt({ task_id: "s2", result: "[]", signature: "sig-s2" });
    const f1 = makeReceipt({ task_id: "f1", result: "page A", signature: "sig-f1" });
    const ws = new StubAtomAdapter([s1, s2]);
    const ru = new StubAtomAdapter([f1]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "1" } },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "motebit_read_url",
            input: { url: "https://a.com" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-3", name: "motebit_web_search", input: { query: "2" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Final." }] });

    const result = await research("multi", {
      ...baseConfig,
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
    });

    expect(result.search_count).toBe(2);
    expect(result.fetch_count).toBe(1);
    expect(result.delegation_receipts.map((r) => r.signature)).toEqual([
      "sig-s1",
      "sig-f1",
      "sig-s2",
    ]);
  });

  it("signals failure and continues when adapter returns ok:false", async () => {
    const ws = new StubAtomAdapter([]);
    const ru = new StubAtomAdapter([]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Synthesized anyway." }] });

    const result = await research("q", {
      ...baseConfig,
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
    });

    expect(result.search_count).toBe(0);
    expect(result.delegation_receipts).toEqual([]);
    const secondCall = mockCreate.mock.calls[1]![0] as {
      messages: { role: string; content: unknown }[];
    };
    const tr = (
      secondCall.messages[secondCall.messages.length - 1]!.content as Array<{ is_error?: boolean }>
    )[0]!;
    expect(tr.is_error).toBe(true);
  });

  it("fails dispatch when adapter returns ok but no receipt captured", async () => {
    class NoReceiptAdapter implements AtomAdapter {
      async connect() {}
      async disconnect() {}
      async executeTool() {
        return { ok: true, data: "some non-receipt result" };
      }
      getAndResetDelegationReceipts() {
        return [];
      }
    }

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

    const result = await research("q", {
      ...baseConfig,
      adapterFactory: () => new NoReceiptAdapter(),
    });

    expect(result.delegation_receipts).toEqual([]);
    expect(result.search_count).toBe(0);
    const secondCall = mockCreate.mock.calls[1]![0] as {
      messages: { role: string; content: unknown }[];
    };
    const tr = (
      secondCall.messages[secondCall.messages.length - 1]!.content as Array<{ is_error?: boolean }>
    )[0]!;
    expect(tr.is_error).toBe(true);
  });

  it("rejects unknown tool names with is_error", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tu-1", name: "motebit_make_coffee", input: {} }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Sorry." }] });

    const result = await research("bogus", {
      ...baseConfig,
      adapterFactory: () => new StubAtomAdapter([]),
    });

    expect(result.delegation_receipts).toEqual([]);
    const secondCall = mockCreate.mock.calls[1]![0] as {
      messages: { role: string; content: unknown }[];
    };
    const tr = (
      secondCall.messages[secondCall.messages.length - 1]!.content as Array<{
        is_error?: boolean;
        content: string;
      }>
    )[0]!;
    expect(tr.is_error).toBe(true);
    expect(tr.content).toContain("unknown tool");
  });

  it("respects maxToolCalls — forces final synthesis when exhausted", async () => {
    const r1 = makeReceipt({ task_id: "s1", result: "[]", signature: "sig-r1" });
    const r2 = makeReceipt({ task_id: "s2", result: "[]", signature: "sig-r2" });
    const ws = new StubAtomAdapter([r1, r2]);
    const ru = new StubAtomAdapter([]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "1" } },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-2", name: "motebit_web_search", input: { query: "2" } },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Forced synthesis after budget exhausted." }],
      });

    const result = await research("greedy", {
      ...baseConfig,
      maxToolCalls: 2,
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
    });

    expect(result.search_count).toBe(2);
    expect(result.report).toContain("Forced synthesis");
    const finalCall = mockCreate.mock.calls[2]![0] as { system: string };
    expect(finalCall.system).toContain("tool budget exhausted");
  });

  it("declares the three-tier tool set (interior + web search + web fetch) to Claude", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
    await research("anything", {
      ...baseConfig,
      adapterFactory: () => new StubAtomAdapter([]),
    });
    const call = mockCreate.mock.calls[0]![0] as { tools: Array<{ name: string }>; system: string };
    expect(call.tools.map((t) => t.name).sort()).toEqual([
      "motebit_read_url",
      "motebit_recall_self",
      "motebit_web_search",
    ]);
    // Interior-first guidance must be visible in the system prompt.
    expect(call.system).toContain("motebit_recall_self");
    expect(call.system).toContain("motebit_web_search");
    expect(call.system).toContain("motebit_read_url");
    expect(call.system).toContain("FIRST");
  });

  // ── Interior tier (Ring 1: recall_self) ──

  it("recall_self runs locally with no adapter call and emits interior-source citations", async () => {
    const ws = new StubAtomAdapter([]);
    const ru = new StubAtomAdapter([]);
    mockCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu-interior",
            name: "motebit_recall_self",
            input: { query: "what is motebit", limit: 2 },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Synthesized from interior knowledge." }],
      });

    const result = await research("tell me about Motebit", {
      ...baseConfig,
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
    });

    // No web atom was touched — interior runs in-process.
    expect(ws.calls).toHaveLength(0);
    expect(ru.calls).toHaveLength(0);
    // Counters reflect the tier actually used.
    expect(result.recall_self_count).toBe(1);
    expect(result.search_count).toBe(0);
    expect(result.fetch_count).toBe(0);
    // No signed receipts — interior tier is self-attested via corpus hash.
    expect(result.delegation_receipts).toEqual([]);
    // Citations are populated with source:"interior" and no receipt_task_id.
    expect(result.citations.length).toBeGreaterThan(0);
    for (const c of result.citations) {
      expect(c.source).toBe("interior");
      expect(c.receipt_task_id).toBeUndefined();
      expect(c.locator).toMatch(/\.md#/);
    }
  });

  it("treats recall_self with missing query as an empty-query miss (no crash)", async () => {
    // The self-knowledge tool schema makes `query` required, but Claude
    // occasionally emits tool_use blocks with missing fields. The dispatcher
    // must coerce a missing query to "" and run the normal miss branch —
    // never throw, never silently drop the tool call.
    const ws = new StubAtomAdapter([]);
    const ru = new StubAtomAdapter([]);
    mockCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu-no-query",
            name: "motebit_recall_self",
            input: {}, // no query, no limit
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
      });

    const result = await research("tell me something", {
      ...baseConfig,
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
    });

    expect(result.recall_self_count).toBe(1);
    expect(ws.calls).toHaveLength(0);
    expect(ru.calls).toHaveLength(0);
  });

  it("falls through to web after an interior miss", async () => {
    const ws = new StubAtomAdapter([
      makeReceipt({
        task_id: "search-after-miss",
        motebit_id: "web-search-agent",
        result: JSON.stringify([{ title: "External", url: "https://example.com" }]),
        signature: "sig-after-miss",
      }),
    ]);
    const ru = new StubAtomAdapter([]);

    // Claude tries recall_self on an exotic query (will miss), then falls
    // through to web_search, then synthesizes.
    mockCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "motebit_recall_self",
            input: { query: "zeolite catalysts" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "motebit_web_search",
            input: { query: "zeolite catalysts" },
          },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Synthesized from web." }] });

    const result = await research("what are zeolite catalysts", {
      ...baseConfig,
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
    });

    expect(result.recall_self_count).toBe(1);
    expect(result.search_count).toBe(1);
    expect(result.delegation_receipts).toHaveLength(1);
    expect(result.delegation_receipts[0]!.signature).toBe("sig-after-miss");
    // Interior miss → no interior citations; bare web_search hits don't
    // produce citations either (only read_url does, per the citation policy).
    expect(result.citations).toEqual([]);
  });

  it("propagates Anthropic errors (adapters still disconnect)", async () => {
    const ws = new StubAtomAdapter([]);
    const ru = new StubAtomAdapter([]);
    mockCreate.mockRejectedValue(new Error("rate_limit_exceeded"));

    await expect(
      research("q", {
        ...baseConfig,
        adapterFactory: makeFactory(
          new Map([
            ["web-search", ws],
            ["read-url", ru],
          ]),
        ),
      }),
    ).rejects.toThrow("rate_limit_exceeded");

    expect(ws.disconnected).toBe(1);
    expect(ru.disconnected).toBe(1);
  });

  // ── Receipt content edge cases ──

  it("falls back to empty prompt when Claude omits query/url args", async () => {
    const ws = new StubAtomAdapter([]);
    const ru = new StubAtomAdapter([]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: {} },
          { type: "tool_use", id: "tu-2", name: "motebit_read_url", input: {} },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

    const result = await research("q", {
      ...baseConfig,
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
    });

    expect(result.delegation_receipts).toEqual([]);
    expect(ws.calls[0]!.args.prompt).toBe("");
    expect(ru.calls[0]!.args.prompt).toBe("");
  });

  it("stringifies non-string receipt.result before passing to Claude", async () => {
    // Cast through unknown — ExecutionReceipt.result is typed as string but
    // atom services may return structured payloads; the dispatcher stringifies.
    const receiptWithObject = makeReceipt({
      result: { items: [{ id: 1, name: "structured" }] } as unknown as string,
      signature: "sig-obj",
    });
    const ws = new StubAtomAdapter([receiptWithObject]);
    const ru = new StubAtomAdapter([]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

    await research("q", {
      ...baseConfig,
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
    });
    const secondCall = mockCreate.mock.calls[1]![0] as {
      messages: { role: string; content: unknown }[];
    };
    const tr = (
      secondCall.messages[secondCall.messages.length - 1]!.content as Array<{ content: string }>
    )[0]!;
    expect(typeof tr.content).toBe("string");
    expect(tr.content).toContain("structured");
  });

  it("handles receipt with null/missing result via ?? null fallback", async () => {
    const noResult = {
      task_id: "t-empty",
      motebit_id: "atom-stub",
      device_id: "d",
      submitted_at: 0,
      completed_at: Date.now(),
      status: "completed",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "",
      result_hash: "",
      signature: "sig-empty",
    } as unknown as SignedReceipt;
    const ws = new StubAtomAdapter([noResult]);
    const ru = new StubAtomAdapter([]);

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

    const result = await research("q", {
      ...baseConfig,
      adapterFactory: makeFactory(
        new Map([
          ["web-search", ws],
          ["read-url", ru],
        ]),
      ),
    });
    expect(result.delegation_receipts).toHaveLength(1);
    const secondCall = mockCreate.mock.calls[1]![0] as {
      messages: { role: string; content: unknown }[];
    };
    const tr = (
      secondCall.messages[secondCall.messages.length - 1]!.content as Array<{ content: string }>
    )[0]!;
    expect(tr.content).toBe("null");
  });

  // ── Optional relay budget binding (research-specific) ──

  it("opens a relay task + forwards relay_task_id when relay configured", async () => {
    const receipt = makeReceipt({ result: "[]", signature: "sig-r1" });
    const ws = new StubAtomAdapter([receipt]);
    const ru = new StubAtomAdapter([]);
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => {
        return new Response(JSON.stringify({ task_id: "relay-task-xyz" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      mockCreate
        .mockResolvedValueOnce({
          content: [
            { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
          ],
        })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

      await research("q", {
        ...baseConfig,
        syncUrl: "http://relay.test",
        apiToken: "tok",
        webSearchTargetId: "ws-mote",
        adapterFactory: makeFactory(
          new Map([
            ["web-search", ws],
            ["read-url", ru],
          ]),
        ),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("http://relay.test/agent/ws-mote/task");
    const body = JSON.parse(call[1]!.body as string);
    expect(body.required_capabilities).toEqual(["web_search"]);
    expect(ws.calls[0]!.args.relay_task_id).toBe("relay-task-xyz");
  });

  it("survives relay-binding non-OK status (no relay_task_id forwarded)", async () => {
    const receipt = makeReceipt({ result: "[]", signature: "sig-r1" });
    const ws = new StubAtomAdapter([receipt]);
    const ru = new StubAtomAdapter([]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("rate limited", { status: 429 }),
    ) as unknown as typeof fetch;

    try {
      mockCreate
        .mockResolvedValueOnce({
          content: [
            { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
          ],
        })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

      const result = await research("q", {
        ...baseConfig,
        syncUrl: "http://relay.test",
        apiToken: "tok",
        webSearchTargetId: "ws-mote",
        adapterFactory: makeFactory(
          new Map([
            ["web-search", ws],
            ["read-url", ru],
          ]),
        ),
      });
      expect(result.delegation_receipts).toHaveLength(1);
      expect(ws.calls[0]!.args.relay_task_id).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("survives relay-binding throw (catch swallows)", async () => {
    const receipt = makeReceipt({ result: "[]", signature: "sig-r1" });
    const ws = new StubAtomAdapter([receipt]);
    const ru = new StubAtomAdapter([]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network blip");
    }) as unknown as typeof fetch;

    try {
      mockCreate
        .mockResolvedValueOnce({
          content: [
            { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
          ],
        })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

      const result = await research("q", {
        ...baseConfig,
        syncUrl: "http://relay.test",
        apiToken: "tok",
        webSearchTargetId: "ws-mote",
        adapterFactory: makeFactory(
          new Map([
            ["web-search", ws],
            ["read-url", ru],
          ]),
        ),
      });
      expect(result.delegation_receipts).toHaveLength(1);
      expect(ws.calls[0]!.args.relay_task_id).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── Default adapter wiring ──

  it("default factory constructs McpClientAdapter with motebit identity for both atoms", async () => {
    mcpConstructorCalls.length = 0;
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "direct" }],
    });

    // No adapterFactory — exercise the defaultAdapterFactory
    await research("q", baseConfig);

    expect(mcpConstructorCalls).toHaveLength(2);
    const names = mcpConstructorCalls.map((c) => c.name).sort();
    expect(names).toEqual(["read-url", "web-search"]);
    for (const c of mcpConstructorCalls) {
      expect(c.transport).toBe("http");
      expect(c.motebit).toBe(true);
      expect(c.motebitType).toBe("service");
      expect(c.callerMotebitId).toBe(baseConfig.callerMotebitId);
      expect(c.callerDeviceId).toBe(baseConfig.callerDeviceId);
      expect(c.callerPrivateKey).toBe(baseConfig.callerPrivateKey);
    }
    // URLs route to their atoms
    const byName = new Map(mcpConstructorCalls.map((c) => [c.name as string, c]));
    expect(byName.get("web-search")!.url).toBe(baseConfig.webSearchUrl);
    expect(byName.get("read-url")!.url).toBe(baseConfig.readUrlUrl);
  });

  it("does not touch fetch when relay binding is not configured", async () => {
    const receipt = makeReceipt({ result: "[]", signature: "sig-r1" });
    const ws = new StubAtomAdapter([receipt]);
    const ru = new StubAtomAdapter([]);
    const fetchMock = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      mockCreate
        .mockResolvedValueOnce({
          content: [
            { type: "tool_use", id: "tu-1", name: "motebit_web_search", input: { query: "q" } },
          ],
        })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

      await research("q", {
        ...baseConfig,
        adapterFactory: makeFactory(
          new Map([
            ["web-search", ws],
            ["read-url", ru],
          ]),
        ),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
