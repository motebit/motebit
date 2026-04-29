// --- Provider creation, tool registry, runtime bootstrap ---

import * as fs from "node:fs";
import * as path from "node:path";
import {
  MotebitRuntime,
  NullRenderer,
  PLANNING_TASK_ROUTER,
  createRelayCapabilitiesFetcher,
} from "@motebit/runtime";
import { buildHardwareVerifiers } from "@motebit/verify";
import { embedText } from "@motebit/memory-graph";
import type { StorageAdapters } from "@motebit/runtime";
import { AnthropicProvider, OpenAIProvider } from "@motebit/ai-core";
import type { StreamingProvider, MotebitPersonalityConfig } from "@motebit/ai-core";
import { openMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import type { EventStoreAdapter } from "@motebit/event-log";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import {
  HttpEventStoreAdapter,
  EncryptedEventStoreAdapter,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
} from "@motebit/sync-engine";
import { NodeFsSkillStorageAdapter, SkillRegistry, SkillSelector } from "@motebit/skills";
import type { SkillSelectorHook } from "@motebit/sdk";
import type { ConversationSyncStoreAdapter, PlanSyncStoreAdapter } from "@motebit/sync-engine";
import type {
  SyncConversation,
  SyncConversationMessage,
  SyncPlan,
  SyncPlanStep,
  PlanStep,
  UnifiedProviderConfig,
  ProviderSpec,
  ResolverEnv,
} from "@motebit/sdk";
import {
  EventType,
  RiskLevel,
  resolveProviderSpec,
  UnsupportedBackendError,
  DEFAULT_GOVERNANCE_CONFIG,
  DEFAULT_MOTEBIT_CLOUD_URL,
  APPROVAL_PRESET_CONFIGS,
  type GovernanceConfig,
} from "@motebit/sdk";
import {
  InMemoryToolRegistry,
  readFileDefinition,
  createReadFileHandler,
  writeFileDefinition,
  createWriteFileHandler,
  shellExecDefinition,
  createShellExecHandler,
  undoWriteDefinition,
  createUndoWriteHandler,
  webSearchDefinition,
  createWebSearchHandler,
  readUrlDefinition,
  createReadUrlHandler,
  recallMemoriesDefinition,
  rewriteMemoryDefinition,
  createRewriteMemoryHandler,
  searchConversationsDefinition,
  createSearchConversationsHandler,
  createRecallMemoriesHandler,
  recallSelfDefinition,
  createRecallSelfHandler,
  listEventsDefinition,
  createListEventsHandler,
  selfReflectDefinition,
  createSelfReflectHandler,
  currentTimeDefinition,
  createCurrentTimeHandler,
  BraveSearchProvider,
  DuckDuckGoSearchProvider,
  FallbackSearchProvider,
} from "@motebit/tools";
import { querySelfKnowledge } from "@motebit/self-knowledge";
import type { SearchProvider } from "@motebit/tools";
import type { McpServerConfig } from "@motebit/mcp-client";
import { dim } from "./colors.js";
import type { CliConfig } from "./args.js";
import { CONFIG_DIR, loadFullConfig } from "./config.js";

export function getApiKey(provider: "anthropic" | "openai" | "google" = "anthropic"): string {
  const envVar =
    provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "google"
        ? "GOOGLE_API_KEY"
        : "ANTHROPIC_API_KEY";
  const key = process.env[envVar];
  if (key == null || key === "") {
    const hint =
      provider === "openai"
        ? "Set it with: export OPENAI_API_KEY=sk-..."
        : provider === "google"
          ? "Set it with: export GOOGLE_API_KEY=AIza..."
          : "Set it with: export ANTHROPIC_API_KEY=sk-ant-...";
    console.error(`Error: ${envVar} environment variable is not set.\n${hint}`);
    process.exit(1);
  }
  return key;
}

/**
 * Map MotebitDatabase → StorageAdapters with ALL available stores.
 * Eliminates the silent divergence where daemon/serve/services each
 * cherry-picked a different subset and silently dropped trust, gradient,
 * credential, and settlement signals.
 */
export function buildStorageAdapters(moteDb: MotebitDatabase): StorageAdapters {
  // Ring 2 privacy contract: the CLI surface's storage must expose an
  // EventStoreAdapter and an AuditLogAdapter. Enforced statically by
  // check-privacy-ring.
  const eventStore: EventStoreAdapter = moteDb.eventStore;
  const auditLog: AuditLogAdapter = moteDb.auditLog;
  return {
    eventStore,
    memoryStorage: moteDb.memoryStorage,
    identityStorage: moteDb.identityStorage,
    auditLog,
    stateSnapshot: moteDb.stateSnapshot,
    toolAuditSink: moteDb.toolAuditSink,
    conversationStore: moteDb.conversationStore,
    planStore: moteDb.planStore,
    // SqliteGradientStore.latest() returns Record<string, unknown> stats; runtime expects typed stats.
    // Structurally compatible at runtime — the columns are correct, just the TS return type is looser.
    gradientStore: moteDb.gradientStore as unknown as NonNullable<StorageAdapters["gradientStore"]>,
    agentTrustStore: moteDb.agentTrustStore,
    serviceListingStore: moteDb.serviceListingStore,
    budgetAllocationStore: moteDb.budgetAllocationStore,
    settlementStore: moteDb.settlementStore,
    latencyStatsStore: moteDb.latencyStatsStore,
    credentialStore: moteDb.credentialStore,
    approvalStore: moteDb.approvalStore,
  };
}

export function getDbPath(override?: string): string {
  if (override != null && override !== "") return override;
  const envPath = process.env["MOTEBIT_DB_PATH"];
  if (envPath != null && envPath !== "") return envPath;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  return path.join(CONFIG_DIR, "motebit.db");
}

/**
 * CLI's `ResolverEnv`. Node-side direct calls to vendor APIs (no CORS proxy
 * needed). Only `local-server` is supported as an on-device backend — CLI
 * doesn't ship native bindings for Apple FM, MLX, or WebGPU.
 */
/**
 * Resolve the motebit cloud relay URL for the CLI.
 *
 * Canonical env: `MOTEBIT_RELAY_URL`. Legacy alias `MOTEBIT_PROXY_URL`
 * still works for one release cycle. Falls back to the canonical default
 * `DEFAULT_MOTEBIT_CLOUD_URL` from `@motebit/sdk`.
 */
function resolveCliMotebitRelayUrl(): string {
  const canonical = process.env.MOTEBIT_RELAY_URL;
  if (canonical != null && canonical !== "") return canonical;
  const legacy = process.env.MOTEBIT_PROXY_URL;
  if (legacy != null && legacy !== "") {
    console.warn("[motebit] MOTEBIT_PROXY_URL is deprecated, use MOTEBIT_RELAY_URL instead");
    return legacy;
  }
  return DEFAULT_MOTEBIT_CLOUD_URL;
}

const CLI_RESOLVER_ENV: ResolverEnv = {
  cloudBaseUrl: (_wireProtocol, canonical) => canonical,
  defaultLocalServerUrl: "http://127.0.0.1:11434",
  supportedBackends: new Set(["local-server"]),
  motebitCloudBaseUrl: resolveCliMotebitRelayUrl(),
};

/**
 * Convert the CLI's flat `--provider` flag value to the unified shape the
 * resolver speaks.
 *
 * API keys come from environment variables via `getApiKey()` — that's the
 * CLI's I/O boundary for credentials, distinct from mobile/desktop's keyring.
 */
function cliConfigToUnified(config: CliConfig): UnifiedProviderConfig {
  switch (config.provider) {
    case "local-server":
      return {
        mode: "on-device",
        backend: "local-server",
        model: config.model,
        maxTokens: config.maxTokens,
      };
    case "anthropic":
      return {
        mode: "byok",
        vendor: "anthropic",
        apiKey: getApiKey("anthropic"),
        model: config.model,
        maxTokens: config.maxTokens,
      };
    case "openai":
      return {
        mode: "byok",
        vendor: "openai",
        apiKey: getApiKey("openai"),
        model: config.model,
        maxTokens: config.maxTokens,
      };
    case "google":
      return {
        mode: "byok",
        vendor: "google",
        apiKey: getApiKey("google"),
        model: config.model,
        maxTokens: config.maxTokens,
      };
    case "proxy":
      return {
        mode: "motebit-cloud",
        model: config.model,
        maxTokens: config.maxTokens,
      };
  }
}

/**
 * Map a resolved `ProviderSpec` to a CLI-side concrete provider instance.
 * `personalityConfig` and `temperature` are CLI-specific concerns the
 * resolver doesn't know about — they're threaded through the constructor here.
 */
function specToCliProvider(
  spec: ProviderSpec,
  personalityConfig: MotebitPersonalityConfig | undefined,
  temperature: number,
): StreamingProvider {
  switch (spec.kind) {
    case "cloud":
      // Cloud kind dispatches on wireProtocol: anthropic → AnthropicProvider
      // (Anthropic /v1/messages); openai → OpenAIProvider (OpenAI
      // /v1/chat/completions, also used for Google's OpenAI-compat endpoint
      // and any local-server inference via the OpenAI-compat shim).
      if (spec.wireProtocol === "openai") {
        return new OpenAIProvider({
          api_key: spec.apiKey,
          model: spec.model,
          base_url: spec.baseUrl,
          max_tokens: spec.maxTokens,
          temperature: spec.temperature ?? temperature,
          extra_headers: spec.extraHeaders,
          personalityConfig,
        });
      }
      return new AnthropicProvider({
        api_key: spec.apiKey,
        model: spec.model,
        base_url: spec.baseUrl,
        max_tokens: spec.maxTokens,
        temperature: spec.temperature ?? temperature,
        extra_headers: spec.extraHeaders,
        personalityConfig,
      });
    case "webllm":
    case "apple-fm":
    case "mlx":
      // The resolver gates these via supportedBackends; reaching them here
      // means the env was misconfigured.
      throw new UnsupportedBackendError(spec.kind);
  }
}

export function createProvider(
  config: CliConfig,
  personalityConfig?: MotebitPersonalityConfig,
): StreamingProvider {
  const temperature = personalityConfig?.temperature ?? 0.7;
  const unified = cliConfigToUnified(config);
  const spec = resolveProviderSpec(unified, CLI_RESOLVER_ENV);
  return specToCliProvider(spec, personalityConfig, temperature);
}

export function buildToolRegistry(
  config: CliConfig,
  runtimeRef: { current: MotebitRuntime | null },
  motebitId: string,
): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();

  // `--direct` is the scaffolded-agent / minimal-mode signal: the user has
  // declared "no AI loop, run my tools, nothing else." Injecting runtime
  // builtins (read_file, web_search, recall_memories, etc.) on top of that
  // breaks the principle of least surprise — a freshly scaffolded agent
  // would advertise a memory store it can't serve, a filesystem surface
  // the operator never opted into, and a 12-tool MCP listing where the
  // README's "What you see:" block claims 2.
  //
  // Operator console (`motebit run`, `motebit relay up`) does NOT pass
  // --direct, so this gate has no effect on the operator path.
  // External tools loaded via `--tools <path>` are added by the daemon
  // AFTER this function returns, so the user's tool set is preserved.
  if (config.direct) return registry;

  // Always available (R0/R1): read-only file access, web search, web read
  registry.register(readFileDefinition, createReadFileHandler(config.allowedPaths));

  // Search provider chain: Brave (if API key configured) -> DuckDuckGo fallback
  const braveKey = process.env["BRAVE_SEARCH_API_KEY"];
  let searchProvider: SearchProvider | undefined;
  if (braveKey != null && braveKey !== "") {
    searchProvider = new FallbackSearchProvider([
      new BraveSearchProvider(braveKey),
      new DuckDuckGoSearchProvider(),
    ]);
  }
  registry.register(currentTimeDefinition, createCurrentTimeHandler());
  registry.register(webSearchDefinition, createWebSearchHandler(searchProvider));
  registry.register(readUrlDefinition, createReadUrlHandler());

  // Deferred handlers for memory/events (need runtime, which needs registry)
  const memorySearchFn = async (query: string, limit: number) => {
    if (!runtimeRef.current) return [];
    const queryEmbedding = await embedText(query);
    const nodes = await runtimeRef.current.memory.recallRelevant(queryEmbedding, { limit });
    return nodes.map((n) => ({ content: n.content, confidence: n.confidence }));
  };
  const eventQueryFn = async (limit: number, eventType?: string) => {
    if (!runtimeRef.current) return [];
    const filter: {
      motebit_id: string;
      limit: number;
      event_types?: import("@motebit/sdk").EventType[];
    } = {
      motebit_id: motebitId,
      limit,
    };
    if (eventType != null && eventType !== "") {
      filter.event_types = [eventType as EventType];
    }
    const events = await runtimeRef.current.events.query(filter);
    return events.map((e) => ({
      event_type: e.event_type,
      timestamp: e.timestamp,
      payload: e.payload,
    }));
  };

  registry.register(recallMemoriesDefinition, createRecallMemoriesHandler(memorySearchFn));

  // Layer-3 transcript retrieval — BM25 over conversation history.
  // Complements `recall_memories` (Layer 2, embeddings over memory
  // nodes) and the always-loaded memory index (Layer 1).
  registry.register(
    searchConversationsDefinition,
    createSearchConversationsHandler((query, limit) => {
      if (!runtimeRef.current) return [];
      return runtimeRef.current.searchConversations(query, limit);
    }),
  );

  // Register `rewrite_memory` so the agent can correct a stale entry
  // by the short node id from the Layer-1 memory index. Deps close
  // over runtimeRef so the registration is safe during bootstrap (the
  // runtime exists by the time the tool is invoked). See
  // spec/memory-delta-v1.md §5.8.
  registry.register(
    rewriteMemoryDefinition,
    createRewriteMemoryHandler({
      resolveNodeId: async (shortIdOrUuid) => {
        if (!runtimeRef.current) return { kind: "not_found" };
        return runtimeRef.current.memory.resolveNodeIdPrefix(shortIdOrUuid);
      },
      supersedeMemory: async (nodeId, newContent, reason) => {
        if (!runtimeRef.current) throw new Error("Runtime not initialized");
        return runtimeRef.current.memory.supersedeMemoryByNodeId(nodeId, newContent, reason);
      },
    }),
  );
  registry.register(
    recallSelfDefinition,
    createRecallSelfHandler((query, limit) =>
      Promise.resolve(
        querySelfKnowledge(query, { limit }).map((h) => ({
          source: h.source,
          title: h.title,
          content: h.content,
          score: h.score,
        })),
      ),
    ),
  );
  registry.register(listEventsDefinition, createListEventsHandler(eventQueryFn));
  registry.register(
    selfReflectDefinition,
    createSelfReflectHandler(async () => {
      if (!runtimeRef.current) throw new Error("Runtime not initialized");
      return runtimeRef.current.reflect();
    }),
  );

  // Goal execution tools (create_sub_goal, complete_goal, report_progress) are NOT
  // registered here. They are registered/unregistered by GoalScheduler around each
  // goal run so the model only sees them when they can actually be used.

  // Operator-only (R2+): write files, execute shell commands
  if (config.operator) {
    const writeConfig = { allowedPaths: config.allowedPaths };
    registry.register(writeFileDefinition, createWriteFileHandler(writeConfig));
    registry.register(undoWriteDefinition, createUndoWriteHandler(writeConfig));
    registry.register(
      shellExecDefinition,
      createShellExecHandler({
        commandAllowList: config.allowedCommands,
        commandBlockList: config.blockedCommands,
        allowedPaths: config.allowedPaths,
      }),
    );
  }

  return registry;
}

