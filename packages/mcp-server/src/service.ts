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

import { McpServerAdapter, assertOwnerPrincipal } from "./index.js";
import { isServableTool } from "./serve-exposure.js";
import type { MotebitServerDeps, ServedPrincipal, TaskAdmissionConfig } from "./index.js";
import type {
  ToolDefinition,
  ToolResult,
  PolicyDecision,
  EventLogEntry,
  TurnContext,
} from "@motebit/sdk";
import { EventType, SensitivityLevel, AgentTrustLevel } from "@motebit/sdk";
import {
  verifySignedToken as defaultVerifySignedToken,
  verifySuccessionChain,
} from "@motebit/encryption";
import type { TokenAudience } from "@motebit/sdk";

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
  recallRelevant(
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
    data: {
      content: string;
      confidence: number;
      sensitivity: string;
      /** Provenance — the MCP server always passes the literal "peer_agent". */
      source: string | undefined;
    },
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
  getAgentTrust?(remoteMotebitId: string): Promise<{
    trust_level: string;
    public_key?: string;
    /**
     * The caller's guardian key as PINNED by this store from a source the
     * caller itself signed under its earlier key (its identity record at
     * first contact). The only guardian a recovery succession is checked
     * against — a guardian named by the relay never carries trust.
     */
    guardian_public_key?: string;
  } | null>;
  /**
   * Optional: record an interaction with a remote motebit. The stored key
   * changes only when `opts.provenSuccession` is true (a verified succession
   * from the stored key to `publicKey`).
   */
  recordAgentInteraction?(
    remoteMotebitId: string,
    publicKey?: string,
    motebitType?: string,
    opts?: { provenSuccession?: boolean },
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// wireServerDeps — the ~70-line boilerplate eliminator
// ---------------------------------------------------------------------------

/**
 * How a service authenticates to ITS OWN relay for registration, heartbeat,
 * listing publication, and caller-key resolution: a short-lived,
 * audience-bound token signed by the service's own identity key — the same
 * shape the CLI and every device surface use. There is deliberately no
 * shared-secret alternative: a worker never holds the relay operator's master
 * token (`docs/doctrine/task-admission.md` § "The worker authenticates as
 * itself"). A fresh identity is introduced to the relay through the public,
 * rate-limited `POST /api/v1/agents/bootstrap` before its first signed call.
 */
export interface RelayAuth {
  /** The `did` claim the relay resolves the signing key by (bootstrap device id). */
  deviceId: string;
  /** Mint a signed bearer bound to `audience`. Called per request; tokens are short-lived. */
  mint: (audience: TokenAudience) => Promise<string>;
  /**
   * Sign the bootstrap introduction with the identity key — the relay refuses
   * an unsigned `POST /api/v1/agents/bootstrap` (#875: proof of possession of
   * the key it names). Returns the device-registration request
   * (`signDeviceRegistration` from `@motebit/crypto` over `body` plus a fresh
   * `timestamp`). Absent ⇒ bootstrap is skipped and said so; a service whose
   * key the relay already holds still registers with its signed bearer.
   */
  signRegistration?: (body: {
    motebit_id: string;
    device_id: string;
    public_key: string;
  }) => Promise<Record<string, unknown>>;
}

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
    options?: { delegatedScope?: string; relayTaskId?: string; admittedRelayTaskId?: string },
  ) => AsyncGenerator<
    | { type: "text"; text: string }
    | { type: "task_result"; receipt: Record<string, unknown> }
    | { type: string; [key: string]: unknown }
  >;

  /**
   * If provided, wires sendMessage for motebit_query synthetic tool. It must
   * run the turn as `principal` (#943 round 10: stdio owner ⇒ an owner turn,
   * anything else ⇒ a foreign turn).
   */
  sendMessage?: (
    text: string,
    principal: ServedPrincipal,
  ) => Promise<{ response: string; memoriesFormed: number }>;

  /** Relay URL for remote key resolution (fallback when local trust store has no record). */
  syncUrl?: string;
  /** Signed self-auth for the one relay lookup that is not public (`GET /api/v1/agents/:id`). */
  relayAuth?: RelayAuth;
}

