import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventType, SensitivityLevel } from "@motebit/sdk";

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

import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
} from "../index";
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

  it("stores plan adjustments as memories with [plan_adjustment] prefix", async () => {
    mockReflect.mockResolvedValue({
      insights: ["User likes brevity"],
      planAdjustments: ["Be more concise", "Ask fewer clarifying questions"],
      selfAssessment: "Good overall",
    });

    const formSpy = vi.spyOn(runtime.memory, "formMemory");

    await runtime.reflect();

    // 1 insight + 2 plan adjustments = 3 memories formed
    expect(formSpy).toHaveBeenCalledTimes(3);

    // Verify insight is stored with [reflection] prefix
    expect(formSpy.mock.calls[0]![0]).toMatchObject({
      content: "[reflection] User likes brevity",
      confidence: 0.7,
      sensitivity: SensitivityLevel.None,
    });

    // Verify adjustments are stored with [plan_adjustment] prefix and lower confidence
    expect(formSpy.mock.calls[1]![0]).toMatchObject({
      content: "[plan_adjustment] Be more concise",
      confidence: 0.6,
      sensitivity: SensitivityLevel.None,
    });
    expect(formSpy.mock.calls[2]![0]).toMatchObject({
      content: "[plan_adjustment] Ask fewer clarifying questions",
      confidence: 0.6,
    });
  });

  it("passes goals to ai-core reflect when provided", async () => {
    mockReflect.mockResolvedValue({
      insights: [],
      planAdjustments: [],
      selfAssessment: "N/A",
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
    });

    await runtime.reflect();

    expect(mockReflect.mock.calls[0]![2]).toEqual([]);
  });

  it("emits ReflectionCompleted event after reflection", async () => {
    mockReflect.mockResolvedValue({
      insights: ["Insight A", "Insight B"],
      planAdjustments: ["Adjust X"],
      selfAssessment: "Performed well",
    });

    await runtime.reflect();

    // Wait for async event logging
    await new Promise((r) => setTimeout(r, 50));

    // Check event was logged
    const events = await runtime.events.query({ motebit_id: "reflect-test" });
    const reflectionEvents = events.filter(
      (e) => e.event_type === EventType.ReflectionCompleted,
    );
    expect(reflectionEvents).toHaveLength(1);
    expect(reflectionEvents[0]!.payload).toMatchObject({
      insights_count: 2,
      adjustments_count: 1,
    });
  });

  it("handles empty plan adjustments gracefully", async () => {
    mockReflect.mockResolvedValue({
      insights: ["Only insight"],
      planAdjustments: [],
      selfAssessment: "Fine",
    });

    const formSpy = vi.spyOn(runtime.memory, "formMemory");

    await runtime.reflect();

    // Only 1 insight, no adjustments
    expect(formSpy).toHaveBeenCalledTimes(1);
    expect(formSpy.mock.calls[0]![0].content).toContain("[reflection]");
  });
});
