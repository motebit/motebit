import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServerAdapter } from "../index.js";
import type { MotebitServerDeps, McpServerConfig } from "../index.js";
import type { ToolDefinition } from "@motebit/sdk";
import { McpClientAdapter } from "@motebit/mcp-client";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { Server } from "node:http";

// === Helpers ===

function toolDef(name: string, overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

const TEST_TOOLS: ToolDefinition[] = [
  toolDef("echo", {
    description: "Echoes input back",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  }),
  toolDef("ping", {
    description: "Returns pong",
  }),
];

const MOTEBIT_ID = "e2e-test-0000-0000-000000000001";
const PUBLIC_KEY_HEX = "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";

function makeDeps(overrides?: Partial<MotebitServerDeps>): MotebitServerDeps {
  return {
    motebitId: MOTEBIT_ID,
    publicKeyHex: PUBLIC_KEY_HEX,
    listTools: () => TEST_TOOLS,
    filterTools: (tools) => tools,
    validateTool: () => ({ allowed: true, requiresApproval: false }),
    executeTool: async (name, args) => {
      if (name === "echo") {
        const msg = (args as { message?: string }).message ?? "";
        return { ok: true, data: `echo: ${msg}` };
      }
      if (name === "ping") {
        return { ok: true, data: "pong" };
      }
      return { ok: false, error: `Unknown tool: ${name}` };
    },
    getState: () => ({ attention: 0.5, processing: 0.1 }),
    getMemories: async () => [],
    logToolCall: () => {},
    ...overrides,
  };
}

const TEST_AUTH_TOKEN = "test-e2e-token";

function makeConfig(port: number, overrides?: Partial<McpServerConfig>): McpServerConfig {
  return {
    transport: "http",
    port,
    authToken: TEST_AUTH_TOKEN,
    ...overrides,
  };
}

/** Extract the actual listening port from an http.Server. */
function getPort(httpServer: Server): number {
  const addr = httpServer.address();
  if (typeof addr === "object" && addr !== null) {
    return addr.port;
  }
  throw new Error("Server not listening");
}

// ============================================================
// E2E: McpClientAdapter → StreamableHTTP → McpServerAdapter
// ============================================================

describe("E2E: McpClientAdapter ↔ McpServerAdapter (StreamableHTTP)", () => {
  let serverAdapter: McpServerAdapter;
  let port: number;

  beforeAll(async () => {
    // Use port 0 to let the OS assign a free port
    serverAdapter = new McpServerAdapter(makeConfig(0), makeDeps());
    await serverAdapter.start();

    // Extract the actual port from the underlying http server
    // McpServerAdapter stores it as private httpServer — access via reflection
    const httpServer = (serverAdapter as unknown as { httpServer: Server }).httpServer;
    port = getPort(httpServer);
  });

  afterAll(async () => {
    await serverAdapter.stop();
  });

  // --- Test (a): Basic connect + tool discovery ---

  it("connects and discovers tools via StreamableHTTP", async () => {
    const client = new McpClientAdapter({
      name: "test-server",
      transport: "http",
      url: `http://localhost:${port}/mcp`,
      authToken: TEST_AUTH_TOKEN,
    });

    await client.connect();

    try {
      const tools = client.getTools();
      expect(tools.length).toBeGreaterThan(0);

      // Tools are prefixed with the server name
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("test-server__echo");
      expect(toolNames).toContain("test-server__ping");

      // Descriptions are prefixed with server name
      const echoTool = tools.find((t) => t.name === "test-server__echo");
      expect(echoTool?.description).toContain("[test-server]");

      // Manifest check works (first time — no pinned hash)
      const manifest = await client.checkManifest();
      expect(manifest.ok).toBe(true);
      expect(manifest.toolCount).toBeGreaterThan(0);
      expect(manifest.hash).toBeTruthy();
    } finally {
      await client.disconnect();
    }
  });

  // --- Test (b): Tool execution through adapter + registry ---

  it("executes tools through InMemoryToolRegistry", async () => {
    const client = new McpClientAdapter({
      name: "test-server",
      transport: "http",
      url: `http://localhost:${port}/mcp`,
      authToken: TEST_AUTH_TOKEN,
    });

    await client.connect();

    try {
      const registry = new InMemoryToolRegistry();
      client.registerInto(registry);

      // Registry should have the discovered tools
      expect(registry.has("test-server__echo")).toBe(true);
      expect(registry.has("test-server__ping")).toBe(true);

      // Execute echo tool through registry
      const echoResult = await registry.execute("test-server__echo", {
        message: "hello world",
      });
      expect(echoResult.ok).toBe(true);
      expect(typeof echoResult.data).toBe("string");
      expect(echoResult.data as string).toContain("echo: hello world");

      // Execute ping tool through registry
      const pingResult = await registry.execute("test-server__ping", {});
      expect(pingResult.ok).toBe(true);
      expect(typeof pingResult.data).toBe("string");
      expect(pingResult.data as string).toContain("pong");
    } finally {
      await client.disconnect();
    }
  });

  // --- Test (c): Result includes identity tag ---

  it("results include motebit identity tag", async () => {
    const client = new McpClientAdapter({
      name: "test-server",
      transport: "http",
      url: `http://localhost:${port}/mcp`,
      authToken: TEST_AUTH_TOKEN,
    });

    await client.connect();

    try {
      const result = await client.executeTool("test-server__ping", {});
      expect(result.ok).toBe(true);
      // The data should be wrapped with EXTERNAL_DATA and contain the identity tag
      const data = result.data as string;
      expect(data).toContain("[motebit:");
      expect(data).toContain(MOTEBIT_ID.slice(0, 8));
    } finally {
      await client.disconnect();
    }
  });

  // --- Test (d): Manifest pinning ---

  it("manifest hash is stable across reconnections", async () => {
    // First connection — get the manifest hash
    const client1 = new McpClientAdapter({
      name: "test-server",
      transport: "http",
      url: `http://localhost:${port}/mcp`,
      authToken: TEST_AUTH_TOKEN,
    });

    await client1.connect();
    const manifest1 = await client1.checkManifest();
    expect(manifest1.ok).toBe(true);
    const firstHash = manifest1.hash;
    const firstToolNames = manifest1.toolNames;
    await client1.disconnect();

    // Second connection — verify against pinned hash
    const client2 = new McpClientAdapter({
      name: "test-server",
      transport: "http",
      url: `http://localhost:${port}/mcp`,
      authToken: TEST_AUTH_TOKEN,
    });

    await client2.connect();
    const manifest2 = await client2.checkManifest(firstHash, firstToolNames);
    expect(manifest2.ok).toBe(true);
    expect(manifest2.hash).toBe(firstHash);
    expect(manifest2.toolCount).toBe(manifest1.toolCount);
    await client2.disconnect();
  });

  // --- Test (e): External data boundary wrapping ---

  it("wraps tool results in EXTERNAL_DATA boundary markers", async () => {
    const client = new McpClientAdapter({
      name: "test-server",
      transport: "http",
      url: `http://localhost:${port}/mcp`,
      authToken: TEST_AUTH_TOKEN,
    });

    await client.connect();

    try {
      const result = await client.executeTool("test-server__echo", {
        message: "boundary test",
      });
      expect(result.ok).toBe(true);
      const data = result.data as string;
      expect(data).toContain("[EXTERNAL_DATA source=");
      expect(data).toContain("[/EXTERNAL_DATA]");
      expect(data).toContain("mcp:test-server:echo");
    } finally {
      await client.disconnect();
    }
  });

  // --- Test (f): Untrusted server tools require approval ---

  it("marks tools as requiring approval when server is not trusted", async () => {
    const client = new McpClientAdapter({
      name: "untrusted-server",
      transport: "http",
      url: `http://localhost:${port}/mcp`,
      authToken: TEST_AUTH_TOKEN,
      trusted: false,
    });

    await client.connect();

    try {
      const tools = client.getTools();
      for (const tool of tools) {
        expect(tool.requiresApproval).toBe(true);
      }
    } finally {
      await client.disconnect();
    }
  });

  it("does not mark tools as requiring approval when server is trusted", async () => {
    const client = new McpClientAdapter({
      name: "trusted-server",
      transport: "http",
      url: `http://localhost:${port}/mcp`,
      authToken: TEST_AUTH_TOKEN,
      trusted: true,
    });

    await client.connect();

    try {
      const tools = client.getTools();
      for (const tool of tools) {
        expect(tool.requiresApproval).toBeUndefined();
      }
    } finally {
      await client.disconnect();
    }
  });
});

// ============================================================
// E2E: Policy enforcement through transport
// ============================================================

describe("E2E: Policy enforcement through StreamableHTTP", () => {
  let serverAdapter: McpServerAdapter;
  let port: number;

  beforeAll(async () => {
    const deps = makeDeps({
      validateTool: (tool) => {
        if (tool.name === "echo") {
          return { allowed: false, requiresApproval: false, reason: "echo is denied" };
        }
        return { allowed: true, requiresApproval: false };
      },
    });

    serverAdapter = new McpServerAdapter(makeConfig(0), deps);
    await serverAdapter.start();

    const httpServer = (serverAdapter as unknown as { httpServer: Server }).httpServer;
    port = getPort(httpServer);
  });

  afterAll(async () => {
    await serverAdapter.stop();
  });

  it("returns policy denial through the full transport path", async () => {
    const client = new McpClientAdapter({
      name: "policy-test",
      transport: "http",
      url: `http://localhost:${port}/mcp`,
      authToken: TEST_AUTH_TOKEN,
    });

    await client.connect();

    try {
      // Echo is denied by policy
      const echoResult = await client.executeTool("policy-test__echo", {
        message: "should be denied",
      });
      expect(echoResult.ok).toBe(false);
      expect(echoResult.error).toContain("Policy denied");
      expect(echoResult.error).toContain("echo is denied");

      // Ping is allowed
      const pingResult = await client.executeTool("policy-test__ping", {});
      expect(pingResult.ok).toBe(true);
      expect(typeof pingResult.data).toBe("string");
      expect(pingResult.data as string).toContain("pong");
    } finally {
      await client.disconnect();
    }
  });
});
