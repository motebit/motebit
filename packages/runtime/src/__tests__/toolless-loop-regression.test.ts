/**
 * Toolless-loop regression (T1).
 *
 * Bug: `wireLoopDeps` snapshotted `loopDeps.tools` as
 * `scopedToolRegistry.size > 0 ? wrap(...) : undefined` — a ONE-SHOT read at
 * wire time. A runtime built with a provider but an EMPTY tool registry (the
 * live shape on mobile + desktop), then populated via the raw
 * `getToolRegistry().register(...)` (which has no re-wire hook, unlike
 * `registerExternalTools`/`setProvider`/`updatePolicyConfig`), kept
 * `loopDeps.tools === undefined`. `ai-core/loop.ts` reads `deps.tools` and runs
 * the agentic loop with ZERO tools when it is falsy.
 *
 * This test drives the REAL `runTurnStreaming` (deliberately NOT mocking
 * @motebit/ai-core — that mock is exactly why existing streaming tests miss
 * this) and asserts via a provider that records the tool definitions the loop
 * offers it (`contextPack.tools`).
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters, StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack, ToolDefinition } from "@motebit/sdk";
import { RiskLevel } from "@motebit/sdk";

/** Provider that records the tool names offered to it on each turn. */
function createToolCapturingProvider(offered: string[][]): StreamingProvider {
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
    async *generateStream(ctx: ContextPack) {
      offered.push((ctx.tools ?? []).map((t) => t.name));
      yield { type: "text" as const, text: "ok" };
      yield { type: "done" as const, response };
    },
  };
}

function probeTool(name: string): ToolDefinition {
  return {
    name,
    description: `probe ${name}`,
    inputSchema: { type: "object" },
    riskHint: { risk: RiskLevel.R0_READ },
  };
}

function makeRuntime(motebitId: string, offered: string[][]): MotebitRuntime {
  const adapters: PlatformAdapters = {
    storage: createInMemoryStorage(),
    renderer: new NullRenderer(),
    ai: createToolCapturingProvider(offered),
  };
  return new MotebitRuntime({ motebitId, tickRateHz: 0 }, adapters);
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of gen) {
    // consume — the turn's chunks are not asserted here
  }
}

describe("MotebitRuntime — toolless-loop regression (T1)", () => {
  it("offers tools registered AFTER construction on an empty registry (no incidental re-wire)", async () => {
    const offered: string[][] = [];
    const runtime = makeRuntime("toolless-1", offered);

    // The mobile/desktop shape: constructed provider-only (empty registry →
    // wireLoopDeps already ran), then populated via the RAW registry with no
    // re-wire. Before the fix, loopDeps.tools stayed undefined → toolless loop.
    runtime.getToolRegistry().register(probeTool("probe_tool"), async () => ({ ok: true }));

    await drain(runtime.sendMessageStreaming("hi"));

    expect(offered.length).toBeGreaterThan(0);
    expect(offered[0]).toContain("probe_tool");
  });

  it("an empty registry still runs the loop cleanly (always-wrap tolerates an empty list)", async () => {
    const offered: string[][] = [];
    const runtime = makeRuntime("toolless-2", offered);

    // No tools registered at all — the loop must still complete without error
    // and simply offer nothing. Guards the fix's empty-registry path.
    await drain(runtime.sendMessageStreaming("hi"));

    expect(offered.length).toBeGreaterThan(0);
    expect(offered[0]).toEqual([]);
  });
});
