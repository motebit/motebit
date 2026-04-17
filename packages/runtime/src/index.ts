import type {
  MotebitState,
  BehaviorCues,
  ConversationMessage,
  ToolRegistry,
  AgentTask,
  ExecutionReceipt,
  AgentTrustRecord,
  GoalExecutionManifest,
  AgentServiceListing,
  PrecisionWeights,
  KeyringAdapter,
} from "@motebit/sdk";
import { EventType, AgentTrustLevel } from "@motebit/sdk";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import {
  MemoryGraph,
  InMemoryMemoryStorage,
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
import { IdentityManager, InMemoryIdentityStorage } from "@motebit/core-identity";
import { PrivacyLayer, InMemoryAuditLog } from "@motebit/privacy-layer";
import type { AuditLogAdapter } from "@motebit/privacy-layer";
import { SyncEngine } from "@motebit/sync-engine";
import type { RenderSpec } from "@motebit/sdk";
import { CANONICAL_SPEC } from "@motebit/render-engine/spec";
import type {
  RenderAdapter,
  RenderFrame,
  InteriorColor,
  AudioReactivity,
} from "@motebit/render-engine/spec";
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
  TaskRouterConfig,
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
import { createSolanaWalletRail } from "@motebit/wallet-solana";
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

import { performReflection } from "./reflection.js";
import type { ReflectionDeps } from "./reflection.js";
import { runHousekeeping } from "./housekeeping.js";
import type { HousekeepingDeps } from "./housekeeping.js";
import type { AgentTrustDeps } from "./agent-trust.js";
import { handleAgentTask as handleAgentTaskFn } from "./agent-task-handler.js";
import type { AgentTaskHandlerDeps } from "./agent-task-handler.js";
export { canonicalJson } from "./execution-ledger.js";
export {
  executeCommand,
  cmdSelfTest,
  COMMAND_DEFINITIONS,
  PlanExecutionVM,
  type CommandResult,
  type RelayConfig,
  type SelfTestConfig,
  type MintToken,
  type PlanSnapshot,
  type PlanEvent,
} from "./commands/index.js";
export {
  ProxySession,
  fetchProxyToken,
  DEFAULT_PROXY_BASE_URL,
  type ProxySessionAdapter,
  type ProxyTokenData,
  type ProxyProviderConfig,
} from "./proxy-session.js";
import type {
  GradientSnapshot,
  GradientStoreAdapter,
  BehavioralStats,
  SelfModelSummary,
} from "./gradient.js";
export type { GradientSnapshot, GradientStoreAdapter } from "./gradient.js";

// Re-export key types for consumers
export type {
  TurnResult,
  AgenticChunk,
  ReflectionResult,
  MotebitLoopDependencies,
} from "@motebit/ai-core";
export type { StreamingProvider } from "@motebit/ai-core";
export type { TaskRouterConfig, TaskType, ResolvedTaskConfig } from "@motebit/ai-core";

/**
 * Default task router config for planning operations.
 * Uses the strongest model for decomposition + reflection — bad plans cascade.
 * Step execution stays on the user's current model (auto-routed per message).
 *
 * Class aliases ("claude-opus") are resolved to current dated versions by the
 * proxy's resolveModelAlias(). When Anthropic ships a new Opus, update the
 * alias table in proxy/validation.ts — every surface gets the upgrade.
 */
export const PLANNING_TASK_ROUTER: TaskRouterConfig = {
  default: { model: "default" },
  overrides: {
    planning: { model: "strongest", temperature: 0.3 },
    plan_reflection: { model: "strongest", temperature: 0.5 },
  },
};
export type {
  MotebitState,
  BehaviorCues,
  ToolRegistry,
  ConversationMessage,
  AgentTrustRecord,
} from "@motebit/sdk";
export { AgentTrustLevel } from "@motebit/sdk";
export type { EventStoreAdapter } from "@motebit/event-log";
export type {
  MemoryStorageAdapter,
  CuriosityTarget,
  MemoryAuditResult,
  PhantomCertainty,
  MemoryConflict,
} from "@motebit/memory-graph";
export type { IdentityStorage } from "@motebit/core-identity";
export type { AuditLogAdapter } from "@motebit/privacy-layer";
export type { DeletionCertificate } from "@motebit/encryption";
export type {
  RenderAdapter,
  RenderFrame,
  InteriorColor,
  AudioReactivity,
} from "@motebit/render-engine/spec";
export type { RenderSpec } from "@motebit/sdk";
export { PolicyGate } from "@motebit/policy";
export type { PolicyConfig, MemoryGovernanceConfig, AuditLogSink } from "@motebit/policy";
export type {
  GoalExecutionManifest,
  ExecutionTimelineEntry,
  ExecutionStepSummary,
  DelegationReceiptSummary,
} from "@motebit/sdk";
export type {
  PlanChunk,
  StepDelegationAdapter,
  CollaborativeDelegationAdapter,
} from "@motebit/planner";
export type { PlanStoreAdapter } from "@motebit/planner";
export { RelayDelegationAdapter } from "@motebit/planner";
export type { RelayDelegationConfig } from "@motebit/planner";
export type { GradientConfig, BehavioralStats, SelfModelSummary } from "./gradient.js";
export {
  computeGradient,
  computePrecision,
  gradientToMarketConfig,
  narrateEconomicConsequences,
  NEUTRAL_PRECISION,
  InMemoryGradientStore,
  summarizeGradientHistory,
  buildPrecisionContext,
} from "./gradient.js";
export { AgentGraphManager } from "./agent-graph.js";
export { InMemoryAgentTrustStore } from "./in-memory-agent-trust-store.js";
export type { RouteWeight } from "./agent-graph.js";

// Sovereign receipt exchange — protocol types, transport interface, and
// an in-memory reference implementation for tests and in-process demos.
// See sovereign-receipt-exchange.ts for the protocol definition.
export type {
  SovereignReceiptRequest,
  SovereignReceiptResponse,
  SovereignReceiptExchangeAdapter,
} from "./sovereign-receipt-exchange.js";
export { InMemoryReceiptExchangeHub } from "./sovereign-receipt-exchange.js";

// HTTP direct receipt exchange — pure peer-to-peer transport, no relay.
// Node-only (server side), fetch-based (client side). See
// http-receipt-exchange.ts for the wire format and usage.
export { createHttpReceiptExchange } from "./http-receipt-exchange.js";
export type { HttpReceiptExchange, HttpReceiptExchangeConfig } from "./http-receipt-exchange.js";

// Relay-mediated receipt exchange — the paved convenience tier,
// paralleling the HTTP direct transport as the sovereign floor.
// Best for NAT-bound, dynamic-IP, or intermittently-online motebits.
// Relay is a dumb pipe per CLAUDE.md "sync is the floor of legitimate
// centralization." See relay-receipt-exchange.ts for the protocol.
export { createRelayReceiptExchange } from "./relay-receipt-exchange.js";
export type { RelayReceiptExchange, RelayReceiptExchangeConfig } from "./relay-receipt-exchange.js";

// Composite receipt exchange — dual-transport routing with automatic
// fallback on transport-level errors, fail-fast on payee-level errors.
// The primitive that makes "HTTP direct first, relay-mediated fallback"
// trivial to configure. See composite-receipt-exchange.ts.
export { createCompositeReceiptExchange } from "./composite-receipt-exchange.js";
export type { CompositeReceiptExchange } from "./composite-receipt-exchange.js";

// === McpServerConfig (inlined to avoid importing Node-only @motebit/mcp-client) ===
// Credential/verifier interfaces imported from @motebit/sdk (canonical source).

export type {
  CredentialRequest,
  CredentialSource,
  VerifierConfigUpdates,
  VerificationResult,
  ServerVerifier,
} from "@motebit/sdk";

import type { CredentialSource, ServerVerifier } from "@motebit/sdk";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** When false (default), all tools from this server require user approval. */
  trusted?: boolean;
  /** Origin of this config entry (e.g. "Claude Desktop", "Claude Code", "VS Code"). */
  source?: string;
  /** Set to true after user confirms spawning a command-based discovered server. */
  spawnApproved?: boolean;
  /** SHA-256 hash of the tool manifest, set on first connect. */
  toolManifestHash?: string;
  /** Tool names from the last pinned manifest, used for diffing on change. */
  pinnedToolNames?: string[];
  /** This server is a motebit — verify identity on connect. */
  motebit?: boolean;
  /** Type of the remote motebit — determines default trust and policy behavior. */
  motebitType?: "personal" | "service" | "collaborative";
  /** Pinned public key hex (set on first verified connect). */
  motebitPublicKey?: string;
  /** Dynamic credential source for non-motebit MCP servers. Takes precedence over authToken. */
  credentialSource?: CredentialSource;
  /** Server verifier run after connect. Fail-closed: verification failure disconnects. */
  serverVerifier?: ServerVerifier;
  /** SHA-256 fingerprint of the server's TLS certificate, pinned on first connect. */
  tlsCertFingerprint?: string;
}

