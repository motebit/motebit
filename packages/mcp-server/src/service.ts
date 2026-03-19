/**
 * Service scaffold — turns a MotebitRuntime into a running MCP service
 * in ~10 lines of caller code.
 *
 * Duck-typed interfaces: no dependency on @motebit/runtime, @motebit/crypto,
 * or @motebit/memory-graph. The caller provides concrete implementations.
 *
 * Usage:
 *   const deps = wireServerDeps(runtime, { motebitId, publicKeyHex, ... });
 *   const handle = await startServiceServer(deps, { port: 3200, ... });
 *   // handle.shutdown() to stop
 */

import { McpServerAdapter } from "./index.js";
import type { MotebitServerDeps } from "./index.js";
import type {
  ToolDefinition,
  ToolResult,
  PolicyDecision,
  EventLogEntry,
  TurnContext,
} from "@motebit/sdk";
import { EventType, SensitivityLevel, AgentTrustLevel } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Duck-typed interfaces — match what MotebitRuntime provides
// ---------------------------------------------------------------------------

/** Minimal tool registry interface. */
export interface ServiceToolRegistry {
  list(): ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/** Minimal policy gate interface. */
export interface ServicePolicyGate {
  filterTools(tools: ToolDefinition[]): ToolDefinition[];
  validate(tool: ToolDefinition, args: Record<string, unknown>, context: unknown): PolicyDecision;
  createTurnContext(): unknown;
}

/** Minimal memory graph interface. */
export interface ServiceMemoryGraph {
  exportAll(): Promise<{
    nodes: Array<{
      content: string;
      confidence: number;
      sensitivity: string;
      created_at: number;
      tombstoned: boolean;
    }>;
  }>;
  retrieve(
    embedding: number[],
    opts?: {
      limit?: number;
      sensitivityFilter?: SensitivityLevel[];
      [key: string]: unknown;
    },
  ): Promise<
    Array<{
      content: string;
      confidence: number;
      half_life: number;
      memory_type?: string;
      created_at: number;
    }>
  >;
  formMemory(
    data: { content: string; confidence: number; sensitivity: string },
    embedding: number[],
  ): Promise<{ node_id: string }>;
}

/** Minimal event store interface. */
export interface ServiceEventStore {
  append(entry: EventLogEntry): Promise<void>;
}

/** The runtime-shaped object we wire from. */
export interface ServiceRuntime {
  getToolRegistry(): ServiceToolRegistry;
  policy: ServicePolicyGate;
  getState(): unknown;
  memory: ServiceMemoryGraph;
  events: ServiceEventStore;

  /** Optional: look up trust record for a remote motebit. */
  getAgentTrust?(
    remoteMotebitId: string,
  ): Promise<{ trust_level: string; public_key?: string } | null>;
  /** Optional: record an interaction with a remote motebit. */
  recordAgentInteraction?(remoteMotebitId: string, publicKey?: string): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// wireServerDeps — the ~70-line boilerplate eliminator
// ---------------------------------------------------------------------------

export interface WireServerDepsOptions {
  motebitId: string;
  publicKeyHex?: string;
  identityFileContent?: string;

  /** Local embedding function (e.g. embedText from @motebit/memory-graph). */
  embedText?: (text: string) => Promise<number[]>;

  /** Token verification (e.g. verifySignedToken from @motebit/crypto). */
  verifySignedToken?: (
    token: string,
    publicKey: Uint8Array,
  ) => Promise<{ mid: string; did: string; iat: number; exp: number } | null>;

  /**
   * If provided, wires handleAgentTask for motebit_task with signed receipts.
   * Should be an async generator that yields { type: "task_result", receipt }.
   */
  handleAgentTask?: (
    prompt: string,
    options?: { delegatedScope?: string; relayTaskId?: string },
  ) => AsyncGenerator<
    | { type: "text"; text: string }
    | { type: "task_result"; receipt: Record<string, unknown> }
    | { type: string; [key: string]: unknown }
  >;

  /** If provided, wires sendMessage for motebit_query synthetic tool. */
  sendMessage?: (text: string) => Promise<{ response: string; memoriesFormed: number }>;

