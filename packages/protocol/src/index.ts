// === Branded ID Types ===
//
// Compile-time safety against accidental ID swaps. Optional brand pattern:
//   string → MotebitId    ✅  (backward compat — plain strings still assignable)
//   MotebitId → DeviceId  ❌  (catches the bug — different brand literals)
//
// This means branded types can be applied to interfaces WITHOUT breaking existing
// construction sites. The protection is directional: you can put any string INTO
// a branded field, but you can't take a MotebitId and use it as a DeviceId.
//
// Factory functions (asMotebitId etc.) are for explicit intent at system boundaries.

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]?: B };

export type MotebitId = Brand<string, "MotebitId">;
export type DeviceId = Brand<string, "DeviceId">;
export type NodeId = Brand<string, "NodeId">;
export type GoalId = Brand<string, "GoalId">;
export type EventId = Brand<string, "EventId">;
export type ConversationId = Brand<string, "ConversationId">;
export type PlanId = Brand<string, "PlanId">;
export type AllocationId = Brand<string, "AllocationId">;
export type SettlementId = Brand<string, "SettlementId">;
export type ListingId = Brand<string, "ListingId">;
export type ProposalId = Brand<string, "ProposalId">;

/** Brand a string as a MotebitId after validation. */
export function asMotebitId(id: string): MotebitId {
  return id as MotebitId;
}
/** Brand a string as a DeviceId after validation. */
export function asDeviceId(id: string): DeviceId {
  return id as DeviceId;
}
/** Brand a string as a NodeId after validation. */
export function asNodeId(id: string): NodeId {
  return id as NodeId;
}
/** Brand a string as a GoalId after validation. */
export function asGoalId(id: string): GoalId {
  return id as GoalId;
}
/** Brand a string as an EventId after validation. */
export function asEventId(id: string): EventId {
  return id as EventId;
}
/** Brand a string as a ConversationId after validation. */
export function asConversationId(id: string): ConversationId {
  return id as ConversationId;
}
/** Brand a string as a PlanId after validation. */
export function asPlanId(id: string): PlanId {
  return id as PlanId;
}
/** Brand a string as an AllocationId after validation. */
export function asAllocationId(id: string): AllocationId {
  return id as AllocationId;
}
/** Brand a string as a SettlementId after validation. */
export function asSettlementId(id: string): SettlementId {
  return id as SettlementId;
}
/** Brand a string as a ListingId after validation. */
export function asListingId(id: string): ListingId {
  return id as ListingId;
}
/** Brand a string as a ProposalId after validation. */
export function asProposalId(id: string): ProposalId {
  return id as ProposalId;
}

// === Enums ===

export enum TrustMode {
  Full = "full",
  Guarded = "guarded",
  Minimal = "minimal",
}

export enum BatteryMode {
  Normal = "normal",
  LowPower = "low_power",
  Critical = "critical",
}

export enum AgentTrustLevel {
  Unknown = "unknown",
  FirstContact = "first_contact",
  Verified = "verified",
  Trusted = "trusted",
  Blocked = "blocked",
}

export enum MotebitType {
  Personal = "personal",
  Service = "service",
  Collaborative = "collaborative",
}

export enum ProposalStatus {
  Pending = "pending",
  Accepted = "accepted",
  Countered = "countered",
  Rejected = "rejected",
  Withdrawn = "withdrawn",
  Expired = "expired",
}

export enum ProposalResponseType {
  Accept = "accept",
  Reject = "reject",
  Counter = "counter",
}

export interface AgentTrustRecord {
  motebit_id: MotebitId;
  remote_motebit_id: MotebitId;
  trust_level: AgentTrustLevel;
  public_key?: string;
  first_seen_at: number;
  last_seen_at: number;
  interaction_count: number;
  successful_tasks?: number;
  failed_tasks?: number;
  notes?: string;
  /** Exponential moving average of result quality [0, 1]. */
  avg_quality?: number;
  /** Number of quality samples collected. */
  quality_sample_count?: number;
}

// ── Trust Level Transitions ──────────────────────────────────────────

/** Thresholds for automatic trust level promotion/demotion. */
export interface TrustTransitionThresholds {
  /** Min successful tasks for FirstContact → Verified (default 5) */
  promoteToVerified_minTasks: number;
  /** Min success rate for FirstContact → Verified (default 0.8) */
  promoteToVerified_minRate: number;
  /** Min successful tasks for Verified → Trusted (default 20) */
  promoteToTrusted_minTasks: number;
  /** Min success rate for Verified → Trusted (default 0.9) */
  promoteToTrusted_minRate: number;
  /** Success rate below this triggers demotion (default 0.5) */
  demote_belowRate: number;
  /** Min total tasks before demotion can trigger (default 3) */
  demote_minTasks: number;
}

/** Structural type for recursive delegation receipt walking. */
export interface DelegationReceiptLike {
  motebit_id: string;
  delegation_receipts?: DelegationReceiptLike[];
}

export enum SensitivityLevel {
  None = "none",
  Personal = "personal",
  Medical = "medical",
  Financial = "financial",
  Secret = "secret",
}

