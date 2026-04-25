// === MotebitRuntime ===
//
// The runtime hub. Every capability the interior owns (memory, identity,
// policy, delegation, sovereign payments, presence, planning, consolidation)
// lands on this class. It is deliberately large: consolidating the
// interior behind a single object is the whole point — surfaces hold a
// reference to one motebit and reach capabilities through it, not through
// a loose bag of singletons. Sibling managers (ConversationManager,
// CredentialManager, InvokeCapabilityManager, etc.) own their own state
// and receive runtime callbacks when they need them.

import type {
  MotebitState,
  BehaviorCues,
  ConversationMessage,
  ToolRegistry,
  ToolResult,
  AgentTask,
  ExecutionReceipt,
  AgentTrustRecord,
  GoalExecutionManifest,
  AgentServiceListing,
  PrecisionWeights,
  KeyringAdapter,
  IntentOrigin,
} from "@motebit/sdk";
import { signToolInvocationReceipt, hashToolPayload } from "@motebit/crypto";
import { EventType, AgentTrustLevel } from "@motebit/sdk";
import { EventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import {
  MemoryGraph,
  buildConsolidationPrompt,
  parseConsolidationResponse,
} from "@motebit/memory-graph";
import type {
  ConsolidationProvider,
  CuriosityTarget,
  MemoryAuditResult,
} from "@motebit/memory-graph";
import { auditMemoryGraph } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { IdentityManager } from "@motebit/core-identity";
import { PrivacyLayer } from "@motebit/privacy-layer";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import { assertSpeciesIntegrity } from "@motebit/policy-invariants";
import { SyncEngine } from "@motebit/sync-engine";
import type { RenderAdapter } from "@motebit/render-engine/spec";
import {
  runTurn,
  runTurnStreaming,
  TaskRouter,
  withTaskConfig,
  withStageTimeout,
  STAGE_TIMEOUTS_MS,
  StageTimeoutError,
} from "@motebit/ai-core";
import type {
  StreamingProvider,
  MotebitLoopDependencies,
  TurnResult,
  ReflectionResult,
  TaskType,
} from "@motebit/ai-core";
import { connectMcpServers } from "@motebit/mcp-client";
// `McpClientAdapter` is the structural shape we depend on. It's inlined here
// rather than imported from `@motebit/mcp-client` so the runtime's public
// type surface stays independent of mcp-client's class shape — consumers can
// pass any object that satisfies this interface, including test doubles.
type McpClientAdapter = {
  disconnect(): Promise<void>;
  getAndResetDelegationReceipts?(): import("@motebit/sdk").ExecutionReceipt[];
  isMotebit?: boolean;
  motebitType?: "personal" | "service" | "collaborative";
  serverName?: string;
  getTools?(): import("@motebit/sdk").ToolDefinition[];
};
import { PlanEngine, InMemoryPlanStore } from "@motebit/planner";
import type {
  PlanChunk,
  StepDelegationAdapter,
  CollaborativeDelegationAdapter,
} from "@motebit/planner";
import type { PlanStoreAdapter } from "@motebit/planner";
import type { DeviceCapability } from "@motebit/sdk";
import { PolicyGate, MemoryGovernor } from "@motebit/policy";
import type { PolicyConfig, MemoryGovernanceConfig, AuditLogSink } from "@motebit/policy";
import { createSolanaWalletRail, deriveSolanaAddress } from "@motebit/wallet-solana";
import {
  verifyExecutionReceipt,
  signSovereignPaymentReceipt,
  hexToBytes,
} from "@motebit/encryption";
import { InMemoryGradientStore } from "./gradient.js";
import { InMemoryAgentTrustStore } from "./in-memory-agent-trust-store.js";
import { AgentGraphManager } from "./agent-graph.js";
import { CredentialManager } from "./credential-manager.js";
import { PlanExecutionManager } from "./plan-execution.js";
import { createGoalsEmitter, type GoalsEmitter, type GoalLifecycleStatus } from "./goals.js";
import { createMemoryFormationQueue, type MemoryFormationQueue } from "./memory-formation-queue.js";
import { createIdleTickController, type IdleTickController } from "./idle-tick.js";
import { formMemoriesFromCandidates } from "@motebit/memory-graph";
import { setOperatorMode, setupOperatorPin, resetOperatorPin } from "./operator.js";
import {
  bumpTrustFromReceipt as _bumpTrustFromReceipt,
  recordAgentInteraction as _recordAgentInteraction,
} from "./agent-trust.js";
import { ConversationManager } from "./conversation.js";
import { GradientManager } from "./gradient-manager.js";
import { InteractiveDelegationManager } from "./interactive-delegation.js";
import {
  InvokeCapabilityManager,
  type InvokeCapabilityConfig,
  type InvokeCapabilityOptions,
} from "./invoke-capability.js";
import { StreamingManager } from "./streaming.js";
import type { InteractiveDelegationConfig } from "./interactive-delegation.js";

import { performReflection, runReflectionSafe } from "@motebit/reflection";
import type { ReflectionDeps } from "@motebit/reflection";
// eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional import of the deprecated runHousekeeping; the runtime's own `housekeeping()` method is deprecated in lockstep and both retire together at 1.0.0 when curiosity-target computation joins the consolidation cycle
import { runHousekeeping } from "./housekeeping.js";
import type { HousekeepingDeps } from "./housekeeping.js";
import { PresenceController } from "./presence.js";
import { ScopedToolRegistry } from "./scoped-tool-registry.js";
import {
  createSlabController,
  type SlabController,
  type SlabItemOutcome,
} from "./slab-controller.js";
import { toolPolicy } from "./tool-policy.js";
import {
  runConsolidationCycle,
  type ConsolidationCycleConfig,
  type ConsolidationCycleResult,
} from "./consolidation-cycle.js";
import { signConsolidationReceipt } from "@motebit/crypto";
import { buildMerkleTree, canonicalSha256 } from "@motebit/encryption";
import type { ConsolidationAnchor, ConsolidationReceipt, ChainAnchorSubmitter } from "@motebit/sdk";
import type { AgentTrustDeps } from "./agent-trust.js";
import { handleAgentTask as handleAgentTaskFn } from "./agent-task-handler.js";
import type { AgentTaskHandlerDeps } from "./agent-task-handler.js";
import type {
  GradientSnapshot,
  GradientStoreAdapter,
  BehavioralStats,
  SelfModelSummary,
} from "./gradient.js";
import type {
  StateSnapshotAdapter,
  AgentTrustStoreAdapter,
  ServiceListingStoreAdapter,
  LatencyStatsStoreAdapter,
} from "@motebit/sdk";
import type {
  McpServerConfig,
  PlatformAdapters,
  RuntimeConfig,
  StreamChunk,
} from "./runtime-config.js";
import { SimpleToolRegistry } from "./simple-tool-registry.js";

/** Tools the runtime allows during a tending cycle, regardless of user
 *  config. The proactive scope intersects user opt-in WITH this set, so a
 *  user who allowlists a side-effecting tool by mistake still cannot have
 *  it fire proactively. Memory mutations are always safe (atomic writes,
 *  reversible via tombstone). Surface-output tools are deliberately
 *  excluded. The list is small and known. */
const TENDING_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "form_memory",
  "rewrite_memory",
  "prune_memory",
  "search_conversations",
]);

// Slab-projection policy for tool calls (kind × mode × endState per
// tool name) lives in `./tool-policy.ts`. See that file for the
// doctrine mapping; this module is a consumer.

export class MotebitRuntime {
  readonly motebitId: string;
  readonly state: StateVectorEngine;
  readonly behavior: BehaviorEngine;
  readonly events: EventStore;
  readonly memory: MemoryGraph;
  readonly identity: IdentityManager;
  readonly privacy: PrivacyLayer;
  readonly auditLog: AuditLogAdapter;
  readonly sync: SyncEngine;
  /**
   * Goal-lifecycle emitter — the single authorship site for every
   * `goal_*` event shape pinned by `spec/goal-lifecycle-v1.md`. Surfaces
   * (CLI, desktop, mobile, web) call `runtime.goals.*` instead of
   * constructing payloads inline. See `packages/runtime/src/goals.ts`.
   */
  readonly goals: GoalsEmitter;
  private _goalStatusResolver: ((goalId: string) => GoalLifecycleStatus) | null = null;
  /**
   * Background memory-formation queue. Populated only when
   * `RuntimeConfig.deferMemoryFormation === true`; otherwise inert.
   * Single-lane (graph-state ordering required). See
   * `memory-formation-queue.ts` for the design rationale.
   */
  readonly memoryFormation: MemoryFormationQueue;
  private _deferMemoryFormation: boolean;
  /**
   * Proactive idle-tick scheduler. Non-null only when
   * `RuntimeConfig.proactiveTickMs` was set at construction time.
   * Starts on `runtime.start()`, stops on `runtime.stop()`. See
   * `idle-tick.ts`.
   */
  private _idleTick: IdleTickController | null = null;
  /** Unix ms timestamp of the last user-sent message, or null. */
  private _lastUserMessageAt: number | null = null;
  policy: PolicyGate;
  memoryGovernor: MemoryGovernor;

  private renderer: RenderAdapter;
  private provider: StreamingProvider | null;
  private loopDeps: MotebitLoopDependencies | null = null;
  private conversation: ConversationManager;
  private _isProcessing = false;
  private _isFirstConversation = false;
  private latestCues: BehaviorCues = {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0,
    speaking_activity: 0,
  };
  private stateSnapshot?: StateSnapshotAdapter;
  private compactionThreshold: number;
  private lastKnownClock = 0;
  private running = false;
  private toolRegistry: SimpleToolRegistry;
  /** Presence-scoped view onto `toolRegistry`. Filters tool visibility +
   *  execution when presence ≠ responsive. The AI loop reads this; the
   *  underlying registry is mutated through `toolRegistry` directly. */
  private scopedToolRegistry: ScopedToolRegistry;
  /** Operational mode state machine. Public so surfaces can subscribe. */
  readonly presence: PresenceController;
  /**
   * Slab controller — the "Motebit Computer" lifecycle orchestrator.
   * Projects the runtime's stream / tool-call / plan-step events into
   * typed `SlabItem*` lifecycle events the surface layer can diff and
   * render. Public so the surface startup path can bind it to its
   * render adapter via `bindSlabControllerToRenderer(...)`. See
   * `docs/doctrine/motebit-computer.md`.
   */
  readonly slab: SlabController;
  /** Allowed proactive capability names. Empty by default — fail-closed
   *  sovereign default. User opts in explicitly via runtime config. */
  private _proactiveCapabilities: ReadonlySet<string>;
  /** Auto-anchor policy; null when disabled. Stored by reference so the
   *  submitter can be rotated by the surface without re-constructing the
   *  runtime. */
  private _proactiveAnchor: RuntimeConfig["proactiveAnchor"] | null = null;
  private mcpAdapters: McpClientAdapter[] = [];
  private mcpConfigs: McpServerConfig[];
  /** Maps tool names to motebit server names (only for motebit MCP adapters). */
  private motebitToolServers = new Map<string, string>();
  private interactiveDelegation!: InteractiveDelegationManager;
  /**
   * Deterministic `invokeCapability` primitive — the surface-determinism
   * path. Null until `enableInvokeCapability(config)` is called. Surfaces
   * (chip tap, slash command, scene click, voice opt-in) consume this via
   * `MotebitRuntime.invokeCapability`. See
   * `docs/doctrine/surface-determinism.md`.
   */
  private invokeCapabilityManager: InvokeCapabilityManager | null = null;
  private keyring: KeyringAdapter | null;
  private toolAuditSink?: AuditLogSink;
  private externalToolSources = new Map<string, string[]>();
  private planStore: PlanStoreAdapter;
  private planEngine: PlanEngine;
  private _localCapabilities: DeviceCapability[] = [];
  private taskRouter: TaskRouter | null;
  private streaming!: StreamingManager;
  private episodicConsolidation: boolean;
  private gradientStore: GradientStoreAdapter;
  private gradientManager!: GradientManager;
  private agentTrustStore: AgentTrustStoreAdapter | null;
  private serviceListingStore: ServiceListingStoreAdapter | null;
  private latencyStatsStore: LatencyStatsStoreAdapter | null;
  private agentGraph: AgentGraphManager;
  private _signingKeys: { privateKey: Uint8Array; publicKey: Uint8Array } | null;
  /**
   * Sovereign Solana wallet rail. Null when the runtime has no signing keys
   * or the caller did not configure a Solana rail. When present, exposes
   * the motebit's onchain address, balance, and USDC send capability via
   * `getSolanaAddress`, `getSolanaBalance`, and `sendUsdc`.
   */
  private _solanaWallet: import("@motebit/wallet-solana").SolanaWalletRail | null = null;
  /**
   * Sovereign receipt exchange transport. Null when no transport is
   * configured — in that state, the runtime can still send USDC via
   * the Solana rail, but cannot get a trust-bearing receipt back from
   * the counterparty. Receipts produced via this transport flow into
   * the trust loop the same way relay-mediated receipts do.
   */
  private _receiptExchange:
    | import("./sovereign-receipt-exchange.js").SovereignReceiptExchangeAdapter
    | null = null;
  private credentialManager!: CredentialManager;
  private planExecution!: PlanExecutionManager;
  private approvalStore: import("@motebit/sdk").ApprovalStoreAdapter | null = null;
  private _signingKeysErased = false;
  private _logger: { warn(message: string, context?: Record<string, unknown>): void };
  /**
   * Device ID used on any artifact this runtime signs — ExecutionReceipt,
   * ToolInvocationReceipt, sovereign payment receipt. Defaults to
   * `"runtime-default"` when unset, matching the legacy behavior of the
   * explicit `opts.deviceId` fallback on the agent-task handler.
   */
  private _deviceId: string;
  /**
   * Optional sink for signed per-tool-call receipts. When set, the
   * streaming manager fires this once per matched calling→done pair
   * after composing + signing the receipt. Wired through from
   * `RuntimeConfig.onToolInvocation` at construction time; the
   * slab projection + panels + telemetry subscribe here to populate
   * the per-call audit trail the user sees while the motebit works.
   */
  private _onToolInvocation:
    | ((receipt: import("@motebit/crypto").SignableToolInvocationReceipt) => void)
    | null;
  /**
   * Live activity sink for slab items in virtual_browser mode and
   * any other surface that needs the raw args/result alongside the
   * signed audit trail. Ephemeral by contract — consumers must not
   * persist the payload beyond the call.
   */
  private _onToolActivity: ((event: import("./streaming.js").ToolActivityEvent) => void) | null;