/**
 * Bridges SqliteConversationStore (camelCase) to ConversationSyncStoreAdapter (snake_case).
 */
export class SqliteConversationSyncStoreAdapter implements ConversationSyncStoreAdapter {
  constructor(private store: MotebitDatabase["conversationStore"]) {}

  getConversationsSince(motebitId: string, since: number): SyncConversation[] {
    return this.store.getConversationsSince(motebitId, since).map((c) => ({
      conversation_id: c.conversationId,
      motebit_id: c.motebitId,
      started_at: c.startedAt,
      last_active_at: c.lastActiveAt,
      title: c.title,
      summary: c.summary,
      message_count: c.messageCount,
    }));
  }

  getMessagesSince(conversationId: string, since: number): SyncConversationMessage[] {
    return this.store.getMessagesSince(conversationId, since).map((m) => ({
      message_id: m.messageId,
      conversation_id: m.conversationId,
      motebit_id: m.motebitId,
      role: m.role,
      content: m.content,
      tool_calls: m.toolCalls,
      tool_call_id: m.toolCallId,
      created_at: m.createdAt,
      token_estimate: m.tokenEstimate,
    }));
  }

  upsertConversation(conv: SyncConversation): void {
    this.store.upsertConversation({
      conversationId: conv.conversation_id,
      motebitId: conv.motebit_id,
      startedAt: conv.started_at,
      lastActiveAt: conv.last_active_at,
      title: conv.title,
      summary: conv.summary,
      messageCount: conv.message_count,
    });
  }

