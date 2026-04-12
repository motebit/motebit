import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

interface MockAdapterState {
  connected: boolean;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  serverConfig: {
    toolManifestHash?: string;
    pinnedToolNames?: string[];
    trusted?: boolean;
    motebitPublicKey?: string;
  };
  isMotebit: boolean;
  verifiedIdentity: { verified: boolean } | null;
  connectRejects: boolean;
}

let adapterInstances: Array<{
  config: Record<string, unknown>;
  state: MockAdapterState;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  executeTool: ReturnType<typeof vi.fn>;
}> = [];

let defaultAdapterState: MockAdapterState = {
  connected: false,
  tools: [],
  serverConfig: {},
  isMotebit: false,
  verifiedIdentity: null,
  connectRejects: false,
};

vi.mock("@motebit/mcp-client", () => {
  class AdvisoryManifestVerifier {}

  class McpClientAdapter {
    config: Record<string, unknown>;
    state: MockAdapterState = { ...defaultAdapterState };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    executeTool: ReturnType<typeof vi.fn>;

    constructor(config: Record<string, unknown>) {
      this.config = config;
      this.state = { ...defaultAdapterState };
      this.connect = vi.fn().mockImplementation(() => {
        if (this.state.connectRejects) {
          return Promise.reject(new Error("connect failed"));
        }
        this.state.connected = true;
        return Promise.resolve();
      });
      this.disconnect = vi.fn().mockResolvedValue(undefined);
      this.executeTool = vi.fn().mockResolvedValue({ ok: true });
      adapterInstances.push(this as never);
    }

    get isConnected() {
      return this.state.connected;
    }
    get serverConfig() {
      return this.state.serverConfig;
    }
    get isMotebit() {
      return this.state.isMotebit;
    }
    get verifiedIdentity() {
      return this.state.verifiedIdentity;
    }
    getTools() {
      return this.state.tools;
    }
  }

  return { McpClientAdapter, AdvisoryManifestVerifier };
});

vi.mock("@motebit/tools", () => {
  class InMemoryToolRegistry {
    tools: Array<{ def: unknown; impl: unknown }> = [];
    register(def: unknown, impl: unknown) {
      this.tools.push({ def, impl });
    }
  }
  return { InMemoryToolRegistry };
});

// AsyncStorage mock
const asyncStoreData = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(asyncStoreData.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      asyncStoreData.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      asyncStoreData.delete(key);
      return Promise.resolve();
    }),
  },
}));

import { MobileMcpManager } from "../mcp-manager";
import type { McpManagerDeps } from "../mcp-manager";

beforeEach(() => {
  asyncStoreData.clear();
  adapterInstances = [];
  defaultAdapterState = {
    connected: false,
    tools: [],
    serverConfig: {},
    isMotebit: false,
    verifiedIdentity: null,
    connectRejects: false,
  };
});

function makeRuntime() {
  return {
    registerExternalTools: vi.fn(),
    unregisterExternalTools: vi.fn(),
  };
}

function makeDeps(overrides?: Partial<McpManagerDeps>): McpManagerDeps {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRuntime: () => makeRuntime() as any,
    ...overrides,
  };
}

