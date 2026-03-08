import { describe, it, expect, vi } from "vitest";
import { wireServerDeps } from "../service.js";
import type { ServiceRuntime } from "../service.js";

// === Mock runtime ===

function makeRuntime(overrides: Partial<ServiceRuntime> = {}): ServiceRuntime {
  return {
    getToolRegistry: () => ({
      list: () => [
        { name: "test_tool", description: "A test tool", inputSchema: {} },
      ],
      execute: vi.fn().mockResolvedValue({ ok: true, data: "result" }),
    }),
    policy: {
      filterTools: (tools) => tools,
      validate: () => ({ allowed: true, requiresApproval: false }),
      createTurnContext: () => ({}),
    },
    getState: () => ({ attention: 0.5 }),
    memory: {
      exportAll: vi.fn().mockResolvedValue({
        nodes: [
          { content: "test", confidence: 0.9, sensitivity: "none", created_at: 1000, tombstoned: false },
          { content: "deleted", confidence: 0.5, sensitivity: "none", created_at: 900, tombstoned: true },
        ],
      }),
      retrieve: vi.fn().mockResolvedValue([
        { content: "retrieved", confidence: 0.8 },
      ]),
      formMemory: vi.fn().mockResolvedValue({ node_id: "mem-123" }),
    },
    events: {
      append: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

describe("wireServerDeps", () => {
  it("wires all required deps from runtime", () => {
    const runtime = makeRuntime();
    const deps = wireServerDeps(runtime, {
      motebitId: "test-id",
      publicKeyHex: "abcdef",
    });

    expect(deps.motebitId).toBe("test-id");
    expect(deps.publicKeyHex).toBe("abcdef");
    expect(deps.listTools()).toHaveLength(1);
    expect(deps.listTools()[0]!.name).toBe("test_tool");
  });

  it("filters tombstoned memories", async () => {
    const runtime = makeRuntime();
    const deps = wireServerDeps(runtime, { motebitId: "test-id" });
    const memories = await deps.getMemories(10);
    expect(memories).toHaveLength(1);
    expect(memories[0]!.content).toBe("test");
  });

  it("logs tool calls to event store", () => {
    const runtime = makeRuntime();
    const deps = wireServerDeps(runtime, { motebitId: "test-id" });
    deps.logToolCall("test_tool", { arg: "val" }, { ok: true, data: "out" });
    expect(runtime.events.append).toHaveBeenCalledTimes(1);
  });

  it("does NOT wire queryMemories without embedText", () => {
    const runtime = makeRuntime();
    const deps = wireServerDeps(runtime, { motebitId: "test-id" });
    expect(deps.queryMemories).toBeUndefined();
    expect(deps.storeMemory).toBeUndefined();
  });

  it("wires queryMemories and storeMemory when embedText is provided", async () => {
    const runtime = makeRuntime();
    const mockEmbed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const deps = wireServerDeps(runtime, {
      motebitId: "test-id",
      embedText: mockEmbed,
    });

    expect(deps.queryMemories).toBeDefined();
    expect(deps.storeMemory).toBeDefined();

    const results = await deps.queryMemories!("test query", 5);
    expect(mockEmbed).toHaveBeenCalledWith("test query");
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("retrieved");

    const stored = await deps.storeMemory!("new memory");
    expect(stored.node_id).toBe("mem-123");
  });

  it("wires identityFileContent when provided", () => {
    const runtime = makeRuntime();
    const deps = wireServerDeps(runtime, {
      motebitId: "test-id",
      identityFileContent: "---\nspec: motebit/identity@1.0\n---",
    });
    expect(deps.identityFileContent).toContain("motebit/identity@1.0");
  });

  it("wires verifySignedToken when provided", () => {
    const mockVerify = vi.fn();
    const runtime = makeRuntime();
    const deps = wireServerDeps(runtime, {
      motebitId: "test-id",
      verifySignedToken: mockVerify,
    });
    expect(deps.verifySignedToken).toBe(mockVerify);
  });

  it("wires handleAgentTask when provided", () => {
    const mockTask = vi.fn();
    const runtime = makeRuntime();
    const deps = wireServerDeps(runtime, {
      motebitId: "test-id",
      handleAgentTask: mockTask as unknown as typeof deps.handleAgentTask,
    });
    expect(deps.handleAgentTask).toBe(mockTask);
  });

  it("wires sendMessage when provided", () => {
    const mockSend = vi.fn();
    const runtime = makeRuntime();
    const deps = wireServerDeps(runtime, {
      motebitId: "test-id",
      sendMessage: mockSend,
    });
    expect(deps.sendMessage).toBe(mockSend);
  });
});
