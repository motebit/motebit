/**
 * /serve with the mobile serving gate forced ON — the kept scaffolding
 * (registration + toggle) still behaves, for the day the gate is flipped.
 * The default (gate OFF) behaviour is asserted in slash-commands.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@motebit/gradient", () => ({
  narrateEconomicConsequences: vi.fn(() => [] as string[]),
}));

vi.mock("../serving-gate", () => ({
  MOBILE_SERVING_ENABLED: true,
  MOBILE_SERVING_UNAVAILABLE: "unavailable",
  mobileServingAllowed: () => true,
  canExecuteDelegatedTask: (servingOn: boolean) => servingOn,
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
      {
        name: "srv1",
        url: "https://a",
        connected: true,
        toolCount: 2,
        trusted: true,
        motebit: false,
      },
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
    setShowConversationsPanel: vi.fn(),
    setShowMemoryPanel: vi.fn(),
    setShowGoalsPanel: vi.fn(),
    setShowSettings: vi.fn(),
    setShowCapabilitiesPanel: vi.fn(),
    setShowActivityPanel: vi.fn(),
    _messages: messages,
    _toasts: toasts,
    _app: app,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSlashCommand /serve — gate forced ON (control)", () => {
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
});
