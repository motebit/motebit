import { describe, it, expect, vi, afterEach } from "vitest";
import { wireServerDeps, startServiceServer } from "../service.js";
import type { ServiceRuntime } from "../service.js";
import { AgentTrustLevel } from "@motebit/sdk";

// === Mock runtime ===

function makeRuntime(overrides: Partial<ServiceRuntime> = {}): ServiceRuntime {
  return {
    getToolRegistry: () => ({
      list: () => [{ name: "test_tool", description: "A test tool", inputSchema: {} }],
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
          {
            content: "test",
            confidence: 0.9,
            sensitivity: "none",
            created_at: 1000,
            tombstoned: false,
          },
          {
            content: "deleted",
            confidence: 0.5,
            sensitivity: "none",
            created_at: 900,
            tombstoned: true,
          },
        ],
      }),
      recallRelevant: vi.fn().mockResolvedValue([{ content: "retrieved", confidence: 0.8 }]),
      formMemory: vi.fn().mockResolvedValue({ node_id: "mem-123" }),
    },
    events: {
      append: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

describe("wireServerDeps", () => {
  it("wires all required deps from runtime", async () => {
    const runtime = makeRuntime();
    const deps = wireServerDeps(runtime, {
      motebitId: "test-id",
      publicKeyHex: "abcdef",
    });

    expect(deps.motebitId).toBe("test-id");
    expect(deps.publicKeyHex).toBe("abcdef");
    expect(await deps.listTools()).toHaveLength(1);
    expect((await deps.listTools())[0]!.name).toBe("test_tool");
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
        createTurnContext: () => ({
          turnId: "t1",
          toolCallCount: 0,
          turnStartMs: Date.now(),
          costAccumulated: 0,
        }),
      },
    });
    const deps = wireServerDeps(runtime, { motebitId: "test-id" });

    const tool = { name: "test_tool", description: "test", inputSchema: {} };
    const caller = { motebitId: "remote-mote", trustLevel: AgentTrustLevel.Verified };
    void deps.validateTool(tool, { arg: "val" }, caller);

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
        createTurnContext: () => ({
          turnId: "t1",
          toolCallCount: 0,
          turnStartMs: Date.now(),
          costAccumulated: 0,
        }),
      },
    });
    const deps = wireServerDeps(runtime, { motebitId: "test-id" });

    const tool = { name: "test_tool", description: "test", inputSchema: {} };
    void deps.validateTool(tool, { arg: "val" });

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

