import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock @motebit/mcp-client (the live adapter) ---------------------------

interface MockAdapterState {
  connected: boolean;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
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

let adapterInstances: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
let defaultAdapterState: MockAdapterState;

vi.mock("@motebit/mcp-client", () => {
  class AdvisoryManifestVerifier {}
  class McpClientAdapter {
    state: MockAdapterState = { ...defaultAdapterState };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    executeTool: ReturnType<typeof vi.fn>;
    constructor(_config: Record<string, unknown>) {
      this.state = { ...defaultAdapterState };
      this.connect = vi.fn().mockImplementation(() => {
        if (this.state.connectRejects) return Promise.reject(new Error("connect failed"));
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

import { McpManager } from "../mcp-manager.js";
import type { McpManagerCoreDeps, KeyValueStore, ExternalToolHost } from "../mcp-manager.js";

const KEY = "motebit:mcp_servers";

// In-memory KeyValueStore port (stands in for AsyncStorage / localStorage).
function makeStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => Promise.resolve(data.get(k) ?? null),
    setItem: (k, v) => {
      data.set(k, v);
      return Promise.resolve();
    },
  };
}

function makeHost() {
  const host = { registerExternalTools: vi.fn(), unregisterExternalTools: vi.fn() };
  return host as typeof host & ExternalToolHost;
}

class StubRegistry {
  tools: Array<{ def: unknown }> = [];
  register(def: unknown) {
    this.tools.push({ def });
  }
}

function makeDeps(overrides?: Partial<McpManagerCoreDeps>): McpManagerCoreDeps {
  return {
    storage: makeStore(),
    storageKey: KEY,
    getToolHost: () => makeHost(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createToolRegistry: () => new StubRegistry() as any,
    ...overrides,
  };
}

beforeEach(() => {
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

describe("McpManager.addMcpServer", () => {
  it("rejects non-http transports", async () => {
    const mgr = new McpManager(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(mgr.addMcpServer({ name: "x", transport: "stdio" } as any)).rejects.toThrow(
      /HTTP MCP servers/,
    );
  });

  it("rejects http without url", async () => {
    const mgr = new McpManager(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      mgr.addMcpServer({ name: "x", transport: "http", url: "" } as any),
    ).rejects.toThrow(/requires a url/);
  });

  it("connects a trusted server, registers tools, and persists via the storage port", async () => {
    defaultAdapterState.tools = [{ name: "t1", description: "d", inputSchema: { type: "object" } }];
    const host = makeHost();
    const store = makeStore();
    const mgr = new McpManager(makeDeps({ storage: store, getToolHost: () => host }));
    await mgr.addMcpServer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      name: "srv",
      transport: "http",
      url: "https://s",
      trusted: true,
    } as any);

    expect(host.registerExternalTools).toHaveBeenCalledWith("mcp:srv", expect.anything());
    // Persisted through the injected store, not a hard-coded backend.
    expect(store.data.get(KEY)).toContain("srv");
    const servers = mgr.getMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "srv", connected: true, toolCount: 1, trusted: true });
  });

  it("pins the motebit public key when a verified motebit server is connected", async () => {
    defaultAdapterState.isMotebit = true;
    defaultAdapterState.verifiedIdentity = { verified: true };
    defaultAdapterState.serverConfig = { motebitPublicKey: "pk-pinned" };
    const store = makeStore();
    const mgr = new McpManager(makeDeps({ storage: store }));
    await mgr.addMcpServer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      name: "srv",
      transport: "http",
      url: "https://s",
    } as any);
    expect(mgr.getMcpServers()[0]!.motebitPublicKey).toBe("pk-pinned");
    expect(store.data.get(KEY)).toContain("pk-pinned");
  });

  it("untrusted server registers tools requiring approval", async () => {
    defaultAdapterState.tools = [{ name: "t1" }];
    const registries: StubRegistry[] = [];
    const mgr = new McpManager(
      makeDeps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createToolRegistry: () => {
          const r = new StubRegistry();
          registries.push(r);
          return r as never;
        },
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "srv", transport: "http", url: "https://s" } as any);
    expect(registries[0]!.tools[0]!.def).toMatchObject({ requiresApproval: true });
  });
});

describe("McpManager.onToolsChanged", () => {
  it("fires the callback after add / remove / trust changes", async () => {
    const cb = vi.fn();
    const mgr = new McpManager(makeDeps());
    mgr.onToolsChanged(cb);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "srv", transport: "http", url: "https://s" } as any);
    expect(cb).toHaveBeenCalledTimes(1);
    await mgr.setMcpServerTrust("srv", true);
    expect(cb).toHaveBeenCalledTimes(2);
    await mgr.removeMcpServer("srv");
    expect(cb).toHaveBeenCalledTimes(3);
  });
});

