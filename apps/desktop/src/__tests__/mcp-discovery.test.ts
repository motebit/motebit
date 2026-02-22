import { describe, it, expect } from "vitest";
import {
  parseClaudeDesktopConfig,
  parseClaudeCodeConfig,
  parseVSCodeMcpConfig,
  mergeDiscoveredServers,
} from "../mcp-discovery";
import type { McpServerConfig } from "../index";

// ---------------------------------------------------------------------------
// parseClaudeDesktopConfig
// ---------------------------------------------------------------------------

describe("parseClaudeDesktopConfig", () => {
  it("parses valid config with stdio servers", () => {
    const config = JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "ghp_xxx" },
        },
      },
    });

    const result = parseClaudeDesktopConfig(config);
    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      trusted: false,
      source: "Claude Desktop",
    });

    expect(result[1]).toEqual({
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "ghp_xxx" },
      trusted: false,
      source: "Claude Desktop",
    });
  });

  it("parses HTTP server entries", () => {
    const config = JSON.stringify({
      mcpServers: {
        remote: { url: "https://mcp.example.com/v1" },
      },
    });

    const result = parseClaudeDesktopConfig(config);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "remote",
      transport: "http",
      url: "https://mcp.example.com/v1",
      trusted: false,
      source: "Claude Desktop",
    });
  });

  it("returns [] for missing mcpServers key", () => {
    expect(parseClaudeDesktopConfig(JSON.stringify({}))).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseClaudeDesktopConfig("not json")).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parseClaudeDesktopConfig("")).toEqual([]);
  });

  it("skips entries with neither command nor url", () => {
    const config = JSON.stringify({
      mcpServers: {
        empty: {},
        valid: { command: "node", args: ["server.js"] },
      },
    });
    const result = parseClaudeDesktopConfig(config);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("valid");
  });

  it("filters non-string args", () => {
    const config = JSON.stringify({
      mcpServers: {
        test: { command: "node", args: ["valid", 123, null, "also-valid"] },
      },
    });
    const result = parseClaudeDesktopConfig(config);
    expect(result[0]!.args).toEqual(["valid", "also-valid"]);
  });
});

// ---------------------------------------------------------------------------
// parseClaudeCodeConfig
// ---------------------------------------------------------------------------

