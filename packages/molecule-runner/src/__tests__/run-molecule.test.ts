/**
 * Tests for `runMolecule` — the shared boot pipeline.
 *
 * Strategy: stub every adapter slot (identity bootstrap, DB open, server
 * start, embed fn) so the test exercises the runner's orchestration —
 * argument passing, ordering, default fallbacks — without spinning up
 * real filesystem, SQLite, or HTTP. The contract under test is:
 *
 *   config + build callback → well-formed inputs to each downstream
 *   primitive, in the expected order.
 *
 * The primitives (`bootstrapAndEmitIdentity`, `openMotebitDatabase`,
 * `MotebitRuntime`, `startServiceServer`) each have their own package's
 * tests; duplicating their coverage here would be noise. What's novel
 * to this package — and therefore what this file has to prove — is the
 * wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapAndEmitIdentityResult, ServiceHandle } from "@motebit/mcp-server";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { MotebitDatabase } from "@motebit/persistence";
import { createInMemoryStorage } from "@motebit/runtime";
import type { MoleculeConfig, MoleculeRunnerAdapters } from "../index.js";
import { defaultCreateRuntime, defaultLog, runMolecule } from "../index.js";

// ---------------------------------------------------------------------------
// Stub builders — reusable across tests
// ---------------------------------------------------------------------------

function fakeIdentity(
  overrides: Partial<BootstrapAndEmitIdentityResult> = {},
): BootstrapAndEmitIdentityResult {
  return {
    motebitId: "mot_test_12345678",
    deviceId: "dev_test",
    publicKeyHex: "00".repeat(32),
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(32),
    identityContent: "# motebit.md\n",
    identityPath: "/data/motebit.md",
    isFirstLaunch: true,
    ...overrides,
  };
}

/**
 * Minimal MotebitDatabase stub. The runner only calls `close()` on it,
 * plus `assembleStorageAdapters` reads 16 fields. Populate each with a
 * minimal shape — the runtime's initialization accepts partially-typed
 * adapters through the duck-typed interface.
 */
function fakeDatabase(): { db: MotebitDatabase; closed: { value: boolean } } {
  const closed = { value: false };
  const minimalAdapter = {} as unknown;
  const db = {
    eventStore: {
      append: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      getByMotebit: vi.fn().mockResolvedValue([]),
      getSince: vi.fn().mockResolvedValue([]),
      appendWithClock: vi.fn().mockResolvedValue(1),
    },
    memoryStorage: {
      saveNode: vi.fn().mockResolvedValue(undefined),
      saveEdge: vi.fn().mockResolvedValue(undefined),
      getNode: vi.fn().mockResolvedValue(null),
      queryNodes: vi.fn().mockResolvedValue([]),
      exportAll: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    },
    identityStorage: {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      saveDevice: vi.fn().mockResolvedValue(undefined),
      listDevices: vi.fn().mockResolvedValue([]),
    },
    auditLog: {
      log: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    },
    stateSnapshot: minimalAdapter,
    toolAuditSink: minimalAdapter,
    conversationStore: minimalAdapter,
    planStore: minimalAdapter,
    gradientStore: minimalAdapter,
    agentTrustStore: minimalAdapter,
    serviceListingStore: minimalAdapter,
    budgetAllocationStore: minimalAdapter,
    settlementStore: minimalAdapter,
    latencyStatsStore: minimalAdapter,
    credentialStore: minimalAdapter,
    approvalStore: minimalAdapter,
    close: () => {
      closed.value = true;
    },
  } as unknown as MotebitDatabase;
  return { db, closed };
}

function fakeHandle(): ServiceHandle {
  return {
    shutdown: vi.fn().mockResolvedValue(undefined),
    server: {} as unknown as ServiceHandle["server"],
  };
}

function baseConfig(): MoleculeConfig {
  return {
    dataDir: "/tmp/motebit-test-data",
    dbPath: "/tmp/motebit-test-data/test.db",
    port: 9999,
    serviceName: "motebit-test",
    displayName: "Test",
    serviceDescription: "Unit test molecule",
    capabilities: ["test_tool"],
  };
}

