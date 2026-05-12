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

    // /welcome — Phase 1 of the onboarding arc. A calm one-message tour
    // that names the three thesis pillars and points to universal slash
    // commands every surface ships. Discovery affordance for the
    // architecture's accumulated state.
    describe("welcome", () => {
      it("returns a calm summary that opens the tour", async () => {
        const result = await executeCommand(mockRuntime(), "welcome");
        expect(result!.summary).toContain("Welcome");
        expect(result!.summary).toContain("motebit");
      });

      it("detail names the sovereign-identity pillar", async () => {
        const result = await executeCommand(mockRuntime(), "welcome");
        expect(result!.detail).toContain("cryptographic identity");
        expect(result!.detail).toContain("sovereign");
      });

      it("detail points to universal slash commands as concrete affordances", async () => {
        const result = await executeCommand(mockRuntime(), "welcome");
        // The four universal commands every surface ships — the
        // cross-surface contract `check-trust-slash-cross-surface`
        // locks for /trust extends in spirit to these.
        expect(result!.detail).toContain("/trust");
        expect(result!.detail).toContain("/memories");
        expect(result!.detail).toContain("/forget");
        expect(result!.detail).toContain("/help");
      });

      it("detail closes with an invitation, not a feature inventory", async () => {
        const result = await executeCommand(mockRuntime(), "welcome");
        // Calm-software register — the tour ends with "ask me anything"
        // not "here's the full list of capabilities."
        expect(result!.detail).toMatch(/ask me/i);
      });

      it("does not depend on runtime state — works pre-bootstrap", async () => {
        // The welcome message is independent of memories / conversations
        // / receipts; a brand-new motebit gets the same tour as one
        // that has been running for months.
        const result = await executeCommand(mockRuntime(), "welcome");
        expect(result!.summary).toBeTruthy();
        expect(result!.detail).toBeTruthy();
      });
    });

    // /trust — the trust-accumulation visibility arc. The shared
    // command aggregates five dimensions: memories, conversations,
    // signed receipts (accumulation pillar), signed deletions
    // (governance pillar), federation peers (network pillar).
    // Surface-specific overlays (cookies on web) layer on top in the
    // surface's slash-command.
    describe("trust", () => {
      // Default empty-everything stubs the new dimensions use.
      const emptyAudit = { query: async () => [] };
      const emptyAgents = async () => [];

      it("reports the empty-accumulation case", async () => {
        const result = await executeCommand(
          mockRuntime({
            motebitId: "did:motebit:0xtest",
            listConversations: () => [],
            getRecentReceipts: () => [],
            memory: { exportAll: async () => ({ nodes: [], edges: [] }) },
            auditLog: emptyAudit,
            listTrustedAgents: emptyAgents,
          }),
          "trust",
        );
        expect(result!.summary).toContain("hasn't accumulated state yet");
        expect(result!.data).toMatchObject({
          trust: { memories: 0, conversations: 0, receipts: 0, deletions: 0, peers: 0 },
        });
      });

      it("aggregates memories + conversations + receipts when present", async () => {
        const result = await executeCommand(
          mockRuntime({
            motebitId: "did:motebit:0xtest",
            listConversations: () => [
              { id: "c1", startedAt: 0, messageCount: 5 },
              { id: "c2", startedAt: 0, messageCount: 3 },
            ],
            getRecentReceipts: () => [
              { tool_name: "click_element", status: "completed" },
              { tool_name: "type_into", status: "completed" },
              { tool_name: "navigate", status: "completed" },
            ],
            memory: {
              exportAll: async () => ({
                nodes: [
                  { node_id: "n1", sensitivity: "personal" },
                  { node_id: "n2", sensitivity: "personal" },
                  { node_id: "n3", sensitivity: "none" },
                ],
                edges: [],
              }),
            },
            auditLog: emptyAudit,
            listTrustedAgents: emptyAgents,
          }),
          "trust",
        );
        expect(result!.summary).toContain("3 memories");
        expect(result!.summary).toContain("2 conversations");
        expect(result!.summary).toContain("3 signed receipts");
        expect(result!.data).toMatchObject({
          trust: { memories: 3, conversations: 2, receipts: 3, deletions: 0, peers: 0 },
        });
      });

      it("singular forms when count is 1", async () => {
        const result = await executeCommand(
          mockRuntime({
            motebitId: "did:motebit:0xtest",
            listConversations: () => [{ id: "c1", startedAt: 0, messageCount: 1 }],
            getRecentReceipts: () => [{ tool_name: "navigate", status: "completed" }],
            memory: {
              exportAll: async () => ({
                nodes: [{ node_id: "n1", sensitivity: "none" }],
                edges: [],
              }),
            },
            auditLog: emptyAudit,
            listTrustedAgents: emptyAgents,
          }),
          "trust",
        );
        expect(result!.summary).toContain("1 memory,");
        expect(result!.summary).toContain("1 conversation,");
        expect(result!.summary).toContain("1 signed receipt");
      });

      it("surfaces sensitivity distribution in detail when memories exist", async () => {
        const result = await executeCommand(
          mockRuntime({
            motebitId: "did:motebit:0xtest",
            listConversations: () => [],
            getRecentReceipts: () => [],
            memory: {
              exportAll: async () => ({
                nodes: [
                  { node_id: "n1", sensitivity: "personal" },
                  { node_id: "n2", sensitivity: "personal" },
                  { node_id: "n3", sensitivity: "financial" },
                ],
                edges: [],
              }),
            },
            auditLog: emptyAudit,
            listTrustedAgents: emptyAgents,
          }),
          "trust",
        );
        expect(result!.detail).toContain("Memory sensitivity:");
        expect(result!.detail).toContain("2 personal");
        expect(result!.detail).toContain("1 financial");
      });

      it("surfaces recent receipts (up to 5) in detail when present", async () => {
        const receipts = Array.from({ length: 8 }, (_, i) => ({
          tool_name: `tool_${i}`,
          status: "completed" as const,
        }));
        const result = await executeCommand(
          mockRuntime({
            motebitId: "did:motebit:0xtest",
            listConversations: () => [],
            getRecentReceipts: () => receipts,
            memory: { exportAll: async () => ({ nodes: [], edges: [] }) },
            auditLog: emptyAudit,
            listTrustedAgents: emptyAgents,
          }),
          "trust",
        );
        // Last 5: tool_3..tool_7
        expect(result!.detail).toContain("Recent receipts: tool_3, tool_4, tool_5, tool_6, tool_7");
      });

      it("omits detail when memory and receipts both empty (one-line summary)", async () => {
        const result = await executeCommand(
          mockRuntime({
            motebitId: "did:motebit:0xtest",
            listConversations: () => [
              { id: "c1", startedAt: 0, messageCount: 1 },
              { id: "c2", startedAt: 0, messageCount: 1 },
            ],
            getRecentReceipts: () => [],
            memory: { exportAll: async () => ({ nodes: [], edges: [] }) },
            auditLog: emptyAudit,
            listTrustedAgents: emptyAgents,
          }),
          "trust",
        );
        expect(result!.summary).toContain("conversations");
        expect(result!.detail).toBeUndefined();
      });

      // Governance pillar — signed deletion certificates.
      it("counts signed deletions from audit log (delete_memory + delete_conversation + flush_record)", async () => {
        const result = await executeCommand(
          mockRuntime({
            motebitId: "did:motebit:0xtest",
            listConversations: () => [],
            getRecentReceipts: () => [],
            memory: { exportAll: async () => ({ nodes: [], edges: [] }) },
            auditLog: {
              query: async () => [
                { audit_id: "a1", action: "delete_memory", target_type: "memory" },
                { audit_id: "a2", action: "delete_memory", target_type: "memory" },
                { audit_id: "a3", action: "delete_conversation", target_type: "conversation" },
                { audit_id: "a4", action: "flush_record", target_type: "memory" },
                // Non-deletion actions are excluded.
                { audit_id: "a5", action: "set_sensitivity", target_type: "session" },
                { audit_id: "a6", action: "skill_trust_grant", target_type: "skill" },
              ],
            },
            listTrustedAgents: emptyAgents,
          }),
          "trust",
        );
        expect(result!.summary).toContain("4 signed deletions on the audit trail");
        expect(result!.data).toMatchObject({ trust: { deletions: 4 } });
      });

      it("surfaces deletion-action breakdown in detail", async () => {
        const result = await executeCommand(
          mockRuntime({
            motebitId: "did:motebit:0xtest",
            listConversations: () => [],
            getRecentReceipts: () => [],
            memory: { exportAll: async () => ({ nodes: [], edges: [] }) },
            auditLog: {
              query: async () => [
                { audit_id: "a1", action: "delete_memory" },
                { audit_id: "a2", action: "delete_memory" },
                { audit_id: "a3", action: "delete_memory" },
                { audit_id: "a4", action: "flush_record" },
              ],
            },
            listTrustedAgents: emptyAgents,
          }),
          "trust",
        );
        expect(result!.detail).toContain("Deletion breakdown:");
        expect(result!.detail).toContain("3 delete_memory");
        expect(result!.detail).toContain("1 flush_record");
      });

      it("uses singular 'deletion' when count is 1", async () => {
        const result = await executeCommand(
          mockRuntime({
            motebitId: "did:motebit:0xtest",
            listConversations: () => [],
            getRecentReceipts: () => [],
            memory: { exportAll: async () => ({ nodes: [], edges: [] }) },
            auditLog: { query: async () => [{ audit_id: "a1", action: "delete_memory" }] },
            listTrustedAgents: emptyAgents,
          }),
          "trust",
        );
        expect(result!.summary).toContain("1 signed deletion on the audit trail");
      });

      // Network pillar — federation peers.
      it("counts federation peers via listTrustedAgents", async () => {
        const result = await executeCommand(
          mockRuntime({
            motebitId: "did:motebit:0xtest",
            listConversations: () => [],
            getRecentReceipts: () => [],
            memory: { exportAll: async () => ({ nodes: [], edges: [] }) },
            auditLog: emptyAudit,
            listTrustedAgents: async () => [
              { remote_motebit_id: "did:motebit:0xa", trust_level: "verified" },
              { remote_motebit_id: "did:motebit:0xb", trust_level: "discovered" },
              { remote_motebit_id: "did:motebit:0xc", trust_level: "verified" },
            ],
          }),
          "trust",
        );
        expect(result!.summary).toContain("3 federation peers known");
        expect(result!.data).toMatchObject({ trust: { peers: 3 } });
      });

      it("uses singular 'peer' when count is 1", async () => {
        const result = await executeCommand(
          mockRuntime({
            motebitId: "did:motebit:0xtest",
            listConversations: () => [],
            getRecentReceipts: () => [],
            memory: { exportAll: async () => ({ nodes: [], edges: [] }) },
            auditLog: emptyAudit,
            listTrustedAgents: async () => [
              { remote_motebit_id: "did:motebit:0xa", trust_level: "verified" },
            ],
          }),
          "trust",
        );
        expect(result!.summary).toContain("1 federation peer known");
      });

      // Composition — all five dimensions present simultaneously.
      it("composes all five dimensions in the summary line", async () => {
        const result = await executeCommand(
          mockRuntime({
            motebitId: "did:motebit:0xtest",
            listConversations: () => [{ id: "c1", startedAt: 0, messageCount: 1 }],
            getRecentReceipts: () => [{ tool_name: "navigate", status: "completed" }],
            memory: {
              exportAll: async () => ({
                nodes: [{ node_id: "n1", sensitivity: "personal" }],
                edges: [],
              }),
            },
            auditLog: {
              query: async () => [
                { audit_id: "a1", action: "delete_memory" },
                { audit_id: "a2", action: "delete_conversation" },
              ],
            },
            listTrustedAgents: async () => [
              { remote_motebit_id: "did:motebit:0xa", trust_level: "verified" },
            ],
          }),
          "trust",
        );
        // All five dimensions visible.
        expect(result!.summary).toContain("1 memory");
        expect(result!.summary).toContain("1 conversation");
        expect(result!.summary).toContain("1 signed receipt");
        expect(result!.summary).toContain("2 signed deletions");
        expect(result!.summary).toContain("1 federation peer");
        expect(result!.data).toMatchObject({
          trust: { memories: 1, conversations: 1, receipts: 1, deletions: 2, peers: 1 },
        });
      });
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
        // /forget routes through the privacy layer choke point — the
        // mock returns a stub mutable_pruning cert so cmdForget's
        // signed-delete path resolves cleanly.
        privacy: {
          deleteMemory: vi.fn(async (nodeId: string) => ({
            kind: "mutable_pruning",
            target_id: nodeId,
            sensitivity: "none",
            reason: "user_request",
            deleted_at: Date.now(),
          })),
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