  /** Relay URL for remote key resolution (fallback when local trust store has no record). */
  syncUrl?: string;
  /** API token for relay calls (key resolution, etc.). */
  apiToken?: string;
}

export function wireServerDeps(
  runtime: ServiceRuntime,
  opts: WireServerDepsOptions,
): MotebitServerDeps {
  const { motebitId, publicKeyHex } = opts;

  const deps: MotebitServerDeps = {
    motebitId,
    publicKeyHex,

    listTools: () => runtime.getToolRegistry().list(),
    filterTools: (tools) => runtime.policy.filterTools(tools),
    validateTool: (tool, args, caller?) => {
      const ctx = runtime.policy.createTurnContext() as TurnContext;
      if (caller) {
        ctx.callerMotebitId = caller.motebitId;
        ctx.callerTrustLevel = caller.trustLevel;
      }
      return runtime.policy.validate(tool, args, ctx);
    },
    executeTool: (name, args) => runtime.getToolRegistry().execute(name, args),

    getState: () => runtime.getState() as Record<string, unknown>,

    getMemories: async (limit = 50) => {
      const data = await runtime.memory.exportAll();
      return data.nodes
        .filter((n) => !n.tombstoned)
        .map((n) => ({
          content: n.content,
          confidence: n.confidence,
          sensitivity: n.sensitivity,
          created_at: n.created_at,
        }))
        .slice(0, limit);
    },

    logToolCall: (name, args, result) => {
      const entry: EventLogEntry = {
        event_id: crypto.randomUUID(),
        motebit_id: motebitId,
        timestamp: Date.now(),
        event_type: EventType.ToolUsed,
        payload: {
          tool: name,
          args_preview: JSON.stringify(args).slice(0, 200),
          ok: result.ok,
          source: "mcp_server",
        },
        version_clock: 0,
        tombstoned: false,
      };
      void runtime.events.append(entry).catch(() => {});
    },

    identityFileContent: opts.identityFileContent,
  };

  // Optional: memory search + store (needs embedText)
  if (opts.embedText) {
    const embedText = opts.embedText;
    deps.queryMemories = async (query: string, limit?: number) => {
      const embedding = await embedText(query);
      const nodes = await runtime.memory.retrieve(embedding, {
        limit: limit ?? 10,
        sensitivityFilter: [SensitivityLevel.None, SensitivityLevel.Personal],
      });
      return nodes.map((n) => ({
        content: n.content,
        confidence: n.confidence,
        similarity: 0,
        half_life_days: Math.round(n.half_life / 86_400_000),
        memory_type: n.memory_type ?? "semantic",
        created_at: n.created_at,
      }));
    };

    deps.storeMemory = async (content: string, sensitivity?: string) => {
      const embedding = await embedText(content);
      const node = await runtime.memory.formMemory(
        {
          content,
          confidence: 0.7,
          sensitivity: sensitivity ?? SensitivityLevel.None,
        },
        embedding,
      );
      return { node_id: node.node_id };
    };
  }

  // Optional: signed token verification
  if (opts.verifySignedToken) {
    deps.verifySignedToken = opts.verifySignedToken;
  }

  // Caller key resolution: local trust store → relay fallback
  {
    const getAgentTrust = runtime.getAgentTrust?.bind(runtime);
    const syncUrl = opts.syncUrl?.replace(/\/+$/, "");
    const apiToken = opts.apiToken;

    // Track relay-confirmed callers so local FirstContact records get upgraded
    const relayConfirmedCallers = new Set<string>();

    if (getAgentTrust || syncUrl) {
      deps.resolveCallerKey = async (callerMotebitId: string) => {
        // 1. Try local trust store first
        if (getAgentTrust) {
          const record = await getAgentTrust(callerMotebitId);
          if (record?.public_key) {
            const trustMap: Record<string, AgentTrustLevel> = {
              [AgentTrustLevel.Unknown]: AgentTrustLevel.Unknown,
              [AgentTrustLevel.FirstContact]: AgentTrustLevel.FirstContact,
              [AgentTrustLevel.Verified]: AgentTrustLevel.Verified,
              [AgentTrustLevel.Trusted]: AgentTrustLevel.Trusted,
              [AgentTrustLevel.Blocked]: AgentTrustLevel.Blocked,
            };
            let trustLevel = trustMap[record.trust_level] ?? AgentTrustLevel.Unknown;
            // Upgrade FirstContact → Verified for callers whose key was confirmed by the relay
            if (
              trustLevel === AgentTrustLevel.FirstContact &&
              relayConfirmedCallers.has(callerMotebitId)
            ) {
              trustLevel = AgentTrustLevel.Verified;
            }
            return {
              publicKey: record.public_key,
              trustLevel,
            };
          }
        }

        // 2. Relay fallback — look up device public key
        if (syncUrl) {
          try {
            const headers: Record<string, string> = {};
            if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;
            const resp = await fetch(`${syncUrl}/api/v1/devices/${callerMotebitId}`, { headers });
            if (resp.ok) {
              const raw: unknown = await resp.json();
              const arr = Array.isArray(raw)
                ? (raw as Array<{ public_key?: string }>)
                : (((raw as Record<string, unknown>).devices as Array<{ public_key?: string }>) ??
                  []);
              const key = arr.find((d) => d.public_key)?.public_key;
              if (key) {
                // Relay confirmed this public key — mark as relay-verified so subsequent
                // lookups from local trust store upgrade FirstContact → Verified.
                relayConfirmedCallers.add(callerMotebitId);
                return { publicKey: key, trustLevel: AgentTrustLevel.Verified };
              }
            }
          } catch {
            // Relay unreachable — fail closed
          }
        }

        return null;
      };
    }
  }

  // Optional: callback on caller verification
  if (runtime.recordAgentInteraction) {
    const recordInteraction = runtime.recordAgentInteraction.bind(runtime);
    deps.onCallerVerified = (
      callerMotebitId: string,
      publicKey: string,
      _trustLevel: AgentTrustLevel,
    ) => {
      void recordInteraction(callerMotebitId, publicKey);
    };
  }

  // Optional: agent task handler (motebit_task)
  if (opts.handleAgentTask) {
    deps.handleAgentTask = opts.handleAgentTask;
  }

  // Optional: AI query (motebit_query)
  if (opts.sendMessage) {
    deps.sendMessage = opts.sendMessage;
  }

  return deps;
}

// ---------------------------------------------------------------------------
// startServiceServer — MCP server + relay + graceful shutdown
// ---------------------------------------------------------------------------

export interface ServiceServerConfig {
  /** Server name (default: motebit-service-<id>). */
  name?: string;
  /** MCP transport port. */
  port: number;
  /** Require bearer token for incoming connections. */
  authToken?: string;
  /** Service type for inbound policy. */
  motebitType?: "personal" | "service" | "collaborative";

