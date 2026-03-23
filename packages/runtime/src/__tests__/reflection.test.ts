import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventType } from "@motebit/sdk";

// Mock embedText — avoid loading HF pipeline in tests
vi.mock("@motebit/memory-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/memory-graph")>();
  return {
    ...actual,
    embedText: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  };
});

// Mock the ai-core reflect function so we control what it returns
vi.mock("@motebit/ai-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/ai-core")>();
  return {
    ...actual,
    reflect: vi.fn(),
  };
});

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import { reflect as aiReflect } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";

const mockReflect = vi.mocked(aiReflect);

function createMockProvider(): StreamingProvider {
  const response: AIResponse = {
    text: "mock response",
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
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: "mock response" };
      yield { type: "done" as const, response };
    },
  };
}

describe("Runtime reflection — learning loop", () => {
  let runtime: MotebitRuntime;

  beforeEach(() => {
    mockReflect.mockReset();
    runtime = new MotebitRuntime(
      { motebitId: "reflect-test", tickRateHz: 0 },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: createMockProvider(),
      },
    );
  });

  it("does not store reflection insights as memories (event log is canonical)", async () => {
    mockReflect.mockResolvedValue({
      insights: ["User likes brevity"],
      planAdjustments: ["Be more concise", "Ask fewer clarifying questions"],
      selfAssessment: "Good overall",
      patterns: [],
    });

    const formSpy = vi.spyOn(runtime.memory, "formMemory");

    await runtime.reflect();

    // Reflection results go to the event log, not the memory graph
    expect(formSpy).not.toHaveBeenCalled();
  });

  it("passes goals to ai-core reflect when provided", async () => {
    mockReflect.mockResolvedValue({
      insights: [],
      planAdjustments: [],
      selfAssessment: "N/A",
      patterns: [],
    });

    const goals = [
      { description: "Check email every hour", status: "active" },
      { description: "Summarize news daily", status: "paused" },
    ];

    await runtime.reflect(goals);

    expect(mockReflect).toHaveBeenCalledTimes(1);
    // Third argument is the goals array
    expect(mockReflect.mock.calls[0]![2]).toEqual(goals);
  });

  it("passes empty goals when none provided", async () => {
    mockReflect.mockResolvedValue({
      insights: [],
      planAdjustments: [],
      selfAssessment: "N/A",
      patterns: [],
    });

    await runtime.reflect();

    expect(mockReflect.mock.calls[0]![2]).toEqual([]);
  });

  it("emits ReflectionCompleted event after reflection", async () => {
    mockReflect.mockResolvedValue({
      insights: ["Insight A", "Insight B"],
      planAdjustments: ["Adjust X"],
      selfAssessment: "Performed well",
      patterns: [],
    });

    await runtime.reflect();

    // Wait for async event logging
    await new Promise((r) => setTimeout(r, 50));

    // Check event was logged
    const events = await runtime.events.query({ motebit_id: "reflect-test" });
    const reflectionEvents = events.filter((e) => e.event_type === EventType.ReflectionCompleted);
    expect(reflectionEvents).toHaveLength(1);
    expect(reflectionEvents[0]!.payload).toMatchObject({
      source: "runtime_reflect",
      insights_count: 2,
      adjustments_count: 1,
    });
  });

  it("handles empty plan adjustments gracefully", async () => {
    mockReflect.mockResolvedValue({
      insights: ["Only insight"],
      planAdjustments: [],
      selfAssessment: "Fine",
      patterns: [],
    });

    const formSpy = vi.spyOn(runtime.memory, "formMemory");

    await runtime.reflect();

    // Reflection no longer stores to memory graph
    expect(formSpy).not.toHaveBeenCalled();
  });
});