export enum EventType {
  IdentityCreated = "identity_created",
  StateUpdated = "state_updated",
  MemoryFormed = "memory_formed",
  MemoryDecayed = "memory_decayed",
  MemoryDeleted = "memory_deleted",
  MemoryAccessed = "memory_accessed",
  ProviderSwapped = "provider_swapped",
  ExportRequested = "export_requested",
  DeleteRequested = "delete_requested",
  SyncCompleted = "sync_completed",
  AuditEntry = "audit_entry",
  ToolUsed = "tool_used",
  PolicyViolation = "policy_violation",
  GoalCreated = "goal_created",
  GoalExecuted = "goal_executed",
  GoalRemoved = "goal_removed",
  ApprovalRequested = "approval_requested",
  ApprovalApproved = "approval_approved",
  ApprovalDenied = "approval_denied",
  ApprovalExpired = "approval_expired",
  GoalCompleted = "goal_completed",
  GoalProgress = "goal_progress",
  MemoryAudit = "memory_audit",
  MemoryPinned = "memory_pinned",
  PlanCreated = "plan_created",
  PlanStepStarted = "plan_step_started",
  PlanStepCompleted = "plan_step_completed",
  PlanStepFailed = "plan_step_failed",
  PlanCompleted = "plan_completed",
  PlanStepDelegated = "plan_step_delegated",
  CredentialRevoked = "credential_revoked",
  IdentityRevoked = "identity_revoked",
  PlanFailed = "plan_failed",
  HousekeepingRun = "housekeeping_run",
  ReflectionCompleted = "reflection_completed",
  MemoryConsolidated = "memory_consolidated",
  AgentTaskCompleted = "agent_task_completed",
  AgentTaskFailed = "agent_task_failed",
  AgentTaskDenied = "agent_task_denied",
  ProposalCreated = "proposal_created",
  ProposalAccepted = "proposal_accepted",
  ProposalRejected = "proposal_rejected",
  ProposalCountered = "proposal_countered",
  CollaborativeStepCompleted = "collaborative_step_completed",
  ChainTrustComputed = "chain_trust_computed",
  TrustLevelChanged = "trust_level_changed",
  KeyRotated = "key_rotated",
}

export enum MemoryType {
  Episodic = "episodic",
  Semantic = "semantic",
}

// === Core Identity ===

export interface MotebitIdentity {
  readonly motebit_id: MotebitId;
  readonly created_at: number;
  readonly owner_id: string;
  version_clock: number;
}

// === Memory ===

/** Cognition-facing memory content — what the agent's mind sees. */
export interface MemoryContent {
  content: string;
  confidence: number;
  sensitivity: SensitivityLevel;
  memory_type?: MemoryType;
  valid_from?: number;
  valid_until?: number | null;
}

export interface MemoryCandidate {
  content: string;
  confidence: number;
  sensitivity: SensitivityLevel;
  memory_type?: MemoryType;
}

// === Event Log ===

export interface EventLogEntry {
  event_id: EventId;
  motebit_id: MotebitId;
  /** Device that originated this event (for multi-device conflict resolution) */
  device_id?: DeviceId;
  timestamp: number;
  event_type: EventType;
  payload: Record<string, unknown>;
  version_clock: number;
  tombstoned: boolean;
}

// === Risk Model ===

export enum RiskLevel {
  R0_READ = 0,
  R1_DRAFT = 1,
  R2_WRITE = 2,
  R3_EXECUTE = 3,
  R4_MONEY = 4,
}

export enum DataClass {
  PUBLIC = "public",
  PRIVATE = "private",
  SECRET = "secret",
}

export enum SideEffect {
  NONE = "none",
  REVERSIBLE = "reversible",
  IRREVERSIBLE = "irreversible",
}

export interface ToolRiskProfile {
  risk: RiskLevel;
  dataClass: DataClass;
  sideEffect: SideEffect;
  requiresApproval: boolean;
}

/** M-of-N approval quorum configuration. */
export interface ApprovalQuorum {
  /** Number of approvals required (M). */
  threshold: number;
  /** Authorized approver identifiers. */
  approvers: string[];
  /** Minimum risk level that triggers quorum (optional — default: all approval-required tools). */
  risk_floor?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  budgetRemaining?: { calls: number; timeMs: number; cost: number };
  /** When quorum is required, contains the quorum metadata. */
  quorum?: { required: number; approvers: string[]; collected: string[] };
}

export interface TurnContext {
  turnId: string;
  runId?: string;
  toolCallCount: number;
  turnStartMs: number;
  costAccumulated: number;
  /** Caller motebit ID — set in MCP server mode when caller presents a signed token. */
  callerMotebitId?: string;
  /** Caller trust level — set in MCP server mode for identity-aware policy decisions. */
  callerTrustLevel?: AgentTrustLevel;
  /** Type of the remote motebit making the call (personal/service/collaborative). */
  remoteMotebitType?: string;
  /** Delegation scope — when set, only tools within this scope are allowed. */
  delegationScope?: string;
}

export interface InjectionWarning {
  detected: boolean;
  patterns: string[];
  directiveDensity?: number;
  structuralFlags?: string[];
}

