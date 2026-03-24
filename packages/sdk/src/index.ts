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

// ── Trust Semiring Algebra ──────────────────────────────────────────
// (TrustScores, max, ×, 0, 1) — standard algebraic path problem.
// Multiplicative discount for serial chains, max for parallel paths.

/** Canonical AgentTrustLevel → [0,1] mapping (single source of truth). */
export const TRUST_LEVEL_SCORES: Record<string, number> = {
  [AgentTrustLevel.Unknown]: 0.1,
  [AgentTrustLevel.FirstContact]: 0.3,
  [AgentTrustLevel.Verified]: 0.6,
  [AgentTrustLevel.Trusted]: 0.9,
  [AgentTrustLevel.Blocked]: 0.0,
};

/** Convert a trust level to its numeric score. */
export function trustLevelToScore(level: AgentTrustLevel | string): number {
  return TRUST_LEVEL_SCORES[level] ?? 0.1;
}

/** Semiring zero — annihilator for ⊗, identity for ⊕. */
export const TRUST_ZERO = 0;

/** Semiring one — identity for ⊗. */
export const TRUST_ONE = 1;

/** ⊕: parallel paths — pick the best route. */
export function trustAdd(a: number, b: number): number {
  return Math.max(a, b);
}

/** ⊗: serial chain — discount per hop. */
export function trustMultiply(a: number, b: number): number {
  return a * b;
}

/** Fold a chain of trust scores with ⊗. Empty chain → 1.0 (identity). */
export function composeTrustChain(scores: number[]): number {
  return scores.reduce(trustMultiply, TRUST_ONE);
}

/** Fold parallel route scores with ⊕. No routes → 0.0 (identity). */
export function joinParallelRoutes(scores: number[]): number {
  return scores.reduce(trustAdd, TRUST_ZERO);
}

// ── Trust Level Transitions (reputation state machine) ────────────

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

export const DEFAULT_TRUST_THRESHOLDS: TrustTransitionThresholds = {
  promoteToVerified_minTasks: 5,
  promoteToVerified_minRate: 0.8,
  promoteToTrusted_minTasks: 20,
  promoteToTrusted_minRate: 0.9,
  demote_belowRate: 0.5,
  demote_minTasks: 3,
};

/**
 * Pure: evaluate whether a trust record should transition levels.
 *
 * Promotion: sustained evidence of success (asymmetric — harder to earn).
 * Demotion: success rate dropping below threshold (faster — protect the network).
 * Blocked is never auto-assigned or auto-removed (security decision).
 *
 * Returns the new level, or null if no transition.
 */
export function evaluateTrustTransition(
  record: AgentTrustRecord,
  thresholds?: Partial<TrustTransitionThresholds>,
): AgentTrustLevel | null {
  const t = { ...DEFAULT_TRUST_THRESHOLDS, ...thresholds };
  const level = record.trust_level;
  const succeeded = record.successful_tasks ?? 0;
  const failed = record.failed_tasks ?? 0;
  const total = succeeded + failed;

  // Blocked is manual-only — never auto-transition in or out
  if (level === AgentTrustLevel.Blocked) return null;

  const rate = total > 0 ? succeeded / total : 1;

  // Check demotion first (fail-fast, protect the network)
  if (total >= t.demote_minTasks && rate < t.demote_belowRate) {
    if (level === AgentTrustLevel.Trusted) return AgentTrustLevel.Verified;
    if (level === AgentTrustLevel.Verified) return AgentTrustLevel.FirstContact;
    // FirstContact and Unknown can't demote further (Blocked is manual)
    return null;
  }

  // Check promotion (asymmetric — higher bar)
  if (level === AgentTrustLevel.Unknown && total >= 1) {
    return AgentTrustLevel.FirstContact;
  }
  if (
    level === AgentTrustLevel.FirstContact &&
    succeeded >= t.promoteToVerified_minTasks &&
    rate >= t.promoteToVerified_minRate
  ) {
    return AgentTrustLevel.Verified;
  }
  if (
    level === AgentTrustLevel.Verified &&
    succeeded >= t.promoteToTrusted_minTasks &&
    rate >= t.promoteToTrusted_minRate
  ) {
    return AgentTrustLevel.Trusted;
  }

  return null;
}

/** Structural type for recursive delegation receipt walking. */
export interface DelegationReceiptLike {
  motebit_id: string;
  delegation_receipts?: DelegationReceiptLike[];
}

/**
 * Compose trust through a delegation receipt tree.
 *
 * Walks `receipt.delegation_receipts` recursively:
 * - Each sub-delegation: directTrust ⊗ getTrust(sub.motebit_id)
 * - Parallel branches joined with ⊕ (best route wins)
 * - No sub-delegations → returns directTrust unchanged.
 */