  upsertMessage(msg: SyncConversationMessage): void {
    this.store.upsertMessage({
      messageId: msg.message_id,
      conversationId: msg.conversation_id,
      motebitId: msg.motebit_id,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.tool_calls,
      toolCallId: msg.tool_call_id,
      createdAt: msg.created_at,
      tokenEstimate: msg.token_estimate,
    });
  }
}

export class SqlitePlanSyncStoreAdapter implements PlanSyncStoreAdapter {
  constructor(
    private store: MotebitDatabase["planStore"],
    private motebitId: string,
  ) {}

  getPlansSince(_motebitId: string, since: number): SyncPlan[] {
    const allPlans = this.store.listAllPlans(this.motebitId);
    return allPlans
      .filter((p) => p.updated_at > since)
      .map((p) => ({
        ...p,
        proposal_id: p.proposal_id ?? null,
        collaborative: p.collaborative ? 1 : 0,
      }));
  }

  getStepsSince(_motebitId: string, since: number): SyncPlanStep[] {
    const steps = this.store.listStepsSince(this.motebitId, since);
    return steps.map((s) => ({
      step_id: s.step_id,
      plan_id: s.plan_id,
      motebit_id: this.motebitId,
      ordinal: s.ordinal,
      description: s.description,
      prompt: s.prompt,
      depends_on: JSON.stringify(s.depends_on),
      optional: s.optional,
      status: s.status,
      required_capabilities:
        s.required_capabilities != null ? JSON.stringify(s.required_capabilities) : null,
      delegation_task_id: s.delegation_task_id ?? null,
      assigned_motebit_id: s.assigned_motebit_id ?? null,
      result_summary: s.result_summary,
      error_message: s.error_message,
      tool_calls_made: s.tool_calls_made,
      started_at: s.started_at,
      completed_at: s.completed_at,
      retry_count: s.retry_count,
      updated_at: s.updated_at,
    }));
  }