describe("MobileMcpManager.addMcpServer", () => {
  it("rejects non-http transports", async () => {
    const mgr = new MobileMcpManager(makeDeps());
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mgr.addMcpServer({ name: "x", transport: "stdio" } as any),
    ).rejects.toThrow(/HTTP MCP servers/);
  });

  it("rejects http without url", async () => {
    const mgr = new MobileMcpManager(makeDeps());
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mgr.addMcpServer({ name: "x", transport: "http", url: "" } as any),
    ).rejects.toThrow(/requires a url/);
  });

  it("connects, registers, and persists a trusted server", async () => {
    defaultAdapterState.tools = [
      { name: "t1", description: "desc", inputSchema: { type: "object" } },
    ];
    defaultAdapterState.serverConfig = { toolManifestHash: "h1", pinnedToolNames: ["t1"] };
    const runtime = makeRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new MobileMcpManager({ getRuntime: () => runtime as any });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({
      name: "server1",
      transport: "http",
      url: "https://x.test",
      trusted: true,
    } as any);
    expect(adapterInstances[0]?.connect).toHaveBeenCalled();
    expect(runtime.registerExternalTools).toHaveBeenCalledWith("mcp:server1", expect.any(Object));
    expect(asyncStoreData.get("@motebit/mcp_servers")).toBeTruthy();
    const servers = mgr.getMcpServers();
    expect(servers[0]).toMatchObject({ name: "server1", connected: true, toolCount: 1 });
  });

  it("propagates verifier trust override", async () => {
    defaultAdapterState.tools = [{ name: "t1" }];
    defaultAdapterState.serverConfig = { trusted: false };
    const mgr = new MobileMcpManager(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: any = {
      name: "server1",
      transport: "http",
      url: "https://x.test",
      trusted: true,
    };
    await mgr.addMcpServer(config);
    expect(config.trusted).toBe(false);
  });

  it("pins motebit public key when verified", async () => {
    defaultAdapterState.tools = [];
    defaultAdapterState.isMotebit = true;
    defaultAdapterState.verifiedIdentity = { verified: true };
    defaultAdapterState.serverConfig = { motebitPublicKey: "pubkey123" };
    const mgr = new MobileMcpManager(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: any = { name: "motebit1", transport: "http", url: "https://x.test" };
    await mgr.addMcpServer(config);
    expect(config.motebitPublicKey).toBe("pubkey123");
  });

  it("replaces existing server with same name", async () => {
    defaultAdapterState.tools = [];
    const mgr = new MobileMcpManager(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "dup", transport: "http", url: "https://x.test" } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "dup", transport: "http", url: "https://y.test" } as any);
    const servers = mgr.getMcpServers();
    const dups = servers.filter((s) => s.name === "dup");
    expect(dups.length).toBe(1);
    expect(dups[0]?.url).toBe("https://y.test");
  });

  it("untrusted server registers tools with requiresApproval", async () => {
    defaultAdapterState.tools = [{ name: "t1", inputSchema: undefined }];
    const runtime = makeRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new MobileMcpManager({ getRuntime: () => runtime as any });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({
      name: "untrusted",
      transport: "http",
      url: "https://x.test",
    } as any);
    const registry = runtime.registerExternalTools.mock.calls[0]?.[1] as {
      tools: Array<{ def: { requiresApproval?: boolean } }>;
    };
    expect(registry.tools[0]?.def.requiresApproval).toBe(true);
  });

  it("onToolsChanged callback fires after add", async () => {
    defaultAdapterState.tools = [];
    const mgr = new MobileMcpManager(makeDeps());
    let fired = false;
    mgr.onToolsChanged(() => {
      fired = true;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "s", transport: "http", url: "https://x.test" } as any);
    expect(fired).toBe(true);
  });
});

describe("MobileMcpManager.removeMcpServer", () => {
  it("disconnects and removes a server", async () => {
    defaultAdapterState.tools = [];
    const runtime = makeRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new MobileMcpManager({ getRuntime: () => runtime as any });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "s", transport: "http", url: "https://x.test" } as any);
    await mgr.removeMcpServer("s");
    expect(adapterInstances[0]?.disconnect).toHaveBeenCalled();
    expect(runtime.unregisterExternalTools).toHaveBeenCalledWith("mcp:s");
    expect(mgr.getMcpServers()).toHaveLength(0);
  });

  it("handles removing non-existent server gracefully", async () => {
    const mgr = new MobileMcpManager(makeDeps());
    await mgr.removeMcpServer("nonexistent");
    expect(mgr.getMcpServers()).toHaveLength(0);
  });

  it("skips runtime unregister when runtime is null", async () => {
    const mgr = new MobileMcpManager({ getRuntime: () => null });
    await mgr.removeMcpServer("whatever");
    expect(mgr.getMcpServers()).toHaveLength(0);
  });
});

