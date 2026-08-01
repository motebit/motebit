/**
 * Capability-tiered tool admission (#501): a minimal-tier model is never
 * OFFERED an R4_MONEY tool — omitted from the model-visible list,
 * fail-closed on execute — unless the sovereign override is set. Born
 * live 2026-07-31: llama3.2 (3B) fabricated a real-money hire proposal
 * from noise; governance caught it, this makes the class unrepresentable
 * (runtime-invariants-over-prompt-rules; intelligence-pluggability
 * commitment #3).
 */
import { describe, it, expect, vi } from "vitest";
import { RiskLevel, SideEffect } from "@motebit/sdk";
import type { AIResponse, ContextPack, ToolDefinition } from "@motebit/sdk";
import type { StreamingProvider } from "@motebit/ai-core";

vi.mock("@motebit/memory-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/memory-graph")>();
  return {
    ...actual,
    embedText: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  };
});

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { ScopedToolRegistry } from "../scoped-tool-registry";

function createMockProvider(initialModel: string): StreamingProvider {
  const response: AIResponse = {
    text: "ok",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };
  // Mirrors real providers: setModel mutates the live `model` field the
  // tier predicate reads by reference. `model` is readonly on the
  // interface, so the mutable truth lives beside it.
  let currentModel = initialModel;
  const provider: StreamingProvider = {
    get model() {
      return currentModel;
    },
    setModel: (m: string) => {
      currentModel = m;
    },
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn<(r: AIResponse) => Promise<never[]>>().mockResolvedValue([]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: "ok" };
      yield { type: "done" as const, response };
    },
  };
  return provider;
}

const MONEY_TOOL: ToolDefinition = {
  name: "pay_worker",
  description: "Delegate a paid task to a worker agent",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R4_MONEY, sideEffect: SideEffect.IRREVERSIBLE },
};

const READ_TOOL: ToolDefinition = {
  name: "read_notes",
  description: "Read local notes",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R0_READ, sideEffect: SideEffect.NONE },
};

/** The R2 shape delegate_to_agent takes when NO payment rail is bound. */
const RAILLESS_DELEGATE: ToolDefinition = {
  name: "delegate_to_agent",
  description: "Delegate a task to a remote agent",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R2_WRITE, sideEffect: SideEffect.REVERSIBLE },
};

function build(model: string, offerOverride?: boolean) {
  const runtime = new MotebitRuntime(
    {
      motebitId: "tier-test",
      tickRateHz: 0,
      ...(offerOverride != null ? { offerMoneyToolsToMinimalModels: offerOverride } : {}),
    },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: createMockProvider(model),
    },
  );
  runtime.getToolRegistry().register(MONEY_TOOL, async () => ({ ok: true }));
  runtime.getToolRegistry().register(READ_TOOL, async () => ({ ok: true }));
  const scoped = (runtime as unknown as { scopedToolRegistry: ScopedToolRegistry })
    .scopedToolRegistry;
  return { runtime, scoped };
}

describe("capability-tiered tool admission (#501)", () => {
  it("a minimal-tier model never SEES the money tool; execute fail-closes", async () => {
    const { runtime, scoped } = build("llama3.2");
    const visible = scoped.list().map((t) => t.name);
    expect(visible).toContain("read_notes");
    expect(visible).not.toContain("pay_worker");

    const result = await scoped.execute("pay_worker", {});
    expect(result.ok).toBe(false);

    expect(runtime.moneyToolsWithheld).toBe(true);
  });

  it("a capable/frontier model gets full exposure", () => {
    const { runtime, scoped } = build("claude-sonnet-4-6");
    expect(scoped.list().map((t) => t.name)).toContain("pay_worker");
    expect(runtime.moneyToolsWithheld).toBe(false);
  });

  it("a mid-session model switch adjusts exposure with no re-wire (predicate reads by reference)", () => {
    const { runtime, scoped } = build("claude-sonnet-4-6");
    expect(scoped.list().map((t) => t.name)).toContain("pay_worker");

    runtime.setModel("llama3.2");
    expect(scoped.list().map((t) => t.name)).not.toContain("pay_worker");
    expect(runtime.moneyToolsWithheld).toBe(true);

    runtime.setModel("qwen3");
    expect(scoped.list().map((t) => t.name)).toContain("pay_worker");
    expect(runtime.moneyToolsWithheld).toBe(false);
  });

  it("the sovereign override restores full exposure to a minimal model", () => {
    const { runtime, scoped } = build("llama3.2", true);
    expect(scoped.list().map((t) => t.name)).toContain("pay_worker");
    expect(runtime.moneyToolsWithheld).toBe(false);
  });

  it("a rail-less delegate tool (R2) stays offered to a minimal model — the tool crosses the line only when it can move money", () => {
    const { scoped, runtime } = build("llama3.2");
    runtime.getToolRegistry().register(RAILLESS_DELEGATE, async () => ({ ok: true }));
    expect(scoped.list().map((t) => t.name)).toContain("delegate_to_agent");
  });

  it("non-money tools are untouched on every tier", () => {
    for (const model of ["llama3.2", "qwen3", "claude-opus-5"]) {
      const { scoped } = build(model);
      expect(scoped.list().map((t) => t.name)).toContain("read_notes");
    }
  });
});