export interface ToolAuditEntry {
  turnId: string;
  runId?: string;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  decision: PolicyDecision;
  result?: { ok: boolean; durationMs: number };
  injection?: InjectionWarning;
  costUnits?: number;
  timestamp: number;
}

// === Tools ===

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  requiresApproval?: boolean;
  /** Risk hint for PolicyGate classification. If absent, inferred from name/description. */
  riskHint?: {
    risk?: RiskLevel;
    dataClass?: DataClass;
    sideEffect?: SideEffect;
  };
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** Set by adapters that already applied boundary wrapping (e.g. MCP client). */
  _sanitized?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolRegistry {
  list(): ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  register(tool: ToolDefinition, handler: ToolHandler): void;
  /** Replace the handler for an existing tool, or register if new. */
  replace?(tool: ToolDefinition, handler: ToolHandler): void;
  /** Remove a tool from the registry. Returns true if it existed. */
  unregister?(name: string): boolean;
}

// === Privacy ===

export interface AuditRecord {
  audit_id: string;
  motebit_id: MotebitId;
  timestamp: number;
  action: string;
  target_type: string;
  target_id: string;
  details: Record<string, unknown>;
}

// === Sync ===

export interface SyncCursor {
  motebit_id: MotebitId;
  last_event_id: EventId;
  last_version_clock: number;
}

export interface ConflictEdge {
  local_event: EventLogEntry;
  remote_event: EventLogEntry;
  resolution: "local_wins" | "remote_wins" | "merged" | "unresolved";
}

// === Conversation Sync ===

/** Conversation metadata for sync. Matches persistence Conversation shape using snake_case for wire format. */
export interface SyncConversation {
  conversation_id: ConversationId;
  motebit_id: MotebitId;
  started_at: number;
  last_active_at: number;
  title: string | null;
  summary: string | null;
  message_count: number;
}

/** Conversation message for sync. Matches persistence ConversationMessage shape using snake_case for wire format. */
export interface SyncConversationMessage {
  message_id: string;
  conversation_id: ConversationId;
  motebit_id: MotebitId;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: number;
  token_estimate: number;
}

/** Result of a conversation sync cycle. */
export interface ConversationSyncResult {
  conversations_pushed: number;
  conversations_pulled: number;
  messages_pushed: number;
  messages_pulled: number;
}

// === Plan-Execute Engine ===

export enum PlanStatus {
  Active = "active",
  Completed = "completed",
  Failed = "failed",
  Paused = "paused",
}

export enum StepStatus {
  Pending = "pending",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Skipped = "skipped",
}

export interface PlanStep {
  step_id: string;
  plan_id: PlanId;
  ordinal: number;
  description: string;
  prompt: string;
  depends_on: string[];
  optional: boolean;
  status: StepStatus;
  required_capabilities?: DeviceCapability[];
  /** Task ID assigned by the relay when this step was delegated to a remote device. */
  delegation_task_id?: string;
  /** Motebit ID of the agent assigned to execute this step in collaborative plans. */
  assigned_motebit_id?: MotebitId;
  result_summary: string | null;
  error_message: string | null;
  tool_calls_made: number;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
  updated_at: number;
}

export interface Plan {
  plan_id: PlanId;
  goal_id: GoalId;
  motebit_id: MotebitId;
  title: string;
  status: PlanStatus;
  created_at: number;
  updated_at: number;
  current_step_index: number;
  total_steps: number;
  proposal_id?: ProposalId;
  collaborative?: boolean;
}

// === Plan Sync ===

/** Plan record for cross-device sync. Mirrors Plan but uses wire-format field names. */
export interface SyncPlan {
  plan_id: PlanId;
  goal_id: GoalId;
  motebit_id: MotebitId;
  title: string;
  status: PlanStatus;
  created_at: number;
  updated_at: number;
  current_step_index: number;
  total_steps: number;
  proposal_id: string | null;
  collaborative: number; // 0 | 1 for SQLite wire
}

/** Plan step record for cross-device sync. */
export interface SyncPlanStep {
  step_id: string;
  plan_id: PlanId;
  motebit_id: MotebitId;
  ordinal: number;
  description: string;
  prompt: string;
  depends_on: string; // JSON-serialized string[] for wire format
  optional: boolean;
  status: StepStatus;
  required_capabilities: string | null; // JSON-serialized DeviceCapability[] | null
  delegation_task_id: string | null;
  assigned_motebit_id: string | null;
  result_summary: string | null;
  error_message: string | null;
  tool_calls_made: number;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
  updated_at: number;
}

/** Result of a plan sync cycle. */
export interface PlanSyncResult {
  plans_pushed: number;
  plans_pulled: number;
  steps_pushed: number;
  steps_pulled: number;
}

// === Agent Protocol ===

export enum DeviceCapability {
  StdioMcp = "stdio_mcp",
  HttpMcp = "http_mcp",
  FileSystem = "file_system",
  Keyring = "keyring",
  Background = "background",
  LocalLlm = "local_llm",
  /** Device supports push-triggered wake for background task execution. */
  PushWake = "push_wake",
}