  upsertPlan(plan: SyncPlan): void {
    const existing = this.store.getPlan(plan.plan_id);
    if (!existing || plan.updated_at >= existing.updated_at) {
      this.store.savePlan({
        ...plan,
        proposal_id: plan.proposal_id ?? undefined,
        collaborative: plan.collaborative === 1,
      });
    }
  }

  upsertStep(step: SyncPlanStep): void {
    const existing = this.store.getStep(step.step_id);
    if (existing) {
      const ORDER: Record<string, number> = {
        pending: 0,
        running: 1,
        completed: 2,
        failed: 2,
        skipped: 2,
      };
      if ((ORDER[step.status] ?? 0) < (ORDER[existing.status] ?? 0)) return;
    }
    this.store.saveStep({
      step_id: step.step_id,
      plan_id: step.plan_id,
      ordinal: step.ordinal,
      description: step.description,
      prompt: step.prompt,
      depends_on:
        typeof step.depends_on === "string" ? (JSON.parse(step.depends_on) as string[]) : [],
      optional: step.optional,
      status: step.status,
      required_capabilities:
        step.required_capabilities != null
          ? (JSON.parse(step.required_capabilities) as PlanStep["required_capabilities"])
          : undefined,
      delegation_task_id: step.delegation_task_id ?? undefined,
      assigned_motebit_id: step.assigned_motebit_id ?? undefined,
      result_summary: step.result_summary,
      error_message: step.error_message,
      tool_calls_made: step.tool_calls_made,
      started_at: step.started_at,
      completed_at: step.completed_at,
      retry_count: step.retry_count,
      updated_at: step.updated_at,
    });
  }
}

