import { describe, it, expect, vi } from "vitest";
import { wireServerDeps } from "../service.js";
import type { ServiceRuntime } from "../service.js";
import { AgentTrustLevel } from "@motebit/sdk";

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

  it("forwards CallerIdentity to policy context in validateTool", () => {
    const validateSpy = vi.fn().mockReturnValue({ allowed: true, requiresApproval: false });
    const runtime = makeRuntime({
      policy: {
        filterTools: (tools) => tools,
        validate: validateSpy,
        createTurnContext: () => ({ turnId: "t1", toolCallCount: 0, turnStartMs: Date.now(), costAccumulated: 0 }),
      },
    });
    const deps = wireServerDeps(runtime, { motebitId: "test-id" });

    const tool = { name: "test_tool", description: "test", inputSchema: {} };
    const caller = { motebitId: "remote-mote", trustLevel: AgentTrustLevel.Verified };
    deps.validateTool(tool, { arg: "val" }, caller);

    expect(validateSpy).toHaveBeenCalledTimes(1);
    const ctx = validateSpy.mock.calls[0]![2];
    expect(ctx.callerMotebitId).toBe("remote-mote");
    expect(ctx.callerTrustLevel).toBe(AgentTrustLevel.Verified);
  });

  it("validateTool works without caller (backward compat)", () => {
    const validateSpy = vi.fn().mockReturnValue({ allowed: true, requiresApproval: false });
    const runtime = makeRuntime({
      policy: {
        filterTools: (tools) => tools,
        validate: validateSpy,
        createTurnContext: () => ({ turnId: "t1", toolCallCount: 0, turnStartMs: Date.now(), costAccumulated: 0 }),
      },
    });
    const deps = wireServerDeps(runtime, { motebitId: "test-id" });

    const tool = { name: "test_tool", description: "test", inputSchema: {} };
    deps.validateTool(tool, { arg: "val" });

    const ctx = validateSpy.mock.calls[0]![2];
    expect(ctx.callerMotebitId).toBeUndefined();
    expect(ctx.callerTrustLevel).toBeUndefined();
  });

  it("wires resolveCallerKey when getAgentTrust exists", async () => {
    const runtime = makeRuntime({
      getAgentTrust: vi.fn().mockResolvedValue({
        trust_level: AgentTrustLevel.Verified,
        public_key: "ed25519:abc123",
      }),
    });
    const deps = wireServerDeps(runtime, { motebitId: "test-id" });

    expect(deps.resolveCallerKey).toBeDefined();
    const result = await deps.resolveCallerKey!("remote-mote");
    expect(result).toEqual({
      publicKey: "ed25519:abc123",
      trustLevel: AgentTrustLevel.Verified,
    });
  });

  it("resolveCallerKey returns null for unknown caller", async () => {
    const runtime = makeRuntime({
      getAgentTrust: vi.fn().mockResolvedValue(null),
    });
    const deps = wireServerDeps(runtime, { motebitId: "test-id" });

    const result = await deps.resolveCallerKey!("unknown-mote");
    expect(result).toBeNull();
  });

  it("wires onCallerVerified when recordAgentInteraction exists", () => {
    const recordSpy = vi.fn().mockResolvedValue({});
    const runtime = makeRuntime({
      recordAgentInteraction: recordSpy,
    });
    const deps = wireServerDeps(runtime, { motebitId: "test-id" });

    expect(deps.onCallerVerified).toBeDefined();
    deps.onCallerVerified!("remote-mote", "ed25519:key", AgentTrustLevel.FirstContact);
    expect(recordSpy).toHaveBeenCalledWith("remote-mote", "ed25519:key");
  });

  it("does NOT wire resolveCallerKey without getAgentTrust", () => {
    const runtime = makeRuntime();
    const deps = wireServerDeps(runtime, { motebitId: "test-id" });
    expect(deps.resolveCallerKey).toBeUndefined();
  });
});
