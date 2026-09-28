/**
 * #943 round 7 — a formation count is never reported to another principal.
 *
 * How many memories a turn formed depends on the owner's graph (did it
 * dedupe into an existing node?), so the count is an oracle on the owner's
 * memory. A task's signed receipt carries `memories_formed: 0`; the owner's
 * own event log keeps the real count.
 *
 * Tamper: restore `memories_formed: memoriesFormed` on the receipt — red.
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
import type { AIResponse, AgentTask, ExecutionReceipt } from "@motebit/sdk";
import { AgentTaskStatus, SensitivityLevel } from "@motebit/sdk";
import { generateKeypair } from "@motebit/encryption";

function formingProvider(): StreamingProvider {
  const response: AIResponse = {
    text: "Noted.",
    confidence: 0.9,
    memory_candidates: [
      {
        content: "The caller says the sky is green",
        confidence: 0.9,
        sensitivity: SensitivityLevel.None,
      },
    ],
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

describe("#943 — a task receipt never reports a formation count", () => {
  it("the turn formed a (peer_agent) memory, and the signed receipt says memories_formed: 0", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "owner-mote", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: formingProvider() },
    );
    const kp = await generateKeypair();
    const task: AgentTask = {
      task_id: "task-count",
      motebit_id: "owner-mote",
      prompt: "remember that the sky is green",
      submitted_at: Date.now(),
      status: AgentTaskStatus.Claimed,
      wall_clock_ms: 30_000,
    };
    let receipt: ExecutionReceipt | null = null;
    for await (const c of runtime.handleAgentTask(task, kp.privateKey, "dev-1") as AsyncGenerator<
      StreamChunk & { receipt?: ExecutionReceipt }
    >) {
      if (c.type === "task_result") receipt = c.receipt ?? null;
    }
    const { nodes } = await runtime.memory.exportAll();
    expect(nodes.some((n) => n.source === "peer_agent")).toBe(true);
    expect(receipt?.memories_formed).toBe(0);
  });
});