/**
 * Derive runtime governance wiring from an optional persisted
 * `GovernanceConfig`. Absent fields fall back to `DEFAULT_GOVERNANCE_CONFIG`,
 * so existing config files without `governance` behave exactly as before.
 *
 * Returns three parallel slices:
 *  - `policyBudget` — feeds `policy.budget` (maxCallsPerTurn)
 *  - `policyApproval` — feeds `policy.maxRiskLevel` / `requireApprovalAbove` /
 *    `denyAbove` via `APPROVAL_PRESET_CONFIGS`
 *  - `memoryGovernance` — feeds `MemoryGovernor` construction
 *
 * This is the single canonical mapping used by all CLI command entry points
 * that construct a `MotebitRuntime` directly from `config.json` (REPL and
 * `motebit delegate --plan`). The `handleRun` / `handleServe` daemon paths
 * derive their policy from the signed identity file instead — this helper
 * fills in the memory-governance + budget slices that the identity file does
 * not carry, so both paths end up with complete governance wiring.
 */
export function deriveGovernanceForRuntime(governance: GovernanceConfig | undefined): {
  policyBudget: { maxCallsPerTurn: number };
  policyApproval: {
    maxRiskLevel: RiskLevel;
    requireApprovalAbove: RiskLevel;
    denyAbove: RiskLevel;
  };
  memoryGovernance: {
    persistenceThreshold: number;
    rejectSecrets: boolean;
    maxMemoriesPerTurn: number;
  };
} {
  const g = governance ?? DEFAULT_GOVERNANCE_CONFIG;
  const preset = APPROVAL_PRESET_CONFIGS[g.approvalPreset] ?? APPROVAL_PRESET_CONFIGS["balanced"]!;
  return {
    policyBudget: { maxCallsPerTurn: g.maxCallsPerTurn },
    policyApproval: {
      maxRiskLevel: preset.maxRiskLevel as RiskLevel,
      requireApprovalAbove: preset.requireApprovalAbove as RiskLevel,
      denyAbove: preset.denyAbove as RiskLevel,
    },
    memoryGovernance: {
      persistenceThreshold: g.persistenceThreshold,
      rejectSecrets: g.rejectSecrets,
      maxMemoriesPerTurn: g.maxMemoriesPerTurn,
    },
  };
}

