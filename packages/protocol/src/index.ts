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

/**
 * A signed delegation token authorizing one agent to act on behalf of
 * another within a declared scope. The delegator signs the token body
 * (everything except `signature`) with their private key.
 *
 * Public keys are hex-encoded, matching every other motebit artifact
 * that carries an Ed25519 key; the signature is base64url-encoded per
 * the `motebit-jcs-ed25519-b64-v1` suite. `@motebit/crypto` re-exports
 * this type alongside `signDelegation` / `verifyDelegation` helpers;
 * the shape itself is the binding wire format.
 *
 * See `spec/market-v1.md §12.1` for the full spec.
 */
export interface DelegationToken {
  delegator_id: string;
  /** Delegator's Ed25519 public key, hex-encoded (64 characters, lowercase). */
  delegator_public_key: string;
  delegate_id: string;
  /** Delegate's Ed25519 public key, hex-encoded (64 characters, lowercase). */
  delegate_public_key: string;
  /** Comma-separated capability list, or `"*"` for wildcard. See market-v1 §12.3. */
  scope: string;
  issued_at: number;
  expires_at: number;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` for
   * this artifact today. Part of the signed body — tampering breaks
   * verification. Verifiers reject missing or unknown values fail-closed.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  /** Base64url-encoded Ed25519 signature. */
  signature: string;
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
  IdleTickFired = "idle_tick_fired",
  MemoryConsolidated = "memory_consolidated",
  MemoryPromoted = "memory_promoted",
  ConsolidationCycleRun = "consolidation_cycle_run",
  ConsolidationReceiptSigned = "consolidation_receipt_signed",
  ConsolidationReceiptsAnchored = "consolidation_receipts_anchored",
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
  // Computer-use session lifecycle — opened/closed by `createComputerSessionManager`
  // on `openSession()` / `closeSession()`. Third parties replay the audit trail
  // via the session_id → observation-action sequence binding.
  ComputerSessionOpened = "computer_session_opened",
  ComputerSessionClosed = "computer_session_closed",
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
  /**
   * Cost-tier declaration driving registry sort order. `api` (cheap,
   * structured) ranks above `ax` (structured accessibility tree) above
   * `pixels` (screen capture + synthetic input). Untagged tools sort
   * last. See `@motebit/protocol/tool-mode`.
   */
  mode?: ToolMode;
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
  /**
   * Device holds its identity key inside hardware (Secure Enclave / TPM /
   * hardware keystore) and can produce signatures the private material
   * never leaves. Consumed by `HardwareAttestationSemiring` to rank
   * hardware-attested agents above software-only agents when the routing
   * caller asks for the attestation dimension. Pairs with the
   * `hardware_attestation` subject-field extension on `AgentTrustCredential`
   * (spec/credential-v1.md §3.4).
   */
  SecureEnclave = "secure_enclave",
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
  /**
   * How this task was authorized for invocation. Propagated from the task
   * submission body through the agent envelope to the outer receipt. See
   * `IntentOrigin` for the closed value set and
   * `docs/doctrine/surface-determinism.md` for the surface-determinism
   * doctrine this discriminator supports.
   */
  invocation_origin?: IntentOrigin;
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
  /**
   * How this task was authorized for invocation. Discriminates user-explicit
   * affordances (chip tap, slash command, scene click) from AI-mediated
   * delegations (the model called `delegate_to_agent` in its loop) and from
   * machine-driven origins (cron, agent-to-agent). Optional and additive —
   * absent ≡ unknown origin (legacy receipts predate the field; no
   * back-fill). When present, the value is signature-bound: verifiers
   * reject any tampered substitution.
   *
   * Carried through to the relay's task-submission body and emitted on
   * the agent's outer receipt by `buildServiceReceipt`. Surface determinism
   * (CLAUDE.md principle): user-tap delegations MUST set `"user-tap"`.
   */
  invocation_origin?: IntentOrigin;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` for
   * this artifact today — the verification recipe is JCS canonicalization
   * of the unsigned body (this object without `signature`), Ed25519
   * primitive, base64url signature encoding, hex public-key encoding.
   *
   * Narrowed to the single suite today so widening requires intentional
   * registry + type change (the plan for post-quantum migration). Verifiers
   * reject missing or unknown suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

/**
 * Signed per-tool-call proof: one receipt per invocation of a tool during
 * an agent turn. Complements `ExecutionReceipt` (which commits to the
 * task as a whole) by committing to each individual tool call inside
 * the task — the finer-grained audit granularity the Motebit Computer
 * needs to show the user exactly which tool ran, what it was given,
 * and what it returned, with a signature per call.
 *
 * Why this exists as its own artifact instead of an inner field on
 * `ExecutionReceipt`:
 *
 *   - Third-party implementers verifying a single tool's output do not
 *     need the enclosing task's receipt — the per-call receipt is
 *     independently self-verifiable with just the signer's public key.
 *   - The slab emits these live as tool calls complete, before the
 *     enclosing task finishes; nesting inside `ExecutionReceipt`
 *     would force the UI to wait for the outer receipt.
 *   - Delegation is recursive at the task level (`delegation_receipts`);
 *     keeping tool-invocation receipts separate avoids tangling two
 *     different recursion shapes in one artifact.
 *
 * Commits only to structural facts: tool name, canonical SHA-256 hashes
 * of the args and the result, the result status, the motebit + device
 * identities, and timestamps. The receipt does *not* carry the raw args
 * or raw result bytes — those may contain sensitive content. A verifier
 * who holds the raw bytes can recompute the hash and check against the
 * signature; one who holds only the receipt can still prove the tool
 * ran with *some* input at *some* time.
 *
 * Binding to the enclosing task is via `task_id` — the same task_id
 * carried on the parent `ExecutionReceipt`. A verifier can gather all
 * tool-invocation receipts for a task by matching task_id and verify
 * them in parallel.
 */
export interface ToolInvocationReceipt {
  /** Stable identifier for this invocation — UUID assigned when the tool is dispatched. */
  invocation_id: string;
  /** Task this invocation belongs to. Matches `ExecutionReceipt.task_id` when nested in a task. */
  task_id: string;
  motebit_id: MotebitId;
  /** Signer's Ed25519 public key (hex). Enables verification without relay lookup. */
  public_key?: string;
  device_id: DeviceId;
  /** Tool name as registered in the runtime's tool registry (e.g., "read_url", "web_search"). */
  tool_name: string;
  /** Unix ms when the tool was dispatched. */
  started_at: number;
  /** Unix ms when the tool reached terminal state. Equal to `started_at` for instantaneous tools. */
  completed_at: number;
  /** Terminal state of the tool invocation. */
  status: "completed" | "failed" | "denied";
  /**
   * SHA-256 hex digest of the canonical JSON of the tool's arguments.
   * A verifier with the raw args recomputes and matches; absence of raw
   * args does not weaken the receipt's self-verifiability.
   */
  args_hash: string;
  /**
   * SHA-256 hex digest of the canonical JSON of the tool's result (or of
   * the error message string, when status is `failed` or `denied`).
   */
  result_hash: string;
  /**
   * How this invocation was authorized. `user-tap` for explicit affordance
   * invocations (surface-determinism); `ai-loop` for model-mediated calls
   * inside a turn. Propagates the enclosing task's origin so per-call
   * receipts can be audited independently of the task receipt.
   */
  invocation_origin?: IntentOrigin;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` today.
   * Widening requires a registry change in `SuiteId` + a new dispatch
   * arm in `@motebit/crypto`, not a wire-format break.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

/**
 * Signed proof that the motebit performed a consolidation cycle. The
 * receipt commits to structural facts only — counts of memories merged,
 * promoted, pruned, and the cycle's identity / timestamps — never to
 * memory content, embeddings, or any sensitive identifier. Anyone with
 * the signer's public key can verify; no relay contact required.
 *
 * Why this exists: every other proactive AI agent today binds the
 * agent's identity to the operator's billing relationship. Motebit
 * binds it to a sovereign Ed25519 identity, so the consolidation work
 * the motebit performs while idle becomes self-attesting evidence the
 * motebit can show to anyone — including itself, across time. The
 * receipt is the evidence; anchoring it on a public ledger (Solana
 * memo via `SolanaMemoSubmitter`, batched per `spec/credential-anchor-v1`)
 * is the additive proof that the receipt existed at the time it claims.
 *
 * Doctrine: [`docs/doctrine/proactive-interior.md`](../../docs/doctrine/proactive-interior.md).
 */
export interface ConsolidationReceipt {
  /** UUID — the receipt's own identity (separate from cycle_id). */
  receipt_id: string;
  /** The motebit that performed the cycle. */
  motebit_id: MotebitId;
  /** Signer's Ed25519 public key (hex). Embedded for portable verification
   *  — third parties verify without contacting any relay. */
  public_key?: string;
  /** Matches the `cycle_id` carried by the `consolidation_cycle_run` event
   *  emitted at cycle completion. Verifiers cross-reference. */
  cycle_id: string;
  /** Cycle timing — milliseconds since Unix epoch. */
  started_at: number;
  finished_at: number;
  /** Phases that ran to completion. Closed union — adding a phase is a
   *  protocol-coordinated change. */
  phases_run: ReadonlyArray<"orient" | "gather" | "consolidate" | "prune">;
  /** Phases that yielded mid-execution because their AbortSignal fired
   *  (budget exhausted or parent signal aborted). Subset of `phases_run`. */
  phases_yielded: ReadonlyArray<"orient" | "gather" | "consolidate" | "prune">;
  /** Structural counts only — never memory content. The privacy boundary
   *  is the type: there is no field here that could leak a memory's text
   *  or embedding. Adding such a field is a protocol break. */
  summary: {
    orient_nodes?: number;
    gather_clusters?: number;
    gather_notable?: number;
    consolidate_merged?: number;
    pruned_decay?: number;
    pruned_notability?: number;
    pruned_retention?: number;
  };
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` for
   * this artifact today — the verification recipe is JCS canonicalization
   * of the unsigned body (this object without `signature`), Ed25519
   * primitive, base64url signature encoding, hex public-key encoding.
   * Verifiers reject missing or unknown suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

/**
 * Merkle-batched anchor over signed `ConsolidationReceipt`s. The motebit
 * batches its own receipts (no relay required), computes a Merkle root
 * over canonical-JSON SHA-256 leaves, and optionally submits the root
 * via a `ChainAnchorSubmitter` (the same primitive the relay uses for
 * credential anchoring; `SolanaMemoSubmitter` is the reference impl).
 *
 * When `tx_hash` is populated the anchor is onchain — anyone can verify
 * that the included receipts existed at `anchored_at` by recomputing
 * their leaf hashes and checking inclusion against the root recorded in
 * the Solana transaction memo (`motebit:anchor:v1:{root}:{leaf_count}`).
 * When `tx_hash` is absent, the anchor is a local-only Merkle commitment
 * — still verifiable by recomputation, just not timestamp-attested.
 *
 * The anchor itself is NOT separately signed. Its cryptographic load is
 * carried by (a) the signatures on the receipts it groups, and (b) the
 * onchain Solana transaction signed by the motebit's identity key (which
 * IS the Solana address — Ed25519 curve coincidence, see
 * `packages/wallet-solana/CLAUDE.md`). Adding a batch-level signature
 * would be redundant.
 *
 * Doctrine: [`docs/doctrine/proactive-interior.md`](../../docs/doctrine/proactive-interior.md).
 */
export interface ConsolidationAnchor {
  /** UUID identifying this anchor batch. */
  batch_id: string;
  /** Motebit that produced the receipts in this batch (and signed the
   *  Solana transaction that carries the root, when onchain). */
  motebit_id: MotebitId;
  /** Hex-encoded SHA-256 Merkle root over the receipts' canonical-body
   *  leaf hashes. Stable for a given ordered set of receipts. */
  merkle_root: string;
  /** Receipt IDs included in this batch, in the order their leaf hashes
   *  were inserted into the Merkle tree. Consumers recomputing inclusion
   *  proofs MUST preserve this order. */
  receipt_ids: ReadonlyArray<string>;
  /** leaf_count = receipt_ids.length (duplicated for parsers that don't
   *  want to count the array). */
  leaf_count: number;
  /** Milliseconds since Unix epoch when the anchor was produced. */
  anchored_at: number;
  /** On-chain transaction hash (Solana signature base58 for
   *  `SolanaMemoSubmitter`) if the anchor was submitted. Absent when the
   *  anchor was constructed without a submitter. */
  tx_hash?: string;
  /** CAIP-2 network identifier the anchor was submitted to (e.g.,
   *  `"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"` for mainnet). Paired
   *  with `tx_hash` — absent when `tx_hash` is absent. */
  network?: string;
}

/**
 * Provenance discriminator on `ExecutionReceipt.invocation_origin` and on
 * relay task-submission bodies. Closed string-literal union; verifiers and
 * routers MAY use this to score, audit, or differentiate paths.
 *
 *   - `"user-tap"`        — explicit user authorization via a UI affordance
 *                           (chip, button, slash command, scene-object click,
 *                           voice opt-in). Strongest consent signal.
 *   - `"ai-loop"`         — the AI loop chose to delegate (e.g., the model
 *                           called `delegate_to_agent`). Weakest consent
 *                           signal — the user authorized the conversation,
 *                           not the specific delegation.
 *   - `"scheduled"`       — a cron / scheduled trigger initiated the task.
 *   - `"agent-to-agent"`  — a downstream agent initiated as part of its own
 *                           handleAgentTask (composition).
 *
 * Doctrine: `docs/doctrine/surface-determinism.md`.
 */
export type IntentOrigin = "user-tap" | "ai-loop" | "scheduled" | "agent-to-agent";

/**
 * Provenance tier for a citation's source. Mirrors the three-tier knowledge
 * hierarchy of the answer engine:
 *
 *   - `"interior"`  — the motebit's own pre-built knowledge corpus
 *                     (@motebit/self-knowledge). Offline, no delegation, no
 *                     receipt — the source is the committed corpus itself.
 *   - `"federation"` — another motebit queried through the delegation graph.
 *                      The `receipt_task_id` field binds the citation to a
 *                      specific signed ExecutionReceipt in the parent
 *                      receipt's `delegation_receipts` chain.
 *   - `"web"`       — an external URL fetched through a read-url atom. The
 *                     `receipt_task_id` binds to the read-url atom's signed
 *                     receipt; the claim is "this motebit actually read that
 *                     URL," not "this URL is correct."
 *
 * Verifiers treat `"interior"` as self-attested (trust the corpus checksum),
 * `"federation"` and `"web"` as receipt-attested (verify the bound receipt's
 * signature and match its `task_id`).
 */
export type CitationSource = "interior" | "federation" | "web";

/**
 * One grounded citation in a `CitedAnswer`. The `text_excerpt` is the span
 * actually incorporated into the answer; the `source` discriminator tells
 * verifiers how to check it.
 *
 * Wire format (foundation law): this is the universal shape for "here is
 * the source of one claim in my answer." Adding fields is additive; changing
 * the discriminator or removing fields is a wire-format break.
 */
export interface Citation {
  /** The span of source text the answer drew on. */
  text_excerpt: string;
  /** Which tier produced this source. */
  source: CitationSource;
  /**
   * For `"web"`: the fetched URL.
   * For `"interior"`: the doc path relative to the corpus (e.g., "README.md#section").
   * For `"federation"`: the queried motebit's ID.
   */
  locator: string;
  /**
   * For `"federation"` and `"web"` — the `task_id` of the bound
   * `ExecutionReceipt` in the parent answer's `delegation_receipts`. Undefined
   * for `"interior"` (the committed corpus is the provenance).
   */
  receipt_task_id?: string;
}

/**
 * A grounded answer with per-claim citations. Emitted by the answer-engine
 * path (research service today; any grounded-generation surface in future).
 *
 * Wire format: JCS-canonicalizable. Auditors with only `@motebit/protocol`
 * and `@motebit/crypto` can verify:
 *   1. The outer `receipt` signature.
 *   2. Every `citation.receipt_task_id` resolves to a receipt in
 *      `receipt.delegation_receipts` whose own signature verifies.
 *   3. For `"interior"` citations, the corpus hash matches the motebit's
 *      committed self-knowledge build.
 *
 * The answer text is a plain string; citation-to-text alignment is the
 * renderer's concern (e.g., numbered markers like `[1]` in `answer`).
 */
export interface CitedAnswer {
  /** Natural-language answer. */
  answer: string;
  /** Ordered list of sources. `answer` may reference them by index. */
  citations: Citation[];
  /**
   * Outer receipt signed by the emitting motebit. Its
   * `delegation_receipts` chain carries the per-atom signatures that
   * back each `"federation"` / `"web"` citation.
   */
  receipt: ExecutionReceipt;
}

/**
 * Self-attesting device-to-relay registration request body.
 *
 * The cryptographic equivalent of a TOFU handshake: the device signs a
 * canonical-JSON serialization of this object (with `signature` removed) using
 * its Ed25519 private key, and the relay verifies the signature against the
 * `public_key` carried in the same request. No prior trust anchor required —
 * the signature proves key control, and key control proves the registrant
 * controls this `motebit_id` going forward (until a key-rotation request
 * explicitly changes the binding, per `spec/auth-token-v1.md` §9).
 *
 * Wire format (foundation law) — the spec lives at
 * `spec/device-self-registration-v1.md`. Verifiers MUST reject requests that
 * fall outside the ±5-minute timestamp window; the relay endpoint is
 * intentionally auth-less because the signature IS the auth.
 *
 * Trust posture: a self-registered device starts at trust zero. Trust
 * accrues through receipts, credentials, and onchain anchors — never
 * through registration alone. See `docs/doctrine/protocol-model.md`.
 */
export interface DeviceRegistrationRequest {
  /** Self-asserted identifier. Bound to `public_key` upon successful registration. */
  motebit_id: MotebitId;
  /** Self-asserted device identifier. Bound to `public_key` for the device's lifetime. */
  device_id: string;
  /** 64-char lowercase hex Ed25519 public key (32 bytes). */
  public_key: string;
  /** Optional human-readable label for operator panels and audit logs. */
  device_name?: string;
  /**
   * Optional owner reference. Sovereign devices that own themselves SHOULD
   * set `"self:<motebit_id>"`. Multi-tenant SDKs MAY set their tenant
   * identifier. The relay defaults to `"self:<motebit_id>"` when absent.
   */
  owner_id?: string;
  /**
   * Epoch milliseconds at request creation. Relay rejects requests where
   * `abs(now - timestamp) > 5 minutes` — the only replay defense at the
   * wire level. See spec §6.1 for the threat model this defends.
   */
  timestamp: number;
  /**
   * Cryptosuite identifier. Routes through the suite-dispatch in
   * `@motebit/crypto`; PQ migration is a registry addition, not a
   * wire-format break.
   */
  suite: import("./crypto-suite.js").SuiteId;
  /**
   * base64url-encoded Ed25519 signature over the canonical-JSON
   * serialization of this object with `signature` removed.
   */
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
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-hex-v1"` for
   * this artifact today — JCS canonicalization of the unsigned payload,
   * Ed25519 primitive, hex signature encoding, hex public-key encoding.
   * The same suite as the identity frontmatter (spec/identity-v1.md §3.8).
   * Verifiers reject missing or unknown suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-hex-v1";
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

/**
 * Per-task settlement bookkeeping artifact.
 *
 * Foundation Law (services/api/CLAUDE.md rule 6):
 * - Every truth the relay asserts (credential anchor proofs,
 *   revocation memos, settlement receipts) is independently
 *   verifiable onchain without relay contact.
 *
 * The settlement is signed by the issuing relay over the canonical
 * JSON of all fields except `signature`. Verifiers reconstruct the
 * canonical bytes (omitting `signature`) and check Ed25519 against
 * the issuing relay's public key. A malicious relay therefore
 * cannot issue inconsistent records to different observers — the
 * signature commits the relay to the exact (amount_settled,
 * platform_fee, platform_fee_rate, status) tuple it published.
 *
 * Federation settlements additionally get Merkle-batched and
 * onchain-anchored (relay-federation-v1.md §7.6); per-agent
 * settlements rely on the signature for self-attestation.
 */
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
  /**
   * Issuing relay's motebit_id. The signer of this record. Must
   * match the public key resolvable through the relay's identity.
   */
  issuer_relay_id: string;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` —
   * JCS canonicalization, Ed25519 primitive, base64url signature
   * encoding. Verifiers reject missing or unknown values fail-closed.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  /**
   * Base64url-encoded Ed25519 signature by the issuing relay over
   * canonical JSON of all fields except `signature`. Lets a worker
   * (or any auditor) prove what the relay claimed without trusting
   * the relay's word about it.
   */
  signature: string;
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
 * Settlement rail — the external money-movement boundary, split by custody.
 *
 * Every rail is either a GuestRail (relay holds the money, rail moves it in/out)
 * or a SovereignRail (the agent holds the keys, the rail is the agent's own wallet).
 * The `custody` discriminant makes this a compile-time distinction.
 *
 * Doctrine: the relay's rail registry accepts only GuestRails. SovereignRails live
 * in the agent's runtime process and are never registered at the relay, because
 * sovereign means the agent signs its own transactions and the relay is not in
 * the signing path. The type system enforces the doctrine — not prose.
 *
 * See GuestRail and SovereignRail below for their respective contracts.
 */
export interface SettlementRail {
  /** Human-readable name for logging and config (e.g., "stripe", "solana-wallet"). */
  readonly name: string;

  /** Who holds the keys/funds this rail moves. Compile-time custody boundary. */
  readonly custody: "relay" | "agent";

  /** Whether this rail is currently available (provider reachable, config valid). */
  isAvailable(): Promise<boolean>;
}

/**
 * GuestRail — relay-custody settlement rail.
 *
 * The relay holds the user's money in a virtual account; a GuestRail moves it
 * across the relay's boundary to an external system and back. The rail is a
 * guest in the relay's economic loop — it doesn't hold the permanent ledger,
 * it just carries money through the membrane.
 *
 * Three rail types:
 * - "fiat" — traditional payment processor (Stripe Checkout)
 * - "protocol" — HTTP-native agent payment protocols (MPP, x402)
 * - "orchestration" — fiat↔crypto bridging (Bridge)
 *
 * There is no "direct_asset" GuestRail — direct onchain transfer is always
 * sovereign (the agent signs) and belongs in SovereignRail.
 *
 * Not all rails support deposits. Fiat rails accept proactive deposits.
 * Protocol rails (x402, MPP) are pay-per-request — money moves at the HTTP
 * boundary, not through the rail. Use `supportsDeposit` discriminant for
 * runtime narrowing: `if (rail.supportsDeposit) rail.deposit(...)`.
 *
 * The relay picks the rail at routing time based on what the counterparty accepts.
 */
export interface GuestRail extends SettlementRail {
  readonly custody: "relay";
  readonly railType: "fiat" | "protocol" | "orchestration";

  /** Whether this rail supports proactive deposits. False for pay-per-request rails (x402, MPP). */
  readonly supportsDeposit: boolean;

  /**
   * Whether the rail exposes a single-call batch withdrawal primitive.
   * When true, `withdrawBatch` MUST be implemented. When false (the
   * default for every rail that ships in the reference relay today),
   * aggregation is still a win at the relay layer — the batch worker
   * defers sub-threshold items and fires serially once the policy
   * clears — but the rail itself settles one item per call.
   * Mirrors `supportsDeposit` + `DepositableGuestRail` as a
   * discriminant narrowing to `BatchableGuestRail`.
   */
  readonly supportsBatch: boolean;

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
   * Submit multiple withdrawals in one rail call when the rail
   * supports a native batch primitive (e.g., a future x402 multi-
   * authorization, a Bridge bulk-transfer). Present only when
   * `supportsBatch` is true — narrow with `isBatchableRail`.
   */
  withdrawBatch?(items: readonly BatchWithdrawalItem[]): Promise<BatchWithdrawalResult>;

  /**
   * Record a payment proof with a settlement (e.g., x402 tx hash, Stripe charge ID).
   * Called after settleOnReceipt() computes the settlement record.
   */
  attachProof(settlementId: string, proof: PaymentProof): Promise<void>;
}

/**
 * Single item within a batch withdrawal submission. Amounts are
 * micro-units (1_000_000 = 1 unit of asset). The relay constructs
 * one item per `relay_pending_withdrawals` row.
 */
export interface BatchWithdrawalItem {
  readonly motebit_id: string;
  readonly amount_micro: number;
  readonly currency: string;
  readonly destination: string;
  readonly idempotency_key: string;
}

/**
 * Per-item outcome of a batch withdrawal. Partial failure is
 * first-class: a rail MAY succeed on some items and fail on others.
 * `failed[i].reason` is a human-readable string — not part of the
 * signed proof, just operator telemetry.
 */
export interface BatchWithdrawalResult {
  readonly fired: ReadonlyArray<{ item: BatchWithdrawalItem; result: WithdrawalResult }>;
  readonly failed: ReadonlyArray<{ item: BatchWithdrawalItem; reason: string }>;
}

/**
 * A guest rail that supports batch withdrawal submission.
 * Use the `supportsBatch` discriminant for runtime narrowing from `GuestRail`.
 */
export interface BatchableGuestRail extends GuestRail {
  readonly supportsBatch: true;
  withdrawBatch(items: readonly BatchWithdrawalItem[]): Promise<BatchWithdrawalResult>;
}

/**
 * A guest rail that supports proactive deposits (Stripe Checkout).
 * Use the `supportsDeposit` discriminant for runtime narrowing from `GuestRail`.
 */
export interface DepositableGuestRail extends GuestRail {
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

/** Type guard: narrows GuestRail to DepositableGuestRail. */
export function isDepositableRail(rail: GuestRail): rail is DepositableGuestRail {
  return rail.supportsDeposit;
}

/** Type guard: narrows GuestRail to BatchableGuestRail. */
export function isBatchableRail(rail: GuestRail): rail is BatchableGuestRail {
  return rail.supportsBatch === true && typeof rail.withdrawBatch === "function";
}

/**
 * SovereignRail — agent-custody settlement rail.
 *
 * The agent's identity key signs; the rail is the agent's own wallet. There is
 * no third-party custodian and the relay is not in the signing path. Withdrawal
 * from a sovereign rail is just a transfer — the funds never left the agent.
 *
 * Reference implementation: `SolanaWalletRail` in `@motebit/wallet-solana`.
 * The Ed25519 identity public key is natively a valid Solana address, so the
 * wallet address equals the motebit's identity — no second key, no key-derivation
 * ceremony, no vendor. Future Ed25519-native chains (Aptos, Sui) implement the
 * same interface.
 *
 * SovereignRails MUST NOT appear in the relay's guest rail registry. The type
 * split is mechanical: `SettlementRailRegistry.register` accepts only `GuestRail`,
 * so the compiler rejects attempts to register a sovereign rail at the relay.
 * This is the sovereignty doctrine expressed as a type.
 */
export interface SovereignRail extends SettlementRail {
  readonly custody: "agent";
  /** Chain identifier (e.g., "solana"). Future: "aptos", "sui". */
  readonly chain: string;
  /** Asset symbol (e.g., "USDC"). */
  readonly asset: string;
  /** Agent's own address on this chain. Equals the motebit identity public key for Ed25519-native chains. */
  readonly address: string;
  /** Current balance in micro-units (1e6 = 1 unit of asset). */
  getBalance(): Promise<bigint>;
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
  /**
   * Cryptosuite discriminator for `initiator_signature`. Always
   * `"motebit-jcs-ed25519-b64-v1"` today — JCS canonicalization of the
   * aggregate payload, Ed25519 primitive, base64url signature encoding.
   * Verifiers reject missing or unknown suite values fail-closed.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
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
  /**
   * Optional hardware-attestation claim. Present when the subject agent
   * demonstrated that its identity key lives inside a hardware keystore
   * (Secure Enclave, TPM, Android Keystore / Play Integrity, Apple
   * DeviceCheck). Consumed by `HardwareAttestationSemiring` in the
   * routing layer to rank hardware-attested agents above software-only
   * agents for sensitivity-aware delegation. See spec/credential-v1.md
   * §3.4 and `HardwareAttestationClaim`. Absence means "no claim"
   * (equivalent to `platform: "software"` for ranking purposes).
   */
  hardware_attestation?: HardwareAttestationClaim;
}

/**
 * Hardware attestation claim embedded in `TrustCredentialSubject`. One claim
 * describes the subject agent's key-custody posture on the device that issued
 * the credential.
 *
 * Wire format (foundation law) — see spec/credential-v1.md §3.4 for the
 * binding subsection. Every conformant implementation MUST emit these
 * field names and types; the claim is carried inside the existing
 * `AgentTrustCredential` VC envelope so the outer `suite` field already
 * covers the signature.
 *
 * `platform` enumerates the attestation surface; `"software"` is the
 * sentinel for "no hardware-backed key" and is explicitly part of the
 * enum so credentials can truthfully claim "we tried, there was no
 * hardware" rather than omit the field (which is ambiguous between
 * "unknown" and "software").
 *
 * `key_exported` matters because even a hardware-generated key can be
 * exported to software storage (e.g. backup, pairing, migration). When
 * `true`, the claim is weaker — the private material left the hardware,
 * so the binding between "this key is signing" and "this hardware held
 * it" is broken for the lifetime of the export.
 *
 * `attestation_receipt` is an opaque platform-specific blob (Apple
 * DeviceCheck assertion, Google Play Integrity token, TPM quote) that
 * a verifier with the matching platform adapter can independently
 * verify. Motebit does not parse these — adapters are glucose per the
 * metabolic principle; this field just reserves wire-format space for
 * them. Absence does not invalidate the claim; it just means the
 * verifier has no side-channel proof beyond the credential signature.
 */
export interface HardwareAttestationClaim {
  /**
   * Attestation surface identifier. `"software"` is the explicit
   * no-hardware sentinel — a credential that carries a claim with
   * `platform: "software"` is truthfully claiming "this key is not
   * hardware-backed", distinct from an absent claim ("unknown").
   */
  platform: "secure_enclave" | "tpm" | "play_integrity" | "device_check" | "webauthn" | "software";
  /**
   * True when the private key was exported from hardware to software
   * storage (backup, pairing). Weakens the claim — the hardware no
   * longer uniquely holds the material. Default false; absent ≡ false
   * for backward compatibility when a minting tool forgets to set it
   * on a software-only platform.
   */
  key_exported?: boolean;
  /**
   * Opaque platform-specific attestation blob. Apple DeviceCheck
   * assertion, Google Play Integrity token, or TPM quote bytes encoded
   * as the platform expects (base64url by convention). Motebit does not
   * parse this — platform adapters at the verification boundary do.
   * Absent when no platform receipt is available.
   */
  attestation_receipt?: string;
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
  /**
   * Optional self-issued `AgentTrustCredential` (JSON-serialized signed
   * VC) bearing a `hardware_attestation` claim about this device's
   * identity key. Identity metadata, not a credential-index entry —
   * served via `GET /agent/:motebitId/capabilities` so peers can pull,
   * verify, and issue their own peer credentials about this subject.
   * The `/credentials/submit` self-issued rejection (spec §23) remains
   * unchanged. See `spec/identity-v1.md` §3 (device record) and
   * `docs/doctrine/promoting-private-to-public.md` companion.
   */
  hardware_attestation_credential?: string;
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
  MaxProductLogSemiring,
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
  REFERENCE_TRUST_THRESHOLDS,
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

// ── Per-Agent Settlement Anchoring (protocol-level) ────────────────────────────
// Self-verifiable Merkle inclusion proofs for the per-agent settlement
// "ceiling" alongside the SettlementRecord signing "floor". Worker audit
// of relay-as-counterparty — distinct audience from federation peer audit
// (relay-federation-v1.md §7.6) and credential portability
// (credential-anchor-v1.md). Same Merkle primitive, different proof endpoint.
// motebit/agent-settlement-anchor@1.0.

export type {
  AgentSettlementAnchorBatch,
  AgentSettlementChainAnchor,
  AgentSettlementAnchorProof,
} from "./agent-settlement-anchor.js";

// ── Discovery (protocol-level) ────────────────────────────
// Relay metadata, DNS discovery, and agent resolution.
// motebit/discovery@1.0.

export type { RelayMetadata, RelayMetadataPeer, AgentResolutionResult } from "./discovery.js";

// ── Migration (protocol-level) ────────────────────────────
// Agent migration between relays with identity continuity and trust portability.
// motebit/migration@1.0.

export type {
  MigrationState,
  MigrationRequest,
  MigrationToken,
  DepartureAttestation,
  CredentialBundle,
  BalanceWaiver,
  MigrationPresentation,
} from "./migration.js";

// ── Dispute (protocol-level) ────────────────────────────
// Dispute resolution for agent-to-agent delegations.
// motebit/dispute@1.0.

export type {
  DisputeState,
  DisputeOutcome,
  DisputeCategory,
  DisputeFundAction,
  DisputeRequest,
  DisputeEvidence,
  DisputeEvidenceType,
  AdjudicatorVote,
  DisputeResolution,
  DisputeAppeal,
} from "./dispute.js";

// ── Settlement Mode (protocol-level) ────────────────────────────
// Relay-mediated vs peer-to-peer settlement selection.

export type {
  SettlementMode,
  P2pPaymentProof,
  PaymentVerificationStatus,
  SettlementEligibility,
  SolvencyProof,
} from "./settlement-mode.js";

// === Cryptosuite Registry ===
// Every signed wire-format artifact in motebit declares its verification
// recipe via a `suite: SuiteId` field. Missing or unknown values are
// rejected fail-closed. See `packages/protocol/src/crypto-suite.ts` for
// the registry and `packages/crypto/src/suite-dispatch.ts` for the
// verification hook. Post-quantum migration is a new registry entry,
// not a wire-format change.
export type {
  SuiteId,
  SuiteEntry,
  SuiteStatus,
  SuiteAlgorithm,
  SuiteCanonicalization,
  SuiteSignatureEncoding,
  SuitePublicKeyEncoding,
} from "./crypto-suite.js";
export { SUITE_REGISTRY, ALL_SUITE_IDS, isSuiteId, getSuiteEntry } from "./crypto-suite.js";

// ── Memory event payloads (spec/memory-delta-v1.md) ───────────────
export type {
  MemoryDecayedPayload,
  MemoryFormedPayload,
  MemoryAccessedPayload,
  MemoryPinnedPayload,
  MemoryDeletedPayload,
  MemoryConsolidatedPayload,
  MemoryAuditPayload,
  MemoryPromotedPayload,
} from "./memory-events.js";

// ── Goal-lifecycle event payloads (spec/goal-lifecycle-v1.md) ────
export type {
  GoalCreatedPayload,
  GoalExecutedPayload,
  GoalProgressPayload,
  GoalCompletedPayload,
  GoalRemovedPayload,
} from "./goal-lifecycle.js";

// ── Plan-lifecycle event payloads (spec/plan-lifecycle-v1.md) ────
export type {
  PlanCreatedPayload,
  PlanStepStartedPayload,
  PlanStepCompletedPayload,
  PlanStepFailedPayload,
  PlanStepDelegatedPayload,
  PlanCompletedPayload,
  PlanFailedPayload,
} from "./plan-lifecycle.js";

// ── Computer-use payloads (spec/computer-use-v1.md) ──────────────
export type {
  ComputerPoint,
  ComputerTargetHint,
  ScreenshotAction,
  CursorPositionAction,
  ClickAction,
  DoubleClickAction,
  MouseMoveAction,
  DragAction,
  TypeAction,
  KeyAction,
  ScrollAction,
  ComputerAction,
  ComputerActionKind,
  ComputerActionRequest,
  ComputerObservationResult,
  ComputerRedaction,
  ScreenshotObservation,
  CursorPositionObservation,
  ComputerSessionOpened,
  ComputerSessionClosed,
  ComputerFailureReason,
} from "./computer-use.js";
export { COMPUTER_ACTION_KINDS, COMPUTER_FAILURE_REASONS } from "./computer-use.js";

export type { ToolMode } from "./tool-mode.js";
export { TOOL_MODES, toolModePriority } from "./tool-mode.js";
import type { ToolMode } from "./tool-mode.js";
