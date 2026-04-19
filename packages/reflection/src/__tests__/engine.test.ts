import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock embedText to be deterministic (hash-based), plus supply a poison
// trigger phrase to exercise the embedding-failure defensive path.
// Audit + formMemory can be toggled to throw via shared flags — lets us
// exercise the two other defensive catch blocks without forcing malformed
// data that would break earlier code paths.
const EMBED_POISON = "__POISON_EMBED__";
const testFlags = { auditThrows: false, patternsThrows: false };
vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return {
    ...actual,
    embedText: (text: string) => {
      if (text.includes(EMBED_POISON)) return Promise.reject(new Error("embedding unavailable"));
      return Promise.resolve(actual.embedTextHash(text));
    },
    rankNotableMemories: (
      nodes: Parameters<typeof actual.rankNotableMemories>[0],
      edges: Parameters<typeof actual.rankNotableMemories>[1],
      options?: Parameters<typeof actual.rankNotableMemories>[2],
    ) => {
      if (testFlags.auditThrows) throw new Error("audit imploded");
      return actual.rankNotableMemories(nodes, edges, options);
    },
    detectReflectionPatterns: (past: Parameters<typeof actual.detectReflectionPatterns>[0]) => {
      if (testFlags.patternsThrows) throw new Error("patterns imploded");
      return actual.detectReflectionPatterns(past);
    },
  };
});

import { performReflection, runReflectionSafe } from "../engine.js";
import type { ReflectionDeps } from "../engine.js";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { MemoryGovernor } from "@motebit/policy";
import { EventType, SensitivityLevel, MemoryType } from "@motebit/sdk";
import type {
  AIResponse,
  ContextPack,
  MemoryCandidate,
  ConversationMessage,
  MemoryNode,
} from "@motebit/sdk";
import type { StreamingProvider } from "@motebit/ai-core";

const MOTEBIT_ID = "test-reflector";

/**
 * Minimal StreamingProvider double.
 * `generate` returns a canned reflection text; everything else is a no-op.
 * Tests that need a specific response pass it via the factory arg.
 */
function makeProvider(responseText: string): StreamingProvider {
  const response: AIResponse = {
    text: responseText,
    memory_candidates: [],
    state_updates: {},
    confidence: 0.9,
  };
  return {
    model: "mock-model",
    setModel() {},
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: () => Promise.resolve(0.9),
    extractMemoryCandidates: (): Promise<MemoryCandidate[]> => Promise.resolve([]),
    async *generateStream(): AsyncGenerator<
      { type: "text"; text: string } | { type: "done"; response: AIResponse }
    > {
      yield { type: "text", text: responseText };
      yield { type: "done", response };
    },
  } satisfies StreamingProvider;
}

function makeDeps(opts: {
  responseText: string;
  history?: ConversationMessage[];
  summary?: string | null;
}): {
  deps: ReflectionDeps;
  eventStore: EventStore;
  memory: MemoryGraph;
  state: StateVectorEngine;
} {
  const eventStore = new EventStore(new InMemoryEventStore());
  const memory = new MemoryGraph(new InMemoryMemoryStorage(), eventStore, MOTEBIT_ID);
  const state = new StateVectorEngine();
  const memoryGovernor = new MemoryGovernor();
  const provider = makeProvider(opts.responseText);
  const deps: ReflectionDeps = {
    motebitId: MOTEBIT_ID,
    memory,
    events: eventStore,
    state,
    memoryGovernor,
    getProvider: () => provider,
    getTaskRouter: () => null,
    getConversationSummary: () => opts.summary ?? null,
    getConversationHistory: () => opts.history ?? [],
  };
  return { deps, eventStore, memory, state };
}

const CANONICAL_REFLECTION = `INSIGHTS:
- The user asks about relay_task_id binding 3 times per session on average
- The formMemory call rejected redacted content from the sync path

ADJUSTMENTS:
- Explain relay_task_id proactively at conversation start

ASSESSMENT:
Handled technical questions well, surfaced a specific binding issue.`;

