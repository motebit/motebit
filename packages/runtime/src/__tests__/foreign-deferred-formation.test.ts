/**
 * #943 round 8 — the DEFERRED formation path (desktop, web and mobile run
 * `deferMemoryFormation: true`, so this is the live path for a delegated
 * task) keeps a foreign turn's formation `isolated_add`.
 *
 * Real runtime, through `handleAgentTask`, deferred formation on. The owner
 * holds "wife is named Beth"; a customer's task says "…Beth" (would
 * REINFORCE) or "…Carol" (would UPDATE / supersede). After the queue drains
 * the owner node is byte-identical and the consolidation classifier was
 * never consulted. The owner's own deferred turn still consolidates.
 *
 * Tamper: make the runtime's deferred consumer use `"consolidate"` (it has
 * to be cast — `formDeferredMemories` takes a `TurnFormationMode`) — red.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import { ConsolidationAction, embedTextHash } from "@motebit/memory-graph";
import type { ConsolidationProvider } from "@motebit/memory-graph";
import type { AIResponse, AgentTask } from "@motebit/sdk";
import { AgentTaskStatus, SensitivityLevel } from "@motebit/sdk";
import { generateKeypair } from "@motebit/encryption";

const OWNER_FACT = "The owner's wife is named Beth";

function candidateProvider(content: string): StreamingProvider {
  const response: AIResponse = {
    text: "Noted.",
    confidence: 0.9,
    memory_candidates: [{ content, confidence: 0.9, sensitivity: SensitivityLevel.None }],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async () => response),
    estimateConfidence: vi.fn(async () => 0.9),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream() {
      yield { type: "text" as const, text: "Noted." };
      yield { type: "done" as const, response };
    },
  };
}

async function setup(content: string) {
  const runtime = new MotebitRuntime(
    { motebitId: "owner-mote", tickRateHz: 0, deferMemoryFormation: true },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: candidateProvider(content),
    },
  );
  const owner = await runtime.memory.formMemory(
    {
      content: OWNER_FACT,
      confidence: 0.9,
      sensitivity: SensitivityLevel.None,
      source: "user_stated",
    },
    embedTextHash(OWNER_FACT),
  );
  const classify = vi.fn<ConsolidationProvider["classify"]>(async (newContent) => ({
    action: newContent.includes("Carol")
      ? ConsolidationAction.UPDATE
      : ConsolidationAction.REINFORCE,
    existingNodeId: owner.node_id,
    reason: "test",
  }));
  (
    runtime as unknown as { loopDeps: { consolidationProvider: ConsolidationProvider } }
  ).loopDeps.consolidationProvider = { classify };
  return { runtime, owner, classify };
}

async function snapshot(runtime: MotebitRuntime, nodeId: string): Promise<string> {
  const { nodes, edges } = await runtime.memory.exportAll();
  const node = nodes.find((n) => n.node_id === nodeId);
  return JSON.stringify({
    confidence: node?.confidence,
    half_life: node?.half_life,
    valid_until: node?.valid_until ?? null,
    last_accessed: node?.last_accessed,
    touching: edges.filter((e) => e.source_id === nodeId || e.target_id === nodeId),
  });
}

async function runTask(runtime: MotebitRuntime, prompt: string): Promise<void> {
  const kp = await generateKeypair();
  const task: AgentTask = {
    task_id: "task-deferred",
    motebit_id: "owner-mote",
    prompt,
    submitted_at: Date.now(),
    status: AgentTaskStatus.Claimed,
    wall_clock_ms: 30_000,
  };
  for await (const _c of runtime.handleAgentTask(
    task,
    kp.privateKey,
    "dev-1",
  ) as AsyncGenerator<StreamChunk>) {
    /* consume */
  }
  await runtime.awaitPendingMemoryFormation();
}

describe("#943 — deferred formation of a foreign task never touches the owner's graph", () => {
  for (const [cell, content] of [
    ["REINFORCE cell (…Beth)", "Your owner's wife is named Beth"],
    ["UPDATE cell (…Carol)", "Your owner's wife is named Carol"],
  ] as const) {
    it(`${cell}: owner node byte-identical after the queue drains; classify never called`, async () => {
      const { runtime, owner, classify } = await setup(content);
      const before = await snapshot(runtime, owner.node_id);
      await new Promise((r) => setTimeout(r, 5));
      await runTask(runtime, content);
      expect(await snapshot(runtime, owner.node_id)).toBe(before);
      expect(classify).not.toHaveBeenCalled();
      const { nodes } = await runtime.memory.exportAll();
      expect(nodes.some((n) => n.source === "peer_agent")).toBe(true);
    });
  }

  it("the owner's own deferred turn still consolidates (no regression)", async () => {
    const { runtime, classify } = await setup("My wife is named Beth");
    for await (const _c of runtime.sendMessageStreaming("My wife is named Beth")) {
      /* consume */
    }
    await runtime.awaitPendingMemoryFormation();
    expect(classify).toHaveBeenCalled();
  });
});
