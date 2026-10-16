/**
 * The loop's memory formation must embed through the SAME `embedText` the
 * loop imports — the seam every ai-core test replaces with the 128-d hash.
 *
 * Before the fix, `formMemoriesFromCandidates` (memory-graph) called its own
 * module-internal `embedText`, which a `vi.mock("@motebit/memory-graph")`
 * cannot reach. So five ai-core test files that "mocked the embedder" still
 * loaded the real all-MiniLM-L6-v2 ONNX model (8 loads per run, measured) out
 * of the one shared @xenova/transformers cache in the pnpm store — the path
 * that hung `@motebit/ai-core:test` in the pre-push run.
 *
 * Tamper check: drop the `embed` the loop passes to formation — the formed
 * memory is embedded by the real loader again (384-d, not the 128-d mock),
 * and the real-model guard (vitest.real-model-guard.ts) fails the run.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { runTurn } from "../loop";
import type { MotebitLoopDependencies } from "../loop";
import type { StreamingProvider } from "../index";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage, embedTextHash } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { SensitivityLevel } from "@motebit/sdk";
import type { AIResponse, ContextPack, SensitivityCleared } from "@motebit/sdk";

const FACT = "The owner prefers green tea in the morning";

function factProvider(): StreamingProvider {
  const final: AIResponse = {
    text: "Noted.",
    confidence: 0.9,
    memory_candidates: [{ content: FACT, confidence: 0.9, sensitivity: SensitivityLevel.None }],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn().mockResolvedValue(final),
    estimateConfidence: vi.fn().mockResolvedValue(0.9),
    extractMemoryCandidates: vi.fn().mockResolvedValue([]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: "Noted." };
      yield { type: "done" as const, response: final };
    },
  } as unknown as StreamingProvider;
}

describe("loop memory formation uses the loop's embedder", () => {
  it("a formed memory is embedded by the mocked embedText, never the real model loader", async () => {
    const eventStore = new EventStore(new InMemoryEventStore());
    const d = {
      motebitId: "owner-mote",
      eventStore,
      memoryGraph: new MemoryGraph(new InMemoryMemoryStorage(), eventStore, "owner-mote"),
      stateEngine: new StateVectorEngine(),
      behaviorEngine: new BehaviorEngine(),
      provider: factProvider(),
      getEffectiveSensitivity: () => SensitivityLevel.None,
    } as unknown as SensitivityCleared<MotebitLoopDependencies>;

    const result = await runTurn(d, `Remember: ${FACT}`);
    expect(result.memoriesFormed).toHaveLength(1);
    expect(result.memoriesFormed[0]!.embedding).toEqual(embedTextHash(FACT));
  });
});