describe("parseClaudeCodeConfig", () => {
  it("parses valid claude.json with mcpServers", () => {
    const config = JSON.stringify({
      mcpServers: {
        postgres: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-postgres"],
          env: { DATABASE_URL: "postgres://localhost/test" },
        },
      },
    });

    const result = parseClaudeCodeConfig(config);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("postgres");
    expect(result[0]!.source).toBe("Claude Code");
  });

  it("returns [] when mcpServers key is missing", () => {
    expect(parseClaudeCodeConfig(JSON.stringify({ other: "stuff" }))).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseClaudeCodeConfig("{invalid")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseVSCodeMcpConfig
// ---------------------------------------------------------------------------

describe("parseVSCodeMcpConfig", () => {
  it("parses nested mcp.servers format", () => {
    const config = JSON.stringify({
      "editor.fontSize": 14,
      mcp: {
        servers: {
          brave: {
            command: "npx",
            args: ["-y", "@anthropic/mcp-server-brave"],
            env: { BRAVE_API_KEY: "xxx" },
          },
        },
      },
    });

    const result = parseVSCodeMcpConfig(config);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("brave");
    expect(result[0]!.source).toBe("VS Code");
    expect(result[0]!.command).toBe("npx");
  });

  it("parses flat mcp.servers key format", () => {
    const config = JSON.stringify({
      "mcp.servers": {
        sqlite: { command: "uvx", args: ["mcp-server-sqlite"] },
      },
    });

    const result = parseVSCodeMcpConfig(config);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("sqlite");
  });

  it("returns [] when no MCP keys present", () => {
    expect(parseVSCodeMcpConfig(JSON.stringify({ "editor.fontSize": 14 }))).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseVSCodeMcpConfig("not json")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeDiscoveredServers
// ---------------------------------------------------------------------------

describe("mergeDiscoveredServers", () => {
  it("adds new servers from discovery", () => {
    const existing: McpServerConfig[] = [];
    const discovered = [
      {
        source: "Claude Desktop",
        servers: [
          { name: "fs", transport: "stdio" as const, command: "npx", trusted: false, source: "Claude Desktop" },
        ],
      },
    ];

    const { merged, newServers } = mergeDiscoveredServers(existing, discovered);
    expect(merged).toHaveLength(1);
    expect(newServers).toHaveLength(1);
    expect(newServers[0]!.name).toBe("fs");
  });

  it("does not overwrite existing servers with same name", () => {
    const existing: McpServerConfig[] = [
      { name: "fs", transport: "stdio", command: "my-custom-fs", trusted: true },
    ];
    const discovered = [
      {
        source: "Claude Desktop",
        servers: [
          { name: "fs", transport: "stdio" as const, command: "npx", trusted: false, source: "Claude Desktop" },
        ],
      },
    ];

    const { merged, newServers } = mergeDiscoveredServers(existing, discovered);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.command).toBe("my-custom-fs");
    expect(merged[0]!.trusted).toBe(true);
    expect(newServers).toHaveLength(0);
  });

  it("deduplicates across multiple discovery sources", () => {
    const existing: McpServerConfig[] = [];
    const discovered = [
      {
        source: "Claude Desktop",
        servers: [
          { name: "github", transport: "stdio" as const, command: "npx", trusted: false, source: "Claude Desktop" },
        ],
      },
      {
        source: "Claude Code",
        servers: [
          { name: "github", transport: "stdio" as const, command: "npx", trusted: false, source: "Claude Code" },
          { name: "postgres", transport: "stdio" as const, command: "npx", trusted: false, source: "Claude Code" },
        ],
      },
    ];

    const { merged, newServers } = mergeDiscoveredServers(existing, discovered);
    expect(merged).toHaveLength(2);
    expect(newServers).toHaveLength(2);
    // First source wins for duplicate name
    expect(newServers.find(s => s.name === "github")?.source).toBe("Claude Desktop");
  });

  it("preserves existing servers in order", () => {
    const existing: McpServerConfig[] = [
      { name: "a", transport: "stdio", command: "a" },
      { name: "b", transport: "stdio", command: "b" },
    ];
    const discovered = [
      { source: "Test", servers: [{ name: "c", transport: "stdio" as const, command: "c", trusted: false, source: "Test" }] },
    ];

    const { merged } = mergeDiscoveredServers(existing, discovered);
    expect(merged.map(s => s.name)).toEqual(["a", "b", "c"]);
  });

  it("returns empty newServers when all discovered already exist", () => {
    const existing: McpServerConfig[] = [
      { name: "fs", transport: "stdio", command: "npx" },
    ];
    const discovered = [
      { source: "Claude Desktop", servers: [{ name: "fs", transport: "stdio" as const, command: "npx", trusted: false, source: "Claude Desktop" }] },
    ];

    const { merged, newServers } = mergeDiscoveredServers(existing, discovered);
    expect(merged).toHaveLength(1);
    expect(newServers).toHaveLength(0);
  });

  it("reports collisions when same name has different command", () => {
    const existing: McpServerConfig[] = [
      { name: "fs", transport: "stdio", command: "my-fs-server" },
    ];
    const discovered = [
      {
        source: "Claude Desktop",
        servers: [
          { name: "fs", transport: "stdio" as const, command: "npx", trusted: false, source: "Claude Desktop" },
        ],
      },
    ];

    const { collisions } = mergeDiscoveredServers(existing, discovered);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.name).toBe("fs");
    expect(collisions[0]!.existingCommand).toBe("my-fs-server");
    expect(collisions[0]!.discoveredCommand).toBe("npx");
    expect(collisions[0]!.discoveredSource).toBe("Claude Desktop");
  });

  it("does not report collision when same name has same command", () => {
    const existing: McpServerConfig[] = [
      { name: "fs", transport: "stdio", command: "npx" },
    ];
    const discovered = [
      {
        source: "Claude Desktop",
        servers: [
          { name: "fs", transport: "stdio" as const, command: "npx", trusted: false, source: "Claude Desktop" },
        ],
      },
    ];

    const { collisions } = mergeDiscoveredServers(existing, discovered);
    expect(collisions).toHaveLength(0);
  });

  it("reports collision for URL-based servers with different URLs", () => {
    const existing: McpServerConfig[] = [
      { name: "api", transport: "http", url: "http://localhost:3000" },
    ];
    const discovered = [
      {
        source: "VS Code",
        servers: [
          { name: "api", transport: "http" as const, url: "http://localhost:4000", trusted: false, source: "VS Code" },
        ],
      },
    ];

    const { collisions } = mergeDiscoveredServers(existing, discovered);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.existingCommand).toBe("http://localhost:3000");
    expect(collisions[0]!.discoveredCommand).toBe("http://localhost:4000");
  });
});
