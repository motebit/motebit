// Barrel for `@motebit/runtime`.
//
// Per root CLAUDE.md Conventions: "Export from `src/index.ts`". The class,
// config types, renderer, and tool registry each live in their own source
// file (one-class-per-file). This file re-exports them in the same order
// and shape the package has published since extraction began — any change
// visible through this barrel is a public-API event.

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

export { PLANNING_TASK_ROUTER } from "./runtime-config.js";

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
export { createGoalsEmitter } from "./goals.js";
export type { GoalsEmitter, GoalsEmitterDeps, GoalLifecycleStatus } from "./goals.js";

export { createComputerSessionManager, ComputerDispatcherError } from "./computer-use.js";
export type {
  ComputerSessionManager,
  ComputerSessionManagerDeps,
  ComputerSessionHandle,
  ComputerActionOutcome,
  ComputerDisplayInfo,
  ComputerPlatformDispatcher,
  ComputerGovernanceClassifier,
  ComputerApprovalFlow,
} from "./computer-use.js";

export { InMemoryAgentTrustStore } from "./in-memory-agent-trust-store.js";
export type { RouteWeight } from "./agent-graph.js";

// Hardware-attestation peer flow — production fetcher for the runtime's
// `setHardwareAttestationFetcher` slot. Surfaces wire it once at runtime
// construction; without it, the peer-credential issuance hook is
// dormant. See `hardware-attestation-fetcher.ts` for the contract.
export {
  createRelayCapabilitiesFetcher,
  type RelayCapabilitiesFetcherConfig,
} from "./hardware-attestation-fetcher.js";
export type { HardwareAttestationFetcher } from "./agent-trust.js";

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

export type { McpServerConfig } from "./runtime-config.js";

// === Tool Registry ===
// `SimpleToolRegistry` lives in `./simple-tool-registry.js`. Re-exported so
// runtime consumers (desktop MCP manager, tests) keep a single import site.
export { SimpleToolRegistry } from "./simple-tool-registry.js";

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

export type { PlatformAdapters } from "./runtime-config.js";

// === Null Renderer (for CLI / headless) ===

export { NullRenderer } from "./null-renderer.js";

// === Runtime Configuration ===

export type { RuntimeConfig } from "./runtime-config.js";

// === Stream Chunk ===

export type { StreamChunk } from "./runtime-config.js";
export type { ToolActivityEvent } from "./streaming.js";

// === Operator Mode ===
// Canonical implementation in ./operator.ts. Re-exported here.

export type { OperatorModeResult } from "./operator.js";

// === In-Memory Storage Factory ===

export { createInMemoryStorage } from "./in-memory-storage.js";

// === MotebitRuntime ===

export {
  MotebitRuntime,
  SovereignTierRequiredError,
  DropTargetGovernanceRequiredError,
} from "./motebit-runtime.js";

// === Activity Tracking (Ring 1) ===
// Surface-agnostic derivation of what the agent is currently doing, as
// a short label. Every surface that shows "current activity" reads
// through these primitives. See ./activity.ts for the full module.

export { deriveStreamActivity, derivePlanActivity, ActivityTracker } from "./activity.js";
export type { ActivityLabel } from "./activity.js";
export { resolveProactiveAnchor } from "./proactive-anchor.js";
export type { ResolveProactiveAnchorArgs } from "./proactive-anchor.js";

// Slab ("Motebit Computer") — controller + bridge. See
// docs/doctrine/motebit-computer.md. Exposed so surfaces and tests
// consume the lifecycle controller and the cross-surface bridge as
// one public API. The render-side types (SlabItemSpec,
// SlabItemHandle, SlabItemPhase, SlabItemKind, EmbodimentMode) live
// in @motebit/render-engine; controller types here are runtime-layer.
export {
  createSlabController,
  defaultDetachPolicy,
  type SlabController,
  type SlabControllerDeps,
  type SlabItem,
  type SlabItemOutcome,
  type SlabState,
  type SlabAmbient,
  type SlabSubscriber,
  type ArtifactKindForDetach,
  type DetachDecision,
  type DetachPolicy,
  type TimeoutHandle,
} from "./slab-controller.js";
export {
  bindSlabControllerToRenderer,
  type SlabBridgeDeps,
  type SlabItemActions,
  type SlabRendererTarget,
} from "./slab-bridge.js";