function fakeRuntime(): {
  init: () => Promise<void>;
  stop: () => void;
  stopped: { value: boolean };
  policy: unknown;
  getState: () => unknown;
  memory: unknown;
  events: unknown;
  getToolRegistry: () => unknown;
} {
  const stopped = { value: false };
  return {
    init: vi.fn().mockResolvedValue(undefined),
    stop: () => {
      stopped.value = true;
    },
    stopped,
    policy: {
      filterTools: (t: unknown) => t,
      validate: () => ({ allowed: true }),
      createTurnContext: () => ({}),
    },
    getState: () => ({}),
    memory: {
      exportAll: async () => ({ nodes: [], edges: [] }),
      recallRelevant: async () => [],
      formMemory: async () => ({ node_id: "n1" }),
    },
    events: {
      append: async () => undefined,
      appendWithClock: async () => 0,
    },
    getToolRegistry: () => ({
      list: () => [],
      execute: async () => ({ ok: true, data: "noop" }),
    }),
  };
}

function baseAdapters(): MoleculeRunnerAdapters & {
  bootstrapCalls: unknown[];
  openCalls: string[];
  startCalls: unknown[];
  mkdirCalls: string[];
  existsReturns: Record<string, boolean>;
  dbClosed: { value: boolean };
  runtimeStopped: { value: boolean };
  logLines: string[];
} {
  const { db, closed } = fakeDatabase();
  const runtime = fakeRuntime();
  const bootstrapCalls: unknown[] = [];
  const openCalls: string[] = [];
  const startCalls: unknown[] = [];
  const mkdirCalls: string[] = [];
  const existsReturns: Record<string, boolean> = {};
  const logLines: string[] = [];

  return {
    bootstrapCalls,
    openCalls,
    startCalls,
    mkdirCalls,
    existsReturns,
    dbClosed: closed,
    runtimeStopped: runtime.stopped,
    logLines,
    bootstrapIdentity: async (opts) => {
      bootstrapCalls.push(opts);
      return fakeIdentity();
    },
    openDatabase: async (dbPath) => {
      openCalls.push(dbPath);
      return db;
    },
    createRuntime: () => runtime as never,
    startServer: vi.fn(async (deps, cfg) => {
      startCalls.push({ deps, cfg });
      return fakeHandle();
    }),
    existsSync: (p: string) => existsReturns[p] ?? false,
    mkdirSync: (p: string) => {
      mkdirCalls.push(p);
    },
    embedText: async () => new Array(64).fill(0),
    log: (msg) => logLines.push(msg),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runMolecule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: bootstraps identity, opens DB, assembles runtime, starts server", async () => {
    const adapters = baseAdapters();
    const cfg = baseConfig();
    const tools = new InMemoryToolRegistry();
    const build = vi.fn().mockResolvedValue({ toolRegistry: tools });

    const handle = await runMolecule(cfg, build, adapters);

    expect(handle).toBeDefined();
    expect(handle.shutdown).toBeInstanceOf(Function);

    // Bootstrap received all six identity fields
    expect(adapters.bootstrapCalls).toHaveLength(1);
    const bootArgs = adapters.bootstrapCalls[0] as Record<string, unknown>;
    expect(bootArgs.dataDir).toBe(cfg.dataDir);
    expect(bootArgs.serviceName).toBe(cfg.serviceName);
    expect(bootArgs.displayName).toBe(cfg.displayName);
    expect(bootArgs.serviceDescription).toBe(cfg.serviceDescription);
    expect(bootArgs.capabilities).toEqual(cfg.capabilities);

    // DB opened with resolved absolute path
    expect(adapters.openCalls).toHaveLength(1);
    expect(adapters.openCalls[0]).toMatch(/test\.db$/);

    // Build callback received the identity
    expect(build).toHaveBeenCalledTimes(1);
    const buildArg = build.mock.calls[0]![0] as BootstrapAndEmitIdentityResult;
    expect(buildArg.motebitId).toBe("mot_test_12345678");

    // Server started with the right config slice
    expect(adapters.startCalls).toHaveLength(1);
    const { cfg: serverCfg } = adapters.startCalls[0] as { cfg: Record<string, unknown> };
    expect(serverCfg.port).toBe(cfg.port);
    expect(serverCfg.motebitType).toBe("service");
    expect(String(serverCfg.name)).toContain("motebit-test-mot_test");
  });

  it("creates the DB parent directory when missing", async () => {
    const adapters = baseAdapters();
    adapters.existsReturns["/tmp/motebit-test-data"] = false;

    await runMolecule(baseConfig(), () => ({ toolRegistry: new InMemoryToolRegistry() }), adapters);

    // Resolve is OS-dependent but endsWith the expected dir
    expect(adapters.mkdirCalls.length).toBeGreaterThanOrEqual(1);
    expect(adapters.mkdirCalls[0]).toMatch(/motebit-test-data$/);
  });

  it("skips mkdir when parent directory already exists", async () => {
    const adapters = baseAdapters();
    // Mark every path as existing
    adapters.existsSync = () => true;

    await runMolecule(baseConfig(), () => ({ toolRegistry: new InMemoryToolRegistry() }), adapters);

    expect(adapters.mkdirCalls).toHaveLength(0);
  });

  it("propagates identity to the build callback so tool handlers can close over it", async () => {
    const adapters = baseAdapters();
    adapters.bootstrapIdentity = async () =>
      fakeIdentity({ motebitId: "mot_custom", privateKey: new Uint8Array([1, 2, 3]) });

    const seen: BootstrapAndEmitIdentityResult[] = [];
    const build = (id: BootstrapAndEmitIdentityResult) => {
      seen.push(id);
      return { toolRegistry: new InMemoryToolRegistry() };
    };

    await runMolecule(baseConfig(), build, adapters);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.motebitId).toBe("mot_custom");
    expect(Array.from(seen[0]!.privateKey)).toEqual([1, 2, 3]);
  });

  it("passes through handleAgentTask when provided", async () => {
    const adapters = baseAdapters();
    const handleAgentTask = async function* () {
      yield { type: "text" as const, text: "hello" };
    };

    await runMolecule(
      baseConfig(),
      () => ({ toolRegistry: new InMemoryToolRegistry(), handleAgentTask }),
      adapters,
    );

    const deps = (adapters.startCalls[0] as { deps: Record<string, unknown> }).deps;
    expect(deps.handleAgentTask).toBe(handleAgentTask);
  });

  it("passes through getServiceListing when provided", async () => {
    const adapters = baseAdapters();
    const getServiceListing = vi.fn().mockResolvedValue({
      capabilities: ["test_tool"],
      pricing: [{ capability: "test_tool", unit_cost: 0.1, currency: "USD", per: "call" }],
      sla: { max_latency_ms: 30_000, availability_guarantee: 0.99 },
      description: "Test listing",
    });

    await runMolecule(
      baseConfig(),
      () => ({ toolRegistry: new InMemoryToolRegistry(), getServiceListing }),
      adapters,
    );

    const deps = (adapters.startCalls[0] as { deps: Record<string, unknown> }).deps;
    expect(deps.getServiceListing).toBe(getServiceListing);
  });

  it("wires customRoutes into the server config", async () => {
    const adapters = baseAdapters();
    const customRoutes = vi.fn().mockResolvedValue(true);

    await runMolecule(
      baseConfig(),
      () => ({ toolRegistry: new InMemoryToolRegistry(), customRoutes }),
      adapters,
    );

    const serverCfg = (adapters.startCalls[0] as { cfg: Record<string, unknown> }).cfg;
    expect(serverCfg.customRoutes).toBe(customRoutes);
  });

  it("forwards authToken, syncUrl, apiToken, publicUrl when present", async () => {
    const adapters = baseAdapters();
    const cfg: MoleculeConfig = {
      ...baseConfig(),
      authToken: "tok_auth",
      syncUrl: "https://relay.example",
      apiToken: "tok_api",
      publicUrl: "https://self.example",
    };

    await runMolecule(cfg, () => ({ toolRegistry: new InMemoryToolRegistry() }), adapters);

    const serverCfg = (adapters.startCalls[0] as { cfg: Record<string, unknown> }).cfg;
    expect(serverCfg.authToken).toBe("tok_auth");
    expect(serverCfg.syncUrl).toBe("https://relay.example");
    expect(serverCfg.apiToken).toBe("tok_api");
    expect(serverCfg.publicEndpointUrl).toBe("https://self.example");
  });

  it("omits optional server-config fields when config leaves them unset", async () => {
    const adapters = baseAdapters();
    await runMolecule(baseConfig(), () => ({ toolRegistry: new InMemoryToolRegistry() }), adapters);

    const serverCfg = (adapters.startCalls[0] as { cfg: Record<string, unknown> }).cfg;
    expect(serverCfg.authToken).toBeUndefined();
    expect(serverCfg.syncUrl).toBeUndefined();
    expect(serverCfg.apiToken).toBeUndefined();
    expect(serverCfg.publicEndpointUrl).toBeUndefined();
  });

  it("disables embedText wiring when adapters.embedText === null", async () => {
    const adapters = baseAdapters();
    adapters.embedText = null;

    await runMolecule(baseConfig(), () => ({ toolRegistry: new InMemoryToolRegistry() }), adapters);

    const deps = (adapters.startCalls[0] as { deps: Record<string, unknown> }).deps;
    // Without embedText, wireServerDeps skips queryMemories/storeMemory wiring
    expect(deps.queryMemories).toBeUndefined();
    expect(deps.storeMemory).toBeUndefined();
  });

  it("runs onStop hook, stops runtime, closes DB, and zeroes private key by default", async () => {
    const adapters = baseAdapters();
    const privKey = new Uint8Array([1, 2, 3, 4, 5]);
    adapters.bootstrapIdentity = async () => fakeIdentity({ privateKey: privKey });

    const onStop = vi.fn();
    await runMolecule(
      baseConfig(),
      () => ({ toolRegistry: new InMemoryToolRegistry(), onStop }),
      adapters,
    );

    // Trigger the server's onStop callback
    const serverCfg = (adapters.startCalls[0] as { cfg: Record<string, unknown> }).cfg;
    (serverCfg.onStop as () => void)();

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(adapters.dbClosed.value).toBe(true);
    expect(adapters.runtimeStopped.value).toBe(true);
    // Private key bytes are zeroed
    expect(Array.from(privKey)).toEqual([0, 0, 0, 0, 0]);
  });

  it("preserves private key when zeroPrivateKeyOnShutdown is false", async () => {
    const adapters = baseAdapters();
    const privKey = new Uint8Array([9, 8, 7]);
    adapters.bootstrapIdentity = async () => fakeIdentity({ privateKey: privKey });

    await runMolecule(
      baseConfig(),
      () => ({ toolRegistry: new InMemoryToolRegistry(), zeroPrivateKeyOnShutdown: false }),
      adapters,
    );

    const serverCfg = (adapters.startCalls[0] as { cfg: Record<string, unknown> }).cfg;
    (serverCfg.onStop as () => void)();

    expect(Array.from(privKey)).toEqual([9, 8, 7]);
  });

  it("catches and logs molecule onStop errors so shutdown still completes", async () => {
    const adapters = baseAdapters();
    const onStop = vi.fn().mockRejectedValue(new Error("cleanup boom"));

    await runMolecule(
      baseConfig(),
      () => ({ toolRegistry: new InMemoryToolRegistry(), onStop }),
      adapters,
    );

    const serverCfg = (adapters.startCalls[0] as { cfg: Record<string, unknown> }).cfg;
    (serverCfg.onStop as () => void)();

    // Let the async rejection propagate through
    await new Promise((r) => setTimeout(r, 0));

    expect(onStop).toHaveBeenCalledTimes(1);
    // The error message surfaced through the log
    const logged = adapters.logLines.join("\n");
    expect(logged).toMatch(/molecule onStop error: cleanup boom/);
  });

  it("forwards policyOverrides verbatim to createRuntime", async () => {
    const adapters = baseAdapters();
    const overrides = { requireApprovalAbove: 2, denyAbove: 4 } as never;
    const createRuntime = vi.fn().mockImplementation(() => fakeRuntime());
    adapters.createRuntime = createRuntime;

    await runMolecule(
      baseConfig(),
      () => ({
        toolRegistry: new InMemoryToolRegistry(),
        policyOverrides: overrides,
      }),
      adapters,
    );

    expect(createRuntime).toHaveBeenCalledTimes(1);
    // (identity, storage, toolRegistry, policyOverrides)
    const args = createRuntime.mock.calls[0]!;
    expect(args[3]).toEqual({ requireApprovalAbove: 2, denyAbove: 4 });
  });

  it("falls back to the auto-R3 default policyOverrides when the builder omits them", async () => {
    const adapters = baseAdapters();
    const createRuntime = vi.fn().mockImplementation(() => fakeRuntime());
    adapters.createRuntime = createRuntime;

    await runMolecule(baseConfig(), () => ({ toolRegistry: new InMemoryToolRegistry() }), adapters);

    const args = createRuntime.mock.calls[0]!;
    // requireApprovalAbove === denyAbove === R3_EXECUTE (numeric 3)
    const overrides = args[3] as { requireApprovalAbove: number; denyAbove: number };
    expect(overrides.requireApprovalAbove).toBe(3);
    expect(overrides.denyAbove).toBe(3);
  });

  it("build callback is awaited (supports async service assembly)", async () => {
    const adapters = baseAdapters();
    let resolved = false;

    await runMolecule(
      baseConfig(),
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        resolved = true;
        return { toolRegistry: new InMemoryToolRegistry() };
      },
      adapters,
    );

    expect(resolved).toBe(true);
    // Server only starts after build resolved
    expect(adapters.startCalls).toHaveLength(1);
  });

  it("passes serverLog override through to startServiceServer", async () => {
    const adapters = baseAdapters();
    const serverLog = vi.fn();
    adapters.serverLog = serverLog;

    await runMolecule(baseConfig(), () => ({ toolRegistry: new InMemoryToolRegistry() }), adapters);

    const serverCfg = (adapters.startCalls[0] as { cfg: Record<string, unknown> }).cfg;
    expect(serverCfg.log).toBe(serverLog);
  });

  it("onStart logs port and tool count when invoked by the server stub", async () => {
    const adapters = baseAdapters();
    const registry = new InMemoryToolRegistry();

    await runMolecule(baseConfig(), () => ({ toolRegistry: registry }), adapters);

    const serverCfg = (adapters.startCalls[0] as { cfg: Record<string, unknown> }).cfg;
    (serverCfg.onStart as (port: number, toolCount: number) => void)(9999, 3);

    const logged = adapters.logLines.join("\n");
    expect(logged).toMatch(/MCP server running on http:\/\/localhost:9999/);
    expect(logged).toMatch(/3 tools exposed/);
  });

  it("logs 'loaded' (not 'generated') when isFirstLaunch is false", async () => {
    const adapters = baseAdapters();
    adapters.bootstrapIdentity = async () => fakeIdentity({ isFirstLaunch: false });

    await runMolecule(baseConfig(), () => ({ toolRegistry: new InMemoryToolRegistry() }), adapters);

    const logged = adapters.logLines.join("\n");
    expect(logged).toMatch(/Identity loaded:/);
    expect(logged).not.toMatch(/Identity generated:/);
  });

  it("uses default log when adapters.log is omitted", async () => {
    const adapters = baseAdapters();
    // Remove the test log sink to exercise the default fallback
    delete (adapters as MoleculeRunnerAdapters).log;

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runMolecule(baseConfig(), () => ({ toolRegistry: new InMemoryToolRegistry() }), adapters);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("uses the default embed function when adapters.embedText is undefined", async () => {
    const adapters = baseAdapters();
    // Remove override — the runner should fall back to the default
    delete (adapters as MoleculeRunnerAdapters).embedText;

    await runMolecule(baseConfig(), () => ({ toolRegistry: new InMemoryToolRegistry() }), adapters);

    // With embed wired in, wireServerDeps populates queryMemories/storeMemory
    const deps = (adapters.startCalls[0] as { deps: Record<string, unknown> }).deps;
    expect(deps.queryMemories).toBeDefined();
    expect(deps.storeMemory).toBeDefined();
  });

  it("shutdown without a molecule onStop just closes DB + runtime (no extra side effects)", async () => {
    const adapters = baseAdapters();
    // No onStop provided — exercises the `if (molecule.onStop)` false branch
    await runMolecule(baseConfig(), () => ({ toolRegistry: new InMemoryToolRegistry() }), adapters);

    const serverCfg = (adapters.startCalls[0] as { cfg: Record<string, unknown> }).cfg;
    (serverCfg.onStop as () => void)();

    expect(adapters.dbClosed.value).toBe(true);
    expect(adapters.runtimeStopped.value).toBe(true);
  });

  it("falls back to defaultCreateRuntime when adapters.createRuntime is undefined", async () => {
    // Provide a stub DB and a no-op startServer so the real runtime's
    // init path has something to wire. `createInMemoryStorage` gives us
    // the full adapter surface — same factory the other in-process
    // runtime tests use.
    const adapters = baseAdapters();
    delete (adapters as MoleculeRunnerAdapters).createRuntime;
    // Swap the fakeDatabase for one that hands the runtime
    // createInMemoryStorage's adapters by proxy.
    const storage = createInMemoryStorage();
    const storageAny = storage as unknown as Record<string, unknown>;
    adapters.openDatabase = async () =>
      ({
        ...storageAny,
        close: () => {},
      }) as never;

    await runMolecule(baseConfig(), () => ({ toolRegistry: new InMemoryToolRegistry() }), adapters);

    // A real MotebitRuntime booted and wireServerDeps was called on it
    expect(adapters.startCalls).toHaveLength(1);
  });
});

describe("defaultLog", () => {
  it("prefixes messages with an ISO timestamp", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    defaultLog("boot complete");
    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[\d{4}-\d{2}-\d{2}T.+\] boot complete$/),
    );
    spy.mockRestore();
  });
});

describe("defaultCreateRuntime", () => {
  it("constructs a real MotebitRuntime with in-memory storage", () => {
    const identity = fakeIdentity();
    const storage = createInMemoryStorage();
    const tools = new InMemoryToolRegistry();
    const runtime = defaultCreateRuntime(identity, storage, tools, {});

    expect(runtime).toBeDefined();
    // Duck-typed RunnerRuntime surface — both methods present
    expect(typeof runtime.init).toBe("function");
    expect(typeof runtime.stop).toBe("function");
  });
});