describe("McpManager.removeMcpServer", () => {
  it("disconnects, unregisters tools, and persists removal", async () => {
    const host = makeHost();
    const store = makeStore();
    const mgr = new McpManager(makeDeps({ storage: store, getToolHost: () => host }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "srv", transport: "http", url: "https://s" } as any);
    await mgr.removeMcpServer("srv");

    expect(host.unregisterExternalTools).toHaveBeenCalledWith("mcp:srv");
    expect(adapterInstances[0]!.disconnect).toHaveBeenCalled();
    expect(mgr.getMcpServers()).toHaveLength(0);
    expect(store.data.get(KEY)).toBe("[]");
  });
});

describe("McpManager.setMcpServerTrust", () => {
  it("re-registers tools with the new approval flag", async () => {
    defaultAdapterState.tools = [{ name: "t1" }];
    const host = makeHost();
    const mgr = new McpManager(makeDeps({ getToolHost: () => host }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "srv", transport: "http", url: "https://s" } as any);
    host.registerExternalTools.mockClear();

    await mgr.setMcpServerTrust("srv", true);
    expect(host.unregisterExternalTools).toHaveBeenCalledWith("mcp:srv");
    expect(host.registerExternalTools).toHaveBeenCalledWith("mcp:srv", expect.anything());
    expect(mgr.getMcpServers()[0]!.trusted).toBe(true);
  });

  it("is a no-op for an unknown server", async () => {
    const mgr = new McpManager(makeDeps());
    await expect(mgr.setMcpServerTrust("nope", true)).resolves.toBeUndefined();
  });
});

describe("McpManager.reconnectMcpServers", () => {
  it("reconnects persisted servers from the storage port", async () => {
    const store = makeStore();
    store.data.set(
      KEY,
      JSON.stringify([{ name: "srv", transport: "http", url: "https://s", trusted: true }]),
    );
    const host = makeHost();
    const mgr = new McpManager(makeDeps({ storage: store, getToolHost: () => host }));
    await mgr.reconnectMcpServers();
    expect(host.registerExternalTools).toHaveBeenCalledWith("mcp:srv", expect.anything());
    expect(mgr.getMcpServers()[0]).toMatchObject({ name: "srv", connected: true });
  });

  it("survives a single failing server (silent per-server failure)", async () => {
    defaultAdapterState.connectRejects = true;
    const store = makeStore();
    store.data.set(KEY, JSON.stringify([{ name: "bad", transport: "http", url: "https://s" }]));
    const mgr = new McpManager(makeDeps({ storage: store }));
    await expect(mgr.reconnectMcpServers()).resolves.toBeUndefined();
    expect(mgr.getMcpServers()[0]).toMatchObject({ name: "bad", connected: false });
  });

  it("no-ops on empty storage", async () => {
    const mgr = new McpManager(makeDeps());
    await expect(mgr.reconnectMcpServers()).resolves.toBeUndefined();
    expect(mgr.getMcpServers()).toHaveLength(0);
  });
});

describe("McpManager.dispose", () => {
  it("disconnects every live adapter", async () => {
    const mgr = new McpManager(makeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "a", transport: "http", url: "https://a" } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "b", transport: "http", url: "https://b" } as any);
    await mgr.dispose();
    expect(adapterInstances[0]!.disconnect).toHaveBeenCalled();
    expect(adapterInstances[1]!.disconnect).toHaveBeenCalled();
  });
});
