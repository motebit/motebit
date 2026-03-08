import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AgentTrustLevel,
} from "@motebit/sdk";
import type {
  ToolDefinition,
  ToolResult,
  PolicyDecision,
} from "@motebit/sdk";

// Re-export for consumers
export type { MotebitServerDeps, McpServerConfig };
export { AgentTrustLevel } from "@motebit/sdk";

// Service scaffold — eliminates boilerplate for service motebits
export { wireServerDeps, startServiceServer } from "./service.js";
export type {
  ServiceRuntime,
  ServiceToolRegistry,
  ServicePolicyGate,
  ServiceMemoryGraph,
  ServiceEventStore,
  WireServerDepsOptions,
  ServiceServerConfig,
  ServiceHandle,
} from "./service.js";

// === Dependency interface (injected, not imported — keeps the package light) ===

/** Caller identity resolved from a verified motebit signed token. */
export interface CallerIdentity {
  motebitId: string;
  trustLevel: AgentTrustLevel;
}

interface MotebitServerDeps {
  motebitId: string;
  publicKeyHex?: string;

  // Tools
  listTools(): ToolDefinition[];
  filterTools(tools: ToolDefinition[]): ToolDefinition[];
  validateTool(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    caller?: CallerIdentity,
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

  // Synthetic tool backends (all optional — tool only registered when dep is provided)
  sendMessage?(text: string): Promise<{ response: string; memoriesFormed: number }>;
  queryMemories?(
    query: string,
    limit?: number,
  ): Promise<Array<{ content: string; confidence: number; similarity: number }>>;
  storeMemory?(
    content: string,
    sensitivity?: string,
  ): Promise<{ node_id: string }>;
  handleAgentTask?(
    prompt: string,
  ): AsyncGenerator<
    | { type: "text"; text: string }
    | { type: "task_result"; receipt: Record<string, unknown> }
    | { type: string; [key: string]: unknown }
  >;
  identityFileContent?: string;

  /** Resolve a caller's public key and trust level by motebit ID. */
  resolveCallerKey?(motebitId: string): Promise<{ publicKey: string; trustLevel: AgentTrustLevel } | null>;
  /** Called on first contact with an unknown caller. Returns the trust level to assign. */
  onCallerVerified?(motebitId: string, publicKey: string, trustLevel: AgentTrustLevel): void;
  /** Verify a signed token. Returns parsed payload if valid, null otherwise. Injected from @motebit/crypto. */
  verifySignedToken?(token: string, publicKey: Uint8Array): Promise<{ mid: string; did: string; iat: number; exp: number } | null>;
}

// === Config ===

interface McpServerConfig {
  name?: string;
  version?: string;
  transport: "stdio" | "http";
  port?: number;
  exposeState?: boolean;
  exposeMemories?: boolean;
  authToken?: string;
  /** Known callers: motebit_id -> { publicKey hex, trustLevel } */
  knownCallers?: Map<string, { publicKey: string; trustLevel: AgentTrustLevel }>;
  /** What type of motebit this server represents. Affects default inbound policy. */
  motebitType?: "personal" | "service" | "collaborative";
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
  private lastVerifiedCaller: CallerIdentity | null = null;

  constructor(config: McpServerConfig, deps: MotebitServerDeps) {
    this.config = config;
    this.deps = deps;
    this.server = this.createServer();
  }

  /**
   * Create a new McpServer instance with all tools, resources, and prompts
   * registered. For StreamableHTTP, each session needs its own server instance
   * (the SDK only allows one transport per server).
   */
  private createServer(): McpServer {
    const server = new McpServer({
      name: this.config.name ?? "motebit",
      version: this.config.version ?? "0.1.0",
    });
    this.registerToolsOn(server);
    this.registerSyntheticToolsOn(server);
    this.registerResourcesOn(server);
    this.registerPromptsOn(server);
    return server;
  }