/** Push notification platform for wake-on-demand mobile execution. */
export type PushPlatform = "fcm" | "apns" | "expo";

/** Push token registration payload — sent from device to relay. */
export interface PushTokenRegistration {
  device_id: string;
  push_token: string;
  platform: PushPlatform;
  /** Unix ms timestamp when the token was obtained. Used for staleness detection. */
  registered_at: number;
}

export enum AgentTaskStatus {
  Pending = "pending",
  Claimed = "claimed",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Denied = "denied",
  Expired = "expired",
}

export interface AgentTask {
  task_id: string;
  motebit_id: MotebitId;
  prompt: string;
  submitted_at: number;
  submitted_by?: string;
  wall_clock_ms?: number;
  status: AgentTaskStatus;
  claimed_by?: string;
  required_capabilities?: DeviceCapability[];
  step_id?: string;
  /** Delegation scope — when set, restricts which tools the task can use. */
  delegated_scope?: string;
}

export interface ExecutionReceipt {
  task_id: string;
  motebit_id: MotebitId;
  /** Signer's Ed25519 public key (hex). Enables verification without relay lookup. */
  public_key?: string;
  device_id: DeviceId;
  submitted_at: number;
  completed_at: number;
  status: "completed" | "failed" | "denied";
  result: string;
  tools_used: string[];
  memories_formed: number;
  prompt_hash: string;
  result_hash: string;
  delegation_receipts?: ExecutionReceipt[];
  /**
   * Cryptographic binding to the relay's economic identity for this task.
   *
   * Optional for local (non-relay) execution. **Required** for relay-mediated
   * tasks — the relay rejects receipts without this field (HTTP 400). The value
   * is included in the Ed25519 signature, so tampering breaks verification.
   */
  relay_task_id?: string;
  /** Scope from the delegation token that authorized this execution, if any. */
  delegated_scope?: string;
  signature: string;
}

export interface DelegatedStepResult {
  step_id: string;
  task_id: string;
  receipt: ExecutionReceipt;
  result_text: string;
  /** Routing provenance from the relay — why this agent was selected. */
  routing_choice?: {
    selected_agent: string;
    composite_score: number;
    sub_scores: Record<string, number>;
    routing_paths: string[][];
    alternatives_considered: number;
  };
}

// === Key Succession ===

/**
 * Encrypted identity key transfer payload for multi-device pairing.
 *
 * Device A encrypts its Ed25519 identity seed using ephemeral X25519 key agreement
 * and posts this payload through the relay. The relay sees only opaque ciphertext.
 * Device B decrypts using its held ephemeral X25519 private key + the pairing code.
 */
export interface KeyTransferPayload {
  /** Device A's ephemeral X25519 public key (64-char hex). */
  x25519_pubkey: string;
  /** AES-256-GCM encrypted 32-byte Ed25519 identity seed (hex). */
  encrypted_seed: string;
  /** AES-256-GCM nonce, 12 bytes (24-char hex). */
  nonce: string;
  /** AES-256-GCM auth tag, 16 bytes (32-char hex). */
  tag: string;
  /** Device A's Ed25519 identity public key for post-decryption verification (64-char hex). */
  identity_pubkey_check: string;
}

/**
 * A key succession record proving that one Ed25519 key has been replaced by another.
 * Both the old and new keys sign the record, creating a cryptographic chain of custody.
 * Structurally compatible with @motebit/crypto KeySuccessionRecord.
 *
 * Guardian recovery records have `recovery: true` and `guardian_signature` instead of
 * `old_key_signature`. This allows identity recovery when the primary key is compromised.
 */
export interface KeySuccessionRecord {
  old_public_key: string; // hex
  new_public_key: string; // hex
  timestamp: number;
  reason?: string;
  old_key_signature?: string; // hex — present in normal rotation, absent in guardian recovery
  new_key_signature: string; // hex, new key signs the canonical payload
  /** Guardian recovery: true when succession was authorized by guardian, not old key. */
  recovery?: boolean;
  /** Guardian signature — present only when recovery is true. */
  guardian_signature?: string; // hex
}

/**
 * Organizational guardian — enables key recovery and organizational custody.
 * The guardian's private key is held by the organization (cold storage).
 * When present, the guardian can sign succession records on behalf of a compromised key.
 */
export interface IdentityGuardian {
  /** Ed25519 public key of the guardian (hex). */
  public_key: string;
  /** Human-readable organization name. */
  organization?: string;
  /** Machine-readable organization identifier. */
  organization_id?: string;
  /** ISO 8601 timestamp when guardianship was established. */
  established_at: string;
}

/** Result of verifying a key succession chain. */
export interface SuccessionChainResult {
  valid: boolean;
  /** The original (genesis) public key. */
  genesis_public_key: string;
  /** The current (active) public key. */
  current_public_key: string;
  /** Number of key rotations. */
  length: number;
  /** If invalid, the index of the first broken link and error. */
  error?: { index: number; message: string };
}

// === Execution Ledger ===

