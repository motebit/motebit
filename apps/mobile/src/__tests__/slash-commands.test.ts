import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// @motebit/sdk is tiny — use importOriginal to preserve MemoryType enum
// ---------------------------------------------------------------------------

vi.mock("@motebit/gradient", () => ({
  narrateEconomicConsequences: vi.fn(() => [] as string[]),
}));

import { runSlashCommand } from "../slash-commands";
import type { SlashCommandDeps } from "../slash-commands";

// ---------------------------------------------------------------------------
// Test harness — minimal MobileApp stub + observable effect sinks
// ---------------------------------------------------------------------------

function makeAppStub(overrides?: Record<string, unknown>) {
  return {
    currentModel: "llama3.2",
    motebitId: "mote-1",
    isServing: vi.fn(() => false),
    stopServing: vi.fn(),
    startServing: vi.fn(() => Promise.resolve({ ok: true })),
    setModel: vi.fn(),
    startNewConversation: vi.fn(),
    syncNow: vi.fn(() => Promise.resolve()),
    exportAllData: vi.fn(() => Promise.resolve("[exported-data]")),
    summarizeConversation: vi.fn(() => Promise.resolve("a summary")),
    getState: vi.fn(() => ({ intent: 0.5, precision: 0.7 })),
    deleteMemory: vi.fn(() => Promise.resolve()),
    getMcpServers: vi.fn(() => [
      { name: "srv1", url: "https://a", connected: true, toolCount: 2, trusted: true, motebit: false },
    ]),
    getMemoryGraphStats: vi.fn(() =>
      Promise.resolve({
        nodes: [
          {
            node_id: "n1",
            tombstoned: false,
            memory_type: undefined,
            pinned: false,
            half_life: 86_400_000 * 10,
            confidence: 0.7,
            content: "hi",
            created_at: Date.now(),
          },
        ],
        edges: [{ source_id: "n1", target_id: "n1", relation_type: "related" }],
      }),
    ),
    getGradient: vi.fn(() => ({ gradient: 0.5, delta: 0.01 })),
    getGradientSummary: vi.fn(() => ({
      snapshotCount: 5,
      trajectory: "ascending",
      overall: "good",
      strengths: ["s"],
      weaknesses: ["w"],
      posture: "stable",
    })),
    getLastReflection: vi.fn(() => ({ selfAssessment: "all good" })),
    getCuriosityTargets: vi.fn(() => []),
    reflect: vi.fn(() =>
      Promise.resolve({
        insights: ["I1"],
        planAdjustments: ["A1"],
        patterns: ["P1"],
        selfAssessment: "assessed",
      }),
    ),
    auditMemory: vi.fn(() =>
      Promise.resolve({
        nodesAudited: 10,
        phantomCertainties: [],
        conflicts: [],
        nearDeath: [],
      }),
    ),
    listTrustedAgents: vi.fn(() => Promise.resolve([])),
    relayFetch: vi.fn(() => Promise.resolve({ agents: [], proposals: [], transactions: [] })),
    hasPendingApproval: false,
    pendingApprovalInfo: null,
    getRuntime: vi.fn(() => null),
    ...overrides,
  };
}

function makeDeps(appOverrides?: Record<string, unknown>): SlashCommandDeps & {
  _messages: string[];
  _toasts: string[];
  _app: ReturnType<typeof makeAppStub>;
} {
  const messages: string[] = [];
  const toasts: string[] = [];
  const app = makeAppStub(appOverrides);
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app: app as any,
    addSystemMessage: (content: string) => messages.push(content),
    showToast: (msg: string) => toasts.push(msg),
    setMessages: vi.fn(),
    setCurrentModel: vi.fn(),
    setShowConversationPanel: vi.fn(),
    setShowMemoryPanel: vi.fn(),
    setShowGoalsPanel: vi.fn(),
    setShowSettings: vi.fn(),
    _messages: messages,
    _toasts: toasts,
    _app: app,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSlashCommand navigation commands", () => {
  it("/conversations opens conversation panel", () => {
    const deps = makeDeps();
    runSlashCommand("conversations", "", deps);
    expect(deps.setShowConversationPanel).toHaveBeenCalledWith(true);
  });

  it("/memories opens memory panel", () => {
    const deps = makeDeps();
    runSlashCommand("memories", "", deps);
    expect(deps.setShowMemoryPanel).toHaveBeenCalledWith(true);
  });

  it("/settings opens settings", () => {
    const deps = makeDeps();
    runSlashCommand("settings", "", deps);
    expect(deps.setShowSettings).toHaveBeenCalledWith(true);
  });

  it("/goals opens goals panel", () => {
    const deps = makeDeps();
    runSlashCommand("goals", "", deps);
    expect(deps.setShowGoalsPanel).toHaveBeenCalledWith(true);
  });

  it("/new starts new conversation and clears messages", () => {
    const deps = makeDeps();
    runSlashCommand("new", "", deps);
    expect(deps._app.startNewConversation).toHaveBeenCalled();
    expect(deps.setMessages).toHaveBeenCalledWith([]);
  });

  it("/clear same as /new", () => {
    const deps = makeDeps();
    runSlashCommand("clear", "", deps);
    expect(deps._app.startNewConversation).toHaveBeenCalled();
  });
});