// === Tool Registry ===
// `SimpleToolRegistry` is inlined here so the runtime doesn't take a value
// dep on `@motebit/tools`. The main `@motebit/tools` entry pulls in
// node:child_process / node:fs via the shell-exec / read-file / write-file
// builtins; the `@motebit/tools/web-safe` subpath excludes those. Browser
// surfaces import the web-safe subpath; rather than make runtime import
// either subpath, we keep this minimal in-memory registry inline so runtime
// stays neutral on which subpath the consumer uses.

import type { ToolDefinition, ToolResult, ToolHandler } from "@motebit/sdk";

class SimpleToolRegistry implements ToolRegistry {
  private tools = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

  register(tool: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" already registered`);
    this.tools.set(tool.name, { definition: tool, handler });
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }
  has(name: string): boolean {
    return this.tools.has(name);
  }
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) return { ok: false, error: `Unknown tool: ${name}` };
    try {
      return await entry.handler(args);
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  merge(other: ToolRegistry): void {
    for (const def of other.list()) {
      if (!this.tools.has(def.name)) {
        this.tools.set(def.name, {
          definition: def,
          handler: (args) => other.execute(def.name, args),
        });
      }
    }
  }

  /** Replace the handler for an existing tool, or register if new. */
  replace(tool: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(tool.name, { definition: tool, handler });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get size(): number {
    return this.tools.size;
  }
}

export { SimpleToolRegistry };

// === Platform Adapter Interfaces ===
// Canonical definitions live in @motebit/sdk. Re-exported here for backward compatibility.

export type {
  ConversationStoreAdapter,
  StateSnapshotAdapter,
  KeyringAdapter,
  AgentTrustStoreAdapter,
  ServiceListingStoreAdapter,
  BudgetAllocationStoreAdapter,
  SettlementStoreAdapter,
  LatencyStatsStoreAdapter,
  StorageAdapters,
} from "@motebit/sdk";

import type {
  StorageAdapters,
  StateSnapshotAdapter,
  AgentTrustStoreAdapter,
  ServiceListingStoreAdapter,
  LatencyStatsStoreAdapter,
} from "@motebit/sdk";

export interface PlatformAdapters {
  storage: StorageAdapters;
  renderer: RenderAdapter;
  ai?: StreamingProvider;
  keyring?: KeyringAdapter;
  tools?: ToolRegistry;
}

// === Null Renderer (for CLI / headless) ===

export class NullRenderer implements RenderAdapter {
  init(_target: unknown): Promise<void> {
    return Promise.resolve();
  }
  render(_frame: RenderFrame): void {}
  getSpec(): RenderSpec {
    return CANONICAL_SPEC;
  }
  resize(_w: number, _h: number): void {}
  setBackground(_color: number | null): void {}
  setDarkEnvironment(): void {}
  setLightEnvironment(): void {}
  setInteriorColor(_color: InteriorColor): void {}
  setAudioReactivity(_energy: AudioReactivity | null): void {}
  setTrustMode(_mode: import("@motebit/sdk").TrustMode): void {}
  setListeningIndicator(_active: boolean): void {}
  getCreatureGroup(): unknown {
    return null;
  }
  dispose(): void {}
}

// === Runtime Configuration ===

export interface RuntimeConfig {
  motebitId: string;
  tickRateHz?: number;
  maxConversationHistory?: number;
  /** Compact events when count exceeds this threshold (0 = disabled, default 1000) */
  compactionThreshold?: number;
  /** MCP servers to connect to on init. Tools are discovered and merged into the registry. */
  mcpServers?: McpServerConfig[];
  /** Policy configuration. Controls operator mode, budgets, allow/deny lists. */
  policy?: Partial<PolicyConfig>;
  /** Memory governance config. Controls what gets saved, secret rejection. */
  memoryGovernance?: Partial<MemoryGovernanceConfig>;
  /** Summarize conversation after this many messages (0 = disabled, default 20). */
  summarizeAfterMessages?: number;
  /** Auto-deny pending tool approvals after this many ms (0 = disabled, default 600000 = 10 min). */
  approvalTimeoutMs?: number;
  /** Task router config for routing housekeeping tasks to cheaper/faster models. */
  taskRouter?: TaskRouterConfig;
  /** Enable episodic memory consolidation during housekeeping. Default false. */
  episodicConsolidation?: boolean;
  /** Ed25519 signing keys for issuing verifiable credentials (gradient, trust). */
  signingKeys?: { privateKey: Uint8Array; publicKey: Uint8Array };
  /**
   * Sovereign Solana wallet rail configuration.
   *
   * When set (and `signingKeys` is also set), the runtime derives a
   * `SolanaWalletRail` from the identity private key as a 32-byte Ed25519
   * seed — the Solana address is the identity public key itself, by
   * mathematical accident of curve choice. See `spec/settlement-v1.md` §6.
   *
   * Omit this field to run without any sovereign wallet rail. The runtime
   * still works exactly as before; it just has no Solana wallet exposed.
   */
  solana?: {
    /** Solana RPC endpoint URL (mainnet-beta, devnet, or custom). */
    rpcUrl: string;
    /** USDC SPL mint (base58). Defaults to mainnet USDC inside wallet-solana. */
    usdcMint?: string;
    /** RPC commitment level. Defaults to "confirmed" inside wallet-solana. */
    commitment?: "processed" | "confirmed" | "finalized";
  };
  /**
   * Pre-built sovereign Solana wallet rail. Overrides `solana` when set.
   * Intended for tests (inject a rail with a mocked RPC adapter) and for
   * surface apps that want to control rail construction directly.
   */
  solanaWallet?: import("@motebit/wallet-solana").SolanaWalletRail;
  /**
   * Sovereign receipt exchange transport. When provided, the runtime
   * can request signed receipts from counterparties via
   * `requestSovereignReceipt` and automatically fulfills incoming
   * requests by signing receipts for itself as the payee.
   *
   * The transport is the protocol's rails-plural boundary: the request/
   * response format is singular, but any number of transports may
   * implement it (relay-mediated A2A, direct HTTP callback, WebRTC,
   * in-memory hub for tests). See
   * `packages/runtime/src/sovereign-receipt-exchange.ts` for the
   * protocol definition and the `InMemoryReceiptExchangeHub` reference
   * implementation used by the end-to-end trust-loop test.
   */
  sovereignReceiptExchange?: import("./sovereign-receipt-exchange.js").SovereignReceiptExchangeAdapter;
  /** Optional structured logger. Falls back to console.warn for best-effort diagnostics. */
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

// === Stream Chunk ===

export type StreamChunk =
  | { type: "text"; text: string }
  | {
      type: "tool_status";
      name: string;
      status: "calling" | "done";
      result?: unknown;
      context?: string;
    }
  | {
      type: "approval_request";
      tool_call_id: string;
      name: string;
      args: Record<string, unknown>;
      risk_level?: number;
      quorum?: { required: number; approvers: string[]; collected: string[] };
    }
  | { type: "injection_warning"; tool_name: string; patterns: string[] }
  | { type: "approval_expired"; tool_name: string }
  | { type: "result"; result: TurnResult }
  | { type: "task_result"; receipt: ExecutionReceipt }
  | { type: "delegation_start"; server: string; tool: string; motebit_id?: string }
  | {
      type: "delegation_complete";
      server: string;
      tool: string;
      receipt?: { task_id: string; status: string; tools_used: string[] };
      /**
       * The full signed ExecutionReceipt when the delegated tool was a
       * motebit_task call and the result parsed as a receipt. Carries
       * nested delegation_receipts, public_key, signature — enough to
       * render a receipt bubble and run verifyReceiptChain in-browser
       * without a server roundtrip. The narrower `receipt` summary above
       * is kept for existing consumers.
       */
      full_receipt?: ExecutionReceipt;
    }
  | {
      type: "artifact";
      action: "add" | "remove";
      artifact_id: string;
      kind: "text" | "code" | "plan" | "memory" | "receipt";
      content?: string;
      title?: string;
    }
  | {
      /**
       * Deterministic-path delegation failure. Emitted by
       * `MotebitRuntime.invokeCapability` when the submit-and-poll helper
       * returns `{ok: false}`. The UI maps `code` to its user-visible copy;
       * the runtime never falls back to the AI loop on this signal. See
       * `docs/doctrine/surface-determinism.md`.
       */
      type: "invoke_error";
      code: import("./invoke-capability.js").DelegationErrorCode;
      message: string;
      retryAfterSeconds?: number;
      status?: number;
    };

// === Operator Mode ===
// Canonical implementation in ./operator.ts. Re-exported here.

export type { OperatorModeResult } from "./operator.js";

// === In-Memory Storage Factory ===

export function createInMemoryStorage(): StorageAdapters {
  return {
    eventStore: new InMemoryEventStore(),
    memoryStorage: new InMemoryMemoryStorage(),
    identityStorage: new InMemoryIdentityStorage(),
    auditLog: new InMemoryAuditLog(),
    agentTrustStore: new InMemoryAgentTrustStore(),
  };
}

// === MotebitRuntime ===

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

  constructor(config: RuntimeConfig, adapters: PlatformAdapters) {
    this.motebitId = config.motebitId;
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

    // Core engines
    this.state = new StateVectorEngine({ tick_rate_hz: config.tickRateHz ?? 2 });
    this.behavior = new BehaviorEngine();

    // Data stores
    this.events = new EventStore(adapters.storage.eventStore);
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

    // Plan execution manager
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
  }

  stop(): void {
    if (!this.running) return;
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
    }
  }

  async *sendMessageStreaming(
    text: string,
    runId?: string,
    options?: { delegationScope?: string },
  ): AsyncGenerator<StreamChunk> {
    if (!this.loopDeps) throw new Error("AI not initialized — call setProvider() first");
    if (this._isProcessing) throw new Error("Already processing a message");

    this._isProcessing = true;
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
      });
      // Session info applies only to the first message after resume
      this.conversation.clearSessionInfo();
      yield* this.streaming.processStream(stream, text, runId);
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
      yield* this.streaming.processStream(stream, "", runId, { activationOnly: true });
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
    this.renderer.render({
      cues: this.latestCues,
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

  async housekeeping(): Promise<void> {
    const result = await runHousekeeping(this.housekeepingDeps);
    this.gradientManager.setCuriosityTargets(result.curiosityTargets);
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
        tools: this.toolRegistry.size > 0 ? this.toolRegistry : undefined,
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

  private get trustDeps(): AgentTrustDeps {
    return {
      motebitId: this.motebitId,
      agentTrustStore: this.agentTrustStore,
      events: this.events,
      agentGraph: this.agentGraph,
      signingKeys: this._signingKeys,
      onCredentialIssued: (vc, subjectMotebitId) =>
        this.credentialManager.persistCredential(vc, subjectMotebitId),
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
   * Returns null when no Solana wallet is configured. When present, this
   * address is identical to the base58-encoded Ed25519 identity public
   * key — the same key that signs receipts, credentials, and federation
   * messages. Other motebits and external counterparties can send USDC
   * (or SOL) directly to this address.
   */
  getSolanaAddress(): string | null {
    return this._solanaWallet?.address ?? null;
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

// === Activity Tracking (Ring 1) ===
// Surface-agnostic derivation of what the agent is currently doing, as
// a short label. Every surface that shows "current activity" reads
// through these primitives. See ./activity.ts for the full module.

export { deriveStreamActivity, derivePlanActivity, ActivityTracker } from "./activity.js";
export type { ActivityLabel } from "./activity.js";