export type ExecutionTimelineType =
  | "goal_started"
  | "plan_created"
  | "step_started"
  | "tool_invoked"
  | "tool_result"
  | "step_completed"
  | "step_failed"
  | "step_delegated"
  | "plan_completed"
  | "plan_failed"
  | "goal_completed"
  | "proposal_created"
  | "proposal_accepted"
  | "proposal_rejected"
  | "proposal_countered"
  | "collaborative_step_completed";

export interface ExecutionTimelineEntry {
  timestamp: number;
  type: ExecutionTimelineType;
  payload: Record<string, unknown>;
}

export interface ExecutionStepSummary {
  step_id: string;
  ordinal: number;
  description: string;
  status: string;
  tools_used: string[];
  tool_calls: number;
  started_at: number | null;
  completed_at: number | null;
  delegation?: {
    task_id: string;
    receipt_hash?: string;
    /** Routing provenance: why this agent was selected for delegation. */
    routing_choice?: {
      selected_agent: string;
      composite_score: number;
      sub_scores: {
        trust: number;
        success_rate: number;
        latency: number;
        price_efficiency: number;
        capability_match: number;
        availability: number;
      };
      /** Derivation paths through the agent graph. */
      routing_paths: string[][];
      /** Number of candidate agents that were scored. */
      alternatives_considered: number;
    };
  };
}

export interface GoalExecutionManifest {
  spec: "motebit/execution-ledger@1.0";
  motebit_id: string;
  goal_id: string;
  plan_id: string;
  started_at: number;
  completed_at: number;
  status: "completed" | "failed" | "paused" | "active";
  timeline: ExecutionTimelineEntry[];
  steps: ExecutionStepSummary[];
  delegation_receipts: DelegationReceiptSummary[];
  content_hash: string;
  signature?: string;
}

export interface DelegationReceiptSummary {
  task_id: string;
  motebit_id: string;
  device_id: string;
  status: string;
  completed_at: number;
  tools_used: string[];
  signature_prefix: string;
}

export interface AgentCapabilities {
  motebit_id: MotebitId;
  public_key: string;
  /** W3C did:key URI derived from the Ed25519 public key. */
  did?: string;
  tools: string[];
  governance: {
    trust_mode: string;
    max_risk_auto: number;
    require_approval_above: number;
    deny_above: number;
  };
  online_devices: number;
}

// === Market Types ===

export interface CapabilityPrice {
  capability: string;
  unit_cost: number;
  currency: string;
  per: "task" | "tool_call" | "token";
}

export interface AgentServiceListing {
  listing_id: ListingId;
  motebit_id: MotebitId;
  capabilities: string[];
  pricing: CapabilityPrice[];
  sla: { max_latency_ms: number; availability_guarantee: number };
  description: string;
  /** Wallet address for x402 on-chain payment settlement (e.g. "0x..." for EVM). */
  pay_to_address?: string;
  /**
   * Self-declared regulatory risk score [0, ∞). 0 = no risk, higher = more risk.
   * Accumulates along delegation chains via RegulatoryRiskSemiring (min, +).
   * Sources: jurisdiction, data handling classification, compliance certifications,
   * audit requirements. The score is declared by the agent; verification is via
   * credentials (e.g. compliance attestation VCs).
   */
  regulatory_risk?: number;
  updated_at: number;
}

export interface RouteScore {
  motebit_id: MotebitId;
  composite: number;
  sub_scores: {
    trust: number;
    success_rate: number;
    latency: number;
    price_efficiency: number;
    capability_match: number;
    availability: number;
  };
  selected: boolean;
}

export interface BudgetAllocation {
  allocation_id: AllocationId;
  goal_id: GoalId;
  candidate_motebit_id: MotebitId;
  amount_locked: number;
  currency: string;
  created_at: number;
  status: "locked" | "settled" | "released" | "disputed";
}

/**
 * Default platform fee rate (5%) — used by the reference relay deployment.
 * The protocol supports any fee structure; relays configure their own rate
 * via MOTEBIT_PLATFORM_FEE_RATE env or config.platformFeeRate.
 */
export const PLATFORM_FEE_RATE = 0.05;

export interface SettlementRecord {
  settlement_id: SettlementId;
  allocation_id: AllocationId;
  receipt_hash: string;
  ledger_hash: string | null;
  /** Amount paid to the executing agent (after platform fee deduction). */
  amount_settled: number;
  /** Platform fee extracted by the relay. */
  platform_fee: number;
  /** Fee rate applied (e.g. 0.05 = 5%). Recorded per-settlement for auditability. */
  platform_fee_rate: number;
  /** x402 payment transaction hash (when paid on-chain). */
  x402_tx_hash?: string;
  /** x402 network used for payment (CAIP-2 identifier). */
  x402_network?: string;
  status: "completed" | "partial" | "refunded";
  settled_at: number;
}

// === Settlement Rails ===
// Rail types classify how money moves, not which vendor moves it.
// Protocol, provider, and network are properties of the implementation, not the interface.