describe("startServiceServer", () => {
  let handle: Awaited<ReturnType<typeof startServiceServer>> | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.shutdown();
      handle = null;
    }
  });

  function makeDeps(overrides: Partial<ReturnType<typeof wireServerDeps>> = {}) {
    return {
      motebitId: "test-svc",
      listTools: () => [{ name: "echo", description: "Echo", inputSchema: {} }],
      filterTools: (tools: unknown[]) => tools,
      validateTool: () => ({ allowed: true, requiresApproval: false }),
      executeTool: vi.fn().mockResolvedValue({ ok: true, data: "ok" }),
      getState: () => ({ attention: 0.5 }),
      getMemories: vi.fn().mockResolvedValue([]),
      logToolCall: vi.fn(),
      ...overrides,
    } as unknown as ReturnType<typeof wireServerDeps>;
  }

  it("starts server and calls onStart callback", async () => {
    const onStart = vi.fn();
    handle = await startServiceServer(makeDeps(), {
      port: 0,
      onStart,
    });
    expect(handle.server).toBeDefined();
    expect(onStart).toHaveBeenCalledWith(expect.any(Number), 1);
  });

  it("shutdown calls onStop and is idempotent", async () => {
    const onStop = vi.fn();
    handle = await startServiceServer(makeDeps(), {
      port: 0,
      onStop,
    });
    await handle.shutdown();
    expect(onStop).toHaveBeenCalledTimes(1);
    // Second shutdown is a no-op
    await handle.shutdown();
    expect(onStop).toHaveBeenCalledTimes(1);
    handle = null; // already shut down
  });

  it("registers with relay when syncUrl is provided", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ registered: true }), { status: 200 }));

    const log = vi.fn();
    handle = await startServiceServer(makeDeps(), {
      port: 0,
      syncUrl: "http://fake-relay",
      apiToken: "test-token",
      onStart: vi.fn(),
      log,
    });

    expect(fetchSpy).toHaveBeenCalled();
    const registerCall = fetchSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/register"),
    );
    expect(registerCall).toBeDefined();

    fetchSpy.mockRestore();
  });

  it("republishes the service listing on a healthy, continuously-heartbeating service", async () => {
    // Regression for the month-long staging conformance red.
    //
    // The listing is published by `register()` and by nothing else, while
    // `heartbeat()` only extends the TTL — and a successful heartbeat ALSO
    // refreshes `lastRegisteredAt`, which is what the staleness branch reads.
    // So on a healthy service the staleness branch never fired and the listing
    // became a boot-time one-shot: once the relay lost it, nothing ever put it
    // back. Six staging atoms sat live, heartbeating and fully discoverable but
    // unpriced and undescribed for roughly a month, and the archetype
    // conformance probe went red daily until each machine was restarted by hand.
    //
    // The invariant: over a long healthy uptime, `/listing` must be POSTed more
    // than once. Severing the FULL_REREGISTER_INTERVAL_MS branch reds this while
    // the boot-registration test above stays green.
    vi.useFakeTimers();
    try {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      handle = await startServiceServer(makeDeps(), {
        port: 0,
        syncUrl: "http://fake-relay",
        apiToken: "test-token",
        onStart: vi.fn(),
        log: vi.fn(),
      });

      const listingCalls = (): number =>
        fetchSpy.mock.calls.filter(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("/listing"),
        ).length;

      // Boot publishes once.
      expect(listingCalls()).toBe(1);

      // Two hours of a perfectly healthy service: every heartbeat succeeds, so
      // the staleness branch is never reached. Before the fix this produced
      // zero further listing POSTs, forever.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 60_000);

      expect(listingCalls()).toBeGreaterThan(1);

      fetchSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("withholds heartbeats while checkReadiness says the agent cannot work", async () => {
    // Composition-preserves-enforcement: `createProviderReadiness` being correct
    // in isolation proves nothing if `runService` never consults it. This drives
    // the real loop and asserts the seam is actually load-bearing.
    //
    // The behavior it protects: an agent whose provider is dead must stop
    // renewing its claim to be awake, so the relay's freshness ladder decays it
    // instead of letting it keep taking PAID delegations it can only refuse
    // (#593, #610). Deleting the readiness call in the heartbeat timer reds this
    // while every other test here stays green.
    vi.useFakeTimers();
    try {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      let ready = false;
      const log = vi.fn();
      handle = await startServiceServer(
        makeDeps({
          checkReadiness: () =>
            Promise.resolve(
              ready ? { ready: true } : { ready: false, reason: "provider credit exhausted" },
            ),
        } as never),
        {
          port: 0,
          syncUrl: "http://fake-relay",
          apiToken: "test-token",
          onStart: vi.fn(),
          log,
        },
      );

      const heartbeats = (): number =>
        fetchSpy.mock.calls.filter(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("/heartbeat"),
        ).length;

      // An hour of ticks while not ready: not one heartbeat may go out.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(heartbeats()).toBe(0);

      // The transition is logged once, with the reason — an operator must be
      // able to see WHY an agent went quiet.
      expect(log).toHaveBeenCalledWith(expect.stringContaining("NOT ready"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("provider credit exhausted"));

      // Recovery resumes advertising.
      ready = true;
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(heartbeats()).toBeGreaterThan(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Ready again"));

      fetchSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("heartbeats normally when no readiness probe is wired", async () => {
    // The safety default: every service that supplies no probe must behave
    // exactly as it did before this seam existed.
    vi.useFakeTimers();
    try {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      handle = await startServiceServer(makeDeps(), {
        port: 0,
        syncUrl: "http://fake-relay",
        apiToken: "test-token",
        onStart: vi.fn(),
        log: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      const heartbeats = fetchSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("/heartbeat"),
      ).length;
      expect(heartbeats).toBeGreaterThan(0);

      fetchSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps advertising when the readiness probe throws", async () => {
    // Fail OPEN. An unreliable probe must never be the thing that takes a
    // working agent off the market.
    vi.useFakeTimers();
    try {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const log = vi.fn();
      handle = await startServiceServer(
        makeDeps({
          checkReadiness: () => Promise.reject(new Error("probe exploded")),
        } as never),
        { port: 0, syncUrl: "http://fake-relay", apiToken: "t", onStart: vi.fn(), log },
      );

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      const heartbeats = fetchSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("/heartbeat"),
      ).length;
      expect(heartbeats).toBeGreaterThan(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Readiness probe threw"));

      fetchSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles relay registration failure gracefully", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));

    const log = vi.fn();
    handle = await startServiceServer(makeDeps(), {
      port: 0,
      syncUrl: "http://fake-relay",
      log,
    });

    expect(log).toHaveBeenCalledWith(expect.stringContaining("registration failed"));
    fetchSpy.mockRestore();
  });

  it("deregisters from relay on shutdown", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ registered: true }), { status: 200 }));

    handle = await startServiceServer(makeDeps(), {
      port: 0,
      syncUrl: "http://fake-relay",
      apiToken: "tok",
    });

    await handle.shutdown();
    handle = null;

    const deregisterCall = fetchSpy.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("/deregister") &&
        (c[1] as RequestInit)?.method === "DELETE",
    );
    expect(deregisterCall).toBeDefined();

    fetchSpy.mockRestore();
  });
});
