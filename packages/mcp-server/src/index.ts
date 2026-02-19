import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import type {
  ToolDefinition,
  ToolResult,
  PolicyDecision,
} from "@motebit/sdk";

// Re-export for consumers
export type { MotebitServerDeps, McpServerConfig };

// === Dependency interface (injected, not imported — keeps the package light) ===

interface MotebitServerDeps {
  motebitId: string;
  publicKeyHex?: string;

  // Tools
  listTools(): ToolDefinition[];
  filterTools(tools: ToolDefinition[]): ToolDefinition[];
  validateTool(
    tool: ToolDefinition,
    args: Record<string, unknown>,
  ): PolicyDecision;
  executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult>;

  // Resources
  getState(): Record<string, unknown>;
  getMemories(
    limit?: number,
  ): Promise<
    Array<{
      content: string;
      confidence: number;
      sensitivity: string;
      created_at: number;
    }>
  >;

  // Audit
  logToolCall(
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): void;
}

// === Config ===

interface McpServerConfig {
  name?: string;
  version?: string;
  transport: "stdio" | "http";
  port?: number;
  exposeState?: boolean;
  exposeMemories?: boolean;
}

// === Risk → MCP annotation mapping ===

// RiskLevel enum values: R0_READ=0, R1_DRAFT=1, R2_WRITE=2, R3_EXECUTE=3, R4_MONEY=4
export function riskToAnnotations(riskHint?: ToolDefinition["riskHint"]): {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
} {
  if (!riskHint?.risk && riskHint?.risk !== 0) {
    return {};
  }

  const risk = riskHint.risk as number;

  if (risk === 0) {
    // R0_READ
    return { readOnlyHint: true, idempotentHint: true };
  }
  if (risk === 1) {
    // R1_DRAFT
    return { idempotentHint: true };
  }
  // R2_WRITE, R3_EXECUTE, R4_MONEY
  return { destructiveHint: true };
}

// === Result formatting with identity tag ===

export function formatResult(
  result: ToolResult,
  motebitId: string,
  publicKeyHex?: string,
): string {
  const data =
    result.ok && result.data !== undefined
      ? typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data)
      : result.error ?? "no data";

  const keyFragment = publicKeyHex ? publicKeyHex.slice(0, 16) : "none";
  const idFragment = motebitId.slice(0, 8);
  return `${data}\n[motebit:${idFragment} key:${keyFragment}]`;
}

// === Privacy filter for memories ===

const EXCLUDED_SENSITIVITIES = new Set<string>([
  "medical",
  "financial",
  "secret",
]);

export function filterMemories(
  memories: Array<{
    content: string;
    confidence: number;
    sensitivity: string;
    created_at: number;
  }>,
  limit: number,
): Array<{ content: string; confidence: number; created_at: number }> {
  return memories
    .filter((m) => !EXCLUDED_SENSITIVITIES.has(m.sensitivity))
    .slice(0, limit)
    .map(({ content, confidence, created_at }) => ({
      content,
      confidence,
      created_at,
    }));
}

// === JSON Schema → Zod shape conversion ===

/**
 * Convert a JSON Schema object's properties into a zod shape suitable for
 * McpServer.tool(). Handles common primitive types; anything unknown becomes
 * z.unknown().
 */