describe("runSlashCommand /model", () => {
  it("with no args shows current model", () => {
    const deps = makeDeps();
    runSlashCommand("model", "", deps);
    expect(deps._messages[0]).toContain("Current model");
  });

  it("with arg sets model and notifies UI", () => {
    const deps = makeDeps();
    runSlashCommand("model", "claude-haiku-4-5", deps);
    expect(deps._app.setModel).toHaveBeenCalledWith("claude-haiku-4-5");
    expect(deps.setCurrentModel).toHaveBeenCalledWith("claude-haiku-4-5");
  });

  it("catches setModel errors", () => {
    const deps = makeDeps({
      setModel: vi.fn(() => {
        throw new Error("bad model");
      }),
    });
    runSlashCommand("model", "bad-model", deps);
    expect(deps._messages[0]).toContain("bad model");
  });
});

describe("runSlashCommand /sync", () => {
  it("calls syncNow and shows toast on success", async () => {
    const deps = makeDeps();
    runSlashCommand("sync", "", deps);
    // wait microtasks
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._app.syncNow).toHaveBeenCalled();
    expect(deps._toasts[0]).toBe("Synced");
  });

  it("reports error when syncNow rejects", async () => {
    const deps = makeDeps({
      syncNow: vi.fn(() => Promise.reject(new Error("network dead"))),
    });
    runSlashCommand("sync", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages.some((m) => m.includes("network dead"))).toBe(true);
  });
});