/** Proof of payment from a settlement rail. */
export interface PaymentProof {
  /** Transaction hash or reference ID from the rail. */
  reference: string;
  /** Rail type that produced this proof. */
  railType: "fiat" | "protocol" | "direct_asset" | "orchestration";
  /** Network identifier (CAIP-2 for onchain, "stripe" for fiat, etc.). */
  network?: string;
  /** ISO timestamp of when the payment was confirmed. */
  confirmedAt: number;
}

/** Deposit result from a settlement rail. */
export interface DepositResult {
  /** Amount deposited in micro-units. */
  amount: number;
  /** Currency code (e.g., "USD", "USDC"). */
  currency: string;
  /** Payment proof for audit trail. */
  proof: PaymentProof;
}

/** Withdrawal result from a settlement rail. */
export interface WithdrawalResult {
  /** Amount withdrawn in micro-units. */
  amount: number;
  /** Currency code. */
  currency: string;
  /** Payment proof for audit trail. */
  proof: PaymentProof;
}

/**
 * Settlement rail adapter — the external money movement boundary.
 *
 * The relay's internal ledger (virtual accounts, micro-units) handles real-time
 * balance tracking. The rail handles how money enters and exits the system.
 *
 * Four rail types:
 * - FiatRail — traditional payment processor (Stripe Checkout)
 * - ProtocolRail — HTTP-native agent payment protocols (MPP, x402)
 * - DirectAssetRail — direct onchain stablecoin transfer (USDC on Tempo/Base/Solana)
 * - OrchestrationRail — fiat↔crypto bridging (Bridge)
 *
 * Not all rails support deposits. Fiat and direct-asset rails accept proactive
 * deposits. Protocol rails (x402, MPP) are pay-per-request — money moves at the
 * HTTP boundary, not through the rail. Use `supportsDeposit` discriminant for
 * runtime narrowing: `if (rail.supportsDeposit) rail.deposit(...)`.
 *
 * The relay picks the rail at routing time based on what the counterparty accepts.
 */
export interface SettlementRail {
  /** Rail type for routing decisions. */
  readonly railType: "fiat" | "protocol" | "direct_asset" | "orchestration";

  /** Human-readable name for logging and config (e.g., "stripe", "x402-base", "bridge"). */
  readonly name: string;

  /** Whether this rail supports proactive deposits. False for pay-per-request rails (x402, MPP). */
  readonly supportsDeposit: boolean;

  /** Whether this rail is currently available (provider reachable, config valid). */
  isAvailable(): Promise<boolean>;

  /**
   * Execute a withdrawal to an external destination.
   * Fail-closed: throws on any error.
   */
  withdraw(
    motebitId: string,
    amount: number,
    currency: string,
    destination: string,
    idempotencyKey: string,
  ): Promise<WithdrawalResult>;

  /**
   * Record a payment proof with a settlement (e.g., x402 tx hash, Stripe charge ID).
   * Called after settleOnReceipt() computes the settlement record.
   */
  attachProof(settlementId: string, proof: PaymentProof): Promise<void>;
}

/**
 * A settlement rail that supports proactive deposits (Stripe Checkout, onchain transfers).
 * Use the `supportsDeposit` discriminant for runtime narrowing from `SettlementRail`.
 */
export interface DepositableSettlementRail extends SettlementRail {
  readonly supportsDeposit: true;

  /**
   * Initiate a deposit. Returns a deposit result or a redirect URL
   * (for interactive flows like Stripe Checkout).
   */
  deposit(
    motebitId: string,
    amount: number,
    currency: string,
    idempotencyKey: string,
  ): Promise<DepositResult | { redirectUrl: string }>;
}

/** Type guard: narrows SettlementRail to DepositableSettlementRail. */
export function isDepositableRail(rail: SettlementRail): rail is DepositableSettlementRail {
  return rail.supportsDeposit;
}

// === Collaborative Plan Proposals ===

export interface CollaborativePlanProposal {
  proposal_id: ProposalId;
  plan_id: PlanId;
  initiator_motebit_id: MotebitId;
  participants: ProposalParticipant[];
  status: ProposalStatus;
  created_at: number;
  expires_at: number;
  updated_at: number;
}

export interface ProposalParticipant {
  motebit_id: MotebitId;
  assigned_steps: number[]; // step ordinals
  response: ProposalResponseType | null;
  responded_at: number | null;
  counter_steps?: ProposalStepCounter[];
}

export interface ProposalStepCounter {
  ordinal: number;
  description?: string;
  prompt?: string;
  reason: string;
}

export interface ProposalResponse {
  proposal_id: ProposalId;
  responder_motebit_id: MotebitId;
  response: ProposalResponseType;
  counter_steps?: ProposalStepCounter[];
  signature: string;
}

export interface CollaborativeReceipt {
  proposal_id: ProposalId;
  plan_id: PlanId;
  participant_receipts: ExecutionReceipt[];
  content_hash: string;
  initiator_signature: string;
}

export interface MarketConfig {
  weight_trust: number;
  weight_success_rate: number;
  weight_latency: number;
  weight_price_efficiency: number;
  weight_capability_match: number;
  weight_availability: number;
  latency_norm_k: number;
  max_candidates: number;
  settlement_timeout_ms: number;
  /** Exploration weight [0-1]: 0 = pure exploitation, 1 = pure exploration. Default 0. */
  exploration_weight?: number;
}