export function jsonSchemaToZodShape(
  inputSchema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const properties = inputSchema["properties"] as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return shape;

  const required = (inputSchema["required"] as string[] | undefined) ?? [];

  for (const [key, prop] of Object.entries(properties)) {
    let zodType: z.ZodTypeAny;

    switch (prop["type"]) {
      case "string":
        zodType = z.string();
        break;
      case "number":
      case "integer":
        zodType = z.number();
        break;
      case "boolean":
        zodType = z.boolean();
        break;
      default:
        zodType = z.unknown();
        break;
    }

    if (typeof prop["description"] === "string") {
      zodType = zodType.describe(prop["description"]);
    }

    if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return shape;
}

// === McpServerAdapter ===

export class McpServerAdapter {
  private server: McpServer;
  private config: McpServerConfig;
  private deps: MotebitServerDeps;
  private httpServer?: import("node:http").Server;

  constructor(config: McpServerConfig, deps: MotebitServerDeps) {
    this.config = config;
    this.deps = deps;
    this.server = new McpServer({
      name: config.name ?? "motebit",
      version: config.version ?? "0.1.0",
    });
  }

  async start(): Promise<void> {
    this.registerTools();
    this.registerResources();
    this.registerPrompts();

    if (this.config.transport === "stdio") {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
    } else {
      await this.startHttp();
    }
  }

  async stop(): Promise<void> {
    await this.server.close();
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
      this.httpServer = undefined;
    }
  }

  // --- Tool Registration ---

  private registerTools(): void {
    const allTools = this.deps.listTools();
    const visibleTools = this.deps.filterTools(allTools);

    for (const tool of visibleTools) {
      const annotations = riskToAnnotations(tool.riskHint);
      const zodShape = jsonSchemaToZodShape(tool.inputSchema);
      const hasArgs = Object.keys(zodShape).length > 0;

      if (hasArgs) {
        this.server.tool(
          tool.name,
          tool.description,
          zodShape,
          annotations,
          async (args: Record<string, unknown>) => {
            return this.handleToolCall(tool, args);
          },
        );
      } else {
        this.server.tool(
          tool.name,
          tool.description,
          annotations,
          async () => {
            return this.handleToolCall(tool, {});
          },
        );
      }
    }
  }

  private async handleToolCall(
    tool: ToolDefinition,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }> {
    // Policy check
    const decision = this.deps.validateTool(tool, args);

    if (!decision.allowed && !decision.requiresApproval) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Policy denied: ${decision.reason ?? "tool not allowed by governance policy"}`,
          },
        ],
        isError: true,
      };
    }

    if (decision.requiresApproval) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Governance: tool "${tool.name}" requires approval from the motebit owner. This tool is in the approval band of the governance policy.`,
          },
        ],
        isError: true,
      };
    }

    // Execute
    const result = await this.deps.executeTool(tool.name, args);

    // Audit
    this.deps.logToolCall(tool.name, args, result);

    // Format with identity tag
    const formatted = formatResult(
      result,
      this.deps.motebitId,
      this.deps.publicKeyHex,
    );

    return {
      content: [{ type: "text" as const, text: formatted }],
      isError: !result.ok,
    };
  }

  // --- Resource Registration ---

  private registerResources(): void {
    // Identity resource — always exposed
    this.server.resource(
      "identity",
      "motebit://identity",
      async () => ({
        contents: [
          {
            uri: "motebit://identity",
            mimeType: "application/json",
            text: JSON.stringify({
              motebit_id: this.deps.motebitId,
              public_key: this.deps.publicKeyHex ?? null,
            }),
          },
        ],
      }),
    );

    // State resource
    if (this.config.exposeState !== false) {
      this.server.resource(
        "state",
        "motebit://state",
        async () => ({
          contents: [
            {
              uri: "motebit://state",
              mimeType: "application/json",
              text: JSON.stringify(this.deps.getState()),
            },
          ],
        }),
      );
    }

    // Memories resource (privacy-filtered)
    if (this.config.exposeMemories !== false) {
      this.server.resource(
        "memories",
        "motebit://memories",
        async () => {
          const raw = await this.deps.getMemories(50);
          const filtered = filterMemories(raw, 50);
          return {
            contents: [
              {
                uri: "motebit://memories",
                mimeType: "application/json",
                text: JSON.stringify(filtered),
              },
            ],
          };
        },
      );
    }
  }

  // --- Prompt Registration ---

  private registerPrompts(): void {
    this.server.prompt(
      "chat",
      "Send a message to this motebit",
      { message: z.string() },
      ({ message }) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: message,
            },
          },
        ],
      }),
    );

    this.server.prompt(
      "recall",
      "Search semantic memory",
      { query: z.string(), limit: z.string().optional() },
      ({ query, limit }) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Recall memories related to: "${query}"${limit ? ` (limit: ${limit})` : ""}`,
            },
          },
        ],
      }),
    );

    this.server.prompt("reflect", "Trigger reflection", () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: "Please reflect on recent interactions and what you've learned.",
          },
        },
      ],
    }));
  }

  // --- HTTP Transport ---

  private async startHttp(): Promise<void> {
    const http = await import("node:http");
    const port = this.config.port ?? 3100;

    const transports = new Map<string, SSEServerTransport>();

    this.httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (url.pathname === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        await this.server.connect(transport);

        res.on("close", () => {
          transports.delete(transport.sessionId);
        });
      } else if (url.pathname === "/messages" && req.method === "POST") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId || !transports.has(sessionId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid session" }));
          return;
        }
        const transport = transports.get(sessionId)!;
        await transport.handlePostMessage(req, res);
      } else if (url.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            motebit_id: this.deps.motebitId,
          }),
        );
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, () => resolve());
    });
  }
}
