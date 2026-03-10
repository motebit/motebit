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

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";

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

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

describe("Runtime housekeeping — memory retention enforcement", () => {
  let runtime: MotebitRuntime;

  beforeEach(() => {
    runtime = new MotebitRuntime(
      { motebitId: "hk-test", tickRateHz: 0 },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: createMockProvider(),
      },
    );
  });

  it("tombstones decayed memory below persistence threshold", async () => {
    // Form a memory with low confidence and short half-life, backdated so it's decayed
    const embedding = new Array(384).fill(0.1);
    const node = await runtime.memory.formMemory(
      { content: "old fact", confidence: 0.6, sensitivity: SensitivityLevel.None },
      embedding,
      SEVEN_DAYS,
    );

    // Backdate created_at and last_accessed to 30 days ago (well past half-life)
    // Access the storage directly through exportAll to verify node exists
    const before = await runtime.memory.exportAll();
    expect(before.nodes.filter((n) => !n.tombstoned)).toHaveLength(1);

    // Override timestamps to simulate aging — mutate via storage adapter
    // The node's confidence is 0.6, half_life is 7d. After 30 days (~4.3 half-lives):
    // decayed = 0.6 * 0.5^(30/7) = 0.6 * 0.5^4.28 ≈ 0.031
    // Default persistence threshold is 0.5, so 0.031 < 0.5 → tombstone
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    node.last_accessed = thirtyDaysAgo;
    node.created_at = thirtyDaysAgo;
    // Save the backdated node (InMemoryMemoryStorage stores by reference after formMemory,
    // but we re-save to be explicit)
    await (runtime as any).memory["storage"].saveNode(node);

    await runtime.housekeeping();

    const after = await runtime.memory.exportAll();
    const alive = after.nodes.filter((n) => !n.tombstoned);
    expect(alive).toHaveLength(0);

    // Verify the tombstoned node is still in storage (soft delete)
    const tombstoned = after.nodes.filter((n) => n.tombstoned);
    expect(tombstoned).toHaveLength(1);
  });

  it("preserves pinned memory even when decayed", async () => {
    const embedding = new Array(384).fill(0.1);
    const node = await runtime.memory.formMemory(
      { content: "important pinned fact", confidence: 0.6, sensitivity: SensitivityLevel.None },
      embedding,
      SEVEN_DAYS,
    );

    // Pin the memory
    await runtime.memory.pinMemory(node.node_id, true);

    // Backdate to 30 days ago — would be below threshold if not pinned
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    node.last_accessed = thirtyDaysAgo;
    node.created_at = thirtyDaysAgo;
    node.pinned = true;
    await (runtime as any).memory["storage"].saveNode(node);

    await runtime.housekeeping();

    const after = await runtime.memory.exportAll();
    const alive = after.nodes.filter((n) => !n.tombstoned);
    expect(alive).toHaveLength(1);
    expect(alive[0]!.content).toBe("important pinned fact");
  });

  it("preserves fresh memory above threshold", async () => {
    const embedding = new Array(384).fill(0.1);
    await runtime.memory.formMemory(
      { content: "fresh fact", confidence: 0.9, sensitivity: SensitivityLevel.None },
      embedding,
      SEVEN_DAYS,
    );

    // Memory just created — confidence 0.9, elapsed ~0ms, decayed ≈ 0.9 > 0.5 threshold
    await runtime.housekeeping();

    const after = await runtime.memory.exportAll();
    const alive = after.nodes.filter((n) => !n.tombstoned);
    expect(alive).toHaveLength(1);
    expect(alive[0]!.content).toBe("fresh fact");
  });

  it("tombstones old memory even if recently accessed", async () => {
    // Regression: decay must use created_at, not last_accessed.
    // A memory created 30 days ago but accessed 1 minute ago should still decay
    // based on creation time.
    const embedding = new Array(384).fill(0.1);
    const node = await runtime.memory.formMemory(
      { content: "old but accessed", confidence: 0.6, sensitivity: SensitivityLevel.None },
      embedding,
      SEVEN_DAYS,
    );

    // Backdate created_at to 30 days ago, but keep last_accessed recent
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    node.created_at = thirtyDaysAgo;
    node.last_accessed = Date.now(); // accessed just now
    await (runtime as any).memory["storage"].saveNode(node);

    await runtime.housekeeping();

    const after = await runtime.memory.exportAll();
    const alive = after.nodes.filter((n) => !n.tombstoned);
    expect(alive).toHaveLength(0);
  });

  it("tombstones memory exceeding sensitivity retention period", async () => {
    const embedding = new Array(384).fill(0.1);
    const node = await runtime.memory.formMemory(
      { content: "medical record", confidence: 0.9, sensitivity: SensitivityLevel.Medical },
      embedding,
      SEVEN_DAYS * 100, // Very long half-life so decay alone wouldn't tombstone
    );

    // Backdate to 100 days ago — exceeds medical retention of 90 days
    const hundredDaysAgo = Date.now() - 100 * 24 * 60 * 60 * 1000;
    node.last_accessed = hundredDaysAgo;
    node.created_at = hundredDaysAgo;
    await (runtime as any).memory["storage"].saveNode(node);

    await runtime.housekeeping();

    const after = await runtime.memory.exportAll();
    const alive = after.nodes.filter((n) => !n.tombstoned);
    expect(alive).toHaveLength(0);
  });

  it("preserves medical memory within retention period", async () => {
    const embedding = new Array(384).fill(0.1);
    const node = await runtime.memory.formMemory(
      { content: "recent medical note", confidence: 0.9, sensitivity: SensitivityLevel.Medical },
      embedding,
      SEVEN_DAYS * 100,
    );

    // Backdate to 30 days ago — within 90-day medical retention
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    node.last_accessed = thirtyDaysAgo;
    node.created_at = thirtyDaysAgo;
    await (runtime as any).memory["storage"].saveNode(node);

    await runtime.housekeeping();

    const after = await runtime.memory.exportAll();
    const alive = after.nodes.filter((n) => !n.tombstoned);
    expect(alive).toHaveLength(1);
  });

  it("tombstones secret memory exceeding 30-day retention", async () => {
    const embedding = new Array(384).fill(0.1);
    const node = await runtime.memory.formMemory(
      { content: "secret data", confidence: 0.9, sensitivity: SensitivityLevel.Secret },
      embedding,
      SEVEN_DAYS * 100,
    );

    // Backdate to 45 days ago — exceeds secret retention of 30 days
    const fortyFiveDaysAgo = Date.now() - 45 * 24 * 60 * 60 * 1000;
    node.last_accessed = fortyFiveDaysAgo;
    node.created_at = fortyFiveDaysAgo;
    await (runtime as any).memory["storage"].saveNode(node);

    await runtime.housekeeping();

    const after = await runtime.memory.exportAll();
    const alive = after.nodes.filter((n) => !n.tombstoned);
    expect(alive).toHaveLength(0);
  });

  it("does not tombstone SensitivityLevel.None memories by retention (Infinity)", async () => {
    const embedding = new Array(384).fill(0.1);
    const node = await runtime.memory.formMemory(
      { content: "timeless fact", confidence: 0.9, sensitivity: SensitivityLevel.None },
      embedding,
      SEVEN_DAYS * 1000, // Extremely long half-life
    );

    // Backdate to 1000 days ago — no retention limit for None
    const longAgo = Date.now() - 1000 * 24 * 60 * 60 * 1000;
    node.last_accessed = longAgo;
    node.created_at = longAgo;
    await (runtime as any).memory["storage"].saveNode(node);

    await runtime.housekeeping();

    const after = await runtime.memory.exportAll();
    const alive = after.nodes.filter((n) => !n.tombstoned);
    expect(alive).toHaveLength(1);
  });

  it("emits HousekeepingRun event with correct counts", async () => {
    const embedding = new Array(384).fill(0.1);

    // Create 3 memories: one fresh, one decayed, one retention-expired
    await runtime.memory.formMemory(
      { content: "fresh", confidence: 0.9, sensitivity: SensitivityLevel.None },
      embedding,
      SEVEN_DAYS,
    );

    const decayed = await runtime.memory.formMemory(
      { content: "decayed", confidence: 0.6, sensitivity: SensitivityLevel.None },
      embedding,
      SEVEN_DAYS,
    );
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    decayed.last_accessed = thirtyDaysAgo;
    decayed.created_at = thirtyDaysAgo;
    await (runtime as any).memory["storage"].saveNode(decayed);

    const expired = await runtime.memory.formMemory(
      { content: "expired medical", confidence: 0.9, sensitivity: SensitivityLevel.Medical },
      embedding,
      SEVEN_DAYS * 100,
    );
    const hundredDaysAgo = Date.now() - 100 * 24 * 60 * 60 * 1000;
    expired.last_accessed = hundredDaysAgo;
    expired.created_at = hundredDaysAgo;
    await (runtime as any).memory["storage"].saveNode(expired);

    await runtime.housekeeping();

    // Check events
    const events = await runtime.events.query({ motebit_id: "hk-test" });
    const hkEvents = events.filter((e) => e.event_type === EventType.HousekeepingRun);
    expect(hkEvents).toHaveLength(1);
    expect(hkEvents[0]!.payload).toMatchObject({
      source: "memory_housekeeping",
      total_memories: 3,
      tombstoned_decay: 1,
      tombstoned_retention: 1,
      skipped_pinned: 0,
    });
  });

  it("is called on stop() (best-effort, does not throw)", () => {
    const hkSpy = vi.spyOn(runtime, "housekeeping").mockResolvedValue(undefined);

    runtime.start();
    runtime.stop();

    expect(hkSpy).toHaveBeenCalledTimes(1);
  });

  it("does not crash if housekeeping throws internally", async () => {
    // Force exportAll to reject
    vi.spyOn(runtime.memory, "exportAll").mockRejectedValue(new Error("storage failure"));

    // Should not throw — best-effort
    await expect(runtime.housekeeping()).resolves.toBeUndefined();
  });

  it("respects custom persistence threshold from memoryGovernance config", async () => {
    // Create runtime with very low threshold (0.01)
    const rt = new MotebitRuntime(
      { motebitId: "low-thresh", tickRateHz: 0, memoryGovernance: { persistenceThreshold: 0.01 } },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: createMockProvider(),
      },
    );

    const embedding = new Array(384).fill(0.1);
    const node = await rt.memory.formMemory(
      { content: "moderately old", confidence: 0.6, sensitivity: SensitivityLevel.None },
      embedding,
      SEVEN_DAYS,
    );

    // 15 days ago — decayed = 0.6 * 0.5^(15/7) ≈ 0.6 * 0.22 ≈ 0.13
    // 0.13 > 0.01 threshold → should survive
    const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
    node.last_accessed = fifteenDaysAgo;
    node.created_at = fifteenDaysAgo;
    await (rt as any).memory["storage"].saveNode(node);

    await rt.housekeeping();

    const after = await rt.memory.exportAll();
    const alive = after.nodes.filter((n) => !n.tombstoned);
    expect(alive).toHaveLength(1);
  });
});