  constructor(config: RuntimeConfig, adapters: PlatformAdapters) {
    // Defense-in-depth: trip the species-constraint tamper detection as
    // early as possible, before any runtime state is constructed. Throws
    // loudly if @motebit/sdk's SPECIES_CONSTRAINTS have been tampered
    // with (runtime mutation, dependency substitution, accidental
    // regression). Companion to the four CI-time tamper tests in
    // @motebit/policy-invariants. See docs/doctrine/security-boundaries.md
    // for the broader tamper-detection pattern.
    assertSpeciesIntegrity();

    this.motebitId = config.motebitId;
    this._deviceId = config.deviceId ?? "runtime-default";
    this._onToolInvocation = config.onToolInvocation ?? null;
    this._onToolActivity = config.onToolActivity ?? null;
    this.compactionThreshold = config.compactionThreshold ?? 1000;
    this.mcpConfigs = config.mcpServers ?? [];
    this.taskRouter = config.taskRouter ? new TaskRouter(config.taskRouter) : null;
    this.episodicConsolidation = config.episodicConsolidation ?? false;
    // Take OWNERSHIP of signingKeys by copying the bytes. The caller lends
    // us their keypair; on `runtime.stop()` we zero our copy without
    // affecting the caller's reference. Sibling of the
    // McpClientAdapter.disconnect() bug fixed on 2026-04-15, where the
    // same lent-buffer-erasure anti-pattern silently broke signature
    // chains in callers that shared the key reference across lifecycles.
    this._signingKeys = config.signingKeys
      ? {
          privateKey: new Uint8Array(config.signingKeys.privateKey),
          publicKey: new Uint8Array(config.signingKeys.publicKey),
        }
      : null;
    // Sovereign Solana wallet rail. The runtime owns at most one instance.
    // Priority: pre-built rail (for tests / custom adapters) > inline config
    // > nothing (sovereign rail disabled). Requires signing keys either way
    // because the rail derives its keypair from the identity seed.
    if (config.solanaWallet) {
      this._solanaWallet = config.solanaWallet;
    } else if (config.solana && this._signingKeys) {
      this._solanaWallet = createSolanaWalletRail({
        rpcUrl: config.solana.rpcUrl,
        identitySeed: this._signingKeys.privateKey,
        usdcMint: config.solana.usdcMint,
        commitment: config.solana.commitment,
      });
    }
    // Sovereign receipt exchange transport. Register an incoming-request
    // handler so this runtime automatically signs receipts when other
    // motebits request them via the same transport. Handler registration
    // happens BEFORE any outbound request can be made, so the payee side
    // is ready the moment the hub has two parties connected.
    if (config.sovereignReceiptExchange) {
      this._receiptExchange = config.sovereignReceiptExchange;
      this._receiptExchange.onIncomingRequest((req) => this.handleSovereignReceiptRequest(req));
    }
    this._logger = config.logger ?? {
      // eslint-disable-next-line no-console -- default logger fallback when no logger is injected
      warn: (msg, ctx) => console.warn(`[motebit] ${msg}`, ctx ? JSON.stringify(ctx) : ""),
    };
    this.renderer = adapters.renderer;
    this.provider = adapters.ai ?? null;
    this.stateSnapshot = adapters.storage.stateSnapshot;
    this.keyring = adapters.keyring ?? null;

    // Tool registry: merge platform-provided tools if any
    this.toolRegistry = new SimpleToolRegistry();
    if (adapters.tools) {
      this.toolRegistry.merge(adapters.tools);
    }

    // Presence: operational state machine. Constructed early so the scoped
    // tool registry can reference it.
    this.presence = new PresenceController({
      onWatchdogFired: (cycleId, phase) => {
        this._logger.warn("presence watchdog fired — forced back to idle", {
          cycle_id: cycleId,
          phase,
        });
      },
    });

    // Proactive scope: intersect user config with runtime-internal allowlist.
    // Memory-mutation tools only — no surface side effects during tending.
    this._proactiveCapabilities = new Set(config.proactiveCapabilities ?? []);
    this._proactiveAnchor = config.proactiveAnchor ?? null;
    this.scopedToolRegistry = new ScopedToolRegistry(this.toolRegistry, {
      allows: (toolName) => {
        const presence = this.presence.get();
        if (presence.mode === "responsive" || presence.mode === "idle") return true;
        // tending: only the user-allowed proactive tools, intersected with
        // the runtime-internal memory-mutation allowlist.
        if (presence.mode === "tending") {
          if (!this._proactiveCapabilities.has(toolName)) return false;
          return TENDING_ALLOWED_TOOLS.has(toolName);
        }
        return false;
      },
    });

    // Core engines
    this.state = new StateVectorEngine({ tick_rate_hz: config.tickRateHz ?? 2 });
    this.behavior = new BehaviorEngine();

    // Data stores
    this.events = new EventStore(adapters.storage.eventStore);
    this.goals = createGoalsEmitter({
      motebitId: this.motebitId,
      events: this.events,
      getGoalStatus: (goalId) => this._goalStatusResolver?.(goalId) ?? null,
      logger: this._logger,
    });
    this._deferMemoryFormation = config.deferMemoryFormation ?? false;
    this.memoryFormation = createMemoryFormationQueue({ logger: this._logger });
    // Slab ("Motebit Computer") lifecycle controller — see
    // docs/doctrine/motebit-computer.md. Surfaces bind this to their
    // render adapter via `bindSlabControllerToRenderer` at startup; the
    // runtime's streaming/tool-call paths (Phase 5b, subsequent commit)
    // project events onto it. Initialized here with the runtime's
    // logger; no additional config today.
    this.slab = createSlabController({ logger: this._logger });
    if (config.proactiveTickMs != null && config.proactiveTickMs > 0) {
      const tickMs = config.proactiveTickMs;
      const quietMs = config.proactiveQuietWindowMs ?? 60_000;
      const action = config.proactiveAction ?? "none";
      this._idleTick = createIdleTickController({
        intervalMs: tickMs,
        quietWindowMs: quietMs,
        isProcessing: () => this._isProcessing,
        lastUserMessageAt: () => this._lastUserMessageAt,
        onTick: async (timestamp) => {
          try {
            await this.events.appendWithClock({
              event_id: crypto.randomUUID(),
              motebit_id: this.motebitId,
              timestamp,
              event_type: EventType.IdleTickFired,
              payload: {
                interval_ms: tickMs,
                quiet_window_ms: quietMs,
                action,
              },
              tombstoned: false,
            });
          } catch {
            // Event-log append is best-effort — a missed tick record
            // does not corrupt state.
          }
          // Perform the configured action AFTER the heartbeat event
          // is logged — so a reflection failure cannot prevent the
          // cadence signal from being recorded. Each action path is
          // best-effort; a throw here is caught by the idle-tick
          // controller's logger.
          if (action === "reflect") {
            // Calls the public `reflect()` directly (not the private
            // reflectAndStore) so a thrown error reaches the
            // idle-tick controller's logger. The `reflect()` method
            // updates gradient state on success; the controller's
            // catch wrapper handles failure as best-effort.
            await this.reflect();
          } else if (action === "consolidate") {
            // Full proactive interior: 4-phase consolidation cycle. The
            // cycle owns presence transitions and tool scoping; idle-tick
            // just kicks it off. Errors caught by the idle-tick controller.
            await this.consolidationCycle();
          }
        },
        logger: this._logger,
      });
    }
    this.memory = new MemoryGraph(adapters.storage.memoryStorage, this.events, this.motebitId);
    this.identity = new IdentityManager(adapters.storage.identityStorage, this.events);
    this.auditLog = adapters.storage.auditLog;
    this.privacy = new PrivacyLayer(
      adapters.storage.memoryStorage,
      this.memory,
      this.events,
      adapters.storage.auditLog,
      this.motebitId,
    );
    this.sync = new SyncEngine(adapters.storage.eventStore, this.motebitId);

    // State -> cue computation
    this.state.subscribe((state: MotebitState) => {
      this.latestCues = this.behavior.compute(state);
    });

    // Policy & memory governance
    this.toolAuditSink = adapters.storage.toolAuditSink;
    this.policy = new PolicyGate(config.policy, this.toolAuditSink);
    this.memoryGovernor = new MemoryGovernor(config.memoryGovernance);

    // Restore saved state
    if (this.stateSnapshot) {
      const saved = this.stateSnapshot.loadState(this.motebitId);
      if (saved != null && saved !== "") {
        this.state.deserialize(saved);
      }
    }

    // Conversation lifecycle
    this.conversation = new ConversationManager({
      motebitId: this.motebitId,
      maxHistory: config.maxConversationHistory ?? 40,
      summarizeAfterMessages: config.summarizeAfterMessages ?? 20,
      store: adapters.storage.conversationStore ?? null,
      getProvider: () => this.provider,
      getTaskRouter: () => this.taskRouter,
      generateCompletion: (prompt, taskType) => this.generateCompletion(prompt, taskType),
    });
    this.conversation.resumeActiveConversation();
    // First conversation: no prior history was loaded from persistence
    this._isFirstConversation = this.conversation.getHistory().length === 0;

    // Plan-execute engine
    this.planStore = adapters.storage.planStore ?? new InMemoryPlanStore();
    this.planEngine = new PlanEngine(this.planStore);
    this.planEngine.setLocalMotebitId(this.motebitId);

    // Intelligence gradient
    this.gradientStore = adapters.storage.gradientStore ?? new InMemoryGradientStore();

    // Agent trust
    this.agentTrustStore = adapters.storage.agentTrustStore ?? new InMemoryAgentTrustStore();

    // Market stores
    this.serviceListingStore = adapters.storage.serviceListingStore ?? null;
    this.latencyStatsStore = adapters.storage.latencyStatsStore ?? null;

    // Credential manager — issuance, persistence, relay submission
    const credentialStore = adapters.storage.credentialStore ?? null;
    this.credentialManager = new CredentialManager({
      motebitId: this.motebitId,
      credentialStore,
      gradientStore: this.gradientStore,
      logger: this._logger,
    });

    // Gradient manager — computation, precision, self-awareness, behavioral stats
    this.gradientManager = new GradientManager({
      motebitId: this.motebitId,
      gradientStore: this.gradientStore,
      memory: this.memory,
      events: this.events,
      state: this.state,
      toolAuditSink: this.toolAuditSink,
      logger: this._logger,
      issueGradientCredential: (priv, pub) =>
        this.credentialManager.issueGradientCredential(priv, pub),
      persistCredential: (vc) =>
        this.credentialManager.persistCredential(
          vc as import("@motebit/encryption").VerifiableCredential<unknown>,
        ),
      getSigningKeys: () => this._signingKeys,
    });
    this.gradientManager.applyStartupBaseline();

    // Approval store — persistence-backed quorum state (source of truth for multi-party approval)
    this.approvalStore = adapters.storage.approvalStore ?? null;

    // Agent graph — algebraic routing substrate
    // The credential store adapter reads from persistent storage (survives restart)
    // with fallback to in-memory credentials for environments without persistence.
    const credentialMgr = this.credentialManager;
    const graphCredentialStore = {
      getCredentialsForSubject: (subjectMotebitId: string) => {
        // Prefer persistent store (has historical credentials across sessions)
        if (credentialStore) {
          const stored = credentialStore.listBySubject(subjectMotebitId);
          return stored
            .filter((sc) => sc.credential_type === "AgentReputationCredential")
            .flatMap((sc) => {
              try {
                const vc = JSON.parse(sc.credential_json) as Record<string, unknown>;
                return [
                  {
                    type: vc.type as string[],
                    issuer: vc.issuer as string,
                    validFrom: vc.validFrom as string | undefined,
                    credentialSubject:
                      vc.credentialSubject as import("@motebit/sdk").ReputationCredentialSubject & {
                        id: string;
                      },
                  },
                ];
              } catch {
                // Malformed credential_json — skip rather than break the entire array
                return [];
              }
            });
        }
        // Fallback: in-memory credentials only
        return credentialMgr
          .getIssuedCredentials()
          .filter(
            (vc) =>
              vc.credentialSubject?.id?.includes(subjectMotebitId) &&
              vc.type.includes("AgentReputationCredential"),
          )
          .map((vc) => ({
            type: vc.type,
            issuer: vc.issuer,
            validFrom: (vc as unknown as Record<string, unknown>).validFrom as string | undefined,
            credentialSubject:
              vc.credentialSubject as import("@motebit/sdk").ReputationCredentialSubject & {
                id: string;
              },
          }));
      },
    };
    this.agentGraph = new AgentGraphManager(
      this.motebitId,
      this.agentTrustStore,
      this.serviceListingStore,
      this.latencyStatsStore,
      graphCredentialStore,
    );

    // Plan execution manager — wires `_logPlanChunkEvent` with the
    // step-state guard that enforces spec/plan-lifecycle-v1 §3.4.
    this.planExecution = new PlanExecutionManager({
      motebitId: this.motebitId,
      planEngine: this.planEngine,
      planStore: this.planStore,
      toolRegistry: this.toolRegistry,
      events: this.events,
      toolAuditSink: this.toolAuditSink,
      logger: this._logger,
      getLoopDeps: () => this.loopDeps,
      getLocalCapabilities: () => this._localCapabilities,
      getTaskRouter: () => this.taskRouter,
    });

    // Interactive delegation — delegate_to_agent tool + receipt stash
    this.interactiveDelegation = new InteractiveDelegationManager({
      motebitId: this.motebitId,
      logger: this._logger,
      toolRegistry: this.toolRegistry,
      motebitToolServers: this.motebitToolServers,
      setCredentialSubmitter: (submitter) => {
        this.credentialManager.credentialSubmitter = submitter;
      },
      bumpTrustFromReceipt: (receipt) => this.bumpTrustFromReceipt(receipt, true),
      wireLoopDeps: () => this.wireLoopDeps(),
    });

    // Streaming & Approval — stream processing, tool approval lifecycle, timeouts
    this.streaming = new StreamingManager({
      pushStateUpdate: (u) => this.state.pushUpdate(u),
      setSpeaking: (a) => this.behavior.setSpeaking(a),
      setDelegating: (a) => this.behavior.setDelegating(a),
      getMotebitToolServers: () => this.motebitToolServers,
      accumulateTurnStats: (r) => this.accumulateTurnStats(r),
      pushExchange: (u, a) => this.conversation.pushExchange(u, a),
      pushActivation: (a) => this.conversation.pushActivation(a),
      injectIntermediateMessages: (am, um) => this.conversation.injectIntermediateMessages(am, um),
      logToolUsed: (n, r) => void this.logToolUsed(n, r),
      getLiveHistory: () => this.conversation.liveHistory,
      getToolRegistry: () => this.toolRegistry,
      sanitizeToolResult: (result, toolName) => {
        if (typeof this.policy.sanitizeAndCheck === "function") {
          const check = this.policy.sanitizeAndCheck(result, toolName);
          return {
            result: check.result,
            injectionDetected: check.injectionDetected,
            injectionPatterns: check.injectionPatterns,
          };
        }
        if (typeof this.policy.sanitizeResult === "function") {
          return { result: this.policy.sanitizeResult(result, toolName) };
        }
        return { result };
      },
      getLoopDeps: () => this.loopDeps,
      getLatestCues: () => this.latestCues,
      getApprovalStore: () => this.approvalStore,
      redactText: (text) => {
        if (typeof this.policy.redact === "function") {
          return this.policy.redact(text);
        }
        return text;
      },
      approvalTimeoutMs: config.approvalTimeoutMs ?? 600_000,
      motebitId: this.motebitId,
      getDeviceId: () => this._deviceId,
      getSigningPrivateKey: () => this._signingKeys?.privateKey ?? null,
      getSigningPublicKey: () => this._signingKeys?.publicKey ?? null,
      onToolInvocation: this._onToolInvocation
        ? (receipt) => this._onToolInvocation?.(receipt)
        : undefined,
      onToolActivity: this._onToolActivity ? (event) => this._onToolActivity?.(event) : undefined,
    });

    this.wireLoopDeps();
  }