// === Verifiable Credential Subject Types ===

export const VC_TYPE_GRADIENT = "AgentGradientCredential";
export const VC_TYPE_REPUTATION = "AgentReputationCredential";
export const VC_TYPE_TRUST = "AgentTrustCredential";

export interface ReputationCredentialSubject {
  id: string;
  success_rate: number;
  avg_latency_ms: number;
  task_count: number;
  trust_score: number;
  availability: number;
  sample_size: number;
  measured_at: number;
}

export interface TrustCredentialSubject {
  id: string;
  trust_level: string;
  interaction_count: number;
  successful_tasks: number;
  failed_tasks: number;
  first_seen_at: number;
  last_seen_at: number;
}

export interface GradientCredentialSubject {
  id: string;
  gradient: number;
  knowledge_density: number;
  knowledge_quality: number;
  graph_connectivity: number;
  temporal_stability: number;
  retrieval_quality: number;
  interaction_efficiency: number;
  tool_efficiency: number;
  curiosity_pressure: number;
  measured_at: number;
}

// === Platform Storage Adapter Interfaces ===
//
// Pure adapter contracts for platform-specific persistence implementations.
// These live in SDK so that both the runtime (consumer) and persistence
// packages (implementors) can depend on them without layer violations.

export interface ConversationStoreAdapter {
  createConversation(motebitId: string): string;
  appendMessage(
    conversationId: string,
    motebitId: string,
    msg: {
      role: string;
      content: string;
      toolCalls?: string;
      toolCallId?: string;
    },
  ): void;
  loadMessages(
    conversationId: string,
    limit?: number,
  ): Array<{
    messageId: string;
    conversationId: string;
    motebitId: string;
    role: string;
    content: string;
    toolCalls: string | null;
    toolCallId: string | null;
    createdAt: number;
    tokenEstimate: number;
  }>;
  getActiveConversation(motebitId: string): {
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    summary: string | null;
  } | null;
  updateSummary(conversationId: string, summary: string): void;
  updateTitle(conversationId: string, title: string): void;
  listConversations(
    motebitId: string,
    limit?: number,
  ): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }>;
  deleteConversation(conversationId: string): void;
}

export interface StateSnapshotAdapter {
  saveState(motebitId: string, stateJson: string, versionClock?: number): void;
  loadState(motebitId: string): string | null;
  /** Version clock at last snapshot — used to determine what's safe to compact. */
  getSnapshotClock?(motebitId: string): number;
}

export interface KeyringAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AgentTrustStoreAdapter {
  getAgentTrust(motebitId: string, remoteMotebitId: string): Promise<AgentTrustRecord | null>;
  setAgentTrust(record: AgentTrustRecord): Promise<void>;
  listAgentTrust(motebitId: string): Promise<AgentTrustRecord[]>;
  updateTrustLevel(
    motebitId: string,
    remoteMotebitId: string,
    level: AgentTrustLevel,
  ): Promise<void>;
}

export interface ServiceListingStoreAdapter {
  get(motebitId: string): Promise<AgentServiceListing | null>;
  set(listing: AgentServiceListing): Promise<void>;
  list(): Promise<AgentServiceListing[]>;
  delete(listingId: string): Promise<void>;
}

export interface BudgetAllocationStoreAdapter {
  get(allocationId: string): Promise<BudgetAllocation | null>;
  create(allocation: BudgetAllocation): Promise<void>;
  updateStatus(allocationId: string, status: string): Promise<void>;
  listByGoal(goalId: string): Promise<BudgetAllocation[]>;
}

export interface SettlementStoreAdapter {
  get(settlementId: string): Promise<SettlementRecord | null>;
  create(settlement: SettlementRecord): Promise<void>;
  listByAllocation(allocationId: string): Promise<SettlementRecord[]>;
}

export interface LatencyStatsStoreAdapter {
  record(motebitId: string, remoteMotebitId: string, latencyMs: number): Promise<void>;
  getStats(
    motebitId: string,
    remoteMotebitId: string,
    limit?: number,
  ): Promise<{ avg_ms: number; p95_ms: number; sample_count: number }>;
}

export interface EventFilter {
  motebit_id?: string;
  event_types?: EventType[];
  after_timestamp?: number;
  before_timestamp?: number;
  after_version_clock?: number;
  limit?: number;
}

export interface EventStoreAdapter {
  append(entry: EventLogEntry): Promise<void>;
  /**
   * Atomically assign the next version_clock and append the event.
   * Eliminates the race condition in the getLatestClock() + clock+1 pattern.
   * Returns the assigned version_clock.
   */
  appendWithClock?(entry: Omit<EventLogEntry, "version_clock">): Promise<number>;
  query(filter: EventFilter): Promise<EventLogEntry[]>;
  getLatestClock(motebitId: string): Promise<number>;
  tombstone(eventId: string, motebitId: string): Promise<void>;
  /** Delete events with version_clock <= beforeClock. Returns count deleted. */
  compact?(motebitId: string, beforeClock: number): Promise<number>;
  /** Count total events for a motebit. */
  countEvents?(motebitId: string): Promise<number>;
}