describe("runSlashCommand /export", () => {
  it("exports data", async () => {
    const deps = makeDeps();
    runSlashCommand("export", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("[exported-data]");
  });
});

describe("runSlashCommand /summarize", () => {
  it("shows the summary", async () => {
    const deps = makeDeps();
    runSlashCommand("summarize", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("a summary");
  });

  it("shows empty note when no summary", async () => {
    const deps = makeDeps({
      summarizeConversation: vi.fn(() => Promise.resolve("")),
    });
    runSlashCommand("summarize", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("No conversation");
  });

  it("catches errors", async () => {
    const deps = makeDeps({
      summarizeConversation: vi.fn(() => Promise.reject(new Error("no AI"))),
    });
    runSlashCommand("summarize", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("no AI");
  });
});

describe("runSlashCommand /state", () => {
  it("prints state vector", () => {
    const deps = makeDeps();
    runSlashCommand("state", "", deps);
    expect(deps._messages[0]).toContain("State vector");
  });

  it("notes missing state", () => {
    const deps = makeDeps({ getState: vi.fn(() => null) });
    runSlashCommand("state", "", deps);
    expect(deps._messages[0]).toContain("not available");
  });
});

describe("runSlashCommand /forget", () => {
  it("usage without args", () => {
    const deps = makeDeps();
    runSlashCommand("forget", "", deps);
    expect(deps._messages[0]).toContain("Usage");
  });

  it("deletes memory with arg", async () => {
    const deps = makeDeps();
    runSlashCommand("forget", "n1", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._app.deleteMemory).toHaveBeenCalledWith("n1");
  });

  it("catches deleteMemory errors", async () => {
    const deps = makeDeps({
      deleteMemory: vi.fn(() => Promise.reject(new Error("not found"))),
    });
    runSlashCommand("forget", "x", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages.some((m) => m.includes("not found"))).toBe(true);
  });
});

describe("runSlashCommand /tools", () => {
  it("lists connected servers", () => {
    const deps = makeDeps();
    runSlashCommand("tools", "", deps);
    expect(deps._messages[0]).toContain("Tools: 2 from 1");
    expect(deps._messages[0]).toContain("srv1");
  });

  it("shows empty message for no servers", () => {
    const deps = makeDeps({ getMcpServers: vi.fn(() => []) });
    runSlashCommand("tools", "", deps);
    expect(deps._messages[0]).toContain("No MCP servers");
  });
});

describe("runSlashCommand /graph", () => {
  it("shows memory graph stats", async () => {
    const deps = makeDeps();
    runSlashCommand("graph", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Memory Graph");
  });

  it("handles empty graph", async () => {
    const deps = makeDeps({
      getMemoryGraphStats: vi.fn(() => Promise.resolve({ nodes: [], edges: [] })),
    });
    runSlashCommand("graph", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("No memories");
  });

  it("catches errors", async () => {
    const deps = makeDeps({
      getMemoryGraphStats: vi.fn(() => Promise.reject(new Error("db error"))),
    });
    runSlashCommand("graph", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages.some((m) => m.includes("db error"))).toBe(true);
  });
});

describe("runSlashCommand /curious", () => {
  it("handles empty targets", () => {
    const deps = makeDeps();
    runSlashCommand("curious", "", deps);
    expect(deps._messages[0]).toContain("No curiosity targets");
  });

  it("prints targets", () => {
    const deps = makeDeps({
      getCuriosityTargets: vi.fn(() => [
        {
          node: {
            node_id: "abcd1234xyz",
            created_at: Date.now() - 86_400_000 * 5,
            half_life: 86_400_000 * 10,
            confidence: 0.5,
            content: "fading memory",
          },
          curiosityScore: 0.9,
          decayedConfidence: 0.3,
        },
      ]),
    });
    runSlashCommand("curious", "", deps);
    expect(deps._messages[0]).toContain("Curiosity targets");
  });
});

describe("runSlashCommand /reflect", () => {
  it("shows reflection insights", async () => {
    const deps = makeDeps();
    runSlashCommand("reflect", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Reflecting");
    expect(deps._messages[1]).toContain("Insights");
  });

  it("handles no insights", async () => {
    const deps = makeDeps({
      reflect: vi.fn(() =>
        Promise.resolve({
          insights: [],
          planAdjustments: [],
          patterns: [],
          selfAssessment: undefined,
        }),
      ),
    });
    runSlashCommand("reflect", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages.some((m) => m.includes("no insights"))).toBe(true);
  });

  it("catches errors", async () => {
    const deps = makeDeps({
      reflect: vi.fn(() => Promise.reject(new Error("reflect failed"))),
    });
    runSlashCommand("reflect", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages.some((m) => m.includes("reflect failed"))).toBe(true);
  });
});

describe("runSlashCommand /gradient", () => {
  it("shows gradient", async () => {
    const deps = makeDeps();
    runSlashCommand("gradient", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Intelligence Gradient");
  });

  it("handles no gradient", async () => {
    const deps = makeDeps({ getGradient: vi.fn(() => null) });
    runSlashCommand("gradient", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("No gradient");
  });
});

describe("runSlashCommand /audit", () => {
  it("shows clean result", async () => {
    const deps = makeDeps();
    runSlashCommand("audit", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Memory audit");
    expect(deps._messages[0]).toContain("No integrity issues");
  });

  it("shows phantom certainties", async () => {
    const deps = makeDeps({
      auditMemory: vi.fn(() =>
        Promise.resolve({
          nodesAudited: 10,
          phantomCertainties: [{ node: { content: "old memory" }, decayedConfidence: 0.1, edgeCount: 5 }],
          conflicts: [{ a: { content: "a memory" }, b: { content: "b memory" } }],
          nearDeath: [{ node: { content: "dying memory" }, decayedConfidence: 0.02 }],
        }),
      ),
    });
    runSlashCommand("audit", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Phantom");
    expect(deps._messages[0]).toContain("Conflicts");
    expect(deps._messages[0]).toContain("Near-death");
  });

  it("catches errors", async () => {
    const deps = makeDeps({
      auditMemory: vi.fn(() => Promise.reject(new Error("audit failed"))),
    });
    runSlashCommand("audit", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages.some((m) => m.includes("audit failed"))).toBe(true);
  });
});

describe("runSlashCommand /agents", () => {
  it("shows no agents", async () => {
    const deps = makeDeps();
    runSlashCommand("agents", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("No known agents");
  });

  it("lists agents", async () => {
    const deps = makeDeps({
      listTrustedAgents: vi.fn(() =>
        Promise.resolve([
          {
            motebit_id: "aaaaabbbb",
            trust_level: "trusted",
            successful_tasks: 5,
            failed_tasks: 1,
          },
        ]),
      ),
    });
    runSlashCommand("agents", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Known agents");
  });
});

describe("runSlashCommand /discover", () => {
  it("shows no agents", async () => {
    const deps = makeDeps();
    runSlashCommand("discover", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("No agents");
  });

  it("lists discovered agents", async () => {
    const deps = makeDeps({
      relayFetch: vi.fn(() =>
        Promise.resolve({
          agents: [{ motebit_id: "aaaaabbbb", capabilities: ["search"] }],
        }),
      ),
    });
    runSlashCommand("discover", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Discovered agents");
  });

  it("catches errors", async () => {
    const deps = makeDeps({
      relayFetch: vi.fn(() => Promise.reject(new Error("offline"))),
    });
    runSlashCommand("discover", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Discovery error");
  });
});

describe("runSlashCommand /serve", () => {
  it("starts serving when off", async () => {
    const deps = makeDeps();
    runSlashCommand("serve", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._app.startServing).toHaveBeenCalled();
    expect(deps._messages[0]).toContain("Serving");
  });

  it("reports start error", async () => {
    const deps = makeDeps({
      startServing: vi.fn(() => Promise.resolve({ ok: false, error: "no sync" })),
    });
    runSlashCommand("serve", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Could not start serving");
  });

  it("stops serving when on", async () => {
    const deps = makeDeps({ isServing: vi.fn(() => true) });
    runSlashCommand("serve", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._app.stopServing).toHaveBeenCalled();
    expect(deps._messages[0]).toContain("Stopped");
  });
});

describe("runSlashCommand /plan", () => {
  it("usage without args", () => {
    const deps = makeDeps();
    runSlashCommand("plan", "", deps);
    expect(deps._messages[0]).toContain("Usage");
  });

  it("notes missing runtime", async () => {
    const deps = makeDeps();
    runSlashCommand("plan", "some goal", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages.some((m) => m.includes("Runtime not initialized"))).toBe(true);
  });
});

describe("runSlashCommand /balance", () => {
  it("shows balance", async () => {
    const deps = makeDeps({
      relayFetch: vi.fn(() =>
        Promise.resolve({ balance: 100, pending_allocations: 5, currency: "USDC" }),
      ),
    });
    runSlashCommand("balance", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Balance: 100");
  });

  it("catches errors", async () => {
    const deps = makeDeps({
      relayFetch: vi.fn(() => Promise.reject(new Error("502"))),
    });
    runSlashCommand("balance", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Balance error");
  });
});

describe("runSlashCommand /deposits", () => {
  it("shows no deposits", async () => {
    const deps = makeDeps();
    runSlashCommand("deposits", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("No deposits");
  });

  it("shows deposits", async () => {
    const deps = makeDeps({
      relayFetch: vi.fn(() =>
        Promise.resolve({
          transactions: [{ type: "deposit", amount: 10, created_at: Date.now() }],
        }),
      ),
    });
    runSlashCommand("deposits", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Recent deposits");
  });
});

describe("runSlashCommand /approvals", () => {
  it("no pending", () => {
    const deps = makeDeps();
    runSlashCommand("approvals", "", deps);
    expect(deps._messages[0]).toBe("No pending approvals.");
  });

  it("pending approval", () => {
    const deps = makeDeps({
      hasPendingApproval: true,
      pendingApprovalInfo: { toolName: "web_search", args: { query: "x" } },
    });
    runSlashCommand("approvals", "", deps);
    expect(deps._messages[0]).toContain("web_search");
  });
});

describe("runSlashCommand /proposals", () => {
  it("no proposals", async () => {
    const deps = makeDeps();
    runSlashCommand("proposals", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("No active proposals");
  });

  it("lists proposals", async () => {
    const deps = makeDeps({
      relayFetch: vi.fn(() =>
        Promise.resolve({
          proposals: [{ proposal_id: "abcdabcd", status: "pending", goal: "ship it" }],
        }),
      ),
    });
    runSlashCommand("proposals", "", deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps._messages[0]).toContain("Proposals");
  });
});

describe("runSlashCommand CLI stubs and help", () => {
  it("/withdraw", () => {
    const deps = makeDeps();
    runSlashCommand("withdraw", "", deps);
    expect(deps._messages[0]).toContain("CLI");
  });

  it("/delegate", () => {
    const deps = makeDeps();
    runSlashCommand("delegate", "", deps);
    expect(deps._messages[0]).toContain("Delegation");
  });

  it("/propose", () => {
    const deps = makeDeps();
    runSlashCommand("propose", "", deps);
    expect(deps._messages[0]).toContain("Collaborative");
  });

  it("/help", () => {
    const deps = makeDeps();
    runSlashCommand("help", "", deps);
    expect(deps._messages[0]).toContain("Available commands");
  });

  it("/operator is a no-op", () => {
    const deps = makeDeps();
    runSlashCommand("operator", "", deps);
    expect(deps._messages.length).toBe(0);
  });

  it("unknown command", () => {
    const deps = makeDeps();
    runSlashCommand("bogus", "", deps);
    expect(deps._messages[0]).toContain("Unknown command");
  });
});
