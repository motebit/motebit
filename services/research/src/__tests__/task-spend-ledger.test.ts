/**
 * The paid-spend budget bounds the ADMITTED TASK, not one run of it.
 *
 * One admission admits one COMPLETED execution, and a run that timed out is
 * re-presentable by the delegator's honest retry (task-admission.md). Before
 * this ledger the budget lived in `research()`'s closure: on the MCP
 * surface's task timeout the slot was freed while the timed-out run kept
 * paying, and the retry under the same dispatch token started a second run
 * with a FRESH budget — two runs of one paid task paid 105,264 micro against
 * a 66,200 budget; N timeouts ⇒ N budgets.
 *
 * Invariant: per admitted relay task id (the dispatch token's `sub`), the
 * sub-hop money that leaves the wallet across ALL runs of the task — a
 * concurrent zombie and its retry included — is ≤ the paid-spend budget.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

// The real McpServerAdapter, with the MCP SDK's transport surface captured so
// the `motebit_task` handler is driven directly (the admission + timeout path
// under test is the adapter's own code, not the SDK's).
type ToolHandler = (...args: unknown[]) => Promise<unknown>;
let tools: Map<string, ToolHandler>;
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(function () {
    tools = new Map();
    return {
      connect: vi.fn(),
      close: vi.fn(),
      tool: vi.fn((...args: unknown[]) => {
        tools.set(args[0] as string, args[args.length - 1] as ToolHandler);
      }),
      resource: vi.fn(),
      prompt: vi.fn(),
    };
  }),
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: vi.fn() }));

// eslint-disable-next-line no-restricted-imports -- the harness mints real dispatch tokens
import { bytesToHex, generateKeypair, mintAudienceToken, sha256 } from "@motebit/encryption";
import { McpServerAdapter } from "@motebit/mcp-server";
import type { MotebitServerDeps } from "@motebit/mcp-server";
import { fileTaskSpendLedger, memoryTaskSpendLedger, taskSpendFor } from "@motebit/molecule-runner";
import type { TaskSpendLedger } from "@motebit/molecule-runner";
import { computeP2pFeeMicro } from "@motebit/sdk";

import type { AtomAdapter, PaidSubDelegate, ResearchConfig, SignedReceipt } from "../research.js";
import { research, researchConfigForTask } from "../research.js";

const NET = 50_000;
const FEE = computeP2pFeeMicro(NET, 0.05); // 2,632
const OUTFLOW = NET + FEE; // 52,632
/** The coded default budget: $0.25 − 5% margin − the 8-call LLM reserve. */
const BUDGET = 66_200;

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
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async executeTool() {
    return { ok: false, error: "no direct path expected" };
  }
}

function receipt(n: number): SignedReceipt {
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
    result: "[]",
    signature: `sig-${n}`,
  } as unknown as SignedReceipt;
}

/**
 * A model that keeps asking for web searches until it has `k` tool results in
 * its transcript, then writes the report. Stateless per call (it reads the
 * transcript), so concurrent runs each get their own loop.
 */
function modelWantsSearchesPerRun(k: number): void {
  mockCreate.mockImplementation(async (req: { messages: unknown[] }) =>
    req.messages.length < 2 * k + 1
      ? {
          content: [
            {
              type: "tool_use",
              id: `tu-${req.messages.length}`,
              name: "motebit_web_search",
              input: { query: `q${req.messages.length}` },
            },
          ],
        }
      : { content: [{ type: "text", text: REPORT }] },
  );
}

/**
 * A priced web-search market. Every LIVE hop settles at 52,632 after
 * `liveDelayMs` (money leaves at settlement). `maxTotalMicro` is enforced the
 * way the runtime does: over it ⇒ `budget_exceeded`, nothing moved.
 */