export interface DeviceRegistration {
  device_id: string;
  motebit_id: string;
  device_token?: string; // Legacy — retained for DB compat, no longer used for auth
  public_key: string; // hex-encoded Ed25519 public key
  registered_at: number;
  device_name?: string;
}

export interface IdentityStorage {
  save(identity: MotebitIdentity): Promise<void>;
  load(motebitId: string): Promise<MotebitIdentity | null>;
  loadByOwner(ownerId: string): Promise<MotebitIdentity | null>;
  // Device registration (optional — implementations that don't need device auth can omit)
  saveDevice?(device: DeviceRegistration): Promise<void>;
  loadDevice?(deviceId: string): Promise<DeviceRegistration | null>;
  loadDeviceByToken?(token: string): Promise<DeviceRegistration | null>;
  listDevices?(motebitId: string): Promise<DeviceRegistration[]>;
}

export interface AuditLogAdapter {
  record(entry: AuditRecord): Promise<void>;
  query(motebitId: string, options?: { limit?: number; after?: number }): Promise<AuditRecord[]>;
}

export interface AuditStatsSince {
  distinctTurns: number;
  totalToolCalls: number;
  succeeded: number;
  blocked: number;
  failed: number;
}

export interface AuditLogSink {
  append(entry: ToolAuditEntry): void;
  query(turnId: string): ToolAuditEntry[];
  getAll(): ToolAuditEntry[];
  queryStatsSince(afterTimestamp: number): AuditStatsSince;
  /** Query tool audit entries by run_id (plan execution). Optional — returns [] if not implemented. */
  queryByRunId?(runId: string): ToolAuditEntry[];
}

export interface PlanStoreAdapter {
  savePlan(plan: Plan): void;
  getPlan(planId: string): Plan | null;
  getPlanForGoal(goalId: string): Plan | null;
  updatePlan(planId: string, updates: Partial<Plan>): void;
  saveStep(step: PlanStep): void;
  getStep(stepId: string): PlanStep | null;
  getStepsForPlan(planId: string): PlanStep[];
  updateStep(stepId: string, updates: Partial<PlanStep>): void;
  getNextPendingStep(planId: string): PlanStep | null;
  /** List all active plans for a motebit. Optional — returns [] if not implemented. */
  listActivePlans?(motebitId: string): Plan[];
}

/** Stored credential record — JSON-serialized VC with metadata. */
export interface StoredCredential {
  credential_id: string;
  /** The agent the credential is about (credentialSubject.id). */
  subject_motebit_id: string;
  /** did:key of the issuer. */
  issuer_did: string;
  /** e.g. "AgentReputationCredential", "AgentTrustCredential", "AgentGradientCredential". */
  credential_type: string;
  /** Full JSON-serialized VerifiableCredential. */
  credential_json: string;
  issued_at: number;
}

export interface CredentialStoreAdapter {
  save(credential: StoredCredential): void;
  /** List credentials about a specific subject agent. */
  listBySubject(subjectMotebitId: string, limit?: number): StoredCredential[];
  /** List all credentials, optionally filtered by type. */
  list(motebitId: string, type?: string, limit?: number): StoredCredential[];
}

export interface ApprovalStoreAdapter {
  /** Collect a quorum approval vote. Returns whether threshold is met and collected voter IDs. */
  collectApproval(approvalId: string, approverId: string): { met: boolean; collected: string[] };
  /** Set quorum metadata on a pending approval item. */
  setQuorum(approvalId: string, required: number, approvers: string[]): void;
}

// ── Semiring Algebra (protocol-level) ──────────────────────────────
// The language of trust: algebra, graph, traversal, scoring constants.
// Any compatible implementation must use the same algebraic semantics.

export type { Semiring } from "./semiring.js";
export {
  TrustSemiring,
  CostSemiring,
  LatencySemiring,
  BottleneckSemiring,
  ReliabilitySemiring,
  BooleanSemiring,
  RegulatoryRiskSemiring,
  productSemiring,
  recordSemiring,
  mappedSemiring,
} from "./semiring.js";

export type { Edge } from "./graph.js";
export { WeightedDigraph } from "./graph.js";

export { optimalPaths, optimalPath, transitiveClosure, optimalPathTrace } from "./traversal.js";

export {
  TRUST_LEVEL_SCORES,
  trustLevelToScore,
  TRUST_ZERO,
  TRUST_ONE,
  trustAdd,
  trustMultiply,
  composeTrustChain,
  joinParallelRoutes,
  DEFAULT_TRUST_THRESHOLDS,
} from "./trust-algebra.js";

// ── Credential Anchoring (protocol-level) ────────────────────────────
// Self-verifiable Merkle inclusion proofs for onchain credential anchoring.
// motebit/credential-anchor@1.0.

export type {
  CredentialAnchorBatch,
  CredentialChainAnchor,
  CredentialAnchorProof,
  ChainAnchorSubmitter,
} from "./credential-anchor.js";