  // === Lifecycle ===

  async init(target?: unknown): Promise<void> {
    await this.renderer.init(target);

    // Connect to MCP servers and discover their tools.
    if (this.mcpConfigs.length > 0) {
      this.mcpAdapters = await connectMcpServers(this.mcpConfigs, this.toolRegistry as never);

      // Build motebit tool-to-server mapping for delegation visibility
      for (const adapter of this.mcpAdapters) {
        if (adapter.isMotebit && adapter.serverName && adapter.getTools) {
          const serverName = adapter.serverName;
          for (const tool of adapter.getTools()) {
            this.motebitToolServers.set(tool.name, serverName);
          }
        }
      }

      this.wireLoopDeps(); // re-wire with updated registry
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state.start();
    // Proactive idle-tick starts alongside the state engine when
    // configured. See `RuntimeConfig.proactiveTickMs`.
    this._idleTick?.start();
  }

  stop(): void {
    if (!this.running) return;
    this._idleTick?.stop();
    this.sync.stop();
    this.state.stop();
    // Snapshot synchronously, compact in background
    if (this.stateSnapshot) {
      const clock = this.lastKnownClock;
      this.stateSnapshot.saveState(this.motebitId, this.state.serialize(), clock);
    }
    void this.autoCompact();
    void this.housekeeping();
    // Disconnect MCP servers in background
    void Promise.allSettled(this.mcpAdapters.map((a) => a.disconnect()));
    this.slab.dispose();
    this.renderer.dispose();
    this.clearSigningKeys();
    this.running = false;
  }

  /**
   * Securely erase signing key material from memory.
   * Called automatically on stop(). Safe to call multiple times.
   *
   * Overwrites key bytes with random data then zeros (same as secureErase
   * from @motebit/crypto) before nulling the reference.
   */
  clearSigningKeys(): void {
    if (this._signingKeys && !this._signingKeysErased) {
      // Overwrite with random data then zeros (matches secureErase from @motebit/crypto)
      crypto.getRandomValues(this._signingKeys.privateKey);
      this._signingKeys.privateKey.fill(0);
      crypto.getRandomValues(this._signingKeys.publicKey);
      this._signingKeys.publicKey.fill(0);
      this._signingKeysErased = true;
    }
    this._signingKeys = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  // === AI ===

  get isAIReady(): boolean {
    return this.loopDeps !== null;
  }

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get currentModel(): string | null {
    return this.provider?.model ?? null;
  }

  setModel(model: string): void {
    if (!this.provider) throw new Error("No AI provider configured");
    this.provider.setModel(model);
  }

  setProvider(provider: StreamingProvider): void {
    this.provider = provider;
    this.wireLoopDeps();

    // Restore last reflection from event log — creature wakes with behavioral learning intact
    void this.gradientManager.restoreLastReflection();

    // On session resume with a provider now available, reflect on the previous
    // session in background. The creature digests what happened while it slept.
    // The result is available to buildSelfAwareness() on subsequent turns.
    if (
      this.conversation.getSessionInfo()?.continued &&
      this.conversation.getHistory().length > 0
    ) {
      void this.reflectAndStore();
    }
  }

  /** Access the tool registry to register additional tools at runtime. */
  getToolRegistry(): SimpleToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Execute a local tool directly — the deterministic, LLM-free path
   * for surface affordances that must invoke a specific tool (e.g. a
   * slash command firing `read_url` with a user-supplied URL, a user
   * tap re-running a rested fetch). Mirrors the same activity +
   * signed-receipt hooks the AI loop fires, but with
   * `invocation_origin` defaulting to `"user-tap"` so the audit
   * trail discriminates user-driven invocations from model-mediated
   * ones.
   *
   * Per the surface-determinism doctrine, explicit UI affordances
   * MUST route through a typed capability path, never through a
   * constructed prompt. This method is that path for *local* tools;
   * `invokeCapability` remains the path for relay-delegated capabilities.
   *
   * Returns the tool's `ToolResult` so the caller can react inline
   * (e.g. show a toast on failure). The signed receipt + activity
   * events fire as side effects through the configured sinks.
   */
  async invokeLocalTool(
    name: string,
    args: Record<string, unknown>,
    options: { invocationOrigin?: IntentOrigin } = {},
  ): Promise<ToolResult> {
    const invocationId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `inv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const startedAt = Date.now();

    let result: ToolResult;
    try {
      result = await this.toolRegistry.execute(name, args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: msg };
    }

    const completedAt = Date.now();
    const visibleResult = result.ok ? (result.data ?? null) : (result.error ?? null);

    // Fire the live activity channel first — the slab renders
    // immediately; receipt lands right after.
    if (this._onToolActivity) {
      try {
        this._onToolActivity({
          invocation_id: invocationId,
          task_id: invocationId,
          tool_name: name,
          args,
          result: visibleResult,
          started_at: startedAt,
          completed_at: completedAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this._logger.warn(`[runtime] onToolActivity sink threw: ${msg}`);
      }
    }

    // Sign + fire the receipt. Fail-closed: no signing key → no
    // receipt (consistent with the StreamingManager path).
    if (this._onToolInvocation && this._signingKeys) {
      try {
        const argsHash = await hashToolPayload(args);
        const resultHash = await hashToolPayload(visibleResult);
        const signed = await signToolInvocationReceipt(
          {
            invocation_id: invocationId,
            // Standalone invocation — no enclosing task_id. Use the
            // invocation_id as the task_id so the receipt is still a
            // valid signed artifact.
            task_id: invocationId,
            motebit_id: this.motebitId,
            device_id: this._deviceId,
            tool_name: name,
            started_at: startedAt,
            completed_at: completedAt,
            status: result.ok ? "completed" : "failed",
            args_hash: argsHash,
            result_hash: resultHash,
            invocation_origin: options.invocationOrigin ?? "user-tap",
          },
          this._signingKeys.privateKey,
          this._signingKeys.publicKey,
        );
        try {
          this._onToolInvocation(signed);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this._logger.warn(`[runtime] onToolInvocation sink threw: ${msg}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this._logger.warn(`[runtime] tool-invocation-receipt sign failed: ${msg}`);
      }
    }

    return result;
  }

  /** Access the loop dependencies for direct use by PlanEngine. */
  getLoopDeps(): MotebitLoopDependencies | null {
    return this.loopDeps;
  }

  setLocalCapabilities(caps: DeviceCapability[]): void {
    this._localCapabilities = caps;
    this.planEngine.setLocalCapabilities(caps);
  }

  setDelegationAdapter(adapter: StepDelegationAdapter): void {
    this.planEngine.setDelegationAdapter(adapter);
  }

  /**
   * Create a sovereign delegation adapter for relay-free multi-hop delegation (settlement spec §9.1).
   * Returns null if signing keys or wallet rail are not configured.
   */
  createSovereignDelegationAdapter(
    discoveryUrl: string,
    opts?: {
      deviceId?: string;
      routingStrategy?: "cost" | "quality" | "balanced";
      maxRetries?: number;
      authToken?: string | ((audience?: string) => Promise<string>);
      onDelegationFailure?: (
        step: import("@motebit/sdk").PlanStep,
        attempt: number,
        error: string,
        failedAgentId?: string,
      ) => void;
    },
  ): StepDelegationAdapter | null {
    if (!this._signingKeys || !this._solanaWallet) return null;

    const signingKeys = this._signingKeys;
    const solanaWallet = this._solanaWallet;
    const deviceId = opts?.deviceId ?? "runtime-default";

    const config = {
      discoveryUrl,
      motebitId: this.motebitId,
      deviceId,
      signingKeys,
      walletRail: solanaWallet,
      authToken: opts?.authToken,
      routingStrategy: opts?.routingStrategy,
      maxRetries: opts?.maxRetries,
      onDelegationFailure: opts?.onDelegationFailure,
      createSignedToken: async (
        payload: Omit<import("@motebit/encryption").SignedTokenPayload, "suite">,
        privateKey: Uint8Array,
      ): Promise<string> => {
        // The signer stamps `suite` — callers pass the suite-less shape,
        // matching the inline structural type SovereignDelegationConfig
        // declares (no cryptosuite coupling leaking into planner).
        const { createSignedToken: create } = await import("@motebit/encryption");
        return create(payload, privateKey);
      },
      verifyReceipt: async (
        receipt: import("@motebit/sdk").ExecutionReceipt,
        publicKey: Uint8Array,
      ): Promise<boolean> => {
        return verifyExecutionReceipt(
          receipt as import("@motebit/encryption").SignableReceipt,
          publicKey,
        );
      },
      hexToBytes,
      hash: async (data: Uint8Array): Promise<string> => {
        const { hash: h } = await import("@motebit/encryption");
        return h(data);
      },
    };

    let adapter: StepDelegationAdapter | undefined;
    return {
      async delegateStep(...args) {
        if (!adapter) {
          const mod = await import("@motebit/planner");
          adapter = new mod.SovereignDelegationAdapter(config);
        }
        return adapter.delegateStep(...args);
      },
    };
  }