describe("performReflection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the parsed reflection result", async () => {
    const { deps } = makeDeps({ responseText: CANONICAL_REFLECTION });
    const result = await performReflection(deps);
    expect(result.insights).toHaveLength(2);
    expect(result.planAdjustments).toHaveLength(1);
    expect(result.selfAssessment).toContain("technical questions");
  });

  it("throws when no provider is configured", async () => {
    const { deps } = makeDeps({ responseText: CANONICAL_REFLECTION });
    const dead: ReflectionDeps = { ...deps, getProvider: () => null };
    await expect(performReflection(dead)).rejects.toThrow(/No AI provider/);
  });

  it("nudges state — confidence + affect_valence bumped after reflection", async () => {
    const { deps, state } = makeDeps({ responseText: CANONICAL_REFLECTION });
    const pushSpy = vi.spyOn(state, "pushUpdate");
    const before = { ...state.getState() };
    await performReflection(deps);
    // State engine uses EMA smoothing via ticks, so we verify the signal
    // was pushed with the expected deltas rather than polling currentState.
    expect(pushSpy).toHaveBeenCalledTimes(1);
    const partial = pushSpy.mock.calls[0]![0];
    expect(partial.confidence).toBeGreaterThan(before.confidence);
    expect(partial.affect_valence).toBeGreaterThan(before.affect_valence);
    expect(partial.confidence).toBeLessThanOrEqual(1);
    expect(partial.affect_valence).toBeLessThanOrEqual(1);
  });

  it("logs a ReflectionCompleted event containing full payload", async () => {
    const { deps, eventStore } = makeDeps({ responseText: CANONICAL_REFLECTION });
    await performReflection(deps);

    // Allow best-effort async logger to flush
    await new Promise((r) => setTimeout(r, 10));

    const events = await eventStore.query({
      motebit_id: MOTEBIT_ID,
      event_types: [EventType.ReflectionCompleted],
    });
    expect(events.length).toBe(1);
    const payload = events[0]!.payload;
    expect(payload.insights_count).toBe(2);
    expect(payload.adjustments_count).toBe(1);
    expect(Array.isArray(payload.insights)).toBe(true);
    expect(typeof payload.self_assessment).toBe("string");
  });

  it("passes goals through to the provider prompt", async () => {
    const { deps } = makeDeps({ responseText: CANONICAL_REFLECTION });
    const provider = deps.getProvider()!;
    await performReflection(deps, [
      { description: "Ship relay v2", status: "in_progress" },
      { description: "Write shakedown tests", status: "completed" },
    ]);
    const calls = (provider.generate as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const ctx = calls[0]![0] as ContextPack;
    expect(ctx.user_message).toContain("Ship relay v2");
    expect(ctx.user_message).toContain("Write shakedown tests");
    expect(ctx.user_message).toContain("in_progress");
  });

  it("slices history to last 4 when summary is present, full history otherwise", async () => {
    const longHistory: ConversationMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      content: `msg-${i}`,
      timestamp: Date.now(),
    }));

    // With summary: last 4 messages (msg-26 through msg-29)
    const withSummary = makeDeps({
      responseText: CANONICAL_REFLECTION,
      summary: "User asked about X, Y, Z",
      history: longHistory,
    });
    await performReflection(withSummary.deps);
    const summaryCall = (withSummary.deps.getProvider()!.generate as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as ContextPack;
    expect(summaryCall.user_message).toContain("msg-29");
    expect(summaryCall.user_message).toContain("msg-26");
    expect(summaryCall.user_message).not.toContain("msg-25");
    expect(summaryCall.user_message).toContain("User asked about X");

    // Without summary: reflect() caps at last 20 internally
    const noSummary = makeDeps({
      responseText: CANONICAL_REFLECTION,
      summary: null,
      history: longHistory,
    });
    await performReflection(noSummary.deps);
    const noSummaryCall = (noSummary.deps.getProvider()!.generate as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as ContextPack;
    expect(noSummaryCall.user_message).toContain("msg-29");
    expect(noSummaryCall.user_message).toContain("msg-10"); // within last 20
    expect(noSummaryCall.user_message).not.toContain("msg-9");
  });

  it("persists concrete novel insights as semantic memories", async () => {
    const { deps, memory } = makeDeps({ responseText: CANONICAL_REFLECTION });
    await performReflection(deps);

    // Wait a tick for the `void persistHighSignalInsights(...)` promise to settle
    await new Promise((r) => setTimeout(r, 50));

    const exported = await memory.exportAll();
    const reflectionMemories = exported.nodes.filter((n: MemoryNode) =>
      /relay_task_id|formMemory/.test(n.content),
    );
    // At least one of the two concrete insights should land as a memory
    expect(reflectionMemories.length).toBeGreaterThan(0);
    for (const m of reflectionMemories) {
      expect(m.sensitivity).toBe(SensitivityLevel.None);
      expect(m.confidence).toBeCloseTo(0.6);
    }
  });

  it("filters out short generic insights (not concrete)", async () => {
    const generic = `INSIGHTS:
- Be more concise
- Improve responses

ADJUSTMENTS:
- Try harder

ASSESSMENT:
Fine.`;
    const { deps, memory } = makeDeps({ responseText: generic });
    await performReflection(deps);
    await new Promise((r) => setTimeout(r, 50));

    const exported = await memory.exportAll();
    expect(exported.nodes).toHaveLength(0);
  });

  it("returns empty insights when LLM returns no structure", async () => {
    const { deps } = makeDeps({ responseText: "just free-form text" });
    const result = await performReflection(deps);
    expect(result.insights).toHaveLength(0);
    expect(result.planAdjustments).toHaveLength(0);
    expect(result.selfAssessment).toBe("just free-form text");
  });

  it("buildAuditSummary surfaces phantom certainties in the prompt", async () => {
    const { deps, memory } = makeDeps({ responseText: CANONICAL_REFLECTION });

    // Seed an isolated high-confidence node — this triggers a phantom certainty
    // in the memory audit (confidence >= 0.7, decayedConfidence >= 0.5, zero edges).
    await memory.formMemory(
      {
        content: "The deployment uses Ansible playbook v3",
        confidence: 0.95,
        sensitivity: SensitivityLevel.None,
        memory_type: MemoryType.Semantic,
      },
      [1, 0, 0, 0],
    );

    await performReflection(deps);

    const call = (deps.getProvider()!.generate as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as ContextPack;
    expect(call.user_message).toContain("Notable memories this period");
    expect(call.user_message).toMatch(/\[phantom /);
    expect(call.user_message).toContain("Ansible");
  });

  it("includes past reflections section when prior ReflectionCompleted events exist", async () => {
    const { deps, eventStore } = makeDeps({ responseText: CANONICAL_REFLECTION });

    // Seed a prior reflection event
    await eventStore.appendWithClock({
      event_id: crypto.randomUUID(),
      motebit_id: MOTEBIT_ID,
      timestamp: Date.now() - 60_000,
      event_type: EventType.ReflectionCompleted,
      payload: {
        insights: ["Prior insight about user preferences"],
        plan_adjustments: ["Prior adjustment"],
        self_assessment: "Earlier assessment",
      },
      tombstoned: false,
    });

    await performReflection(deps);

    const call = (deps.getProvider()!.generate as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as ContextPack;
    expect(call.user_message).toContain("Past Reflections");
    expect(call.user_message).toContain("Prior insight");
  });
});

describe("defensive paths (best-effort error handling)", () => {
  it("skips insight persistence when embedText rejects", async () => {
    const poisoned = `INSIGHTS:
- ${EMBED_POISON} reference to relay_task_id binding behavior

ADJUSTMENTS:
- None

ASSESSMENT:
Test.`;
    const { deps, memory } = makeDeps({ responseText: poisoned });
    await performReflection(deps);
    await new Promise((r) => setTimeout(r, 50));

    // Insight was concrete (has snake_case) but embedText threw → not persisted
    const exported = await memory.exportAll();
    expect(exported.nodes).toHaveLength(0);
  });

  it("still runs when the memory audit throws (catch swallows)", async () => {
    const { deps } = makeDeps({ responseText: CANONICAL_REFLECTION });

    testFlags.auditThrows = true;
    try {
      const result = await performReflection(deps);
      expect(result.insights).toHaveLength(2);

      // Verify the reflection still fires the LLM call (audit failure must not block)
      const call = (deps.getProvider()!.generate as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as ContextPack;
      // Audit section should NOT be in the prompt since the audit failed
      expect(call.user_message).not.toContain("Notable memories this period");
    } finally {
      testFlags.auditThrows = false;
    }
  });

  it("survives eventStore.query failure in loadPastReflections", async () => {
    const { deps, eventStore } = makeDeps({ responseText: CANONICAL_REFLECTION });
    vi.spyOn(eventStore, "query").mockRejectedValue(new Error("query exploded"));

    const result = await performReflection(deps);
    // Result still returned — past-reflections query failure is silent
    expect(result.insights).toHaveLength(2);

    // No "Past Reflections" section in the prompt since the query failed
    const call = (deps.getProvider()!.generate as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as ContextPack;
    expect(call.user_message).not.toContain("Past Reflections");
  });

  it("survives eventStore.appendWithClock failure in logReflectionCompleted", async () => {
    const { deps, eventStore } = makeDeps({ responseText: CANONICAL_REFLECTION });

    // Only block the ReflectionCompleted append — earlier event activity is fine
    const originalAppend = eventStore.appendWithClock.bind(eventStore);
    vi.spyOn(eventStore, "appendWithClock").mockImplementation(async (entry) => {
      if (entry.event_type === EventType.ReflectionCompleted) {
        throw new Error("append exploded");
      }
      return originalAppend(entry);
    });

    const result = await performReflection(deps);
    expect(result.insights).toHaveLength(2);
    // Allow the best-effort append to resolve/reject
    await new Promise((r) => setTimeout(r, 10));
  });

  it("swallows persistence errors without affecting the return value", async () => {
    const { deps, memory } = makeDeps({ responseText: CANONICAL_REFLECTION });

    // Force formMemory to throw on every call — persistence fails completely
    const formSpy = vi.spyOn(memory, "formMemory").mockRejectedValue(new Error("DB unreachable"));

    const result = await performReflection(deps);
    expect(result.insights).toHaveLength(2);
    expect(result.selfAssessment).toContain("technical questions");
    formSpy.mockRestore();
  });

  it("skips insight that matches a prior reflection pattern (repeated)", async () => {
    const { deps, memory, eventStore } = makeDeps({ responseText: CANONICAL_REFLECTION });

    // Seed enough prior reflections with the same insight that
    // detectReflectionPatterns surfaces it, making the current insight
    // "repeated." detectReflectionPatterns needs >= 2 occurrences.
    const seedInsight = "The user asks about relay_task_id binding 3 times per session on average";
    for (let i = 0; i < 3; i++) {
      await eventStore.appendWithClock({
        event_id: crypto.randomUUID(),
        motebit_id: MOTEBIT_ID,
        timestamp: Date.now() - (i + 1) * 60_000,
        event_type: EventType.ReflectionCompleted,
        payload: {
          insights: [seedInsight],
          plan_adjustments: [],
          self_assessment: "",
        },
        tombstoned: false,
      });
    }

    await performReflection(deps);
    await new Promise((r) => setTimeout(r, 50));

    // The repeated insight should NOT have been persisted as a memory
    const exported = await memory.exportAll();
    const matching = exported.nodes.filter((n: MemoryNode) => n.content === seedInsight);
    expect(matching).toHaveLength(0);
  });

  it("skips insight that is too similar to an existing memory (not novel)", async () => {
    const { deps, memory } = makeDeps({ responseText: CANONICAL_REFLECTION });

    // Pre-seed memories with the exact same content — the novelty check
    // should detect the match (cosine ~1.0) and skip persistence.
    const { embedTextHash } =
      await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
    for (const insight of [
      "The user asks about relay_task_id binding 3 times per session on average",
      "The formMemory call rejected redacted content from the sync path",
    ]) {
      await memory.formMemory(
        {
          content: insight,
          confidence: 0.9,
          sensitivity: SensitivityLevel.None,
          memory_type: MemoryType.Semantic,
        },
        embedTextHash(insight),
      );
    }

    const before = (await memory.exportAll()).nodes.length;
    await performReflection(deps);
    await new Promise((r) => setTimeout(r, 50));

    // No duplicates added
    const after = (await memory.exportAll()).nodes.length;
    expect(after).toBe(before);
  });

  it("loadPastReflections handles events with only insights (no plan_adjustments)", async () => {
    const { deps, eventStore } = makeDeps({ responseText: CANONICAL_REFLECTION });

    // Event with insights only — exercises the plan_adjustments ?? [] fallback
    await eventStore.appendWithClock({
      event_id: crypto.randomUUID(),
      motebit_id: MOTEBIT_ID,
      timestamp: Date.now() - 60_000,
      event_type: EventType.ReflectionCompleted,
      payload: {
        insights: ["one insight"],
        // No plan_adjustments, no self_assessment
      },
      tombstoned: false,
    });

    await performReflection(deps);
    const call = (deps.getProvider()!.generate as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as ContextPack;
    expect(call.user_message).toContain("one insight");
  });

  it("skips insight when the memory governor rejects it", async () => {
    const { deps, memory } = makeDeps({ responseText: CANONICAL_REFLECTION });

    // Force the governor to reject every candidate
    vi.spyOn(deps.memoryGovernor, "evaluate").mockReturnValue([]);

    const before = (await memory.exportAll()).nodes.length;
    await performReflection(deps);
    await new Promise((r) => setTimeout(r, 50));

    // Nothing persisted — governor returned no decisions
    const after = (await memory.exportAll()).nodes.length;
    expect(after).toBe(before);
  });

  it("loadPastReflections handles events with only plan_adjustments", async () => {
    const { deps, eventStore } = makeDeps({ responseText: CANONICAL_REFLECTION });

    // Event with plan_adjustments but no insights — exercises the filter's
    // second arm (`Array.isArray(e.payload.plan_adjustments)`).
    await eventStore.appendWithClock({
      event_id: crypto.randomUUID(),
      motebit_id: MOTEBIT_ID,
      timestamp: Date.now() - 60_000,
      event_type: EventType.ReflectionCompleted,
      payload: {
        plan_adjustments: ["adjust something"],
        // No `insights` field, no `self_assessment` → exercise the ?? "" fallback
      },
      tombstoned: false,
    });

    await performReflection(deps);
    const call = (deps.getProvider()!.generate as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as ContextPack;
    expect(call.user_message).toContain("Past Reflections");
    expect(call.user_message).toContain("adjust something");
  });

  it("swallows top-level persistence setup failure (patterns throw)", async () => {
    const { deps } = makeDeps({ responseText: CANONICAL_REFLECTION });

    testFlags.patternsThrows = true;
    try {
      const result = await performReflection(deps);
      // Main reflection return is unaffected even though the pattern-check
      // setup in persistHighSignalInsights exploded
      expect(result.insights).toHaveLength(2);
    } finally {
      testFlags.patternsThrows = false;
    }
  });
});

describe("runReflectionSafe", () => {
  it("swallows errors from missing provider", async () => {
    const { deps } = makeDeps({ responseText: CANONICAL_REFLECTION });
    const dead: ReflectionDeps = { ...deps, getProvider: () => null };
    // Should not throw
    await expect(runReflectionSafe(dead)).resolves.toBeUndefined();
  });

  it("swallows errors from provider rejection", async () => {
    const { deps } = makeDeps({ responseText: CANONICAL_REFLECTION });
    const broken: StreamingProvider = {
      ...deps.getProvider()!,
      generate: () => Promise.reject(new Error("rate limit")),
    };
    const failing: ReflectionDeps = { ...deps, getProvider: () => broken };
    await expect(runReflectionSafe(failing)).resolves.toBeUndefined();
  });

  it("runs to completion on the happy path", async () => {
    const { deps, state } = makeDeps({ responseText: CANONICAL_REFLECTION });
    const pushSpy = vi.spyOn(state, "pushUpdate");
    await runReflectionSafe(deps);
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });
});