  /** Sync relay URL for discovery registration. */
  syncUrl?: string;
  /** API token for relay authentication. */
  apiToken?: string;
  /** Public endpoint URL for relay registration (default: http://localhost:<port>). */
  publicEndpointUrl?: string;

  /** Called on startup with tool count and port. */
  onStart?: (port: number, toolCount: number) => void;
  /** Called on shutdown. */
  onStop?: () => void;
}

export interface ServiceHandle {
  /** Gracefully shut down the server, deregister from relay, close runtime. */
  shutdown(): Promise<void>;
  /** The MCP server adapter instance. */
  server: McpServerAdapter;
}

export async function startServiceServer(
  deps: MotebitServerDeps,
  config: ServiceServerConfig,
): Promise<ServiceHandle> {
  const serverName = config.name ?? `motebit-service-${deps.motebitId.slice(0, 8)}`;

  const mcpServer = new McpServerAdapter(
    {
      name: serverName,
      transport: "http",
      port: config.port,
      authToken: config.authToken,
      motebitType: config.motebitType ?? "service",
    },
    deps,
  );
  await mcpServer.start();

  const toolCount = deps.listTools().length;
  if (config.onStart) {
    config.onStart(config.port, toolCount);
  }

  // Relay registration
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  if (config.syncUrl) {
    try {
      const toolNames = deps.listTools().map((t) => t.name);
      const regHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (config.apiToken) regHeaders["Authorization"] = `Bearer ${config.apiToken}`;

      const endpointUrl = config.publicEndpointUrl ?? `http://localhost:${config.port}`;
      const regResp = await fetch(`${config.syncUrl}/api/v1/agents/register`, {
        method: "POST",
        headers: regHeaders,
        body: JSON.stringify({
          motebit_id: deps.motebitId,
          public_key: deps.publicKeyHex ?? "",
          endpoint_url: endpointUrl,
          capabilities: toolNames,
          metadata: { name: serverName },
        }),
      });
      if (regResp.ok) {
        heartbeatTimer = setInterval(
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- fire-and-forget heartbeat
          async () => {
            try {
              await fetch(`${config.syncUrl}/api/v1/agents/heartbeat`, {
                method: "POST",
                headers: regHeaders,
                body: JSON.stringify({ motebit_id: deps.motebitId }),
              });
            } catch {
              // Best-effort heartbeat
            }
          },
          5 * 60 * 1000,
        );
      }
    } catch {
      // Best-effort relay registration
    }
  }

  // Shutdown handler (guarded against double-call)
  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (config.syncUrl) {
      try {
        const headers: Record<string, string> = {};
        if (config.apiToken) headers["Authorization"] = `Bearer ${config.apiToken}`;
        await fetch(`${config.syncUrl}/api/v1/agents/deregister`, {
          method: "DELETE",
          headers,
        });
      } catch {
        // Best-effort deregistration
      }
    }
    await mcpServer.stop();
    if (config.onStop) config.onStop();
  };

  // Wire process signals
  const onSignal = (): void => {
    void shutdown()
      .catch(() => {})
      .then(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return { shutdown, server: mcpServer };
}