function market(opts: { liveDelayMs?: number; refuseLive?: string } = {}) {
  const state = { outflow: 0, liveCalls: 0, refused: 0 };
  let n = 0;
  const seam: PaidSubDelegate = async (p) => {
    const settlement = { mode: "p2p" as const, paidMicro: NET, feeMicro: FEE };
    if (p.dryRun === true) return { ok: true, settlement };
    if (opts.refuseLive != null) {
      state.refused++;
      return { ok: false, code: opts.refuseLive };
    }
    if (p.maxTotalMicro != null && OUTFLOW > p.maxTotalMicro) {
      state.refused++;
      return { ok: false, code: "budget_exceeded" };
    }
    state.liveCalls++;
    if (opts.liveDelayMs != null) await new Promise((r) => setTimeout(r, opts.liveDelayMs));
    state.outflow += OUTFLOW;
    n++;
    return { ok: true, receipt: receipt(n), settlement: { ...settlement, txHash: `tx-${n}` } };
  };
  return { state, seam };
}

function baseConfig(seam: PaidSubDelegate): ResearchConfig {
  return {
    anthropicApiKey: "sk-ant-test",
    webSearchUrl: "http://ws.test/mcp",
    readUrlUrl: "http://ru.test/mcp",
    callerMotebitId: "motebit-research",
    callerDeviceId: "research-service",
    callerPrivateKey: new Uint8Array(32),
    maxToolCalls: 8,
    adapterFactory: () => new NoDirectAdapter(),
    paidSubDelegate: seam,
    paidSpendBudgetMicro: BUDGET,
  };
}