export function wireServerDeps(
  runtime: ServiceRuntime,
  opts: WireServerDepsOptions,
): MotebitServerDeps {
  const { motebitId, publicKeyHex } = opts;

  const deps: MotebitServerDeps = {
    motebitId,
    publicKeyHex,

    // `localOnly` tools never leave this function (#874): a money molecule
    // registers `retrieve_task_result` for its own recovery, and serving it
    // let any caller list the molecule's paid tasks and read work bought
    // for other customers.
    listTools: () => runtime.getToolRegistry().list().filter(isServableTool),
    filterTools: (tools) => runtime.policy.filterTools(tools.filter(isServableTool)),
    validateTool: (tool, args, caller?) => {
      const ctx = runtime.policy.createTurnContext() as TurnContext;
      if (caller) {
        ctx.callerMotebitId = caller.motebitId;
        ctx.callerTrustLevel = caller.trustLevel;
      }
      return runtime.policy.validate(tool, args, ctx);
    },
    executeTool: async (name, args) => {
      const def = runtime
        .getToolRegistry()
        .list()
        .find((t) => t.name === name);
      if (def != null && !isServableTool(def)) {
        return { ok: false, error: `Tool "${name}" is not served.` };
      }
      return runtime.getToolRegistry().execute(name, args);
    },

    getState: () => runtime.getState() as Record<string, unknown>,

    getMemories: async (limit = 50, principal) => {
      assertOwnerPrincipal(principal);
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
          // eslint-disable-next-line no-console -- no logger in wireServerDeps scope; stderr is the fail-loud sink (matches the package default logger)
          console.warn(
            "[motebit] tool event log failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      } else {
        void runtime.events.append({ ...entry, version_clock: 0 }).catch((err: unknown) => {
          // eslint-disable-next-line no-console -- no logger in wireServerDeps scope; stderr is the fail-loud sink (matches the package default logger)
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
    deps.queryMemories = async (query: string, limit?: number, principal?: ServedPrincipal) => {
      assertOwnerPrincipal(principal);
      const embedding = await embedText(query);
      const nodes = await runtime.memory.recallRelevant(embedding, {
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
          // Provenance: a remote caller's write is ALWAYS peer_agent —
          // hard-coded, never caller-derived. A peer that could
          // self-declare user_stated would mint trusted memories
          // remotely. Gate-enforced by check-memory-source-canonical.
          source: "peer_agent",
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

  // The successor key each caller PROVED (a signed succession from its stored
  // key), so the trust-store write in onCallerVerified may adopt exactly that
  // key. Written by resolveCallerKey, read by onCallerVerified.
  const provenSuccessors = new Map<string, string>();

  // Caller key resolution: local trust store → relay fallback
  {
    const getAgentTrust = runtime.getAgentTrust?.bind(runtime);
    const syncUrl = opts.syncUrl?.replace(/\/+$/, "");
    const relayAuth = opts.relayAuth;

    // Track relay-confirmed callers so local FirstContact records get upgraded
    const relayConfirmedCallers = new Set<string>();
    // Callers whose relay-served key differed from the stored one. Once seen,
    // the stored key never authenticates on relay unavailability.
    const rotationObserved = new Set<string>();
    const failOpenLogged = new Set<string>();

    // Short-lived cache of the relay's served identity, so a known caller's
    // every request does not cost a relay round trip. Bounded staleness: a
    // retired key keeps authenticating for at most this long after rotation.
    const SERVED_IDENTITY_TTL_MS = 30_000;
    const servedCache = new Map<string, { at: number; value: ServedIdentity }>();
    const servedIdentity = async (callerMotebitId: string): Promise<ServedIdentity | null> => {
      if (!syncUrl) return null;
      const hit = servedCache.get(callerMotebitId);
      if (hit && Date.now() - hit.at < SERVED_IDENTITY_TTL_MS) return hit.value;
      let value: ServedIdentity | null = null;
      try {
        const resp = await fetch(`${syncUrl}/api/v1/identity/${callerMotebitId}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) {
          const raw = (await resp.json()) as {
            current_public_key?: unknown;
            succession?: unknown;
          };
          if (typeof raw.current_public_key === "string" && raw.current_public_key !== "") {
            value = {
              currentKey: raw.current_public_key,
              succession: Array.isArray(raw.succession)
                ? (raw.succession as KeySuccessionRecord[])
                : [],
            };
          }
        }
      } catch {
        // Relay unreachable — not cached, so the next request asks again.
        return null;
      }
      // Only a served key is cached: a caller the relay does not know yet may
      // register at any moment, so a miss is asked again next time.
      if (value) servedCache.set(callerMotebitId, { at: Date.now(), value });
      return value;
    };

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
            const local = { publicKey: record.public_key, trustLevel };
            if (!syncUrl) return local;

            // 1b. The stored key is the key FIRST seen for this caller; it is
            // never preferred over a newer succession. The relay's identity
            // bundle is the authority on the current key — after a rotation
            // the stored key is retired and must stop authenticating (and the
            // successor must start). Relay unreachable / caller unknown there
            // ⇒ the stored key stands (availability; nothing says it moved).
            const served = await servedIdentity(callerMotebitId);
            if (!served) {
              // Relay unavailable or the caller unknown there: nothing says the
              // key moved, so the stored key stands — but at most Verified
              // (relay-confirmed trust needs the relay), and never once a
              // rotation away from it has been seen.
              if (trustLevel === AgentTrustLevel.Blocked) return local;
              if (!failOpenLogged.has(callerMotebitId)) {
                failOpenLogged.add(callerMotebitId);
                // eslint-disable-next-line no-console -- no logger in wireServerDeps scope; stderr is the fail-loud sink (matches the package default logger)
                console.warn(
                  `[motebit] relay identity unavailable for ${callerMotebitId}: ${
                    rotationObserved.has(callerMotebitId)
                      ? "a rotation was observed, the stored key is refused"
                      : "stored key accepted at most at Verified"
                  }`,
                );
              }
              if (rotationObserved.has(callerMotebitId)) return null;
              return { publicKey: record.public_key, trustLevel: capAtVerified(trustLevel) };
            }
            if (sameKey(served.currentKey, record.public_key)) return local;
            rotationObserved.add(callerMotebitId);
            if (trustLevel === AgentTrustLevel.Blocked) {
              return { publicKey: served.currentKey, trustLevel };
            }
            // Earned trust carries over only across a succession PROVEN by the
            // retired key's own signature; a key change the relay asserts
            // without that proof authenticates at most as relay-Verified.
            // A guardian RECOVERY is checked only against the guardian this
            // store pinned from the caller's own signed record — never one
            // the relay answer names (a relay, or whoever controls its
            // answer, could otherwise sign a recovery to its own key with its
            // own "guardian"). No pinned guardian ⇒ a recovery is unproven.
            const proven = await successionLinks(
              served.succession,
              record.public_key,
              served.currentKey,
              typeof record.guardian_public_key === "string" && record.guardian_public_key !== ""
                ? record.guardian_public_key
                : undefined,
            );
            relayConfirmedCallers.add(callerMotebitId);
            if (proven) provenSuccessors.set(callerMotebitId, served.currentKey);
            else provenSuccessors.delete(callerMotebitId);
            // Unproven: the stored record keeps its key (recordAgentInteraction
            // refuses the change), so this cap applies on EVERY request.
            return {
              publicKey: served.currentKey,
              trustLevel: proven ? trustLevel : capAtVerified(trustLevel),
            };
          }
        }

        // 2. Relay fallback — look up by motebit_id across both registries.
        // Service-mode motebits (e.g. molecules) register via
        // /api/v1/agents/register which writes to agent_registry. Device-mode
        // motebits (e.g. web/mobile/desktop) register via /device/register
        // (or the new self-attesting /api/v1/devices/register-self). Either
        // table can hold the public key for a given motebit_id; checking only
        // one silently rejects callers from the other class. Both tables are
        // siblings of the same identity surface — kept in sync by the
        // identity manager — so this lookup is a sibling fallback, not a
        // protocol fork.
        //
        // Every lookup here is either PUBLIC (a key is a public protocol
        // artifact — relay CLAUDE.md rule 6) or signed by THIS service's own
        // identity. None carries an operator secret: before 2026-09-13 these
        // calls sent the relay's master token, which meant every worker
        // container held full relay authority just to read public keys.
        if (syncUrl) {
          // 2a. Identity-transparency binding bundle (public). Covers both
          // registries: the relay assembles it from agent_registry + the
          // succession chain, and it is the same surface an external verifier
          // resolves a receipt's producer through.
          // Relay unreachable ⇒ fall through to the registry reads, then fail closed.
          const served = await servedIdentity(callerMotebitId);
          if (served) {
            relayConfirmedCallers.add(callerMotebitId);
            return { publicKey: served.currentKey, trustLevel: AgentTrustLevel.Verified };
          }

          // 2b. Agent registry via public discovery (`/api/v1/agents/discover`
          // returns every serving agent; filter by motebit_id).
          try {
            const resp = await fetch(`${syncUrl}/api/v1/agents/discover`, {
              signal: AbortSignal.timeout(10_000),
            });
            if (resp.ok) {
              const raw = (await resp.json()) as {
                agents?: Array<{ motebit_id?: string; public_key?: string }>;
              };
              const agent = raw.agents?.find(
                (a) =>
                  a.motebit_id === callerMotebitId &&
                  a.public_key != null &&
                  a.public_key.length > 0,
              );
              if (agent?.public_key) {
                relayConfirmedCallers.add(callerMotebitId);
                return { publicKey: agent.public_key, trustLevel: AgentTrustLevel.Verified };
              }
            }
          } catch {
            // Relay unreachable — one more read, then fail closed
          }

          // 2c. Direct registry row (`/api/v1/agents/:id`) — an agent route, so
          // it takes a bearer: this service's OWN signed token, never a shared
          // secret. Reaches sleeping agents discovery has aged out.
          if (relayAuth) {
            try {
              const token = await relayAuth.mint("admin:query");
              const resp = await fetch(`${syncUrl}/api/v1/agents/${callerMotebitId}`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10_000),
              });
              if (resp.ok) {
                const raw = (await resp.json()) as { public_key?: unknown };
                if (typeof raw.public_key === "string" && raw.public_key !== "") {
                  relayConfirmedCallers.add(callerMotebitId);
                  return { publicKey: raw.public_key, trustLevel: AgentTrustLevel.Verified };
                }
              }
            } catch {
              // Relay unreachable — fail closed
            }
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
      const successor = provenSuccessors.get(callerMotebitId);
      void recordInteraction(callerMotebitId, publicKey, undefined, {
        provenSuccession: successor != null && sameKey(successor, publicKey),
      });
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
  /**
   * Human display name registered as `metadata.display_name` — the
   * self-asserted claim Discover cards render in claim framing
   * (docs/doctrine/agents-as-first-person-trust-graph.md §3). Distinct
   * from `name`, which stays the machine server-name/description default.
   */
  displayName?: string;
  /** MCP transport port. */
  port: number;
  /** Require bearer token for incoming connections. */
  authToken?: string;
  /** Service type for inbound policy. */
  motebitType?: "personal" | "service" | "collaborative";
  /**
   * Task admission — require a relay-signed `dispatch_token` on every
   * `motebit_task` (see `McpServerConfig.taskAdmission`). Priced services
   * registered with a relay should set this; the relay attaches the token
   * to every forward and returns it to the submitter.
   */
  taskAdmission?: TaskAdmissionConfig;
  /**
   * Pinned relay key — lets the relay authenticate to this worker AS ITSELF
   * with a relay-signed `mcp:call` token bound to this worker (never with a
   * dispatch token, which admits a task but authenticates no one — #981).
   */
  relayTrust?: { relayPublicKey: string | (() => Promise<string | null>) };

  /** Sync relay URL for discovery registration. */
  syncUrl?: string;
  /**
   * Signed self-auth to the relay named by `syncUrl`. REQUIRED for
   * registration to succeed: the relay's agent routes take a bearer, and the
   * only bearer a service may present is one signed by its own key. Absent ⇒
   * relay registration is skipped with a loud log line (the service still
   * serves MCP; it is just not discoverable).
   */
  relayAuth?: RelayAuth;
  /** Public endpoint URL for relay registration (default: http://localhost:<port>). */
  publicEndpointUrl?: string;
  /**
   * Onchain settlement address (Solana base58) advertised at registration —
   * where a delegator's direct P2P payment leg lands. Derive from the service's
   * own identity public key (`deriveSolanaAddress`), never hardcode. Omitted →
   * `settlement_address` stays null and the service is relay-mode only.
   */
  settlementAddress?: string;
  /**
   * Settlement modes the service opts into (comma-joined, e.g. "relay" or
   * "relay,p2p"). Default behavior (omitted) leaves it unset → relay-mode only.
   * A service must include "p2p" to be selected for paid peer-to-peer delegation
   * — only enable it once the service can actually SPEND received funds, or
   * earnings accrue at `settlementAddress` with no way out.
   */
  settlementModes?: string;

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
    config.log ??
    // eslint-disable-next-line no-console -- intended default sink; the fail-loud logger when no config.log is injected (see comment above)
    ((msg) => console.warn(`[motebit/mcp-server] ${msg}`));

  const mcpServer = new McpServerAdapter(
    {
      name: serverName,
      transport: "http",
      port: config.port,
      authToken: config.authToken,
      motebitType: config.motebitType ?? "service",
      customRoutes: config.customRoutes,
      ...(config.taskAdmission != null ? { taskAdmission: config.taskAdmission } : {}),
      ...(config.relayTrust != null ? { relayTrust: config.relayTrust } : {}),
    },
    deps,
  );
  await mcpServer.start();

  const toolCount = (await deps.listTools()).length;
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

  /**
   * How often to force a FULL re-registration even while heartbeats succeed.
   *
   * The service listing is published by `register()` and by nothing else, while
   * `heartbeat()` only extends the TTL — and, critically, a successful
   * heartbeat also refreshes `lastRegisteredAt`. So the staleness branch below
   * never fires on a healthy service, which means the listing is a BOOT-TIME
   * ONE-SHOT: if the relay ever loses it, nothing republishes it.
   *
   * That is not hypothetical. Staging carried six live, heartbeating,
   * fully-discoverable atoms with ZERO listing rows for roughly a month —
   * unpriced and undescribed — after the relay's listing table was emptied.
   * The atoms were healthy the entire time, so they never re-registered. The
   * archetype conformance probe went red daily and stayed red until each
   * machine was restarted by hand.
   *
   * Same shape as the transparency boot-anchor incident: a fire-and-forget
   * publish with no maintenance loop leaves a silent, permanent gap. The fix is
   * the same medicine — make it a maintained invariant, idempotent and
   * repeated, rather than a thing that happened once at boot.
   *
   * Hourly is cheap (one registration POST per service per hour) and bounds the
   * damage of any listing loss to an hour instead of forever.
   */
  const FULL_REREGISTER_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let lastRegisteredAt = 0; // wall-clock ms of last successful register/heartbeat
  /**
   * Wall-clock ms of the last successful FULL registration. Deliberately
   * separate from `lastRegisteredAt`: heartbeats refresh that one, which is
   * exactly why it cannot be used to decide when to republish the listing.
   */
  let lastFullRegisterAt = 0;
  let registering = false; // guard against concurrent registration attempts

  if (config.syncUrl && config.relayAuth == null) {
    log(
      `Relay registration skipped: syncUrl is set but no relayAuth (signed self-auth) was ` +
        `configured. A service authenticates to its relay with its OWN identity key — there ` +
        `is no shared-secret path. Wire relayAuth (molecule-runner does this from the ` +
        `bootstrapped identity) to register, heartbeat, and publish a listing.`,
    );
  }
  if (config.syncUrl && config.relayAuth != null) {
    const relayAuth = config.relayAuth;
    const toolNames = (await deps.listTools()).map((t) => t.name);
    /** Fresh signed bearer per call — tokens are short-lived and audience-bound. */
    const relayHeaders = async (audience: TokenAudience): Promise<Record<string, string>> => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${await relayAuth.mint(audience)}`,
    });
    /**
     * Introduce this identity to the relay once per process. `bootstrap` is
     * the public, rate-limited, hijack-guarded (same id + different key ⇒ 409)
     * path that gives the relay a key to verify our signed tokens against
     * BEFORE the first authenticated call. Idempotent on (id, key), so a
     * re-registering service is a no-op here; a 409 is logged loudly because
     * it means this identity is bound to someone else's key on this relay.
     */
    let bootstrapped = false;
    let bootstrapUnsignedLogged = false;
    const bootstrap = async (): Promise<void> => {
      if (bootstrapped) return;
      // The relay admits an introduction only when it is signed by the key it
      // names (#875). Without a signer there is nothing to send: an unsigned
      // bootstrap is refused, so say so once and let the signed-bearer
      // register proceed (it succeeds when the relay already holds our key).
      if (relayAuth.signRegistration == null) {
        if (!bootstrapUnsignedLogged) {
          bootstrapUnsignedLogged = true;
          log(
            `Relay bootstrap skipped: the relay requires proof of possession of the key ` +
              `(a device-registration signature) and relayAuth.signRegistration is not wired.`,
          );
        }
        return;
      }
      const signed = await relayAuth.signRegistration({
        motebit_id: deps.motebitId,
        device_id: relayAuth.deviceId,
        public_key: deps.publicKeyHex ?? "",
      });
      const resp = await fetch(`${config.syncUrl}/api/v1/agents/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        bootstrapped = true;
        return;
      }
      log(
        `Relay bootstrap ${resp.status === 409 ? "REFUSED — this motebit_id is bound to a different key on the relay" : "failed"}: ` +
          `${resp.status} ${await resp.text().catch(() => "")}`,
      );
    };

    const endpointUrl = config.publicEndpointUrl ?? `http://localhost:${config.port}`;
    const regBody = {
      motebit_id: deps.motebitId,
      public_key: deps.publicKeyHex ?? "",
      endpoint_url: endpointUrl,
      capabilities: toolNames,
      metadata: {
        name: serverName,
        // Self-asserted display name — a discovery-time CLAIM, never a
        // verified handle (trust-graph doctrine §3). Rides the registry's
        // free-form metadata; queryLocalAgents surfaces it to Discover.
        ...(config.displayName != null ? { display_name: config.displayName } : {}),
      },
      // Settlement fields are written ONLY by the register route (the relay's
      // PATCH /sweep-config sets address but not modes), so they MUST travel in
      // this body or a service can never become P2P-capable. Sent only when
      // configured; absent → relay-mode only (back-compatible).
      ...(config.settlementAddress != null ? { settlement_address: config.settlementAddress } : {}),
      ...(config.settlementModes != null ? { settlement_modes: config.settlementModes } : {}),
    };

    /** Full registration: register + publish listing. Idempotent, concurrency-guarded. */
    const register = async (): Promise<boolean> => {
      if (registering) return lastRegisteredAt > 0;
      registering = true;
      try {
        await bootstrap();
        const regResp = await fetch(`${config.syncUrl}/api/v1/agents/register`, {
          method: "POST",
          headers: await relayHeaders("admin:query"),
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
        lastFullRegisterAt = lastRegisteredAt;

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
              headers: await relayHeaders("market:listing"),
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

    // Readiness gate. `true` when the last probe said we can do the work (or no
    // probe is wired). Tracked so the transition — not every tick — is logged.
    let advertising = true;
    /**
     * Ask the injected probe whether this agent can currently perform what it
     * advertises. A probe that THROWS is treated as ready: an unreliable probe
     * must never be the thing that takes a working agent off the market.
     */
    const readyToAdvertise = async (): Promise<boolean> => {
      if (deps.checkReadiness == null) return true;
      let verdict: { ready: boolean; reason?: string };
      try {
        verdict = await deps.checkReadiness();
      } catch (err: unknown) {
        // Fail OPEN, deliberately: see above. Log it, since a probe that always
        // throws is silently doing nothing.
        log(
          `Readiness probe threw, continuing to advertise: ${err instanceof Error ? err.message : String(err)}`,
        );
        return true;
      }
      if (verdict.ready !== advertising) {
        advertising = verdict.ready;
        log(
          verdict.ready
            ? `Ready again — resuming heartbeats, listing will refresh`
            : `NOT ready (${verdict.reason ?? "no reason given"}) — withholding heartbeats; ` +
                `discovery freshness will decay rather than advertise work this agent cannot do`,
        );
      }
      return verdict.ready;
    };

    /** Lightweight heartbeat — just extends the TTL. */
    const heartbeat = async (): Promise<void> => {
      try {
        const resp = await fetch(`${config.syncUrl}/api/v1/agents/heartbeat`, {
          method: "POST",
          headers: await relayHeaders("admin:query"),
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
          // Readiness first: an agent that cannot do the work must not renew its
          // claim to be awake for it. Withholding is the whole mechanism — the
          // relay's freshness ladder does the rest.
          if (!(await readyToAdvertise())) return;
          const elapsed = Date.now() - lastRegisteredAt;
          const sinceFull = Date.now() - lastFullRegisterAt;
          if (elapsed >= STALE_THRESHOLD_MS) {
            // Registration likely expired (process was frozen or heartbeats failed).
            // Full re-registration instead of heartbeat.
            const ok = await register();
            if (ok) log(`Re-registered with relay (stale after ${Math.round(elapsed / 1000)}s)`);
          } else if (sinceFull >= FULL_REREGISTER_INTERVAL_MS) {
            // Healthy, but the listing has not been republished in a while.
            // Heartbeats keep `lastRegisteredAt` fresh forever, so without this
            // branch a listing lost on the relay side is never restored.
            const ok = await register();
            if (ok)
              log(`Re-registered with relay (listing refresh, ${Math.round(sinceFull / 60000)}m)`);
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
      // Same gate on the health-check wake path — otherwise a platform health
      // probe re-registers an agent the heartbeat loop deliberately let decay.
      if (!(await readyToAdvertise())) return;
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
    if (config.syncUrl && config.relayAuth != null) {
      try {
        const token = await config.relayAuth.mint("admin:query");
        await fetch(`${config.syncUrl}/api/v1/agents/deregister`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
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

// ---------------------------------------------------------------------------
// Caller key succession
// ---------------------------------------------------------------------------

type KeySuccessionRecord = Parameters<typeof verifySuccessionChain>[0][number];

interface ServedIdentity {
  currentKey: string;
  succession: KeySuccessionRecord[];
  // No guardian: the relay's answer never names the guardian a recovery is
  // checked against (see resolveCallerKey).
}

/** Relay-confirmed trust at most: Trusted → Verified; every other level unchanged. */
function capAtVerified(level: AgentTrustLevel): AgentTrustLevel {
  return level === AgentTrustLevel.Trusted ? AgentTrustLevel.Verified : level;
}

function sameKey(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * True iff `succession` contains a verified run of records leading from
 * `fromKey` to `toKey` — i.e. the retired key (or the caller's PINNED
 * guardian) signed the hand-off. Only then does trust earned under `fromKey` carry to `toKey`.
 */
async function successionLinks(
  succession: KeySuccessionRecord[],
  fromKey: string,
  toKey: string,
  guardianPublicKey?: string,
): Promise<boolean> {
  const start = succession.findIndex(
    (r) => typeof r?.old_public_key === "string" && sameKey(r.old_public_key, fromKey),
  );
  if (start === -1) return false;
  try {
    const result = await verifySuccessionChain(succession.slice(start), guardianPublicKey);
    return result.valid && sameKey(result.current_public_key, toKey);
  } catch {
    return false;
  }
}
