import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDefinition, ToolResult } from "@motebit/sdk";
import { InMemoryToolRegistry } from "@motebit/tools";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** When false (default), all tools from this server require user approval. */
  trusted?: boolean;
}

// === Inline boundary wrapping for MCP results ===

const EXTERNAL_DATA_START = "[EXTERNAL_DATA source=";
const EXTERNAL_DATA_END = "[/EXTERNAL_DATA]";

function wrapMcpResult(data: string, serverName: string, toolName: string): string {
  const escaped = data
    .replace(/\[EXTERNAL_DATA\b/g, "[ESCAPED_DATA")
    .replace(/\[\/EXTERNAL_DATA\]/g, "[/ESCAPED_DATA]");
  const safeServer = serverName.replace(/[\[\]"\\]/g, "_").slice(0, 50);
  const safeTool = toolName.replace(/[\[\]"\\]/g, "_").slice(0, 50);
  return `${EXTERNAL_DATA_START}"mcp:${safeServer}:${safeTool}"]\n${escaped}\n${EXTERNAL_DATA_END}`;
}

export class McpClientAdapter {
  private client: Client;
  private config: McpServerConfig;
  private connected = false;
  private discoveredTools: ToolDefinition[] = [];

  constructor(config: McpServerConfig) {
    this.config = config;
    this.client = new Client(
      { name: `motebit-${config.name}`, version: "0.1.0" },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    if (this.config.transport === "stdio") {
      if (!this.config.command) {
        throw new Error(
          `MCP server "${this.config.name}" requires a command for stdio transport`,
        );
      }
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: this.config.env as Record<string, string> | undefined,
      });
      await this.client.connect(transport);
    } else {
      if (!this.config.url) {
        throw new Error(
          `MCP server "${this.config.name}" requires a url for http transport`,
        );
      }
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url));
      await this.client.connect(transport);
    }

    this.connected = true;
    await this.discoverTools();
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
    this.discoveredTools = [];
  }

  private async discoverTools(): Promise<void> {
    const response = await this.client.listTools();
    this.discoveredTools = response.tools.map((mcpTool) => ({
      name: `${this.config.name}__${mcpTool.name}`,
      description: `[${this.config.name}] ${mcpTool.description ?? mcpTool.name}`,
      inputSchema: (mcpTool.inputSchema ?? {
        type: "object",
        properties: {},
      }) as Record<string, unknown>,
      ...(this.config.trusted ? {} : { requiresApproval: true }),
    }));
  }

  getTools(): ToolDefinition[] {
    return [...this.discoveredTools];
  }

  async executeTool(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const prefix = `${this.config.name}__`;
    if (!qualifiedName.startsWith(prefix)) {
      return {
        ok: false,
        error: `Tool "${qualifiedName}" does not belong to server "${this.config.name}"`,
      };
    }
    const mcpToolName = qualifiedName.slice(prefix.length);

    try {
      const result = await this.client.callTool({
        name: mcpToolName,
        arguments: args,
      });
      const textContent = (
        result.content as Array<{ type: string; text?: string }>
      )
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");

      const wrapped = textContent
        ? wrapMcpResult(textContent, this.config.name, mcpToolName)
        : undefined;
      return {
        ok: !result.isError,
        data: wrapped || result.content,
        error: result.isError ? textContent : undefined,
        _sanitized: true,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /** Register all discovered tools into a ToolRegistry. */
  registerInto(registry: InMemoryToolRegistry): void {
    for (const tool of this.discoveredTools) {
      if (!registry.has(tool.name)) {
        registry.register(tool, (args) => this.executeTool(tool.name, args));
      }
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get serverName(): string {
    return this.config.name;
  }
}

/** Connect to multiple MCP servers and merge their tools into a single registry. */
export async function connectMcpServers(
  configs: McpServerConfig[],
  registry: InMemoryToolRegistry,
): Promise<McpClientAdapter[]> {
  const adapters: McpClientAdapter[] = [];

  for (const config of configs) {
    try {
      const adapter = new McpClientAdapter(config);
      await adapter.connect();
      adapter.registerInto(registry);
      adapters.push(adapter);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `Failed to connect to MCP server "${config.name}": ${message}`,
      );
    }
  }

  return adapters;
}