let dir: string;
beforeEach(() => {
  mockCreate.mockReset();
  dir = mkdtempSync(join(tmpdir(), "rb3-task-spend-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("paid-spend budget is per ADMITTED task, across every run of it", () => {
  it("(1) same admitted sub, two concurrent runs each wanting 8 paid hops ⇒ total outflow ≤ budget", async () => {
    const m = market({ liveDelayMs: 20 });
    modelWantsSearchesPerRun(8);
    const ledger = fileTaskSpendLedger(join(dir, "task-spend.json"));
    const spendFor = (id: string) => taskSpendFor(ledger, id);
    const base = baseConfig(m.seam);

    const [a, b] = await Promise.all([
      research("question", researchConfigForTask(base, "relay-task-1", spendFor)),
      research("question", researchConfigForTask(base, "relay-task-1", spendFor)),
    ]);

    expect(m.state.outflow).toBeLessThanOrEqual(BUDGET);
    expect(m.state.liveCalls).toBe(1);
    expect(ledger.committedMicro("relay-task-1")).toBe(m.state.outflow);
    expect(a.paid_spend_micro + b.paid_spend_micro).toBe(m.state.outflow);
    expect(a.report).toBe(REPORT);
    expect(b.report).toBe(REPORT);
  });

  it("(3) a restart (a new ledger instance on the same dir) keeps the spent amount", async () => {
    const m = market();
    modelWantsSearchesPerRun(8);
    const path = join(dir, "task-spend.json");
    const before = fileTaskSpendLedger(path);
    await research(
      "question",
      researchConfigForTask(baseConfig(m.seam), "relay-task-1", (id) => taskSpendFor(before, id)),
    );
    expect(m.state.outflow).toBe(OUTFLOW);

    // The process restarts: a fresh ledger object, the same file.
    const after = fileTaskSpendLedger(path);
    expect(after.committedMicro("relay-task-1")).toBe(OUTFLOW);
    const retry = await research(
      "question",
      researchConfigForTask(baseConfig(m.seam), "relay-task-1", (id) => taskSpendFor(after, id)),
    );
    expect(m.state.outflow).toBe(OUTFLOW); // the retry paid nothing more
    expect(m.state.outflow).toBeLessThanOrEqual(BUDGET);
    expect(retry.report).toBe(REPORT);
  });

  it("(4) different admitted subs have independent budgets", async () => {
    const m = market();
    modelWantsSearchesPerRun(8);
    const ledger = fileTaskSpendLedger(join(dir, "task-spend.json"));
    const spendFor = (id: string) => taskSpendFor(ledger, id);
    await research("question", researchConfigForTask(baseConfig(m.seam), "task-A", spendFor));
    await research("question", researchConfigForTask(baseConfig(m.seam), "task-B", spendFor));
    expect(m.state.liveCalls).toBe(2);
    expect(ledger.committedMicro("task-A")).toBe(OUTFLOW);
    expect(ledger.committedMicro("task-B")).toBe(OUTFLOW);
  });

  it("(5) a hop refused before money moved releases its reservation", async () => {
    const ledger = memoryTaskSpendLedger();
    // Every live hop is refused pre-sign (no money moved).
    const refusing = market({ refuseLive: "budget_exceeded" });
    modelWantsSearchesPerRun(3);
    const r = await research(
      "question",
      researchConfigForTask(baseConfig(refusing.seam), "task-1", (id) => taskSpendFor(ledger, id)),
    );
    expect(refusing.state.refused).toBe(3); // each hop could reserve: the prior hold was released
    expect(ledger.committedMicro("task-1")).toBe(0);
    expect(r.paid_spend_micro).toBe(0);

    // A real payment refusal (no settlement fact) releases it too.
    const refusedAuth = market({ refuseLive: "money_meter_denied" });
    modelWantsSearchesPerRun(1);
    await research(
      "question",
      researchConfigForTask(baseConfig(refusedAuth.seam), "task-1", (id) =>
        taskSpendFor(ledger, id),
      ),
    );
    expect(ledger.committedMicro("task-1")).toBe(0);

    // And the budget is whole again for a hop that pays.
    const paying = market();
    modelWantsSearchesPerRun(8);
    await research(
      "question",
      researchConfigForTask(baseConfig(paying.seam), "task-1", (id) => taskSpendFor(ledger, id)),
    );
    expect(paying.state.liveCalls).toBe(1);
    expect(ledger.committedMicro("task-1")).toBe(OUTFLOW);
  });

  it("a hop whose seam throws is charged its whole reservation (it may have paid)", async () => {
    const ledger = memoryTaskSpendLedger();
    const seam: PaidSubDelegate = async (p) => {
      if (p.dryRun === true)
        return { ok: true, settlement: { mode: "p2p", paidMicro: NET, feeMicro: FEE } };
      throw new Error("rpc reset mid-payment");
    };
    modelWantsSearchesPerRun(1);
    await expect(
      research(
        "question",
        researchConfigForTask(baseConfig(seam), "task-1", (id) => taskSpendFor(ledger, id)),
      ),
    ).rejects.toThrow();
    expect(ledger.committedMicro("task-1")).toBe(BUDGET);
  });

  it("an unadmitted call keeps today's per-run budget (no admitted id ⇒ base config)", async () => {
    const m = market();
    modelWantsSearchesPerRun(8);
    const ledger = memoryTaskSpendLedger();
    const spendFor = (id: string) => taskSpendFor(ledger, id);
    const base = baseConfig(m.seam);
    expect(researchConfigForTask(base, undefined, spendFor)).toBe(base);
    await research("question", researchConfigForTask(base, undefined, spendFor));
    await research("question", researchConfigForTask(base, undefined, spendFor));
    expect(m.state.liveCalls).toBe(2); // one per run, as before
  });

  it("a corrupt ledger file reserves nothing (fail closed) and the report still ships", async () => {
    const { writeFileSync } = await import("node:fs");
    const path = join(dir, "task-spend.json");
    writeFileSync(path, "{not json");
    const m = market();
    modelWantsSearchesPerRun(3);
    const ledger: TaskSpendLedger = fileTaskSpendLedger(path);
    const r = await research(
      "question",
      researchConfigForTask(baseConfig(m.seam), "task-1", (id) => taskSpendFor(ledger, id)),
    );
    expect(m.state.liveCalls).toBe(0);
    expect(r.report).toBe(REPORT);
  });
});

describe("(2) timeout + retry through the real McpServerAdapter, one dispatch token", () => {
  const WORKER = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";

  function deps(handleAgentTask: MotebitServerDeps["handleAgentTask"]): MotebitServerDeps {
    return {
      motebitId: WORKER,
      publicKeyHex: "00".repeat(32),
      listTools: () => [],
      filterTools: (t) => t,
      validateTool: () => ({ allowed: true, requiresApproval: false }),
      executeTool: async () => ({ ok: true, data: "" }),
      getState: () => ({}),
      getMemories: async () => [],
      logToolCall: () => {},
      handleAgentTask,
    };
  }

  /** The service's handler shape: one research() per run, bound to the admitted task. */
  function handler(
    base: ResearchConfig,
    spendFor: (id: string) => ReturnType<typeof taskSpendFor>,
  ): MotebitServerDeps["handleAgentTask"] {
    return async function* (prompt, options) {
      const r = await research(
        prompt,
        researchConfigForTask(base, options?.admittedRelayTaskId, spendFor),
      );
      yield {
        type: "task_result" as const,
        receipt: {
          task_id: "t",
          motebit_id: WORKER,
          signature: "s",
          status: "completed",
          result: r.report,
        },
      };
    };
  }

  async function adapter(
    relayPublicKey: string,
    h: MotebitServerDeps["handleAgentTask"],
    admission: boolean,
  ): Promise<ToolHandler> {
    const a = new McpServerAdapter(
      {
        transport: "stdio",
        taskTimeoutMs: 40,
        ...(admission ? { taskAdmission: { relayPublicKey } } : {}),
      },
      deps(h),
    );
    await a.start();
    return tools.get("motebit_task")!;
  }

  async function dispatchToken(relayPriv: Uint8Array, sub: string): Promise<string> {
    const digest = bytesToHex(await sha256(new TextEncoder().encode("p")));
    const { token } = await mintAudienceToken(
      { mid: WORKER, did: "relay-did", aud: "task:dispatch", sub, digest },
      relayPriv,
    );
    return token;
  }

  const text = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]!.text;

  it("the timed-out run keeps paying beside its retry, yet the task's total outflow ≤ budget and the retry delivers", async () => {
    // Each live hop settles after 80 ms — longer than the 40 ms task timeout,
    // so the first run times out mid-hop and keeps running (a zombie).
    const m = market({ liveDelayMs: 80 });
    modelWantsSearchesPerRun(8);
    const relay = await generateKeypair();
    const ledger = fileTaskSpendLedger(join(dir, "task-spend.json"));
    const call = await adapter(
      bytesToHex(relay.publicKey),
      handler(baseConfig(m.seam), (id) => taskSpendFor(ledger, id)),
      true,
    );
    const token = await dispatchToken(relay.privateKey, "relay-task-1");

    const first = await call({ prompt: "p", dispatch_token: token }, {});
    expect(text(first)).toContain("timed out");
    // The honest retry of the same admission is admitted (no receipt yet)…
    const retry = await call({ prompt: "p", dispatch_token: token }, {});
    // …and still delivers a report.
    expect((retry as { isError?: boolean }).isError).not.toBe(true);
    expect(text(retry)).toContain("## Findings");

    // Let the zombie finish its hop and its loop.
    await new Promise((r) => setTimeout(r, 400));
    expect(m.state.outflow).toBeLessThanOrEqual(BUDGET); // was 105,264 before the ledger
    expect(ledger.committedMicro("relay-task-1")).toBe(m.state.outflow);
  });

  it("without admission a caller-supplied relay_task_id never keys the ledger (per-run budget)", async () => {
    const m = market();
    modelWantsSearchesPerRun(8);
    const ledger = memoryTaskSpendLedger();
    const relay = await generateKeypair();
    const call = await adapter(
      bytesToHex(relay.publicKey),
      handler(baseConfig(m.seam), (id) => taskSpendFor(ledger, id)),
      false,
    );
    await call({ prompt: "p", relay_task_id: "claimed-1" }, {});
    await call({ prompt: "p", relay_task_id: "claimed-1" }, {});
    expect(m.state.liveCalls).toBe(2);
    expect(ledger.committedMicro("claimed-1")).toBe(0);
  });
});
