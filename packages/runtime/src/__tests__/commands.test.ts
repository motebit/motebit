import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeCommand } from "../commands/index";
import { PlanExecutionVM } from "../commands/plans";
import type { PlanChunk } from "@motebit/planner";
import type { MotebitRuntime } from "../index";

// === Minimal runtime mock ===

function mockRuntime(overrides: Partial<Record<string, unknown>> = {}): MotebitRuntime {
  return {
    getState: () => ({ attention: 0.7, confidence: 0.85, affect_valence: 0.3 }),
    currentModel: "claude-sonnet-4-6",
    getToolRegistry: () => ({ list: () => [{ name: "web_search" }, { name: "recall_memories" }] }),
    getCuriosityTargets: () => [],
    getGradient: () => null,
    getGradientSummary: () => ({
      posture: "stable",
      snapshotCount: 0,
      trajectory: "",
      overall: "",
      strengths: [],
      weaknesses: [],
    }),
    getLastReflection: () => null,
    hasPendingApproval: false,
    pendingApprovalInfo: null,
    listConversations: () => [],
    memory: {
      exportAll: async () => ({ nodes: [], edges: [] }),
      deleteMemory: vi.fn(),
    },
    auditMemory: async () => ({
      phantomCertainties: [],
      conflicts: [],
      nearDeath: [],
      nodesAudited: 0,
    }),
    reflect: async () => ({
      selfAssessment: "All systems nominal.",
      insights: ["Memory consolidation effective"],
      planAdjustments: [],
      patterns: [],
    }),
    summarizeCurrentConversation: async () => "User discussed project architecture.",
    ...overrides,
  } as unknown as MotebitRuntime;
}

// === CommandResult snapshot tests ===