/**
 * Build the runtime's `SkillSelectorHook` for the Node CLI surface.
 *
 * Per spec/skills-v1.md §7: each turn the runtime invokes
 * `selectForTurn(turn)`. This implementation builds a fresh registry
 * read against `~/.motebit/skills/` (so install/remove/trust mid-session
 * propagate without runtime restart), runs the BM25-ranked selector with
 * platform/sensitivity/HA defaults appropriate to the CLI today, and
 * maps the BSL SkillSelection result to the SkillInjection shape the
 * runtime + ai-core consume.
 *
 * Defaults today: `sessionSensitivity = "none"` (CLI sessions don't
 * elevate yet — phase 4 work), `hardwareAttestationScore = 0` (CLI has
 * no HA). Skills with stricter requirements skip per the selector's
 * standard gates.
 */
function buildCliSkillSelectorHook(): SkillSelectorHook {
  const skillsRoot = path.join(
    process.env["MOTEBIT_CONFIG_DIR"] ?? path.join(require("node:os").homedir(), ".motebit"),
    "skills",
  );
  const platform = mapNodePlatformToSkillPlatform(process.platform);
  return {
    async selectForTurn(turn) {
      // Lazy registry construction: cheap (mkdir + index file ensure-exists),
      // and re-reading per turn means install/trust/remove changes propagate
      // without a runtime restart. The fs adapter's atomic-rename writes mean
      // we never observe a partially-written index.
      const adapter = new NodeFsSkillStorageAdapter({ root: skillsRoot });
      const registry = new SkillRegistry(adapter);
      const records = await registry.list();
      if (records.length === 0) return [];
      const selector = new SkillSelector();
      const result = selector.select(records, {
        turn,
        sessionSensitivity: "none",
        hardwareAttestationScore: 0,
        platform,
      });
      return result.selected.map((s) => ({
        name: s.name,
        version: s.version,
        body: s.body,
        provenance: s.provenance_status,
      }));
    },
  };
}

/** Map Node's `process.platform` to the SkillPlatform union (spec §3.1). */
function mapNodePlatformToSkillPlatform(
  nodePlatform: NodeJS.Platform,
): import("@motebit/sdk").SkillPlatform {
  switch (nodePlatform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      // freebsd / openbsd / sunos / aix etc. — treat as linux for skill
      // gating since their interaction model is closer than to macos/windows.
      // Skills with stricter platform requirements still gate correctly.
      return "linux";
  }
}