  async start(): Promise<void> {
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

  private registerToolsOn(server: McpServer): void {
    const allTools = this.deps.listTools();
    const visibleTools = this.deps.filterTools(allTools);

    for (const tool of visibleTools) {
      const annotations = riskToAnnotations(tool.riskHint);
      const zodShape = jsonSchemaToZodShape(tool.inputSchema);
      const hasArgs = Object.keys(zodShape).length > 0;
      // MCP SDK treats empty objects as Zod raw shapes (empty input schema),
      // which breaks overload resolution. Only pass annotations when non-empty.
      const hasAnnotations = Object.keys(annotations).length > 0;

      if (hasArgs && hasAnnotations) {
        server.tool(
          tool.name,
          tool.description,
          zodShape,
          annotations,
          async (args: Record<string, unknown>) => {
            return this.handleToolCall(tool, args);
          },
        );
      } else if (hasArgs) {
        server.tool(
          tool.name,
          tool.description,
          zodShape,
          async (args: Record<string, unknown>) => {
            return this.handleToolCall(tool, args);
          },
        );
      } else if (hasAnnotations) {
        server.tool(
          tool.name,
          tool.description,
          annotations,
          async () => {
            return this.handleToolCall(tool, {});
          },
        );
      } else {
        server.tool(
          tool.name,
          tool.description,
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
    const decision = this.deps.validateTool(tool, args, this.lastVerifiedCaller ?? undefined);

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

  // --- Synthetic Tool Registration ---

  private registerSyntheticToolsOn(server: McpServer): void {
    const fmt = (data: unknown): { content: Array<{ type: "text"; text: string }> } => {
      const text = typeof data === "string" ? data : JSON.stringify(data);
      const result: ToolResult = { ok: true, data: text };
      return {
        content: [{
          type: "text" as const,
          text: formatResult(result, this.deps.motebitId, this.deps.publicKeyHex),
        }],
      };
    };

    if (this.deps.sendMessage) {
      const sendMessage = this.deps.sendMessage;
      server.tool(
        "motebit_query",
        "Ask this motebit a question — AI response with memory context",
        { message: z.string().describe("The question or message to send") },
        async (args: { message: string }) => {
          const result = await sendMessage(args.message);
          this.deps.logToolCall("motebit_query", args, { ok: true, data: result.response });
          return fmt({ response: result.response, memories_formed: result.memoriesFormed });
        },
      );
    }

    if (this.deps.storeMemory) {
      const storeMemory = this.deps.storeMemory;
      server.tool(
        "motebit_remember",
        "Store a memory in this motebit",
        {
          content: z.string().describe("The content to remember"),
          sensitivity: z.string().optional().describe("Sensitivity level (none, personal)"),
        },
        async (args: { content: string; sensitivity?: string }) => {
          // Fail-closed: external callers cannot store high-sensitivity memories
          if (args.sensitivity && EXCLUDED_SENSITIVITIES.has(args.sensitivity)) {
            return {
              content: [{
                type: "text" as const,
                text: `Denied: external callers cannot store memories with sensitivity "${args.sensitivity}"`,
              }],
              isError: true,
            };
          }
          const result = await storeMemory(args.content, args.sensitivity);
          this.deps.logToolCall("motebit_remember", args, { ok: true, data: result.node_id });
          return fmt({ node_id: result.node_id });
        },
      );
    }

    if (this.deps.queryMemories) {
      const queryMemories = this.deps.queryMemories;
      server.tool(
        "motebit_recall",
        "Search this motebit's semantic memory",
        {
          query: z.string().describe("Semantic search query"),
          limit: z.number().optional().describe("Max results to return"),
        },
        async (args: { query: string; limit?: number }) => {
          const results = await queryMemories(args.query, args.limit);
          this.deps.logToolCall("motebit_recall", args, { ok: true, data: results });
          return fmt(results);
        },
      );
    }

    if (this.deps.handleAgentTask) {
      const handleAgentTask = this.deps.handleAgentTask;
      server.tool(
        "motebit_task",
        "Submit an autonomous task — returns a signed ExecutionReceipt",
        { prompt: z.string().describe("The task prompt for the agent to execute") },
        async (args: { prompt: string }) => {
          let receipt: Record<string, unknown> | undefined;
          let responseText = "";

          for await (const chunk of handleAgentTask(args.prompt)) {
            if (chunk.type === "text") {
              responseText += (chunk as { type: "text"; text: string }).text;
            } else if (chunk.type === "task_result") {
              receipt = (chunk as { type: "task_result"; receipt: Record<string, unknown> }).receipt;
            }
          }

          if (receipt) {
            this.deps.logToolCall("motebit_task", args, { ok: true, data: receipt });
            return fmt(receipt);
          }

          this.deps.logToolCall("motebit_task", args, { ok: false, error: "no receipt" });
          return fmt({ status: "completed", response: responseText });
        },
      );
    }

    // motebit_identity — always registered (no dep required)
    server.tool(
      "motebit_identity",
      "Return this motebit's identity information",
      async () => {
        if (this.deps.identityFileContent) {
          return fmt(this.deps.identityFileContent);
        }
        const identity: Record<string, unknown> = {
          motebit_id: this.deps.motebitId,
          public_key: this.deps.publicKeyHex ?? null,
        };
        if (this.config.motebitType) {
          identity.motebit_type = this.config.motebitType;
        }
        return fmt(identity);
      },
    );

    // motebit_tools — always registered
    server.tool(
      "motebit_tools",
      "List available tools with risk levels",
      async () => {
        const tools = this.deps.listTools().map((t) => ({
          name: t.name,
          description: t.description,
          risk: t.riskHint?.risk ?? null,
        }));
        this.deps.logToolCall("motebit_tools", {}, { ok: true, data: tools });
        return fmt(tools);
      },
    );
  }

  // --- Resource Registration ---

  private registerResourcesOn(server: McpServer): void {
    // Identity resource — always exposed
    server.resource(
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
      server.resource(
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
      server.resource(
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

  private registerPromptsOn(server: McpServer): void {
    server.prompt(
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

    server.prompt(
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

    server.prompt("reflect", "Trigger reflection", () => ({
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

  // --- Caller Verification ---

  private async verifyCallerToken(token: string): Promise<CallerIdentity | null> {
    if (!this.deps.verifySignedToken) return null;

    // Parse token payload to extract caller's motebit ID (need mid to look up the key)
    const dotIdx = token.indexOf(".");
    if (dotIdx === -1) return null;

    let claims: { mid: string; did: string; iat: number; exp: number };
    try {
      const raw = token.slice(0, dotIdx);
      const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
      const json = atob(padded);
      claims = JSON.parse(json) as typeof claims;
    } catch {
      return null;
    }

    if (!claims.mid) return null;

    // Look up public key for this caller
    let publicKeyHex: string | undefined;
    let trustLevel = AgentTrustLevel.Unknown;

    // Check knownCallers map first
    const known = this.config.knownCallers?.get(claims.mid);
    if (known) {
      if (known.trustLevel === AgentTrustLevel.Blocked) return null;
      publicKeyHex = known.publicKey;
      trustLevel = known.trustLevel;
    }

    // If not known, try resolveCallerKey
    if (!publicKeyHex && this.deps.resolveCallerKey) {
      const resolved = await this.deps.resolveCallerKey(claims.mid);
      if (resolved) {
        if (resolved.trustLevel === AgentTrustLevel.Blocked) return null;
        publicKeyHex = resolved.publicKey;
        trustLevel = resolved.trustLevel;
      }
    }

    if (!publicKeyHex) {
      // Unknown caller — deny when motebit auth is in use
      return null;
    }

    // Convert hex string to Uint8Array
    const hexToBytes = (hex: string): Uint8Array => {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
      }
      return bytes;
    };

    const pubKeyBytes = hexToBytes(publicKeyHex);
    const payload = await this.deps.verifySignedToken(token, pubKeyBytes);
    if (!payload) return null;

    // Notify caller verified
    if (this.deps.onCallerVerified) {
      this.deps.onCallerVerified(claims.mid, publicKeyHex, trustLevel);
    }

    return { motebitId: claims.mid, trustLevel };
  }

  // --- HTTP Transport (Streamable HTTP) ---

  private async startHttp(): Promise<void> {
    const http = await import("node:http");
    const port = this.config.port ?? 3100;

    // Session ID → transport mapping for stateful connections
    const transports = new Map<string, StreamableHTTPServerTransport>();

    this.httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health endpoint (no auth required)
      if (url.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            motebit_id: this.deps.motebitId,
          }),
        );
        return;
      }

      // Bearer token auth (skip /health, already handled above)
      const authHeader = req.headers["authorization"];
      const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

      if (bearerToken?.startsWith("motebit:")) {
        // Motebit signed token — verify caller identity
        const callerInfo = await this.verifyCallerToken(bearerToken.slice(8));
        if (!callerInfo) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid motebit token" }));
          return;
        }
        this.lastVerifiedCaller = callerInfo;
      } else if (this.config.authToken) {
        // Static token auth
        if (bearerToken !== this.config.authToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
      }
      // If no authToken configured and no motebit token, allow (open access)

      // MCP endpoint — Streamable HTTP transport
      if (url.pathname === "/mcp") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (req.method === "POST") {
          // Read and parse the request body
          let body: unknown;
          try {
            const bodyChunks: Buffer[] = [];
            for await (const chunk of req) {
              bodyChunks.push(chunk as Buffer);
            }
            body = JSON.parse(Buffer.concat(bodyChunks).toString());
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32700, message: "Parse error: invalid JSON" },
              id: null,
            }));
            return;
          }

          let transport: StreamableHTTPServerTransport;

          if (sessionId && transports.has(sessionId)) {
            // Reuse existing transport for this session
            transport = transports.get(sessionId)!;
          } else if (!sessionId && isInitializeRequest(body)) {
            // New initialization request — create a new transport
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (sid) => {
                transports.set(sid, transport);
              },
            });

            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid) transports.delete(sid);
            };

            // Each session gets its own McpServer instance (required by the SDK —
            // a single McpServer can only be connected to one transport at a time).
            const sessionServer = this.createServer();
            await sessionServer.connect(transport);
          } else {
            // Invalid: no session ID and not an init request
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Bad Request: No valid session ID provided" },
              id: null,
            }));
            return;
          }

          await transport.handleRequest(req, res, body);
          return;
        }

        if (req.method === "GET") {
          // SSE stream for server-initiated messages
          if (!sessionId || !transports.has(sessionId)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
            return;
          }
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res);
          return;
        }

        if (req.method === "DELETE") {
          // Session termination
          if (!sessionId || !transports.has(sessionId)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
            return;
          }
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res);
          return;
        }
      }

      res.writeHead(404);
      res.end("not found");
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, () => resolve());
    });
  }
}