describe("executeCommand", () => {
  it("returns null for unknown commands", async () => {
    const result = await executeCommand(mockRuntime(), "nonexistent");
    expect(result).toBeNull();
  });

  it("returns null for surface-specific commands (mcp)", async () => {
    const result = await executeCommand(mockRuntime(), "mcp");
    expect(result).toBeNull();
  });

  describe("system commands", () => {
    it("state: returns summary + detail with dimensions", async () => {
      const result = await executeCommand(mockRuntime(), "state");
      expect(result).toMatchObject({
        summary: "State vector — 3 dimensions",
      });
      expect(result!.detail).toContain("attention: 0.700");
      expect(result!.detail).toContain("confidence: 0.850");
      expect(result!.data).toHaveProperty("state");
    });

    it("model: returns current model name", async () => {
      const result = await executeCommand(mockRuntime(), "model");
      expect(result).toMatchObject({
        summary: "Current model: claude-sonnet-4-6",
      });
    });

    it("model: handles no model", async () => {
      const result = await executeCommand(mockRuntime({ currentModel: null }), "model");
      expect(result!.summary).toBe("No model connected.");
    });

    it("tools: lists registered tools", async () => {
      const result = await executeCommand(mockRuntime(), "tools");
      expect(result!.summary).toContain("2 tools registered");
      expect(result!.summary).toContain("web_search");
    });

    it("approvals: reports no pending", async () => {
      const result = await executeCommand(mockRuntime(), "approvals");
      expect(result!.summary).toBe("No pending approvals.");
    });

    it("approvals: reports pending tool", async () => {
      const result = await executeCommand(
        mockRuntime({
          hasPendingApproval: true,
          pendingApprovalInfo: { toolName: "shell_exec", args: { command: "ls" } },
        }),
        "approvals",
      );
      expect(result!.summary).toBe("Pending approval: shell_exec");
      expect(result!.detail).toContain("ls");
    });

    it("conversations: handles empty list", async () => {
      const result = await executeCommand(mockRuntime(), "conversations");
      expect(result!.summary).toBe("No previous conversations.");
    });

    it("summarize: returns conversation summary", async () => {
      const result = await executeCommand(mockRuntime(), "summarize");
      expect(result!.summary).toBe("User discussed project architecture.");
    });
  });

  describe("memory commands", () => {
    it("memories: handles empty graph", async () => {
      const result = await executeCommand(mockRuntime(), "memories");
      expect(result!.summary).toBe("No memories stored yet.");
    });

    it("curious: reports stable graph", async () => {
      const result = await executeCommand(mockRuntime(), "curious");
      expect(result!.summary).toContain("stable");
    });

    it("forget: requires keyword", async () => {
      const result = await executeCommand(mockRuntime(), "forget");
      expect(result!.summary).toContain("Specify what to forget");
    });

    it("forget: reports no match", async () => {
      const result = await executeCommand(mockRuntime(), "forget", "nonexistent");
      expect(result!.summary).toContain("No memory matching");
    });

    it("audit: reports clean audit", async () => {
      const rt = mockRuntime({
        auditMemory: async () => ({
          phantomCertainties: [],
          conflicts: [],
          nearDeath: [],
          nodesAudited: 42,
        }),
      });
      const result = await executeCommand(rt, "audit");
      expect(result!.summary).toBe("Audit clean — 42 nodes, no issues.");
    });

    it("audit: reports issues with IDs", async () => {
      const rt = mockRuntime({
        auditMemory: async () => ({
          phantomCertainties: [{ node: { node_id: "p1" } }],
          conflicts: [{ a: { node_id: "c1" }, b: { node_id: "c2" } }],
          nearDeath: [],
          nodesAudited: 100,
        }),
      });
      const result = await executeCommand(rt, "audit");
      expect(result!.summary).toContain("1 phantom");
      expect(result!.summary).toContain("1 conflict");
      expect(result!.data!["phantomIds"]).toEqual(["p1"]);
      expect(result!.data!["conflictIds"]).toEqual(["c1", "c2"]);
    });
  });

  describe("intelligence commands", () => {
    it("gradient: handles no data", async () => {
      const result = await executeCommand(mockRuntime(), "gradient");
      expect(result!.summary).toBe("No gradient data yet.");
    });

    it("reflect: returns assessment + insights", async () => {
      const result = await executeCommand(mockRuntime(), "reflect");
      expect(result!.summary).toBe("All systems nominal.");
      expect(result!.detail).toContain("Memory consolidation effective");
    });
  });

  describe("memory commands (with data)", () => {
    const memoryRuntime = () =>
      mockRuntime({
        memory: {
          exportAll: async () => ({
            nodes: [
              {
                node_id: "n1",
                content: "Meeting with Alice about API design",
                confidence: 0.9,
                tombstoned: false,
                valid_until: null,
                pinned: true,
              },
              {
                node_id: "n2",
                content: "Bob prefers REST over GraphQL",
                confidence: 0.6,
                tombstoned: false,
                valid_until: null,
                pinned: false,
              },
              {
                node_id: "n3",
                content: "Old note",
                confidence: 0.1,
                tombstoned: true,
                valid_until: null,
                pinned: false,
              },
            ],
            edges: [
              { relation_type: "related_to" },
              { relation_type: "related_to" },
              { relation_type: "contradicts" },
            ],
          }),
          deleteMemory: vi.fn(),
        },
      });

    it("memories: returns active count and top content", async () => {
      const result = await executeCommand(memoryRuntime(), "memories");
      expect(result!.summary).toContain("2 active memories");
      expect(result!.summary).toContain("3 edges");
      expect(result!.detail).toContain("Meeting with Alice");
    });

    it("graph: returns node/edge/pinned breakdown", async () => {
      const result = await executeCommand(memoryRuntime(), "graph");
      expect(result!.summary).toContain("2 nodes");
      expect(result!.summary).toContain("3 edges");
      expect(result!.summary).toContain("1 pinned");
      expect(result!.detail).toContain("related_to: 2");
      expect(result!.detail).toContain("contradicts: 1");
    });

    it("curious: returns targets when present", async () => {
      const rt = mockRuntime({
        getCuriosityTargets: () => [
          { node: { content: "Fading memory about deployment" }, curiosityScore: 0.8 },
          {
            node: {
              content:
                "Another fading one that is quite long and should be truncated at eighty characters for display",
            },
            curiosityScore: 0.5,
          },
        ],
      });
      const result = await executeCommand(rt, "curious");
      expect(result!.summary).toContain("2 curiosity targets");
      expect(result!.detail).toContain("Fading memory about deployment");
    });

    it("forget: deletes matching memory", async () => {
      const rt = memoryRuntime();
      const result = await executeCommand(rt, "forget", "Alice");
      expect(result!.summary).toContain("Forgot:");
      expect(result!.summary).toContain("Meeting with Alice");
      expect(result!.data!["deletedId"]).toBe("n1");
    });
  });

  describe("intelligence commands (with data)", () => {
    it("gradient: returns full detail with economic consequences", async () => {
      const rt = mockRuntime({
        getGradient: () => ({
          gradient: 0.72,
          delta: 0.05,
          experience: 0.8,
          resilience: 0.6,
          valence_bias: 0.1,
          curiosity_drive: 0.5,
          trust_tendency: 0.7,
          autonomy: 0.4,
        }),
        getGradientSummary: () => ({
          posture: "growth",
          snapshotCount: 5,
          trajectory: "Improving steadily",
          overall: "Strong operational state",
          strengths: ["memory consolidation"],
          weaknesses: ["exploration breadth"],
        }),
        getLastReflection: () => ({ selfAssessment: "Operating well" }),
      });
      const result = await executeCommand(rt, "gradient");
      expect(result!.summary).toContain("0.720");
      expect(result!.summary).toContain("+0.050");
      expect(result!.summary).toContain("growth");
      expect(result!.detail).toContain("Improving steadily");
      expect(result!.detail).toContain("Strengths: memory consolidation");
      expect(result!.detail).toContain("Weaknesses: exploration breadth");
      expect(result!.detail).toContain("Operating well");
    });

    it("reflect: returns adjustments and patterns", async () => {
      const rt = mockRuntime({
        reflect: async () => ({
          selfAssessment: "Needs improvement",
          insights: ["Insight A"],
          planAdjustments: ["Adjust B"],
          patterns: ["Pattern C"],
        }),
      });
      const result = await executeCommand(rt, "reflect");
      expect(result!.detail).toContain("Adjust B");
      expect(result!.detail).toContain("Pattern C");
      expect(result!.data!["adjustments"]).toEqual(["Adjust B"]);
    });
  });

  describe("conversations command (with data)", () => {
    it("returns conversation list", async () => {
      const rt = mockRuntime({
        listConversations: () => [
          {
            conversationId: "c1",
            startedAt: Date.now() - 86400000,
            lastActiveAt: Date.now(),
            title: "API Design",
            messageCount: 12,
          },
          {
            conversationId: "c2",
            startedAt: Date.now() - 172800000,
            lastActiveAt: Date.now() - 86400000,
            title: null,
            messageCount: 3,
          },
        ],
      });
      const result = await executeCommand(rt, "conversations");
      expect(result!.summary).toBe("2 conversations");
      expect(result!.detail).toContain("API Design (12 messages)");
      expect(result!.detail).toContain("Untitled");
    });
  });

  describe("relay commands", () => {
    it("balance: returns not connected without relay", async () => {
      const result = await executeCommand(mockRuntime(), "balance");
      expect(result!.summary).toBe("Not connected to relay.");
    });

    it("deposits: returns not connected without relay", async () => {
      const result = await executeCommand(mockRuntime(), "deposits");
      expect(result!.summary).toBe("Not connected to relay.");
    });

    it("discover: returns not connected without relay", async () => {
      const result = await executeCommand(mockRuntime(), "discover");
      expect(result!.summary).toBe("Not connected to relay.");
    });

    it("proposals: returns not connected without relay", async () => {
      const result = await executeCommand(mockRuntime(), "proposals");
      expect(result!.summary).toBe("Not connected to relay.");
    });

    it("withdraw: returns CLI instruction", async () => {
      const result = await executeCommand(mockRuntime(), "withdraw");
      expect(result!.summary).toContain("motebit withdraw");
    });

    it("delegate: returns info message", async () => {
      const result = await executeCommand(mockRuntime(), "delegate");
      expect(result!.summary).toContain("transparently");
    });

    it("propose: returns CLI instruction", async () => {
      const result = await executeCommand(mockRuntime(), "propose");
      expect(result!.summary).toContain("motebit propose");
    });
  });
});