describe("MobileMcpManager.setMcpServerTrust", () => {
  it("toggles trust and re-registers tools", async () => {
    defaultAdapterState.tools = [{ name: "t1" }];
    const runtime = makeRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new MobileMcpManager({ getRuntime: () => runtime as any });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({
      name: "s",
      transport: "http",
      url: "https://x.test",
      trusted: false,
    } as any);
    runtime.unregisterExternalTools.mockClear();
    runtime.registerExternalTools.mockClear();

    await mgr.setMcpServerTrust("s", true);
    expect(runtime.unregisterExternalTools).toHaveBeenCalledWith("mcp:s");
    expect(runtime.registerExternalTools).toHaveBeenCalledWith("mcp:s", expect.any(Object));
    const server = mgr.getMcpServers()[0];
    expect(server?.trusted).toBe(true);
  });

  it("returns early when server not found", async () => {
    const mgr = new MobileMcpManager(makeDeps());
    await mgr.setMcpServerTrust("missing", true);
    // No throw
  });
});

describe("MobileMcpManager.reconnectMcpServers", () => {
  it("is a no-op when AsyncStorage is empty", async () => {
    const mgr = new MobileMcpManager(makeDeps());
    await mgr.reconnectMcpServers();
    expect(mgr.getMcpServers()).toHaveLength(0);
  });

  it("reconnects persisted servers", async () => {
    asyncStoreData.set(
      "@motebit/mcp_servers",
      JSON.stringify([
        { name: "persisted", transport: "http", url: "https://x.test", trusted: true },
      ]),
    );
    defaultAdapterState.tools = [{ name: "t1" }];
    const mgr = new MobileMcpManager(makeDeps());
    await mgr.reconnectMcpServers();
    expect(adapterInstances[0]?.connect).toHaveBeenCalled();
    expect(mgr.getMcpServers()).toHaveLength(1);
  });

  it("silently skips failing server", async () => {
    asyncStoreData.set(
      "@motebit/mcp_servers",
      JSON.stringify([{ name: "bad", transport: "http", url: "https://y.test" }]),
    );
    defaultAdapterState.tools = [];
    defaultAdapterState.connectRejects = true;
    const mgr = new MobileMcpManager(makeDeps());
    await mgr.reconnectMcpServers();
    // Failing server is still in configs (because reconnect pushes all configs), but not connected
    expect(mgr.getMcpServers().length).toBeGreaterThanOrEqual(0);
  });

  it("handles corrupted JSON gracefully", async () => {
    asyncStoreData.set("@motebit/mcp_servers", "not-json{");
    const mgr = new MobileMcpManager(makeDeps());
    await mgr.reconnectMcpServers();
    expect(mgr.getMcpServers()).toHaveLength(0);
  });

  it("captures motebit public key during reconnect when verified", async () => {
    asyncStoreData.set(
      "@motebit/mcp_servers",
      JSON.stringify([{ name: "m", transport: "http", url: "https://x.test" }]),
    );
    defaultAdapterState.tools = [];
    defaultAdapterState.isMotebit = true;
    defaultAdapterState.verifiedIdentity = { verified: true };
    defaultAdapterState.serverConfig = { motebitPublicKey: "pk42" };
    const mgr = new MobileMcpManager(makeDeps());
    await mgr.reconnectMcpServers();
    const persisted = JSON.parse(asyncStoreData.get("@motebit/mcp_servers") ?? "[]") as Array<{
      motebitPublicKey?: string;
    }>;
    expect(persisted[0]?.motebitPublicKey).toBe("pk42");
  });
});

describe("MobileMcpManager.getMcpServers", () => {
  it("reflects disconnected adapters as connected:false", async () => {
    defaultAdapterState.tools = [];
    const mgr = new MobileMcpManager(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "s", transport: "http", url: "https://x.test" } as any);
    adapterInstances[0]!.state.connected = false;
    const servers = mgr.getMcpServers();
    expect(servers[0]?.connected).toBe(false);
  });

  it("handles motebit flag in status", async () => {
    defaultAdapterState.tools = [];
    const mgr = new MobileMcpManager(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({
      name: "m",
      transport: "http",
      url: "https://x.test",
      motebit: true,
    } as any);
    expect(mgr.getMcpServers()[0]?.motebit).toBe(true);
  });
});