export function composeDelegationTrust(
  directTrust: number,
  receipt: DelegationReceiptLike,
  getTrust: (motebitId: string) => number,
): number {
  const subs = receipt.delegation_receipts;
  if (!subs || subs.length === 0) return directTrust;

  const branchScores = subs.map((sub) => {
    const subTrust = getTrust(sub.motebit_id);
    const chainScore = trustMultiply(directTrust, subTrust);
    // Recurse: sub may have its own delegation_receipts
    return composeDelegationTrust(chainScore, sub, getTrust);
  });

  return joinParallelRoutes(branchScores);
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

export enum RelationType {
  Related = "related",
  CausedBy = "caused_by",
  FollowedBy = "followed_by",
  ConflictsWith = "conflicts_with",
  Reinforces = "reinforces",
  PartOf = "part_of",
  Supersedes = "supersedes",
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

// === State Vector ===

export interface MotebitState {
  attention: number;
  processing: number;
  confidence: number;
  affect_valence: number;
  affect_arousal: number;
  social_distance: number;
  curiosity: number;
  trust_mode: TrustMode;
  battery_mode: BatteryMode;
}

// === Behavior Cues ===

export interface BehaviorCues {
  hover_distance: number;
  drift_amplitude: number;
  glow_intensity: number;
  eye_dilation: number;
  smile_curvature: number;
  speaking_activity: number;
}

// === Species Constraints (type re-export only — enforcement in policy-invariants) ===

export const SPECIES_CONSTRAINTS = Object.freeze({
  MAX_AROUSAL: 0.35,
  SMILE_DELTA_MAX: 0.08,
  GLOW_DELTA_MAX: 0.15,
  DRIFT_VARIATION_MAX: 0.1,
} as const);

export type SpeciesConstraints = typeof SPECIES_CONSTRAINTS;

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

/** Full memory node including persistence metadata. */
export interface MemoryNode extends MemoryContent {
  node_id: NodeId;
  motebit_id: MotebitId;
  embedding: number[];
  created_at: number;
  last_accessed: number;
  half_life: number;
  tombstoned: boolean;
  pinned: boolean;
}

export interface MemoryEdge {
  edge_id: string;
  source_id: NodeId;
  target_id: NodeId;
  relation_type: RelationType;
  weight: number;
  confidence: number;
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

// === AI Provider ===

export interface ContextPack {
  recent_events: EventLogEntry[];
  relevant_memories: MemoryContent[];
  current_state: MotebitState;
  user_message: string;
  conversation_history?: ConversationMessage[];
  behavior_cues?: BehaviorCues;
  tools?: ToolDefinition[];
  /** Session resumption info — set when continuing a persisted conversation. */
  sessionInfo?: { continued: boolean; lastActiveAt: number };
  /** Fading memories the agent might want to check in about, if relevant to conversation. */
  curiosityHints?: Array<{ content: string; daysSinceDiscussed: number }>;
  /** Known agents this motebit has interacted with — trust levels, reputation, interaction history. */
  knownAgents?: AgentTrustRecord[];
  /** Capabilities per agent ID — used to enrich [Agents I Know] so the AI knows what each agent can do. */
  agentCapabilities?: Record<string, string[]>;
  /** Active inference precision context — modulates agent behavior based on intelligence gradient. */
  precisionContext?: string;
  /** First conversation ever — creature should form memories eagerly and discover direction. */
  firstConversation?: boolean;
  /** System-triggered generation — appended to system prompt, no user message sent. */
  activationPrompt?: string;
}

export type ConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AIResponse {
  text: string;
  confidence: number;
  memory_candidates: MemoryCandidate[];
  state_updates: Partial<MotebitState>;
  tool_calls?: ToolCall[];
  /** Token usage from the provider, if available. */
  usage?: { input_tokens: number; output_tokens: number };
}

export interface IntelligenceProvider {
  generate(contextPack: ContextPack): Promise<AIResponse>;
  estimateConfidence(): Promise<number>;
  extractMemoryCandidates(response: AIResponse): Promise<MemoryCandidate[]>;
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

export interface ExportManifest {
  motebit_id: MotebitId;
  exported_at: number;
  identity: MotebitIdentity;
  memories: MemoryNode[];
  edges: MemoryEdge[];
  events: EventLogEntry[];
  audit_log: AuditRecord[];
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

// === Render Spec ===

export interface RenderSpec {
  geometry: GeometrySpec;
  material: MaterialSpec;
  lighting: LightingSpec;
}

export interface GeometrySpec {
  form: "droplet";
  base_radius: number;
  height: number;
}

export interface MaterialSpec {
  ior: number;
  subsurface: number;
  roughness: number;
  clearcoat: number;
  surface_noise_amplitude: number;
  base_color: [number, number, number];
  emissive_intensity: number;
  tint: [number, number, number]; // Attenuation color — glass absorption spectrum
}

export interface LightingSpec {
  environment: "hdri";
  exposure: number;
  ambient_intensity: number;
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
  /** Cryptographic binding to the relay's economic identity for this task. */
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
 * A key succession record proving that one Ed25519 key has been replaced by another.
 * Both the old and new keys sign the record, creating a cryptographic chain of custody.
 * Structurally compatible with @motebit/crypto KeySuccessionRecord.
 */
export interface KeySuccessionRecord {
  old_public_key: string; // hex
  new_public_key: string; // hex
  timestamp: number;
  reason?: string;
  old_key_signature: string; // hex, old key signs the canonical payload
  new_key_signature: string; // hex, new key signs the canonical payload
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
 * The relay's settlement fee rate (5%).
 * Applied to every completed or partial settlement that flows through the relay.
 * This is the Stripe model: the relay proves the work happened, takes its cut.
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

// === Active Inference Precision ===

/**
 * Precision weights derived from the intelligence gradient.
 *
 * In active inference, precision modulates the balance between epistemic value
 * (exploration/curiosity) and pragmatic value (exploitation/reputation).
 * The gradient measures model evidence; precision is the agent's confidence
 * in its own generative model.
 *
 * High gradient → high self-trust → exploit known-good routes, trust memory.
 * Low gradient → low self-trust → explore, diversify, question memory.
 */
// === Verifiable Credential Subject Types ===

export const VC_TYPE_GRADIENT = "AgentGradientCredential";
export const VC_TYPE_REPUTATION = "AgentReputationCredential";
export const VC_TYPE_TRUST = "AgentTrustCredential";

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

// === Active Inference Precision ===

export interface PrecisionWeights {
  /** Overall self-trust [0-1]. Sigmoid of composite gradient. */
  selfTrust: number;
  /** Exploration drive [0-1]. Inverse of self-trust, modulated by gradient delta. */
  explorationDrive: number;
  /** Memory retrieval precision [0-1]. High = trust similarity, low = diversify. */
  retrievalPrecision: number;
  /** Curiosity modulation [0-1]. Fed back into state vector curiosity field. */
  curiosityModulation: number;
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

export interface GradientSnapshot {
  motebit_id: string;
  timestamp: number;
  gradient: number;
  delta: number;
  knowledge_density: number;
  knowledge_density_raw: number;
  knowledge_quality: number;
  graph_connectivity: number;
  graph_connectivity_raw: number;
  temporal_stability: number;
  retrieval_quality: number;
  interaction_efficiency: number;
  tool_efficiency: number;
  curiosity_pressure: number;
  stats: {
    live_nodes: number;
    live_edges: number;
    semantic_count: number;
    episodic_count: number;
    pinned_count: number;
    avg_confidence: number;
    avg_half_life: number;
    consolidation_add: number;
    consolidation_update: number;
    consolidation_reinforce: number;
    consolidation_noop: number;
    total_confidence_mass: number;
    avg_retrieval_score: number;
    retrieval_count: number;
    avg_iterations_per_turn: number;
    total_turns: number;
    tool_calls_succeeded: number;
    tool_calls_blocked: number;
    tool_calls_failed: number;
    curiosity_target_count: number;
    avg_curiosity_score: number;
  };
}

export interface GradientStoreAdapter {
  save(snapshot: GradientSnapshot): void;
  latest(motebitId: string): GradientSnapshot | null;
  list(motebitId: string, limit?: number): GradientSnapshot[];
}

// --- Adapter interfaces from Layer 1-3 packages ---
// Moved here so StorageAdapters (the integration hub) can live in SDK,
// eliminating the browser-persistence → runtime layer violation entirely.

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

export interface MemoryQuery {
  motebit_id: string;
  min_confidence?: number;
  sensitivity_filter?: SensitivityLevel[];
  limit?: number;
  include_tombstoned?: boolean;
  pinned?: boolean;
}

export interface MemoryStorageAdapter {
  saveNode(node: MemoryNode): Promise<void>;
  getNode(nodeId: string): Promise<MemoryNode | null>;
  queryNodes(query: MemoryQuery): Promise<MemoryNode[]>;
  saveEdge(edge: MemoryEdge): Promise<void>;
  getEdges(nodeId: string): Promise<MemoryEdge[]>;
  tombstoneNode(nodeId: string): Promise<void>;
  /** Tombstone with ownership check. Returns true if the node existed and belonged to motebitId. */
  tombstoneNodeOwned?(nodeId: string, motebitId: string): Promise<boolean>;
  pinNode(nodeId: string, pinned: boolean): Promise<void>;
  getAllNodes(motebitId: string): Promise<MemoryNode[]>;
  getAllEdges(motebitId: string): Promise<MemoryEdge[]>;
}

export interface DeviceRegistration {
  device_id: string;
  motebit_id: string;
  device_token: string;
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

export interface StorageAdapters {
  eventStore: EventStoreAdapter;
  memoryStorage: MemoryStorageAdapter;
  identityStorage: IdentityStorage;
  auditLog: AuditLogAdapter;
  stateSnapshot?: StateSnapshotAdapter;
  toolAuditSink?: AuditLogSink;
  conversationStore?: ConversationStoreAdapter;
  planStore?: PlanStoreAdapter;
  gradientStore?: GradientStoreAdapter;
  agentTrustStore?: AgentTrustStoreAdapter;
  serviceListingStore?: ServiceListingStoreAdapter;
  budgetAllocationStore?: BudgetAllocationStoreAdapter;
  settlementStore?: SettlementStoreAdapter;
  latencyStatsStore?: LatencyStatsStoreAdapter;
  credentialStore?: CredentialStoreAdapter;
  approvalStore?: ApprovalStoreAdapter;
}