// === PlanExecutionVM tests ===

describe("PlanExecutionVM", () => {
  let evm: PlanExecutionVM;

  beforeEach(() => {
    evm = new PlanExecutionVM();
  });

  it("starts idle", () => {
    expect(evm.snapshot().status).toBe("idle");
  });

  it("transitions to running on plan_created", () => {
    evm.apply({
      type: "plan_created",
      plan: { title: "Research task", total_steps: 3 } as never,
      steps: [{ step_id: "s1" }, { step_id: "s2" }, { step_id: "s3" }] as never,
    });
    const snap = evm.snapshot();
    expect(snap.status).toBe("running");
    expect(snap.title).toBe("Research task");
    expect(snap.progress).toEqual({ completed: 0, total: 3 });
  });

  it("tracks step progress", () => {
    evm.apply({
      type: "plan_created",
      plan: { title: "Test", total_steps: 2 } as never,
      steps: [{ step_id: "s1" }, { step_id: "s2" }] as never,
    });
    evm.apply({
      type: "step_started",
      step: { step_id: "s1", description: "First step" } as never,
    });
    expect(evm.snapshot().currentStep).toEqual({ id: "s1", description: "First step" });

    evm.apply({
      type: "step_completed",
      step: { step_id: "s1", description: "First step" } as never,
    });
    expect(evm.snapshot().progress).toEqual({ completed: 1, total: 2 });
    expect(evm.snapshot().currentStep).toBeNull();
  });

  it("handles plan_completed", () => {
    evm.apply({
      type: "plan_created",
      plan: { title: "Done", total_steps: 1 } as never,
      steps: [{ step_id: "s1" }] as never,
    });
    evm.apply({
      type: "step_completed",
      step: { step_id: "s1", description: "Only step" } as never,
    });
    evm.apply({ type: "plan_completed", plan: { title: "Done" } as never });
    expect(evm.snapshot().status).toBe("completed");
  });

  it("handles plan_failed", () => {
    evm.apply({
      type: "plan_created",
      plan: { title: "Fail", total_steps: 1 } as never,
      steps: [{ step_id: "s1" }] as never,
    });
    evm.apply({
      type: "plan_failed",
      plan: { title: "Fail" } as never,
      reason: "Provider timeout",
    });
    const snap = evm.snapshot();
    expect(snap.status).toBe("failed");
    expect(snap.failureReason).toBe("Provider timeout");
  });

  it("resets progress on plan_retrying", () => {
    evm.apply({
      type: "plan_created",
      plan: { title: "V1", total_steps: 3 } as never,
      steps: [{ step_id: "s1" }, { step_id: "s2" }, { step_id: "s3" }] as never,
    });
    evm.apply({
      type: "step_completed",
      step: { step_id: "s1", description: "Done" } as never,
    });
    expect(evm.snapshot().progress.completed).toBe(1);

    evm.apply({
      type: "plan_retrying",
      failedPlan: { title: "V1" } as never,
      newPlan: { title: "V2", total_steps: 2 } as never,
    });
    const snap = evm.snapshot();
    expect(snap.status).toBe("running");
    expect(snap.title).toBe("V2");
    expect(snap.progress).toEqual({ completed: 0, total: 2 });
  });

  it("captures reflection", () => {
    evm.apply({
      type: "reflection" as PlanChunk["type"],
      result: { summary: "Good execution", memoryCandidates: [] },
    } as PlanChunk);
    expect(evm.snapshot().reflection).toBe("Good execution");
  });

  it("caps recent events", () => {
    evm.apply({
      type: "plan_created",
      plan: { title: "Big", total_steps: 25 } as never,
      steps: Array.from({ length: 25 }, (_, i) => ({ step_id: `s${i}` })) as never,
    });
    // Generate 25 step_started + step_completed = 50 events + 1 plan_created = 51
    for (let i = 0; i < 25; i++) {
      evm.apply({
        type: "step_started",
        step: { step_id: `s${i}`, description: `Step ${i}` } as never,
      });
      evm.apply({
        type: "step_completed",
        step: { step_id: `s${i}`, description: `Step ${i}` } as never,
      });
    }
    // Should be capped at 20
    expect(evm.snapshot().recentEvents.length).toBeLessThanOrEqual(20);
  });

  it("reset clears all state", () => {
    evm.apply({
      type: "plan_created",
      plan: { title: "Test", total_steps: 1 } as never,
      steps: [{ step_id: "s1" }] as never,
    });
    evm.reset();
    const snap = evm.snapshot();
    expect(snap.status).toBe("idle");
    expect(snap.title).toBe("");
    expect(snap.recentEvents).toHaveLength(0);
  });

  it("ignores step_chunk and plan_truncated", () => {
    const before = evm.snapshot();
    evm.apply({ type: "step_chunk", chunk: {} } as PlanChunk);
    evm.apply({ type: "plan_truncated", requestedSteps: 10, maxSteps: 5 } as PlanChunk);
    const after = evm.snapshot();
    expect(after.status).toBe(before.status);
    expect(after.recentEvents).toHaveLength(0);
  });
});
