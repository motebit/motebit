/**
 * Deferred memory formation — end-to-end integration test.
 *
 * Validates the full autoDream-shape path:
 *   1. Runtime constructed with `deferMemoryFormation: true`.
 *   2. `sendMessageStreaming` runs a turn that produces a memory
 *      candidate in the AI response.
 *   3. The final `result` chunk reaches the consumer; the turn
 *      completes from the user's POV.
 *   4. At that moment, the memory graph does NOT yet contain the
 *      memory — formation is queued, not done.
 *   5. After `awaitPendingMemoryFormation()` resolves, the memory
 *      IS in the graph.
 *   6. A second turn can start; the pre-turn idle barrier ensures
 *      the prior formation completed before new retrieval runs.
 *
 * The mocked StreamingProvider returns a single memory candidate
 * per turn. The real `formMemoriesFromCandidates` runs (no mock at
 * that layer) — so the test exercises the actual embedding +
 * formation path, gated only by the in-memory storage adapter that
 * `createInMemoryStorage()` supplies.
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters, StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack, MemoryCandidate } from "@motebit/sdk";
import { SensitivityLevel } from "@motebit/sdk";

function createProviderWithCandidate(
  responseText: string,
  candidate: MemoryCandidate,
): StreamingProvider {
  const response: AIResponse = {
    text: responseText,
    confidence: 0.9,
    memory_candidates: [candidate],
    state_updates: {},
  };

  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.9),
    extractMemoryCandidates: vi
      .fn<(r: AIResponse) => Promise<MemoryCandidate[]>>()
      .mockResolvedValue([candidate]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: responseText };
      yield { type: "done" as const, response };
    },
  };
}

function createAdapters(provider: StreamingProvider): PlatformAdapters {
  return {
    storage: createInMemoryStorage(),
    renderer: new NullRenderer(),
    ai: provider,
  };
}

async function consume(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

describe("MotebitRuntime — deferred memory formation", () => {
  it("formation runs AFTER the turn completes when deferMemoryFormation is true", async () => {
    const candidate: MemoryCandidate = {
      content: "User prefers dark mode",
      confidence: 0.9,
      sensitivity: SensitivityLevel.Personal,
    };
    const provider = createProviderWithCandidate("Noted.", candidate);
    const runtime = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0, deferMemoryFormation: true },
      createAdapters(provider),
    );

    // Run the turn. All chunks consumed = user's POV of "turn complete".
    await consume(runtime.sendMessageStreaming("What are my display preferences?"));

    // At this moment the queue should be in-flight or depth > 0 (the
    // formation job was enqueued but hasn't necessarily drained yet).
    // After awaiting idle, the memory must exist in the graph.
    expect(runtime.memoryFormation.inFlight() || runtime.memoryFormation.depth() > 0).toBe(true);

    await runtime.awaitPendingMemoryFormation();

    // Now the memory graph reflects the formed candidate.
    const { nodes } = await runtime.memory.exportAll();
    const live = nodes.filter((n) => !n.tombstoned);
    expect(live.some((n) => n.content === "User prefers dark mode")).toBe(true);

    // Queue drained.
    expect(runtime.memoryFormation.inFlight()).toBe(false);
    expect(runtime.memoryFormation.depth()).toBe(0);
  });

  it("pre-turn idle barrier drains the prior turn's queue before the next turn's retrieval runs", async () => {
    // Property under test: when turn 2 starts, the runtime awaits
    // `memoryFormation.idle()` BEFORE runTurnStreaming's recall step
    // fires. So turn 1's formed memory is in the graph by the time
    // turn 2 calls `recallRelevant` — retrieval consistency is
    // preserved across deferred formation.
    //
    // We verify this by recording the queue depth at the moment
    // turn 2's generateStream is called (that runs AFTER the
    // runtime's pre-turn idle). If the barrier works, depth is zero.
    const firstCandidate: MemoryCandidate = {
      content: "User's cat is named Pixel",
      confidence: 0.9,
      sensitivity: SensitivityLevel.Personal,
    };

    let turn = 0;
    const queueDepthWhenTurn2Streamed: { value: number } = { value: -1 };
    let runtimeRef: MotebitRuntime | null = null;

    const provider: StreamingProvider = {
      model: "mock-model",
      setModel: vi.fn(),
      generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue({
        text: "ok",
        confidence: 0.9,
        memory_candidates: [],
        state_updates: {},
      }),
      estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.9),
      extractMemoryCandidates: vi
        .fn<(r: AIResponse) => Promise<MemoryCandidate[]>>()
        .mockResolvedValue([]),
      async *generateStream(_ctx: ContextPack) {
        turn += 1;
        if (turn === 2 && runtimeRef) {
          queueDepthWhenTurn2Streamed.value = runtimeRef.memoryFormation.depth();
        }
        const response: AIResponse = {
          text: "ok",
          confidence: 0.9,
          memory_candidates: turn === 1 ? [firstCandidate] : [],
          state_updates: {},
        };
        yield { type: "text" as const, text: "ok" };
        yield { type: "done" as const, response };
      },
    };

    const runtime = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0, deferMemoryFormation: true },
      createAdapters(provider),
    );
    runtimeRef = runtime;

    // Turn 1 — enqueues formation but we do NOT manually drain.
    await consume(runtime.sendMessageStreaming("Turn one"));
    // The queue SHOULD have work pending (not yet drained).
    expect(
      runtime.memoryFormation.depth() + (runtime.memoryFormation.inFlight() ? 1 : 0),
    ).toBeGreaterThan(0);

    // Turn 2 — the runtime's pre-turn `memoryFormation.idle()` MUST
    // drain before runTurnStreaming fires generateStream. At the
    // moment generateStream runs, queue depth MUST be zero.
    await consume(runtime.sendMessageStreaming("Turn two"));

    expect(queueDepthWhenTurn2Streamed.value).toBe(0);
    // And turn 1's memory must be present in the graph because the
    // queue drained before turn 2 could reach any recall step.
    const { nodes } = await runtime.memory.exportAll();
    const live = nodes.filter((n) => !n.tombstoned);
    expect(live.some((n) => n.content === "User's cat is named Pixel")).toBe(true);
  });

  it("with deferral disabled (default), formation still runs inline — no queue activity", async () => {
    const candidate: MemoryCandidate = {
      content: "User lives in San Francisco",
      confidence: 0.9,
      sensitivity: SensitivityLevel.Personal,
    };
    const provider = createProviderWithCandidate("Got it.", candidate);
    const runtime = new MotebitRuntime(
      // deferMemoryFormation omitted — default false
      { motebitId: "test-mote", tickRateHz: 0 },
      createAdapters(provider),
    );

    await consume(runtime.sendMessageStreaming("Where am I based?"));

    // Inline path: memory present immediately, queue never touched.
    const { nodes } = await runtime.memory.exportAll();
    const live = nodes.filter((n) => !n.tombstoned);
    expect(live.some((n) => n.content === "User lives in San Francisco")).toBe(true);
    expect(runtime.memoryFormation.depth()).toBe(0);
    expect(runtime.memoryFormation.inFlight()).toBe(false);
  });
});