  setCollaborativeAdapter(adapter: CollaborativeDelegationAdapter | undefined): void {
    this.planEngine.setCollaborativeAdapter(adapter);
  }

  /** Create and execute a plan for a goal prompt. */
  async *executePlan(
    goalId: string,
    goalPrompt: string,
    runId?: string,
    privateKey?: Uint8Array,
  ): AsyncGenerator<PlanChunk> {
    yield* this.planExecution.executePlan(goalId, goalPrompt, runId, privateKey);
  }

  /** Return the execution manifest produced by the last `executePlan()` call. */
  getLastExecutionManifest(): GoalExecutionManifest | null {
    return this.planExecution.getLastExecutionManifest();
  }

  /** Resume an existing plan that was paused (e.g. waiting for approval). */
  async *resumePlan(planId: string, runId?: string): AsyncGenerator<PlanChunk> {
    yield* this.planExecution.resumePlan(planId, runId);
  }

  /** Recover delegated steps that were orphaned (e.g. tab closed during delegation). */
  async *recoverDelegatedSteps(): AsyncGenerator<PlanChunk> {
    if (!this.loopDeps) return;
    yield* this.planExecution.recoverDelegatedSteps(this.loopDeps);
  }

  /** Reconstruct a complete execution manifest for a goal from the event log. */
  async replayGoal(goalId: string, privateKey?: Uint8Array): Promise<GoalExecutionManifest | null> {
    return this.planExecution.replayGoal(goalId, privateKey);
  }

  /**
   * Register a goal-status resolver so the goals primitive can enforce
   * the §3.4 terminal-state convention. Surface apps call this once
   * after wiring their goal store — e.g. the CLI scheduler passes a
   * closure over its `SqliteGoalStore`. Absent a resolver, the goals
   * primitive trusts the caller and emits every event.
   */
  setGoalStatusResolver(resolver: (goalId: string) => GoalLifecycleStatus): void {
    this._goalStatusResolver = resolver;
  }

  get isOperatorMode(): boolean {
    return this.policy.operatorMode;
  }

  private get operatorDeps(): import("./operator.js").OperatorDeps {
    return {
      keyring: this.keyring,
      policy: this.policy,
      onPolicyChanged: () => this.wireLoopDeps(),
    };
  }

  async setOperatorMode(
    enabled: boolean,
    pin?: string,
  ): Promise<import("./operator.js").OperatorModeResult> {
    return setOperatorMode(this.operatorDeps, enabled, pin);
  }

  async setupOperatorPin(pin: string): Promise<void> {
    return setupOperatorPin(this.keyring, pin);
  }

  async resetOperatorPin(): Promise<void> {
    return resetOperatorPin(this.operatorDeps);
  }

  /**
   * Replace the PolicyGate with a new instance built from the given config.
   * Immutable swap — no mutation of the existing PolicyGate.
   */
  updatePolicyConfig(config: Partial<PolicyConfig>): void {
    this.policy = new PolicyGate(config, this.toolAuditSink);
    this.wireLoopDeps();
  }

  /**
   * Replace the MemoryGovernor with a new instance built from the given config.
   * Immutable swap — no mutation of the existing MemoryGovernor.
   */
  updateMemoryGovernance(config: Partial<MemoryGovernanceConfig>): void {
    this.memoryGovernor = new MemoryGovernor(config);
    this.wireLoopDeps();
  }

  /**
   * Register external tools under a source ID (e.g. "mcp:filesystem").
   * Merges tools from the given registry, tracking names for bulk unregister.
   */
  registerExternalTools(sourceId: string, registry: ToolRegistry): void {
    const names: string[] = [];
    for (const def of registry.list()) {
      if (!this.toolRegistry.has(def.name)) {
        this.toolRegistry.register(def, (args) => registry.execute(def.name, args));
        names.push(def.name);
      }
    }
    this.externalToolSources.set(sourceId, names);
    this.wireLoopDeps();
  }

  /**
   * Remove all tools registered under a source ID.
   */
  unregisterExternalTools(sourceId: string): void {
    const names = this.externalToolSources.get(sourceId);
    if (names) {
      for (const name of names) {
        this.toolRegistry.unregister(name);
      }
      this.externalToolSources.delete(sourceId);
      this.wireLoopDeps();
    }
  }

  private async buildAgentContext(): Promise<{
    knownAgents?: AgentTrustRecord[];
    agentCapabilities?: Record<string, string[]>;
  }> {
    const knownAgents = await this.listTrustedAgents();
    if (knownAgents.length === 0) return {};

    let agentCapabilities: Record<string, string[]> | undefined;
    if (this.serviceListingStore) {
      const listings = await this.serviceListingStore.list();
      const capMap: Record<string, string[]> = {};
      for (const listing of listings) {
        if (listing.capabilities.length > 0) {
          capMap[listing.motebit_id] = listing.capabilities;
        }
      }
      if (Object.keys(capMap).length > 0) agentCapabilities = capMap;
    }

    return { knownAgents, agentCapabilities };
  }

  private buildSelfAwareness(): string {
    return this.gradientManager.buildSelfAwareness();
  }

