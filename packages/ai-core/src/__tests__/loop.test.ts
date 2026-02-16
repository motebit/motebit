import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual = await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { runTurn } from "../loop";
import type { MotebitLoopDependencies } from "../loop";
import { CloudProvider } from "../index";
import type { CloudProviderConfig } from "../index";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { SensitivityLevel } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTEBIT_ID = "motebit-loop-test";

function mockAnthropicResponse(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-sonnet-4-5-20250514",
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function mockFetchSuccess(text: string): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  mockFn.mockResolvedValueOnce(
    new Response(JSON.stringify(mockAnthropicResponse(text)), { status: 200 }),
  );
}

function mockFetchError(status: number, body: string): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  mockFn.mockResolvedValueOnce(new Response(body, { status }));
}

function makeDeps(): MotebitLoopDependencies {
  const cloudConfig: CloudProviderConfig = {
    provider: "anthropic",
    api_key: "test-key",
    model: "claude-sonnet-4-5-20250514",
  };

  const eventStore = new EventStore(new InMemoryEventStore());
  const storage = new InMemoryMemoryStorage();
  const memoryGraph = new MemoryGraph(storage, eventStore, MOTEBIT_ID);
  const stateEngine = new StateVectorEngine();
  const behaviorEngine = new BehaviorEngine();
  const cloudProvider = new CloudProvider(cloudConfig);

  return {
    motebitId: MOTEBIT_ID,
    eventStore,
    memoryGraph,
    stateEngine,
    behaviorEngine,
    provider: cloudProvider,
  };
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("runTurn", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("full turn: message → response → memory → state → cues", async () => {
    const responseText = [
      "That's really interesting!",
      '<memory confidence="0.9" sensitivity="personal">User enjoys hiking on weekends</memory>',
      '<state field="curiosity" value="0.8"/>',
    ].join(" ");

    mockFetchSuccess(responseText);

    const deps = makeDeps();
    const result = await runTurn(deps, "I love hiking on weekends!");

    // Response text should have tags stripped
    expect(result.response).toContain("That's really interesting!");
    expect(result.response).not.toContain("<memory");
    expect(result.response).not.toContain("<state");

    // Memory should have been formed
    expect(result.memoriesFormed).toHaveLength(1);
    expect(result.memoriesFormed[0]!.content).toBe(
      "User enjoys hiking on weekends",
    );
    expect(result.memoriesFormed[0]!.confidence).toBe(0.9);
    expect(result.memoriesFormed[0]!.sensitivity).toBe(
      SensitivityLevel.Personal,
    );

    // State and cues should be present
    expect(result.stateAfter).toBeDefined();
    expect(result.cues).toBeDefined();
    expect(result.cues.hover_distance).toBeGreaterThan(0);
  });

  it("handles API error gracefully", async () => {
    mockFetchError(500, "Internal Server Error");

    const deps = makeDeps();
    await expect(runTurn(deps, "Hello")).rejects.toThrow(
      "Anthropic API error 500",
    );
  });

  it("handles response with no memory candidates", async () => {
    mockFetchSuccess("Just a plain response, no memories here.");

    const deps = makeDeps();
    const result = await runTurn(deps, "What's up?");

    expect(result.response).toBe("Just a plain response, no memories here.");
    expect(result.memoriesFormed).toHaveLength(0);
  });

  it("memory retrieval works on subsequent turns", async () => {
    const deps = makeDeps();

    // Turn 1: form a memory
    mockFetchSuccess(
      'Cool! <memory confidence="0.9" sensitivity="none">User loves jazz music</memory>',
    );
    const result1 = await runTurn(deps, "I love jazz music");
    expect(result1.memoriesFormed).toHaveLength(1);

    // Turn 2: the memory should be retrievable (it was stored)
    mockFetchSuccess("I remember you like jazz!");
    const result2 = await runTurn(deps, "What kind of music do I like?");
    expect(result2.response).toBe("I remember you like jazz!");

    // Verify the memory is in the graph
    const exported = await deps.memoryGraph.exportAll();
    expect(exported.nodes).toHaveLength(1);
    expect(exported.nodes[0]!.content).toBe("User loves jazz music");
  });

  it("previousCues in options propagates to context pack", async () => {
    const cues = {
      hover_distance: 0.15,
      drift_amplitude: 0.03,
      glow_intensity: 0.7,
      eye_dilation: 0.8,
      smile_curvature: 0.1,
      skirt_deformation: 0.05,
    };

    mockFetchSuccess("I see!");

    const deps = makeDeps();
    // Spy on provider.generate to check the context pack
    const generateSpy = vi.spyOn(deps.provider, "generate");

    await runTurn(deps, "Test with cues", { previousCues: cues });

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const contextPack = generateSpy.mock.calls[0]![0];
    expect(contextPack.behavior_cues).toEqual(cues);
  });

  it("infers state from text when no state tags are present", async () => {
    // Response with positive words, a question, and length > 200 chars — but no <state> tags
    const responseText =
      "I'm so happy you asked about that! It's a wonderful topic and I'd love to explore it with you. " +
      "What aspects are you most interested in? There are definitely many fascinating angles we could investigate together.";

    mockFetchSuccess(responseText);

    const deps = makeDeps();
    const pushSpy = vi.spyOn(deps.stateEngine, "pushUpdate");

    await runTurn(deps, "Tell me about something cool");

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const pushed = pushSpy.mock.calls[0]![0] as Record<string, unknown>;

    // Should have inferred nudges (not explicit state tags)
    expect(pushed.affect_valence).toBeGreaterThan(0); // positive words
    expect(pushed.curiosity).toBeGreaterThan(0); // question mark
    expect(pushed.confidence).toBeGreaterThan(0.5); // "definitely"
  });

  it("explicit state tags take priority over inference", async () => {
    // Response with BOTH positive words and explicit state tags
    const responseText = [
      "I'm so happy about this!",
      '<state field="curiosity" value="0.9"/>',
    ].join(" ");

    mockFetchSuccess(responseText);

    const deps = makeDeps();
    const pushSpy = vi.spyOn(deps.stateEngine, "pushUpdate");

    await runTurn(deps, "Test explicit vs inferred");

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const pushed = pushSpy.mock.calls[0]![0] as Record<string, unknown>;

    // Should use explicit tag value, NOT inference
    expect(pushed).toEqual({ curiosity: 0.9 });
    // Inference would have also set affect_valence — verify it's absent
    expect(pushed.affect_valence).toBeUndefined();
  });

  it("version clocks increment across turns", async () => {
    const deps = makeDeps();

    // Turn 1
    mockFetchSuccess(
      'Hi! <memory confidence="0.8" sensitivity="none">Fact 1</memory>',
    );
    await runTurn(deps, "Message 1");

    // Turn 2
    mockFetchSuccess(
      'Hey! <memory confidence="0.7" sensitivity="none">Fact 2</memory>',
    );
    await runTurn(deps, "Message 2");

    // Check events have incrementing clocks
    const events = await deps.eventStore.query({ motebit_id: MOTEBIT_ID });
    const clocks = events.map((e) => e.version_clock);

    // Each event should have a unique clock
    const uniqueClocks = new Set(clocks);
    expect(uniqueClocks.size).toBe(clocks.length);

    // Clocks should be monotonically increasing
    for (let i = 1; i < clocks.length; i++) {
      expect(clocks[i]!).toBeGreaterThan(clocks[i - 1]!);
    }
  });
});
