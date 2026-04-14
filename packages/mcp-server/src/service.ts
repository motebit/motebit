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
import { verifySignedToken as defaultVerifySignedToken } from "@motebit/encryption";

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
      valid_until?: number | null;
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
  appendWithClock?(entry: Omit<EventLogEntry, "version_clock">): Promise<number>;
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

  /**
   * Token verification. Defaults to `verifySignedToken` from `@motebit/encryption`
   * — the canonical implementation every motebit service was manually wiring.
   * Override only for test injection or an alternative verifier.
   */
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
      const now = Date.now();
      return data.nodes
        .filter((n) => !n.tombstoned && (n.valid_until == null || n.valid_until > now))
        .map((n) => ({
          content: n.content,
          confidence: n.confidence,
          sensitivity: n.sensitivity,
          created_at: n.created_at,
        }))
        .slice(0, limit);
    },

    logToolCall: (name, args, result) => {
      const entry = {
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
        tombstoned: false,
      };
      if (runtime.events.appendWithClock) {
        void runtime.events.appendWithClock(entry).catch((err: unknown) => {
          console.warn(
            "[motebit] tool event log failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      } else {
        void runtime.events
          .append({ ...entry, version_clock: 0 } as EventLogEntry)
          .catch((err: unknown) => {
            console.warn(
              "[motebit] tool event log failed:",
              err instanceof Error ? err.message : String(err),
            );
          });
      }
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

  // Signed token verification: default to the canonical implementation from
  // @motebit/encryption. Every service previously threaded this through by
  // hand — five identical copies of the same wire. Override still honored
  // for tests and alternative verifiers.
  deps.verifySignedToken = opts.verifySignedToken ?? defaultVerifySignedToken;

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

  /** Custom REST routes handled before MCP auth (same level as /health).
   *  Return true if the route was handled, false to continue to MCP. */
  customRoutes?: (
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    url: URL,
  ) => Promise<boolean> | boolean;
  /**
   * Optional logger for registration / heartbeat / shutdown events. When
   * omitted, a default logger writes to `console.warn` with a
   * `[motebit/mcp-server]` prefix — deliberately visible rather than silent,
   * so registration failures surface in fly/heroku/journald output without
   * every service wiring a custom log. Pass a function to route these events
   * through a structured logger; pass `() => {}` to suppress entirely (not
   * recommended — hides sybil-relevant failures).
   */
  log?: (msg: string) => void;
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

  // Default to a visible logger. The earlier "silent when omitted" default
  // silently hid registration failures across every deployed service —
  // classic fail-loudly violation. Callers who want to suppress pass `() => {}`.
  const log: (msg: string) => void =
    config.log ?? ((msg) => console.warn(`[motebit/mcp-server] ${msg}`));

  const mcpServer = new McpServerAdapter(
    {
      name: serverName,
      transport: "http",
      port: config.port,
      authToken: config.authToken,
      motebitType: config.motebitType ?? "service",
      customRoutes: config.customRoutes,
    },
    deps,
  );
  await mcpServer.start();

  const toolCount = deps.listTools().length;
  if (config.onStart) {
    config.onStart(config.port, toolCount);
  }

  // Relay registration with clock-drift-aware heartbeat.
  //
  // Problem: platforms like Fly.io freeze the process when auto-stopping machines.
  // When the machine wakes, setInterval timers resume but don't know time passed —
  // the relay registration (15-min TTL) expires silently. Heartbeats fire on the
  // old schedule as if no time elapsed.
  //
  // Solution: track wall-clock time of last successful registration/heartbeat.
  // On each heartbeat tick, detect drift (actual elapsed > 2× expected interval)
  // and re-register instead of just heartbeating. Expose ensureRegistered() so the
  // health endpoint can also trigger re-registration on wake.
  const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const REGISTRATION_TTL_MS = 15 * 60 * 1000; // 15 minutes (relay-side)
  const STALE_THRESHOLD_MS = REGISTRATION_TTL_MS * 0.7; // re-register at 70% of TTL

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let lastRegisteredAt = 0; // wall-clock ms of last successful register/heartbeat
  let registering = false; // guard against concurrent registration attempts

  if (config.syncUrl) {
    const toolNames = deps.listTools().map((t) => t.name);
    const regHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiToken) regHeaders["Authorization"] = `Bearer ${config.apiToken}`;

    const endpointUrl = config.publicEndpointUrl ?? `http://localhost:${config.port}`;
    const regBody = {
      motebit_id: deps.motebitId,
      public_key: deps.publicKeyHex ?? "",
      endpoint_url: endpointUrl,
      capabilities: toolNames,
      metadata: { name: serverName },
    };

    /** Full registration: register + publish listing. Idempotent, concurrency-guarded. */
    const register = async (): Promise<boolean> => {
      if (registering) return lastRegisteredAt > 0;
      registering = true;
      try {
        const regResp = await fetch(`${config.syncUrl}/api/v1/agents/register`, {
          method: "POST",
          headers: regHeaders,
          body: JSON.stringify(regBody),
          signal: AbortSignal.timeout(10_000),
        });
        if (!regResp.ok) {
          log(
            `Relay registration failed: ${regResp.status} ${await regResp.text().catch(() => "")}`,
          );
          return false;
        }

        lastRegisteredAt = Date.now();

        // Auto-publish service listing so relay routing can find this service
        try {
          const listing = (await deps.getServiceListing?.()) ?? {
            capabilities: toolNames,
            pricing: [],
            sla: { max_latency_ms: 30_000, availability_guarantee: 0.99 },
            description: serverName,
          };
          const listingResp = await fetch(
            `${config.syncUrl}/api/v1/agents/${deps.motebitId}/listing`,
            {
              method: "POST",
              headers: regHeaders,
              body: JSON.stringify(listing),
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (listingResp.ok) {
            log(`Published service listing`);
          } else {
            log(
              `Service listing failed: ${listingResp.status} ${await listingResp.text().catch(() => "")}`,
            );
          }
        } catch {
          // Best-effort listing
        }
        return true;
      } catch (err: unknown) {
        log(`Relay registration error: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      } finally {
        registering = false;
      }
    };

    /** Lightweight heartbeat — just extends the TTL. */
    const heartbeat = async (): Promise<void> => {
      try {
        const resp = await fetch(`${config.syncUrl}/api/v1/agents/heartbeat`, {
          method: "POST",
          headers: regHeaders,
          body: JSON.stringify({ motebit_id: deps.motebitId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) lastRegisteredAt = Date.now();
      } catch {
        // Best-effort heartbeat
      }
    };

    // Initial registration
    try {
      const ok = await register();
      if (ok) {
        log(`Registered with relay (capabilities: ${toolNames.join(", ")})`);
      }
    } catch (err: unknown) {
      log(`Relay registration error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Clock-drift-aware heartbeat timer
    if (lastRegisteredAt > 0) {
      heartbeatTimer = setInterval(
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- fire-and-forget heartbeat
        async () => {
          const elapsed = Date.now() - lastRegisteredAt;
          if (elapsed >= STALE_THRESHOLD_MS) {
            // Registration likely expired (process was frozen or heartbeats failed).
            // Full re-registration instead of heartbeat.
            const ok = await register();
            if (ok) log(`Re-registered with relay (stale after ${Math.round(elapsed / 1000)}s)`);
          } else {
            await heartbeat();
          }
        },
        HEARTBEAT_INTERVAL_MS,
      );
    }

    // Expose ensureRegistered for health endpoint — platforms that freeze processes
    // (Fly.io auto_stop, Kubernetes pod eviction) wake on health checks, which
    // run before any task traffic arrives. Re-registering here closes the window.
    mcpServer.ensureRegistered = async () => {
      const elapsed = Date.now() - lastRegisteredAt;
      if (elapsed >= STALE_THRESHOLD_MS) {
        const ok = await register();
        if (ok)
          log(`Re-registered with relay (health check, stale ${Math.round(elapsed / 1000)}s)`);
      }
    };
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
