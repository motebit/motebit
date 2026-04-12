import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @motebit/mcp-client dynamic import (hoisted state via vi.hoisted)
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
  interface MockAdapterState {
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
    verifiedIdentity: { verified: boolean; public_key?: string } | null;
    connectRejects: boolean;
  }

  return {
    adapterInstances: [] as Array<{
      config: Record<string, unknown>;
      state: MockAdapterState;
      connect: ReturnType<typeof import("vitest").vi.fn>;
      disconnect: ReturnType<typeof import("vitest").vi.fn>;
      registerInto: ReturnType<typeof import("vitest").vi.fn>;
    }>,
    defaultAdapterState: {
      tools: [],
      serverConfig: {},
      isMotebit: false,
      verifiedIdentity: null,
      connectRejects: false,
    } as MockAdapterState,
    dynamicImportShouldFail: false,
  };
});

vi.mock("@motebit/mcp-client", () => {
  class AdvisoryManifestVerifier {}

  class McpClientAdapter {
    config: Record<string, unknown>;
    state: typeof mockState.defaultAdapterState;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    registerInto: ReturnType<typeof vi.fn>;

    constructor(config: Record<string, unknown>) {
      if (mockState.dynamicImportShouldFail) {
        throw new Error("dynamic import failed");
      }
      this.config = config;
      this.state = { ...mockState.defaultAdapterState };
      this.connect = vi.fn(async () => {
        if (this.state.connectRejects) throw new Error("connect failed");
      });
      this.disconnect = vi.fn(async () => {});
      this.registerInto = vi.fn((registry: { register: (d: unknown, h: unknown) => void }) => {
        for (const t of this.state.tools) {
          registry.register(
            { name: t.name, description: t.description, inputSchema: t.inputSchema ?? {} },
            async () => ({ ok: true }),
          );
        }
      });
      mockState.adapterInstances.push(this as never);
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

  return { AdvisoryManifestVerifier, McpClientAdapter };
});

import { McpManager } from "../mcp-manager";

const adapterInstances = mockState.adapterInstances;
const defaultAdapterState = mockState.defaultAdapterState;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime() {
  return {
    registerExternalTools: vi.fn(),
    unregisterExternalTools: vi.fn(),
  };
}

beforeEach(() => {
  mockState.adapterInstances.length = 0;
  mockState.dynamicImportShouldFail = false;
  mockState.defaultAdapterState.tools = [];
  mockState.defaultAdapterState.serverConfig = {};
  mockState.defaultAdapterState.isMotebit = false;
  mockState.defaultAdapterState.verifiedIdentity = null;
  mockState.defaultAdapterState.connectRejects = false;
});

// ---------------------------------------------------------------------------
// addMcpServer
// ---------------------------------------------------------------------------

describe("McpManager.addMcpServer", () => {
  it("connects, registers, persists", async () => {
    defaultAdapterState.tools = [{ name: "t1" }, { name: "t2" }];
    defaultAdapterState.serverConfig = {
      toolManifestHash: "h1",
      pinnedToolNames: ["t1", "t2"],
      trusted: true,
    };
    const runtime = makeRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => runtime as any);
    const status = await mgr.addMcpServer({
      name: "s1",
      transport: "stdio",
      trusted: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(status.connected).toBe(true);
    expect(status.toolCount).toBe(2);
    expect(runtime.registerExternalTools).toHaveBeenCalledWith("mcp:s1", expect.any(Object));
  });

  it("flags manifestChanged when verifier downgrades trust", async () => {
    defaultAdapterState.tools = [{ name: "t1" }];
    defaultAdapterState.serverConfig = {
      trusted: false,
      pinnedToolNames: ["t1", "t2-new"],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => makeRuntime() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: any = {
      name: "s1",
      transport: "stdio",
      trusted: true,
      pinnedToolNames: ["t1"],
    };
    const status = await mgr.addMcpServer(config);
    expect(status.manifestChanged).toBe(true);
    expect(status.manifestDiff?.added).toContain("t2-new");
  });

  it("pins motebit public key on first verified connect", async () => {
    defaultAdapterState.tools = [];
    defaultAdapterState.isMotebit = true;
    defaultAdapterState.verifiedIdentity = { verified: true, public_key: "pk123" };
    defaultAdapterState.serverConfig = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => makeRuntime() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: any = { name: "m1", transport: "stdio" };
    await mgr.addMcpServer(config);
    expect(config.motebitPublicKey).toBe("pk123");
  });

  it("does not re-pin when motebitPublicKey already set", async () => {
    defaultAdapterState.tools = [];
    defaultAdapterState.isMotebit = true;
    defaultAdapterState.verifiedIdentity = { verified: true, public_key: "new-key" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => makeRuntime() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: any = {
      name: "m1",
      transport: "stdio",
      motebitPublicKey: "existing",
    };
    await mgr.addMcpServer(config);
    expect(config.motebitPublicKey).toBe("existing");
  });

  it("skips runtime register when runtime is null", async () => {
    defaultAdapterState.tools = [{ name: "t1" }];
    const mgr = new McpManager(() => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = await mgr.addMcpServer({ name: "s", transport: "stdio" } as any);
    expect(status.connected).toBe(true);
  });

  it("propagates connect errors", async () => {
    defaultAdapterState.connectRejects = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => makeRuntime() as any);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mgr.addMcpServer({ name: "s", transport: "stdio" } as any),
    ).rejects.toThrow("connect failed");
  });
});

// ---------------------------------------------------------------------------
// removeMcpServer
// ---------------------------------------------------------------------------

describe("McpManager.removeMcpServer", () => {
  it("disconnects + unregisters", async () => {
    defaultAdapterState.tools = [];
    const runtime = makeRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => runtime as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "s", transport: "stdio" } as any);
    await mgr.removeMcpServer("s");
    expect(adapterInstances[0]?.disconnect).toHaveBeenCalled();
    expect(runtime.unregisterExternalTools).toHaveBeenCalledWith("mcp:s");
    expect(mgr.getMcpStatus()).toHaveLength(0);
  });

  it("no-ops when server doesn't exist", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => makeRuntime() as any);
    await expect(mgr.removeMcpServer("missing")).resolves.toBeUndefined();
  });

  it("skips runtime unregister when runtime is null", async () => {
    const mgr = new McpManager(() => null);
    await expect(mgr.removeMcpServer("x")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getMcpStatus
// ---------------------------------------------------------------------------

describe("McpManager.getMcpStatus", () => {
  it("returns empty array initially", () => {
    const mgr = new McpManager(() => null);
    expect(mgr.getMcpStatus()).toEqual([]);
  });

  it("reports connected and tool count after addMcpServer", async () => {
    defaultAdapterState.tools = [{ name: "t1" }];
    defaultAdapterState.serverConfig = { trusted: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => makeRuntime() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mgr.addMcpServer({ name: "s", transport: "stdio", trusted: true } as any);
    const statuses = mgr.getMcpStatus();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      name: "s",
      transport: "stdio",
      trusted: true,
      connected: true,
      toolCount: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// connectMcpServerViaTauri (fallback IPC path)
// ---------------------------------------------------------------------------

describe("McpManager.connectMcpServerViaTauri", () => {
  it("uses native addMcpServer path first", async () => {
    defaultAdapterState.tools = [{ name: "t1" }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => makeRuntime() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const invoke: any = vi.fn();
    const status = await mgr.connectMcpServerViaTauri(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { name: "s", transport: "stdio", trusted: true } as any,
      invoke,
    );
    expect(status.connected).toBe(true);
    // Native path works, so invoke should not be called for shell_exec
    expect(invoke).not.toHaveBeenCalled();
  });

  it("falls back to IPC bridge when native fails, then rejects non-stdio or missing command", async () => {
    // Force native import path to fail
    mockState.dynamicImportShouldFail = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => makeRuntime() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const invoke: any = vi.fn();
    const status = await mgr.connectMcpServerViaTauri(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { name: "s", transport: "http", url: "https://x" } as any,
      invoke,
    );
    expect(status.connected).toBe(false);
    expect(status.toolCount).toBe(0);
    // non-stdio never calls shell_exec
    expect(invoke).not.toHaveBeenCalled();
  });

  it("IPC bridge: spawns + parses tools list", async () => {
    mockState.dynamicImportShouldFail = true;
    const runtime = makeRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => runtime as any);
    const stdout = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [
            {
              name: "toolA",
              description: "A",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      }),
    ].join("\n");
    const invoke = vi.fn(async () => ({
      stdout,
      stderr: "",
      exit_code: 0,
    }));
    const status = await mgr.connectMcpServerViaTauri(
      {
        name: "mcp1",
        transport: "stdio",
        command: "mcp-tool",
        args: ["--flag"],
        trusted: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke as any,
    );
    expect(status.connected).toBe(true);
    expect(status.toolCount).toBe(1);
    expect(runtime.registerExternalTools).toHaveBeenCalledWith("mcp:mcp1", expect.any(Object));
  });

  it("IPC bridge: shell_exec with non-zero exit marks disconnected", async () => {
    mockState.dynamicImportShouldFail = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => makeRuntime() as any);
    const invoke = vi.fn(async () => ({
      stdout: "",
      stderr: "boom",
      exit_code: 1,
    }));
    const status = await mgr.connectMcpServerViaTauri(
      {
        name: "mcp1",
        transport: "stdio",
        command: "mcp-tool",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke as any,
    );
    expect(status.connected).toBe(false);
  });

  it("IPC bridge: invoke rejection marks disconnected", async () => {
    mockState.dynamicImportShouldFail = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => makeRuntime() as any);
    const invoke = vi.fn(async () => {
      throw new Error("shell exec denied");
    });
    const status = await mgr.connectMcpServerViaTauri(
      {
        name: "mcp1",
        transport: "stdio",
        command: "mcp-tool",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke as any,
    );
    expect(status.connected).toBe(false);
    expect(status.toolCount).toBe(0);
  });

  it("IPC bridge: skips unparseable stdout lines", async () => {
    mockState.dynamicImportShouldFail = true;
    const runtime = makeRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => runtime as any);
    const stdout = [
      "not-json",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [{ name: "only-one" }] },
      }),
    ].join("\n");
    const invoke = vi.fn(async () => ({ stdout, stderr: "", exit_code: 0 }));
    const status = await mgr.connectMcpServerViaTauri(
      {
        name: "mcp1",
        transport: "stdio",
        command: "mcp-tool",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke as any,
    );
    expect(status.toolCount).toBe(1);
  });

  it("IPC bridge: missing command with stdio transport marks disconnected", async () => {
    mockState.dynamicImportShouldFail = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new McpManager(() => makeRuntime() as any);
    const invoke = vi.fn();
    const status = await mgr.connectMcpServerViaTauri(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { name: "bad", transport: "stdio", command: "" } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke as any,
    );
    expect(status.connected).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