  async sendMessage(text: string, runId?: string): Promise<TurnResult> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
    // Preempt any in-flight consolidation cycle; transition presence to
    // responsive so surfaces stop showing the tending indicator. The cycle
    // sees the abort on its next phase checkpoint and yields.
    this.preemptCycleForUserMessage();
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });

    try {
      const trimmed = this.conversation.trimmed();
      const { knownAgents, agentCapabilities } = await this.buildAgentContext();
      const selfAwareness = this.buildSelfAwareness();
      const result = await runTurn(this.loopDeps, text, {
        conversationHistory: trimmed,
        previousCues: this.latestCues,
        runId,
        sessionInfo: this.conversation.getSessionInfo() ?? undefined,
        curiosityHints: this.gradientManager.buildCuriosityHints(),
        knownAgents,
        agentCapabilities,
        precisionContext: selfAwareness || undefined,
        firstConversation: this._isFirstConversation || undefined,
      });
      this.conversation.pushExchange(text, result.response);
      // First-conversation guidance fades after a few exchanges
      if (this._isFirstConversation && this.conversation.getHistory().length >= 5) {
        this._isFirstConversation = false;
      }
      // Accumulate behavioral stats for the intelligence gradient
      this.accumulateTurnStats(result);
      // Session info applies only to the first message after resume
      this.conversation.clearSessionInfo();
      return result;
    } finally {
      this.state.pushUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
      // Return presence to idle so the next idle-tick can fire. enterIdle
      // is unconditional here — if a cycle is still unwinding, its
      // finally's exitTending will see mode!=tending and no-op.
      this.presence.enterIdle();
    }
  }

  /**
   * Project a turn's chunk stream onto the slab's lifecycle events.
   *
   * Wraps an async chunk stream and yields every chunk unchanged,
   * while side-effecting `this.slab` calls so surfaces see the
   * motebit's work materialize on the liquid-glass plane. See
   * `docs/doctrine/motebit-computer.md` for the item kinds and end
   * states. The method is architected as a projection wrapper rather
   * than inline emission in `sendMessageStreaming` / `generateActivation`
   * because:
   *
   *   - The two callers (user turn, activation turn) have identical
   *     slab semantics — one implementation, two call sites.
   *   - Yielding chunks to the caller is a separate concern from
   *     emitting lifecycle events to the slab. Inlining them coupled
   *     both into a 200-line method at the tagged exploration state;
   *     this wrapper is ~120 lines and lives outside `sendMessageStreaming`
   *     so the streaming method stays readable.
   *   - try/catch/finally around the loop handles all exit paths —
   *     normal completion (`restItem` with final text / default outcome),
   *     failure (`endItem` with failed outcome, rethrows), and any
   *     interrupt surfaces through the same cleanup.
   *
   * Kinds emitted here:
   *
   *   - `stream` — one per turn, opened at entry, updated on every
   *     `text` chunk with accumulated text, ended on exit (rests on
   *     success, dissolves on failure).
   *   - `delegation` — one per `delegation_start` chunk; ended on
   *     the matching `delegation_complete` chunk, with the signed
   *     receipt (if returned) triggering a `detach` to an artifact so
   *     the receipt persists in the scene after the slab item clears.
   *   - `tool_call` — one per `tool_status: "calling"` chunk (unless
   *     the tool is a delegation, in which case the delegation item
   *     owns the lifecycle). Kind + mode + endState come from
   *     `toolPolicy(name)` in `./tool-policy.ts`; a tool with
   *     `endState: "rest"` settles on the slab as an open tab, a tool
   *     with `endState: "dissolve"` ripples away.
   */
  private async *projectSlabForTurn(
    stream: AsyncGenerator<StreamChunk>,
    options: { turnId: string; runId?: string; activationOnly?: boolean },
  ): AsyncGenerator<StreamChunk> {
    const { turnId, runId, activationOnly } = options;
    const basePayload = activationOnly
      ? { text: "", runId, activationOnly: true as const }
      : { text: "", runId };
    this.slab.openItem({ id: turnId, kind: "stream", payload: basePayload });

    let accumulatedText = "";
    let outcome: SlabItemOutcome = { kind: "completed" };
    const toolItemIds = new Map<string, string>();
    const delegationToolNames = new Set<string>();

    try {
      for await (const chunk of stream) {
        if (chunk.type === "text") {
          accumulatedText += chunk.text;
          const updatePayload = activationOnly
            ? { text: accumulatedText, runId, activationOnly: true as const }
            : { text: accumulatedText, runId };
          this.slab.updateItem(turnId, updatePayload);
        } else if (chunk.type === "delegation_start") {
          // Delegation to a peer motebit — doctrine (motebit-computer.md
          // §Hand): "a packet leaves the slab toward a peer, returns as
          // a bead with a signed receipt." Open the delegation-kind
          // item; the matching tool_status: "calling" is skipped so
          // we don't dual-render.
          delegationToolNames.add(chunk.tool);
          const delegationItemId = `slab-delegation-${turnId}-${chunk.tool}-${Date.now()}`;
          toolItemIds.set(chunk.tool, delegationItemId);
          this.slab.openItem({
            id: delegationItemId,
            kind: "delegation",
            payload: {
              server: chunk.server,
              tool: chunk.tool,
              motebit_id: chunk.motebit_id,
              status: "outbound",
            },
          });
        } else if (chunk.type === "delegation_complete") {
          const delegationItemId = toolItemIds.get(chunk.tool);
          if (delegationItemId != null) {
            toolItemIds.delete(chunk.tool);
            delegationToolNames.delete(chunk.tool);
            // A signed receipt is durable — pinch to a receipt artifact
            // in the scene so the proof persists after the slab item
            // clears. Unsigned summaries dissolve; the turn's prose
            // already references the outcome.
            const endOutcome: SlabItemOutcome = chunk.full_receipt
              ? {
                  kind: "completed",
                  result: {
                    server: chunk.server,
                    tool: chunk.tool,
                    receipt: chunk.receipt,
                    full_receipt: chunk.full_receipt,
                  },
                  detachAs: "receipt",
                }
              : {
                  kind: "completed",
                  result: { server: chunk.server, tool: chunk.tool, receipt: chunk.receipt },
                };
            this.slab.endItem(delegationItemId, endOutcome);
          }
        } else if (chunk.type === "tool_status") {
          // Delegations own their own slab item (opened on
          // delegation_start, ended on delegation_complete). Skip the
          // generic tool_call path for them to avoid dual-render.
          if (delegationToolNames.has(chunk.name)) {
            // no-op — delegation slab item handles lifecycle
          } else if (chunk.status === "calling") {
            const toolItemId = `slab-tool-${turnId}-${chunk.name}-${Date.now()}`;
            toolItemIds.set(chunk.name, toolItemId);
            // Single tool-policy lookup drives kind (renderer routing)
            // + mode (embodiment / governance) + endState (set on
            // `done` below). See tool-policy.ts for the registry; it
            // is the one place tool→slab projection is defined.
            const policy = toolPolicy(chunk.name);
            this.slab.openItem({
              id: toolItemId,
              kind: policy.kind,
              mode: policy.mode,
              payload: { name: chunk.name, context: chunk.context, status: "calling" },
            });
          } else if (chunk.status === "done") {
            const toolItemId = toolItemIds.get(chunk.name);
            if (toolItemId != null) {
              toolItemIds.delete(chunk.name);
              // End-state policy: rest = working material the user may
              // consult (tabs open on the slab); dissolve = ephemeral
              // plumbing. Policy comes from the canonical registry.
              // Doctrine: motebit-computer.md §"Three end states."
              const policy = toolPolicy(chunk.name);
              if (policy.endState === "rest" && chunk.result != null) {
                this.slab.restItem(toolItemId, {
                  name: chunk.name,
                  context: chunk.context,
                  status: "done",
                  result: chunk.result,
                });
              } else {
                this.slab.endItem(toolItemId, { kind: "completed", result: chunk.result });
              }
            }
          }
        }
        yield chunk;
      }
    } catch (err: unknown) {
      outcome = { kind: "failed", error: err instanceof Error ? err.message : String(err) };
      throw err;
    } finally {
      // End the slab stream item. On successful completion, the turn's
      // response is durable working material — the user may still be
      // reading it, may want to refer back to it, may want to compare
      // it against the next answer. Doctrine (§"Three end states") puts
      // this in `rest`: it stays on the slab until the user dismisses
      // it or a fresh turn replaces it. Failures and interruptions
      // still dissolve — there's nothing to hold.
      if (outcome.kind === "completed") {
        const restPayload = activationOnly
          ? { text: accumulatedText, runId, activationOnly: true as const }
          : { text: accumulatedText, runId };
        this.slab.restItem(turnId, restPayload);
      } else {
        this.slab.endItem(turnId, outcome);
      }
    }
  }

  async *sendMessageStreaming(
    text: string,
    runId?: string,
    options?: { delegationScope?: string; suppressHistory?: boolean },
  ): AsyncGenerator<StreamChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
    // Preempt any in-flight consolidation cycle; transition presence to
    // responsive so surfaces stop showing the tending indicator. The cycle
    // sees the abort on its next phase checkpoint and yields.
    this.preemptCycleForUserMessage();
    // Record the user-message timestamp for the proactive idle-tick
    // scheduler's quiet-window check (idle-tick.ts). Only set on
    // user-initiated turns — not on `generateActivation`, which is
    // system-triggered and should not reset the quiet window.
    this._lastUserMessageAt = Date.now();
    this.streaming.clearPendingApproval();
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });
    this.behavior.setSpeaking(true);

    // Bounded-time telemetry for every turn. On any throw — stage timeout
    // from the ai-core pipeline, provider error, tool-loop failure — we
    // emit `chat.turn.failed` with stage/duration so a hang in any adapter
    // (persistence, memory graph, embed) becomes a visible, specific error
    // within seconds instead of an untyped "…" forever. See
    // `packages/ai-core/src/core.ts#withStageTimeout`.
    const turnStartedAt = Date.now();

    try {
      const trimmed = this.conversation.trimmed();
      const { knownAgents, agentCapabilities } = await withStageTimeout(
        "build_agent_context",
        STAGE_TIMEOUTS_MS.build_agent_context,
        this.buildAgentContext(),
      );
      const selfAwareness = this.buildSelfAwareness();

      // When background formation is enabled, ensure any prior turn's
      // queued formation has drained before we rebuild the retrieval
      // context — otherwise `recallRelevant` (inside runTurnStreaming)
      // could miss memories that are mid-formation. Cheap: typical
      // human-conversation cadence leaves the queue drained by the
      // time the next message arrives.
      if (this._deferMemoryFormation) {
        await this.memoryFormation.idle();
      }

      const stream = runTurnStreaming(this.loopDeps, text, {
        conversationHistory: trimmed,
        previousCues: this.latestCues,
        runId,
        sessionInfo: this.conversation.getSessionInfo() ?? undefined,
        curiosityHints: this.gradientManager.buildCuriosityHints(),
        knownAgents,
        agentCapabilities,
        precisionContext: selfAwareness || undefined,
        delegationScope: options?.delegationScope,
        firstConversation: this._isFirstConversation || undefined,
        deferMemoryFormation: this._deferMemoryFormation,
      });
      // Session info applies only to the first message after resume
      this.conversation.clearSessionInfo();
      const slabTurnId = `slab-turn-${runId ?? crypto.randomUUID()}`;
      const processed = this.streaming.processStream(
        this._catchDeferredFormationChunks(stream),
        text,
        runId,
        { suppressHistory: options?.suppressHistory === true },
      );
      yield* this.projectSlabForTurn(processed, { turnId: slabTurnId, runId });
      // First-conversation guidance fades after a few exchanges
      if (this._isFirstConversation && this.conversation.getHistory().length >= 5) {
        this._isFirstConversation = false;
      }
    } catch (err: unknown) {
      // Telemetry only — rethrow preserves the UI error path (chat.ts
      // maps labeled errors to user-visible system messages).
      const stage = err instanceof StageTimeoutError ? err.stage : "unknown";
      const errorName = err instanceof Error ? err.name : "Error";
      const errorMessage = err instanceof Error ? err.message : String(err);
      this._logger.warn("chat.turn.failed", {
        stage,
        duration_ms: Date.now() - turnStartedAt,
        motebit_id: this.motebitId,
        error_name: errorName,
        error_message: errorMessage,
        run_id: runId,
      });
      throw err;
    } finally {
      this.behavior.setSpeaking(false);
      this.state.pushUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
      // Return presence to idle so the next idle-tick can fire. enterIdle
      // is unconditional here — if a cycle is still unwinding, its
      // finally's exitTending will see mode!=tending and no-op.
      this.presence.enterIdle();
    }
  }

  /**
   * System-triggered generation with no user message. Used for first-contact
   * activation — the creature speaks first without polluting conversation
   * history with a synthetic user message.
   *
   * The activation prompt is injected as system context, not as user input.
   * Only the assistant's response is recorded in history.
   */
  async *generateActivation(activationPrompt: string, runId?: string): AsyncGenerator<StreamChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
    this.streaming.clearPendingApproval();
    this.state.pushUpdate({ processing: 0.9, attention: 0.8 });
    this.behavior.setSpeaking(true);

    try {
      const stream = runTurnStreaming(this.loopDeps, "", {
        conversationHistory: [],
        previousCues: this.latestCues,
        runId,
        firstConversation: true,
        activationPrompt,
      });
      const slabTurnId = `slab-activation-${runId ?? crypto.randomUUID()}`;
      const processed = this.streaming.processStream(stream, "", runId, { activationOnly: true });
      yield* this.projectSlabForTurn(processed, {
        turnId: slabTurnId,
        runId,
        activationOnly: true,
      });
    } finally {
      this.behavior.setSpeaking(false);
      this.state.pushUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
    }
  }

  /**
   * Handle an externally submitted agent task. Runs in an isolated conversation
   * context, signs the result as an ExecutionReceipt, and yields the receipt.
   */
  async *handleAgentTask(
    task: AgentTask,
    privateKey: Uint8Array,
    deviceId: string,
    publicKey?: Uint8Array,
    options?: { delegatedScope?: string },
  ): AsyncGenerator<StreamChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    yield* handleAgentTaskFn(this.agentTaskDeps, task, privateKey, deviceId, publicKey, options);
  }

  async *resumeAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    yield* this.streaming.resumeAfterApproval(approved);
  }

  get hasPendingApproval(): boolean {
    return this.streaming.hasPendingApproval;
  }

  get pendingApprovalInfo(): {
    toolName: string;
    args: Record<string, unknown>;
    quorum?: { required: number; approvers: string[]; collected: string[] };
  } | null {
    return this.streaming.pendingApprovalInfo;
  }

  async *resolveApprovalVote(approved: boolean, approverId: string): AsyncGenerator<StreamChunk> {
    yield* this.streaming.resolveApprovalVote(approved, approverId);
  }

  onApprovalExpired(cb: () => void): void {
    this.streaming.onApprovalExpired(cb);
  }

  resetConversation(): void {
    // Trigger reflection on previous conversation before clearing (background)
    if (this.provider && this.conversation.getHistory().length > 0) {
      void this.reflectAndStore();
    }
    this.conversation.reset();
  }

  /**
   * Trigger a reflection on the current conversation.
   * The agent reviews its performance, learns insights, and stores them as memories.
   * Returns the reflection result for display (e.g. in the CLI).
   */
  async reflect(goals?: Array<{ description: string; status: string }>): Promise<ReflectionResult> {
    const result = await performReflection(this.reflectionDeps, goals);
    this.gradientManager.setLastReflection(result);
    return result;
  }

  /**
   * Fire reflection in background and capture the result.
   * The result is stored in gradientManager and available to buildSelfAwareness()
   * on subsequent turns — the creature carries forward its behavioral learning.
   */
  private async reflectAndStore(): Promise<void> {
    try {
      const result = await performReflection(this.reflectionDeps);
      this.gradientManager.setLastReflection(result);
    } catch {
      // Reflection is best-effort — don't crash the runtime
    }
  }

  private get reflectionDeps(): ReflectionDeps {
    return {
      motebitId: this.motebitId,
      memory: this.memory,
      events: this.events,
      state: this.state,
      memoryGovernor: this.memoryGovernor,
      getProvider: () => this.provider,
      getTaskRouter: () => this.taskRouter,
      getConversationSummary: () => this.conversation.getStoredSummary(),
      getConversationHistory: () => this.conversation.getHistory(),
    };
  }

  /**
   * Generate a completion from the AI provider without affecting conversation
   * history or state. Useful for housekeeping tasks (title generation,
   * classification, summarization) that should not appear in the chat.
   */
  async generateCompletion(prompt: string, taskType?: TaskType): Promise<string> {
    if (!this.provider) throw new Error("No AI provider configured");

    const contextPack = {
      recent_events: [],
      relevant_memories: [],
      current_state: this.state.getState(),
      user_message: prompt,
    };

    const doGenerate = async (p: import("@motebit/sdk").IntelligenceProvider) =>
      (await p.generate(contextPack)).text;

    let result: string;
    if (taskType && this.taskRouter) {
      result = await withTaskConfig(this.provider, this.taskRouter.resolve(taskType), doGenerate);
    } else {
      result = await doGenerate(this.provider);
    }

    // Audit: log housekeeping run without affecting user-facing state
    void this.logHousekeepingRun(prompt, result);

    return result;
  }

  private async logHousekeepingRun(prompt: string, result: string): Promise<void> {
    try {
      await this.events.appendWithClock({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: Date.now(),
        event_type: EventType.HousekeepingRun,
        payload: {
          prompt_preview: prompt.slice(0, 100),
          result_preview: result.slice(0, 100),
        },
        tombstoned: false,
      });
    } catch {
      // Audit logging is best-effort
    }
  }

  getConversationHistory(): ConversationMessage[] {
    return this.conversation.getHistory();
  }

  getConversationId(): string | null {
    return this.conversation.getId();
  }

  /** Load a specific past conversation by ID, replacing current history. */
  loadConversation(conversationId: string): void {
    this.conversation.load(conversationId);
  }

  /** Delete a conversation and its messages. */
  deleteConversation(conversationId: string): void {
    this.conversation.delete(conversationId);
  }

  /**
   * Heuristic-title every stored conversation whose title is null or
   * empty. Idempotent. Surfaces call this once at startup after their
   * storage preload completes. Returns the count of conversations
   * updated.
   */
  backfillMissingConversationTitles(): number {
    return this.conversation.backfillMissingTitles();
  }

  /**
   * Layer-3 conversation search — lexical BM25 over every persisted
   * user+assistant message for this motebit. Surfaces the raw
   * transcript alongside the Layer-1 memory index and Layer-2
   * embedding recall. See `conversation-search.ts` for the ranking
   * logic.
   */
  searchConversations(query: string, limit = 5) {
    return this.conversation.searchHistory(query, limit);
  }

  /**
   * Resolve when no background memory-formation jobs are pending.
   * Callers outside the runtime (tests, admin tools, shutdown paths)
   * use this to wait for the autoDream-shape queue to drain. The
   * runtime itself awaits this at the top of each new turn when
   * `deferMemoryFormation` is set.
   */
  awaitPendingMemoryFormation(): Promise<void> {
    return this.memoryFormation.idle();
  }

  /**
   * Stream filter: catches `memory_formation_deferred` chunks
   * emitted by `runTurnStreaming` when `deferMemoryFormation` is
   * set, enqueues the formation job onto the single-lane queue, and
   * passes every other chunk through to the downstream consumer. The
   * user sees the final `result` chunk and the turn completes on the
   * UI side; formation runs after the generator returns.
   */
  private async *_catchDeferredFormationChunks(
    source: AsyncIterable<import("@motebit/ai-core").AgenticChunk>,
  ): AsyncGenerator<
    Exclude<import("@motebit/ai-core").AgenticChunk, { type: "memory_formation_deferred" }>
  > {
    for await (const chunk of source) {
      if (chunk.type === "memory_formation_deferred") {
        const candidates = chunk.candidates;
        const relevantMemories = chunk.relevantMemories;
        const memoryGraph = this.memory;
        const consolidationProvider = this.loopDeps?.consolidationProvider;
        this.memoryFormation.enqueue(async () => {
          await formMemoriesFromCandidates(
            { memoryGraph, consolidationProvider },
            candidates,
            relevantMemories,
          );
        });
        // Deferred chunks are internal protocol — never forwarded
        // to the UI / streaming wrapper. Continue consuming.
        continue;
      }
      yield chunk;
    }
  }

  /** List recent conversations (for UI/CLI). */
  listConversations(limit?: number): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> {
    return this.conversation.list(limit);
  }

  /** Generate a title for the current conversation via AI, with heuristic fallback. */
  async autoTitle(): Promise<string | null> {
    return this.conversation.autoTitle();
  }

  /** Manually trigger summarization of the current conversation. */
  async summarizeCurrentConversation(): Promise<string | null> {
    return this.conversation.summarize();
  }

  // === Rendering ===

  renderFrame(deltaTime: number, time: number): void {
    // Presence modulation — subtle visual cue when the motebit is tending
    // to its own interior. "Calm software" doctrine: the user should be
    // able to notice the creature is occupied without being interrupted.
    // Half-closed eye + slightly dimmer glow; no toasts, no bubbles.
    // Responsive + idle: passthrough. See docs/doctrine/proactive-interior.md.
    let cues = this.latestCues;
    if (this.presence.get().mode === "tending") {
      cues = {
        ...cues,
        eye_dilation: Math.min(cues.eye_dilation, 0.5),
        glow_intensity: cues.glow_intensity * 0.85,
      };
    }
    this.renderer.render({
      cues,
      delta_time: deltaTime,
      time,
    });
  }

  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
  }

  // === Observability ===

  getState(): MotebitState {
    return this.state.getState();
  }

  getCues(): BehaviorCues {
    return { ...this.latestCues };
  }

  subscribe(fn: (state: MotebitState) => void): () => void {
    return this.state.subscribe(fn);
  }

  /**
   * Push a partial state update into the state vector.
   * Values are EMA-smoothed by the tick loop — not applied instantly.
   * Use for external signals (presence state, sensor input) that should
   * blend with AI-driven state updates.
   */
  pushStateUpdate(partial: Partial<MotebitState>): void {
    this.state.pushUpdate(partial);
  }

  // === Sync ===

  connectSync(remoteStore: EventStoreAdapter): void {
    this.sync.connectRemote(remoteStore);
  }

  startSync(): void {
    this.sync.start();
  }

  // === Compaction ===

  /**
   * Manually compact the event log, deleting events older than the last snapshot.
   * Returns the number of events deleted.
   */
  async compact(): Promise<number> {
    if (this.compactionThreshold === 0) return 0;

    const eventCount = await this.events.countEvents(this.motebitId);
    if (eventCount < 0 || eventCount < this.compactionThreshold) return 0;

    // Ensure we have a snapshot before compacting
    const clock = await this.events.getLatestClock(this.motebitId);
    if (clock === 0) return 0;

    // Save state snapshot at current clock
    if (this.stateSnapshot) {
      this.stateSnapshot.saveState(this.motebitId, this.state.serialize(), clock);
    }

    // Delete events up to (but not including) the latest clock
    // Keep the most recent event so replay can continue from it
    return this.events.compact(this.motebitId, clock - 1);
  }

  // === Internal ===

  private async autoCompact(): Promise<void> {
    if (this.compactionThreshold <= 0) return;
    try {
      const count = await this.events.countEvents(this.motebitId);
      if (count >= this.compactionThreshold) {
        const clock = await this.events.getLatestClock(this.motebitId);
        if (clock > 0) {
          await this.events.compact(this.motebitId, clock - 1);
        }
      }
    } catch (err: unknown) {
      this._logger.warn("compaction failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * @deprecated since 0.2.0, removed in 1.0.0. Rework the caller — migrate
   * to {@link consolidationCycle} for prune + episodic-consolidation and
   * call `findCuriosityTargets` from `@motebit/memory-graph` directly
   * (then pass the result to `getGradientManager().setCuriosityTargets`)
   * if curiosity-target recomputation is still required.
   *
   * Reason: `housekeeping()` predates the unified four-phase consolidation
   * cycle. The cycle's prune phase supersedes housekeeping's
   * retention/decay/episodic work and the cycle's gather phase
   * supersedes reflection's notability ranking. The one behavior not
   * yet covered by `consolidationCycle()` is curiosity-target
   * computation, which still lives in `runHousekeeping`'s second pass.
   * Unifying curiosity into the cycle is a separate design question
   * (does it belong in gather, or stay a separate signal the
   * gradient manager subscribes to?) — see
   * `docs/doctrine/proactive-interior.md` § "What's deferred". This
   * method retires at 1.0.0 with whatever unification shape lands;
   * the annotation here formalizes the doctrine's existing
   * "deprecated alias" claim and routes the migration through
   * drift-defense #39 rather than PR review.
   */
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional wrapper around the deprecated runHousekeeping; see JSDoc above for the migration path
  async housekeeping(): Promise<void> {
    const result = await runHousekeeping(this.housekeepingDeps);
    this.gradientManager.setCuriosityTargets(result.curiosityTargets);
  }

  /**
   * Run the four-phase consolidation cycle (orient → gather → consolidate
   * → prune). Wraps the cycle in `PresenceController.enterTending` /
   * `exitTending` so surfaces can render the in-flight state and the
   * watchdog catches any phase that ignores its abort signal. Re-entry
   * guarded: returns an empty result when presence is not idle.
   *
   * The runtime owns the cycle's `AbortController`. When a user message
   * arrives mid-cycle, `sendMessage` / `sendMessageStreaming` aborts it
   * so the in-flight phase yields on its next checkpoint and the user's
   * response streams without waiting on consolidation. A caller-provided
   * `config.signal` is honored alongside (cycle aborts on either).
   */
  async consolidationCycle(
    config: ConsolidationCycleConfig = {},
  ): Promise<ConsolidationCycleResult> {
    if (!this.presence.canStartCycle()) {
      const now = Date.now();
      return {
        cycleId: "",
        phasesRun: [],
        phasesYielded: [],
        phasesErrored: [],
        startedAt: now,
        finishedAt: now,
        summary: {},
      };
    }
    const cycleId = config.cycleId ?? crypto.randomUUID();
    let entered = false;
    const internalCtrl = new AbortController();
    this._currentCycleAbortController = internalCtrl;
    // Combine caller signal with our internal one — abort on either.
    let combinedSignal: AbortSignal = internalCtrl.signal;
    let callerOnAbort: (() => void) | null = null;
    if (config.signal) {
      if (config.signal.aborted) {
        internalCtrl.abort(config.signal.reason);
      } else {
        callerOnAbort = () => internalCtrl.abort(config.signal!.reason);
        config.signal.addEventListener("abort", callerOnAbort);
      }
      combinedSignal = internalCtrl.signal;
    }
    try {
      const result = await runConsolidationCycle(
        {
          motebitId: this.motebitId,
          memory: this.memory,
          events: this.events,
          state: this.state,
          memoryGovernor: this.memoryGovernor,
          privacy: this.privacy,
          getProvider: () => this.provider,
          performReflection: () => runReflectionSafe(this.reflectionDeps),
          logger: this._logger,
        },
        {
          ...config,
          cycleId,
          signal: combinedSignal,
          onPhaseStart: (phase, id) => {
            if (!entered) {
              entered = true;
              this.presence.enterTending(id, phase);
            } else {
              this.presence.advancePhase(phase);
            }
            config.onPhaseStart?.(phase, id);
          },
        },
      );
      // Sign + emit a ConsolidationReceipt when signing keys are present
      // and the cycle did meaningful work (at least one phase ran). The
      // receipt is structural-only (counts + ids + timestamps); the
      // privacy boundary is the protocol type. See
      // `docs/doctrine/proactive-interior.md`. Best-effort — a signing
      // or emission failure never throws past the cycle boundary.
      if (this._signingKeys && result.phasesRun.length > 0) {
        await this.signAndEmitConsolidationReceipt(result);
      }
      return result;
    } finally {
      if (config.signal && callerOnAbort) {
        config.signal.removeEventListener("abort", callerOnAbort);
      }
      this._currentCycleAbortController = null;
      if (entered) this.presence.exitTending();
    }
  }

  /** AbortController for the in-flight cycle, or null when idle. The
   *  runtime aborts this from `sendMessage` / `sendMessageStreaming` so
   *  user messages preempt proactive work. */
  private _currentCycleAbortController: AbortController | null = null;

  /**
   * Build a Merkle root over all `ConsolidationReceipt`s that have been
   * signed since the last anchor (or all signed receipts on first call),
   * optionally submit it to a chain via the supplied submitter, and emit
   * a `ConsolidationReceiptsAnchored` event with the resulting
   * `ConsolidationAnchor`.
   *
   * The motebit owns its own anchor cadence — there is no daemon. Call
   * this directly (e.g., from a scheduled job, an idle-tick hook, or a
   * surface affordance like a "publish my work" button). Pending receipt
   * IDs are derived from the event log: every
   * `ConsolidationReceiptSigned` event whose receipt_id has not appeared
   * in a prior `ConsolidationReceiptsAnchored` event is pending.
   *
   * Local-only mode (no submitter): builds the Merkle tree, emits the
   * event with `tx_hash`/`network` undefined. Useful for tests, offline
   * use, and operators who want the commitment without paying for a
   * Solana transaction. The Merkle root is still verifiable by
   * recomputation; it just isn't timestamp-attested onchain.
   *
   * Returns `null` when there are no pending receipts.
   */
  async anchorPendingConsolidationReceipts(
    submitter?: ChainAnchorSubmitter,
  ): Promise<ConsolidationAnchor | null> {
    const signedEvents = await this.events.query({
      motebit_id: this.motebitId,
      event_types: [EventType.ConsolidationReceiptSigned],
    });
    const anchoredEvents = await this.events.query({
      motebit_id: this.motebitId,
      event_types: [EventType.ConsolidationReceiptsAnchored],
    });
    const alreadyAnchored = new Set<string>();
    for (const ev of anchoredEvents) {
      const anchor = (ev.payload as { anchor?: ConsolidationAnchor }).anchor;
      if (anchor) for (const id of anchor.receipt_ids) alreadyAnchored.add(id);
    }
    const pending: ConsolidationReceipt[] = [];
    for (const ev of signedEvents) {
      const receipt = (ev.payload as { receipt?: ConsolidationReceipt }).receipt;
      if (receipt && !alreadyAnchored.has(receipt.receipt_id)) pending.push(receipt);
    }
    if (pending.length === 0) return null;

    // Stable leaf order: the receipt's signed `finished_at` (cycle clock),
    // then `receipt_id` lexicographic as tiebreaker. Lets a verifier
    // reproduce the same Merkle root from the same set of receipts.
    pending.sort((a, b) => {
      if (a.finished_at !== b.finished_at) return a.finished_at - b.finished_at;
      return a.receipt_id.localeCompare(b.receipt_id);
    });

    const leaves: string[] = [];
    for (const r of pending) {
      // Hash the canonical body of the SIGNED receipt — the signature is
      // part of the leaf so the anchor commits to "this exact signed
      // artifact existed," not just "a receipt with these fields could
      // be reconstructed."
      leaves.push(await canonicalSha256(r));
    }
    const tree = await buildMerkleTree(leaves);

    let txHash: string | undefined;
    let network: string | undefined;
    if (submitter) {
      try {
        const result = await submitter.submitMerkleRoot(tree.root, this.motebitId, leaves.length);
        txHash = result.txHash;
        network = submitter.network;
      } catch (err: unknown) {
        // Submitter failure is non-fatal — emit the local anchor anyway.
        // The Merkle root is still useful for offline verification.
        this._logger.warn("consolidation anchor submitter failed — emitting local-only anchor", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const anchor: ConsolidationAnchor = {
      batch_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      merkle_root: tree.root,
      receipt_ids: pending.map((r) => r.receipt_id),
      leaf_count: pending.length,
      anchored_at: Date.now(),
      ...(txHash !== undefined ? { tx_hash: txHash } : {}),
      ...(network !== undefined ? { network } : {}),
    };

    try {
      await this.events.appendWithClock({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: anchor.anchored_at,
        event_type: EventType.ConsolidationReceiptsAnchored,
        payload: { anchor },
        tombstoned: false,
      });
    } catch {
      // Audit emission is best-effort.
    }

    return anchor;
  }

  /**
   * Sign a `ConsolidationReceipt` over the cycle result and emit it as
   * a `ConsolidationReceiptSigned` event. Best-effort — never throws
   * past the cycle boundary. The receipt commits to structural counts
   * only (privacy boundary is the type, not policy: see
   * `@motebit/protocol`'s `ConsolidationReceipt` shape).
   */
  private async signAndEmitConsolidationReceipt(
    cycleResult: ConsolidationCycleResult,
  ): Promise<void> {
    const keys = this._signingKeys;
    if (!keys) return;
    try {
      const unsigned: Omit<ConsolidationReceipt, "signature" | "suite" | "public_key"> = {
        receipt_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        cycle_id: cycleResult.cycleId,
        started_at: cycleResult.startedAt,
        finished_at: cycleResult.finishedAt,
        phases_run: cycleResult.phasesRun,
        phases_yielded: cycleResult.phasesYielded,
        summary: {
          orient_nodes: cycleResult.summary.orientNodes,
          gather_clusters: cycleResult.summary.gatherClusters,
          gather_notable: cycleResult.summary.gatherNotable,
          consolidate_merged: cycleResult.summary.consolidateMerged,
          pruned_decay: cycleResult.summary.prunedDecay,
          pruned_notability: cycleResult.summary.prunedNotability,
          pruned_retention: cycleResult.summary.prunedRetention,
        },
      };
      const signed = await signConsolidationReceipt(unsigned, keys.privateKey, keys.publicKey);
      await this.events.appendWithClock({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: signed.finished_at,
        event_type: EventType.ConsolidationReceiptSigned,
        payload: { receipt: signed },
        tombstoned: false,
      });
    } catch (err: unknown) {
      this._logger.warn("consolidation receipt sign/emit failed", {
        cycle_id: cycleResult.cycleId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Auto-anchor hook — runs independently of the sign-emit success
    // path. A sign failure above should NOT block a policy that would
    // otherwise fire on a prior cycle's receipts.
    await this.maybeAutoAnchor();
  }

  /**
   * If `proactiveAnchor` policy is configured and a trigger is reached,
   * invoke `anchorPendingConsolidationReceipts`. Best-effort — a failure
   * is logged and never thrown. Triggers (OR):
   *   - pending-receipt count ≥ `batchThreshold` (default 8)
   *   - time since last anchor ≥ `minAnchorIntervalMs` (default 0 = off)
   */
  private async maybeAutoAnchor(): Promise<void> {
    const policy = this._proactiveAnchor;
    if (policy == null) return;
    const threshold = policy.batchThreshold ?? 8;
    const intervalMs = policy.minAnchorIntervalMs ?? 0;
    try {
      const [signedEvents, anchoredEvents] = await Promise.all([
        this.events.query({
          motebit_id: this.motebitId,
          event_types: [EventType.ConsolidationReceiptSigned],
        }),
        this.events.query({
          motebit_id: this.motebitId,
          event_types: [EventType.ConsolidationReceiptsAnchored],
        }),
      ]);
      const alreadyAnchored = new Set<string>();
      let lastAnchorAt = 0;
      for (const ev of anchoredEvents) {
        if (ev.timestamp > lastAnchorAt) lastAnchorAt = ev.timestamp;
        const anchor = (ev.payload as { anchor?: ConsolidationAnchor }).anchor;
        if (anchor) for (const id of anchor.receipt_ids) alreadyAnchored.add(id);
      }
      let pendingCount = 0;
      for (const ev of signedEvents) {
        const receipt = (ev.payload as { receipt?: ConsolidationReceipt }).receipt;
        if (receipt && !alreadyAnchored.has(receipt.receipt_id)) pendingCount++;
      }
      if (pendingCount === 0) return;
      const thresholdReached = threshold > 0 && pendingCount >= threshold;
      const timeReached = intervalMs > 0 && Date.now() - lastAnchorAt >= intervalMs;
      if (!thresholdReached && !timeReached) return;
      await this.anchorPendingConsolidationReceipts(policy.submitter);
    } catch (err: unknown) {
      this._logger.warn("auto-anchor failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Called from user-message entry points to preempt an in-flight cycle.
   *  Idempotent — no-op when no cycle is running. */
  private preemptCycleForUserMessage(): void {
    const ctrl = this._currentCycleAbortController;
    if (ctrl != null && !ctrl.signal.aborted) {
      ctrl.abort(new Error("user message arrived"));
    }
    this.presence.enterResponsive();
  }

  private get housekeepingDeps(): HousekeepingDeps {
    return {
      motebitId: this.motebitId,
      memory: this.memory,
      events: this.events,
      state: this.state,
      memoryGovernor: this.memoryGovernor,
      privacy: this.privacy,
      episodicConsolidation: this.episodicConsolidation,
      logger: this._logger,
      getProvider: () => this.provider,
      computeAndStoreGradient: (nodes) =>
        this.gradientManager.computeAndStoreGradient(nodes).then(() => {}),
    };
  }

  // === Curiosity Targets ===

  /** Get curiosity targets computed during last housekeeping cycle. */
  getCuriosityTargets(): CuriosityTarget[] {
    return this.gradientManager.getCuriosityTargets();
  }

  /** Audit the memory graph for integrity issues — phantom certainties, conflicts, near-death nodes. */
  async auditMemory(): Promise<MemoryAuditResult> {
    const { nodes, edges } = await this.memory.exportAll();
    return auditMemoryGraph(nodes, edges);
  }

  // === Intelligence Gradient ===

  /** Get the latest gradient snapshot, or null if none computed yet. */
  getGradient(): GradientSnapshot | null {
    return this.gradientManager.getGradient();
  }

  /** Get current active inference precision weights. */
  getPrecision(): PrecisionWeights {
    return this.gradientManager.getPrecision();
  }

  /** Get gradient history (most recent first). */
  getGradientHistory(limit?: number): GradientSnapshot[] {
    return this.gradientManager.getGradientHistory(limit);
  }

  /** Get gradient-informed market config for delegation routing. Returns undefined if no gradient computed yet. */
  getMarketConfig(): Partial<import("@motebit/sdk").MarketConfig> | undefined {
    return this.gradientManager.getMarketConfig();
  }

  /** Self-model: the agent narrates its own trajectory from gradient history. */
  getGradientSummary(limit = 20): SelfModelSummary {
    return this.gradientManager.getGradientSummary(limit);
  }

  /** Return accumulated behavioral stats and reset the accumulator. */
  getAndResetBehavioralStats(): BehavioralStats {
    return this.gradientManager.getAndResetBehavioralStats();
  }

  /** Return the cached reflection from the last session (or null if none). */
  getLastReflection(): ReflectionResult | null {
    return this.gradientManager.getLastReflection();
  }

  /** Force a gradient computation right now (useful for CLI/debug). */
  async computeGradientNow(): Promise<GradientSnapshot> {
    return this.gradientManager.computeGradientNow();
  }

  /**
   * Accumulate behavioral stats from a turn result and trigger gradient-related
   * side effects (precision refresh, cold-start bootstrap, periodic reflection).
   */
  private accumulateTurnStats(result: TurnResult): void {
    const stats = this.gradientManager.behavioralStats;
    stats.turnCount++;
    stats.totalIterations += result.iterations;
    stats.toolCallsSucceeded += result.toolCallsSucceeded;
    stats.toolCallsBlocked += result.toolCallsBlocked;
    stats.toolCallsFailed += result.toolCallsFailed;
    // Refresh precision weights from latest behavioral stats
    this.gradientManager.recomputePrecisionFromStats();
    // Cold start: bootstrap gradient after first turn if none exists
    if (stats.turnCount === 1 && !this.gradientStore.latest(this.motebitId)) {
      void this.gradientManager.computeGradientNow().catch(() => {});
    }
    // Periodic reflection — every 5th turn, digest in background
    if (stats.turnCount % 5 === 0) {
      void this.reflectAndStore();
    }
  }

  /** Issue a W3C Verifiable Credential containing this agent's current gradient. */
  async issueGradientCredential(privateKey: Uint8Array, publicKey: Uint8Array) {
    return this.credentialManager.issueGradientCredential(privateKey, publicKey);
  }

  /** Return all verifiable credentials issued by this runtime (gradient + trust). */
  getIssuedCredentials() {
    return this.credentialManager.getIssuedCredentials();
  }

  /** Clear the in-memory credential cache (e.g. after persisting or presenting them). */
  clearIssuedCredentials(): void {
    this.credentialManager.clearIssuedCredentials();
  }

  /**
   * Subscribe to credential-set changes. Fires after each credential is
   * persisted (locally issued + forwarded through persistCredential).
   * Returns an unsubscribe function. Used by surfaces rendering credentials
   * as scene objects (satellites) so they don't poll.
   */
  onCredentialsChanged(fn: () => void): () => void {
    return this.credentialManager.onChange(fn);
  }

  private wireLoopDeps(): void {
    if (this.provider) {
      const provider = this.provider;
      const stateEngine = this.state;

      const consolidationProvider: ConsolidationProvider = {
        async classify(newContent, existing) {
          const prompt = buildConsolidationPrompt(newContent, existing);
          const result = await provider.generate({
            recent_events: [],
            relevant_memories: [],
            current_state: stateEngine.getState(),
            user_message: prompt,
          });
          return parseConsolidationResponse(
            result.text,
            existing.map((e) => e.node_id),
          );
        },
      };

      this.loopDeps = {
        motebitId: this.motebitId,
        eventStore: this.events,
        memoryGraph: this.memory,
        stateEngine: this.state,
        behaviorEngine: this.behavior,
        provider: this.provider,
        // Always pass the scoped registry — its predicate is presence-aware
        // and returns full passthrough during responsive/idle turns. Tending
        // turns see only the proactive-allowlisted memory tools.
        tools: this.scopedToolRegistry.size > 0 ? this.scopedToolRegistry : undefined,
        policyGate: this.policy,
        memoryGovernor: this.memoryGovernor,
        consolidationProvider,
      };
    }
  }

  private async logToolUsed(toolName: string, result: unknown): Promise<void> {
    try {
      await this.events.appendWithClock({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: Date.now(),
        event_type: EventType.ToolUsed,
        payload: { tool: toolName, result_summary: String(result).slice(0, 500) },
        tombstoned: false,
      });
    } catch {
      // Tool event logging is best-effort
    }
  }

  // === Agent Trust ===

  /**
   * Bump trust level for a remote motebit based on a verified execution receipt.
   * Trust progression: Unknown → FirstContact (on first interaction) → Verified (after 5+ verified).
   * Never auto-promotes to Trusted — requires explicit owner action.
   */
  private get agentTaskDeps(): AgentTaskHandlerDeps {
    return {
      motebitId: this.motebitId,
      events: this.events,
      agentTrustStore: this.agentTrustStore,
      agentGraph: this.agentGraph,
      latencyStatsStore: this.latencyStatsStore,
      logger: this._logger,
      sendMessageStreaming: (text, runId, options) =>
        this.sendMessageStreaming(text, runId, options),
      saveConversationContext: () => this.conversation.saveContext(),
      clearConversationForTask: () => this.conversation.clearForTask(),
      restoreConversationContext: (ctx) => this.conversation.restoreContext(ctx),
      getMcpAdapters: () => this.mcpAdapters,
      getAndResetInteractiveDelegationReceipts: () =>
        this.getAndResetInteractiveDelegationReceipts(),
      bumpTrustFromReceipt: (receipt, verified) => this.bumpTrustFromReceipt(receipt, verified),
    };
  }

  private _hardwareAttestationFetcher: AgentTrustDeps["getRemoteHardwareAttestations"];

  /**
   * Inject a fetcher for peer-published hardware-attestation credentials.
   * When set, the runtime's `bumpTrustFromReceipt` hook (which fires
   * after every successful delegation interaction) pulls the worker's
   * self-published claim, verifies it, and issues a peer
   * `AgentTrustCredential` carrying the verified claim — Phase 1 of the
   * hardware-attestation peer flow. Surfaces (or tests) inject the
   * fetcher after construction; the production wiring is an HTTP call
   * to `GET /agent/:motebitId/capabilities` on the relay. Best-effort:
   * any failure leaves the existing reputation-credential issuance
   * unchanged.
   */
  setHardwareAttestationFetcher(fetcher: AgentTrustDeps["getRemoteHardwareAttestations"]): void {
    this._hardwareAttestationFetcher = fetcher;
  }

  private _hardwareAttestationVerifiers: AgentTrustDeps["hardwareAttestationVerifiers"];

  /**
   * Inject the platform-specific hardware-attestation verifiers (Phase 2).
   *
   * Without this, only `secure_enclave` (verified in-package via P-256)
   * and the `software` sentinel produce valid outcomes from
   * `verifyHardwareAttestationClaim`. The four "external" platforms —
   * `device_check`, `tpm`, `play_integrity`, `webauthn` — fall through
   * to "verifier not wired" and are dropped before peer-credential
   * issuance.
   *
   * Production wiring: surfaces call
   * `runtime.setHardwareAttestationVerifiers(buildHardwareVerifiers())`
   * from `@motebit/verify` at boot. Tests inject custom verifiers or
   * leave unset to test the in-package paths.
   *
   * `@motebit/verify` is NOT a runtime dep — surfaces own that choice.
   * This setter takes the canonical `HardwareAttestationVerifiers` map
   * from `@motebit/crypto` so any consumer (full bundle, single leaf,
   * custom verifier) can supply it.
   */
  setHardwareAttestationVerifiers(verifiers: AgentTrustDeps["hardwareAttestationVerifiers"]): void {
    this._hardwareAttestationVerifiers = verifiers;
  }

  private get trustDeps(): AgentTrustDeps {
    return {
      motebitId: this.motebitId,
      agentTrustStore: this.agentTrustStore,
      events: this.events,
      agentGraph: this.agentGraph,
      signingKeys: this._signingKeys,
      onCredentialIssued: (vc, subjectMotebitId) =>
        this.credentialManager.persistCredential(vc, subjectMotebitId),
      getRemoteHardwareAttestations: this._hardwareAttestationFetcher,
      hardwareAttestationVerifiers: this._hardwareAttestationVerifiers,
    };
  }

  async bumpTrustFromReceipt(receipt: ExecutionReceipt, verified: boolean): Promise<void> {
    return _bumpTrustFromReceipt(this.trustDeps, receipt, verified);
  }

  async recordAgentInteraction(
    remoteMotebitId: string,
    publicKey?: string,
    motebitType?: string,
  ): Promise<AgentTrustRecord | null> {
    return _recordAgentInteraction(this.trustDeps, remoteMotebitId, publicKey, motebitType);
  }

  /** Get trust record for a specific remote motebit. */
  async getAgentTrust(remoteMotebitId: string): Promise<AgentTrustRecord | null> {
    if (this.agentTrustStore == null) return null;
    return this.agentTrustStore.getAgentTrust(this.motebitId, remoteMotebitId);
  }

  /** List all known agent trust records for this motebit. */
  async listTrustedAgents(): Promise<AgentTrustRecord[]> {
    if (this.agentTrustStore == null) return [];
    return this.agentTrustStore.listAgentTrust(this.motebitId);
  }

  /** Update trust level for a remote motebit. */
  async setAgentTrustLevel(remoteMotebitId: string, level: AgentTrustLevel): Promise<void> {
    if (this.agentTrustStore == null) return;
    await this.agentTrustStore.updateTrustLevel(this.motebitId, remoteMotebitId, level);
    this.agentGraph.invalidate();
  }

  /** Get the agent network graph manager for routing queries. */
  getAgentGraph(): AgentGraphManager {
    return this.agentGraph;
  }

  // ── Sovereign Solana Wallet (motebit/settlement@1.0 §6 default reference impl) ──
  //
  // The runtime exposes the motebit's sovereign wallet as a first-class
  // primitive. The wallet exists by mathematical accident of the Ed25519/
  // Solana curve coincidence — the motebit's identity public key IS a
  // valid Solana address, with no second key, no binding ceremony, and
  // no vendor dependency. See `spec/settlement-v1.md` §3 (foundation
  // law), §6 (default reference implementation), and §7 (sovereign
  // payment receipt format) for the protocol-level semantics.
  //
  // These methods return null when the runtime has no Solana wallet
  // configured (either no signing keys, or no `solana` / `solanaWallet`
  // in RuntimeConfig). Callers can treat absence gracefully: a motebit
  // without a sovereign rail falls back to relay-mediated settlement.

  /**
   * The motebit's sovereign Solana wallet address (base58).
   *
   * The address is `base58(publicKey)` — a pure function of the Ed25519
   * identity public key. It's knowable whenever signing keys are loaded,
   * independent of whether the full Solana rail (RPC-backed balance and
   * send) has been instantiated. Callers that need the deposit
   * destination (Stripe onramp, "Fund sovereign" button, display on the
   * Sovereign panel) get the address even when `config.solana` is
   * unconfigured or RPC init failed — those paths don't need the rail,
   * only the address.
   *
   * Balance queries (`getSolanaBalance`) and transaction signing
   * (`sendUsdc`) still require the rail because they need network access
   * and keypair material.
   *
   * Returns null only when no signing keys are loaded (fresh install, no
   * identity yet, or keystore read failed).
   */
  getSolanaAddress(): string | null {
    if (this._solanaWallet) return this._solanaWallet.address;
    if (this._signingKeys) return deriveSolanaAddress(this._signingKeys.publicKey);
    return null;
  }

  /**
   * USDC balance in micro-units (6 decimals, matching motebit money).
   *
   * Returns null when no Solana wallet is configured. Queries the
   * configured RPC endpoint; best-effort and may throw RPC errors.
   * Missing associated token accounts return 0, not null.
   */
  async getSolanaBalance(): Promise<bigint | null> {
    if (!this._solanaWallet) return null;
    return this._solanaWallet.getBalance();
  }

  /**
   * Send USDC to a counterparty Solana address via the sovereign rail.
   *
   * Returns the transaction signature and confirmation state. Does NOT
   * produce a trust-bearing receipt by itself — sovereign payment
   * receipts are signed by the PAYEE, not the payer, and require a
   * separate receipt-exchange step. See §7 of the settlement spec.
   *
   * Returns null when no Solana wallet is configured. Throws on
   * insufficient balance, invalid counterparty address, or RPC errors
   * (see @motebit/wallet-solana error types).
   */
  async sendUsdc(
    toAddress: string,
    microAmount: bigint,
  ): Promise<import("@motebit/wallet-solana").SendResult | null> {
    if (!this._solanaWallet) return null;
    return this._solanaWallet.send(toAddress, microAmount);
  }

  /**
   * Whether the sovereign Solana rail is reachable right now (best-
   * effort RPC health probe). Returns null when no wallet is configured.
   */
  async isSolanaAvailable(): Promise<boolean | null> {
    if (!this._solanaWallet) return null;
    return this._solanaWallet.isAvailable();
  }

  // ── Sovereign Receipt Exchange (motebit/settlement@1.0 §7) ─────────
  //
  // The receipt exchange closes the last gap in the single-hop sovereign
  // loop. After the payer sends USDC via `sendUsdc`, it calls
  // `requestSovereignReceipt` to ask the payee for a signed
  // SovereignPaymentReceipt. The runtime verifies the signature, feeds
  // the receipt into `bumpTrustFromReceipt`, and returns the verified
  // receipt to the caller. Zero relay involvement at any step.
  //
  // The transport is pluggable — any adapter implementing
  // `SovereignReceiptExchangeAdapter` works. See
  // `sovereign-receipt-exchange.ts` for the protocol definition and
  // the `InMemoryReceiptExchangeHub` reference used by tests.

  /**
   * Request a signed SovereignPaymentReceipt from a counterparty after
   * paying them via the sovereign rail. The payer constructs the
   * request (including the `tx_hash` returned by `sendUsdc`), calls
   * this method, and receives a verified receipt once the payee signs.
   *
   * On success:
   *   - The response's signature is verified against the embedded
   *     public key via `verifyExecutionReceipt`.
   *   - The verified receipt is fed into `bumpTrustFromReceipt` so the
   *     payer's local trust store reflects the interaction.
   *   - The verified receipt is returned to the caller for further use
   *     (logging, UI display, audit).
   *
   * Throws when:
   *   - No receipt exchange transport is configured
   *   - The payee returns an error response
   *   - The returned receipt's signature fails verification
   *   - The `public_key` field is missing or malformed
   *
   * This method intentionally does NOT verify the underlying onchain
   * payment. An optional verifier adapter can add that check before
   * the trust update; see extension points in settlement-v1.md §11.
   */
  async requestSovereignReceipt(
    payeeMotebitId: string,
    request: Omit<
      import("./sovereign-receipt-exchange.js").SovereignReceiptRequest,
      "payer_motebit_id" | "payer_device_id"
    > & { payer_device_id?: string },
  ): Promise<ExecutionReceipt> {
    if (!this._receiptExchange) {
      throw new Error("Sovereign receipt exchange transport not configured on this runtime.");
    }

    const fullRequest: import("./sovereign-receipt-exchange.js").SovereignReceiptRequest = {
      ...request,
      payer_motebit_id: this.motebitId,
      payer_device_id: request.payer_device_id ?? "runtime-default",
    };

    const response = await this._receiptExchange.request(payeeMotebitId, fullRequest);

    if (response.error) {
      throw new Error(
        `Sovereign receipt exchange failed [${response.error.code}]: ${response.error.message}`,
      );
    }
    if (!response.receipt) {
      throw new Error("Sovereign receipt exchange returned neither a receipt nor an error.");
    }

    // Verify the signature using the embedded public key. No relay
    // lookup, no registry, no third-party trust — the receipt is
    // self-verifiable per settlement-v1.md §3.2.
    const receipt = response.receipt;
    if (!receipt.public_key) {
      throw new Error("Sovereign receipt is missing the payee's public_key field.");
    }
    const pubKeyBytes = hexToBytes(receipt.public_key);
    const valid = await verifyExecutionReceipt(receipt, pubKeyBytes);
    if (!valid) {
      throw new Error("Sovereign receipt signature verification failed — rejecting.");
    }

    // Feed into the trust loop. The payee's motebit_id is the subject
    // of the trust update; the payer (this runtime) is the observer.
    await this.bumpTrustFromReceipt(receipt, true);

    return receipt;
  }

  /**
   * Handle an incoming sovereign receipt request from another motebit.
   * Called by the receipt exchange transport when this runtime is the
   * payee. The runtime verifies the request is addressed to us,
   * constructs a SovereignPaymentReceipt from the request data, signs
   * it with the identity key, and returns it in the response.
   *
   * Returns an `error` response when:
   *   - The runtime has no signing keys (can't sign a receipt)
   *   - The request's `payee_motebit_id` doesn't match us
   *   - The request's `payee_address` doesn't match our Solana wallet
   *     address (when we have one)
   *
   * This method does NOT verify the underlying onchain payment. The
   * caller (transport / verifier adapter) is responsible for any
   * onchain cross-check before invoking this handler.
   */
  private async handleSovereignReceiptRequest(
    request: import("./sovereign-receipt-exchange.js").SovereignReceiptRequest,
  ): Promise<import("./sovereign-receipt-exchange.js").SovereignReceiptResponse> {
    if (!this._signingKeys) {
      return {
        error: {
          code: "unknown",
          message: "No signing keys configured on this runtime",
        },
      };
    }

    if (request.payee_motebit_id !== this.motebitId) {
      return {
        error: {
          code: "address_mismatch",
          message: `Request addressed to ${request.payee_motebit_id}, but this motebit is ${this.motebitId}`,
        },
      };
    }

    // When we have a Solana wallet, cross-check that the payee_address
    // in the request matches our own address. This prevents a confused
    // deputy where someone tricks us into signing for a payment that
    // landed somewhere else.
    const ownAddress = this.getSolanaAddress();
    if (ownAddress && request.payee_address !== ownAddress) {
      return {
        error: {
          code: "address_mismatch",
          message: `Request payee_address ${request.payee_address} does not match our wallet ${ownAddress}`,
        },
      };
    }

    try {
      const receipt = await signSovereignPaymentReceipt(
        {
          payee_motebit_id: this.motebitId,
          payee_device_id: "runtime-default",
          payer_motebit_id: request.payer_motebit_id,
          rail: request.rail,
          tx_hash: request.tx_hash,
          amount_micro: request.amount_micro,
          asset: request.asset,
          service_description: request.service_description,
          prompt_hash: request.prompt_hash,
          result_hash: request.result_hash,
          tools_used: request.tools_used,
          submitted_at: request.submitted_at,
          completed_at: request.completed_at,
        },
        this._signingKeys.privateKey,
        this._signingKeys.publicKey,
      );
      return { receipt };
    } catch (err: unknown) {
      return {
        error: {
          code: "unknown",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /** Register or update this agent's service listing. */
  async registerServiceListing(
    listing: Omit<AgentServiceListing, "listing_id" | "updated_at">,
  ): Promise<void> {
    if (this.serviceListingStore == null) return;
    const full: AgentServiceListing = {
      ...listing,
      listing_id: `ls-${crypto.randomUUID()}` as import("@motebit/sdk").ListingId,
      updated_at: Date.now(),
    };
    await this.serviceListingStore.set(full);
  }

  /** Get this agent's service listing. */
  async getServiceListing(): Promise<AgentServiceListing | null> {
    if (this.serviceListingStore == null) return null;
    return this.serviceListingStore.get(this.motebitId);
  }

  /**
   * Enable interactive delegation: registers a `delegate_to_agent` tool so the
   * AI can transparently delegate tasks to remote agents during normal conversation.
   *
   * The tool submits tasks to the relay via REST, polls for results, bumps trust
   * on verified receipts, and returns the result as normal tool output.
   */
  enableInteractiveDelegation(config: InteractiveDelegationConfig): void {
    this.interactiveDelegation.enable(config);
  }

  /**
   * Drain interactive delegation receipts (used by handleAgentTask to include
   * in the parent receipt's delegation_receipts array).
   */
  getAndResetInteractiveDelegationReceipts(): ExecutionReceipt[] {
    return this.interactiveDelegation.getAndResetReceipts();
  }

  /**
   * Enable the `invokeCapability` primitive — the deterministic
   * surface-affordance → delegation path. Idempotent. Shares the same relay
   * coordinates as `enableInteractiveDelegation`; typical usage is to call
   * both with the same config so AI-loop and user-tap paths route through
   * the same relay.
   */
  enableInvokeCapability(config: InvokeCapabilityConfig): void {
    if (this.invokeCapabilityManager != null) return;
    this.invokeCapabilityManager = new InvokeCapabilityManager(
      {
        motebitId: this.motebitId,
        logger: this._logger,
        bumpTrustFromReceipt: (receipt) => this.bumpTrustFromReceipt(receipt, true),
        // Shares the interactive-delegation stash so a concurrent AI loop
        // drains user-tap receipts into its parent receipt's delegation_receipts
        // chain — composition preserved.
        stashReceipt: (receipt) => this.interactiveDelegation.pushReceipt(receipt),
      },
      config,
    );
  }

  /**
   * Invoke a named capability directly, bypassing the AI loop entirely. The
   * surface-determinism primitive: a chip, button, slash command, or scene
   * click MUST use this (never `sendMessageStreaming` with a constructed
   * prompt). See `docs/doctrine/surface-determinism.md`.
   *
   * Throws if `enableInvokeCapability` has not been called — the relay
   * coordinates must be configured before any affordance can fire.
   */
  async *invokeCapability(
    capability: string,
    prompt: string,
    options?: InvokeCapabilityOptions,
  ): AsyncGenerator<StreamChunk> {
    if (this.invokeCapabilityManager == null) {
      // Wiring-not-done is a user-visible condition in practice (first-run
      // state, signed-out device, cleared storage). Surface through the same
      // `invoke_error` taxonomy every other failure uses so the chat layer's
      // `failureCopy` renders a Motebit-native remediation instead of the
      // chat handler's catch block leaking the raw developer message.
      yield {
        type: "invoke_error",
        code: "sync_not_enabled",
        message: "invokeCapability has not been enabled on this runtime",
      };
      return;
    }
    yield* this.invokeCapabilityManager.invokeCapability(capability, prompt, options);
  }
}