export async function createRuntime(
  config: CliConfig,
  motebitId: string,
  toolRegistry: InMemoryToolRegistry,
  mcpServers: McpServerConfig[],
  personalityConfig?: MotebitPersonalityConfig,
  encKey?: Uint8Array,
): Promise<{ runtime: MotebitRuntime; moteDb: MotebitDatabase }> {
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  const provider = createProvider(config, personalityConfig);

  console.log(dim(`Data: ${dbPath}`));
  console.log(dim(`Provider: ${config.provider} (${provider.model})`));
  if (config.operator) {
    console.log("Operator mode: enabled");
  }

  const storage = buildStorageAdapters(moteDb);

  // Governance: if config.json carries a `governance` block, drive
  // PolicyGate budget + approval thresholds + MemoryGovernor from it.
  // Absent → DEFAULT_GOVERNANCE_CONFIG, preserving prior behavior.
  const governance = deriveGovernanceForRuntime(loadFullConfig().governance);

  const runtime = new MotebitRuntime(
    {
      motebitId,
      mcpServers,
      policy: {
        operatorMode: config.operator,
        pathAllowList: config.allowedPaths,
        maxRiskLevel: governance.policyApproval.maxRiskLevel,
        requireApprovalAbove: governance.policyApproval.requireApprovalAbove,
        denyAbove: governance.policyApproval.denyAbove,
        budget: governance.policyBudget,
      },
      memoryGovernance: governance.memoryGovernance,
      taskRouter: PLANNING_TASK_ROUTER,
      skillSelector: buildCliSkillSelectorHook(),
    },
    {
      storage,
      renderer: new NullRenderer(),
      ai: provider,
      tools: toolRegistry,
    },
  );

  // Wire sync — default relay is always available
  const DEFAULT_SYNC_URL = "https://relay.motebit.com";
  const syncUrl =
    config.syncUrl ??
    process.env["MOTEBIT_SYNC_URL"] ??
    loadFullConfig().sync_url ??
    DEFAULT_SYNC_URL;
  // Accept both env var names — they have been aliases for the life of the
  // CLI; see subcommands/_helpers.ts:getRelayAuthHeaders for the canonical
  // fallback order. create-motebit's scaffold writes MOTEBIT_API_TOKEN, so
  // reading only MOTEBIT_SYNC_TOKEN here would silently drop the token on
  // `npm run dev` from a fresh scaffold.
  const syncToken =
    config.syncToken ?? process.env["MOTEBIT_API_TOKEN"] ?? process.env["MOTEBIT_SYNC_TOKEN"];

  const httpAdapter = new HttpEventStoreAdapter({
    baseUrl: syncUrl,
    motebitId,
    authToken: syncToken,
  });
  // Wrap with encryption if key available (zero-knowledge relay)
  const remoteStore = encKey
    ? new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey })
    : httpAdapter;
  runtime.connectSync(remoteStore);
  console.log(dim(`Sync: ${syncUrl}${encKey ? " (encrypted)" : ""}`));

  // Hardware-attestation peer flow — production wiring. Without these
  // two setters the runtime hook in `bumpTrustFromReceipt` is dormant
  // (it gates on `getRemoteHardwareAttestations && updated.public_key`).
  // With them, every successful delegation pulls the worker's
  // self-issued hardware-attestation credential, verifies the embedded
  // claim against the bundled platform adapters, and issues a peer
  // AgentTrustCredential carrying the verified claim — which is what
  // makes the `HW_ATTESTATION_HARDWARE` (1.0) score visible to routing.
  // See `packages/runtime/src/agent-trust.ts:258` for the hook body and
  // `services/relay/src/__tests__/hardware-peer-flow-e2e.test.ts` for the
  // protocol-loop assertion.
  runtime.setHardwareAttestationFetcher(createRelayCapabilitiesFetcher({ baseUrl: syncUrl }));
  runtime.setHardwareAttestationVerifiers(buildHardwareVerifiers());

  return { runtime, moteDb };
}

// Re-export types/values that other modules need
export {
  MotebitRuntime,
  NullRenderer,
  InMemoryToolRegistry,
  HttpEventStoreAdapter,
  EncryptedEventStoreAdapter,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
  openMotebitDatabase,
};
export type { StorageAdapters, MotebitDatabase, StreamingProvider, McpServerConfig };
