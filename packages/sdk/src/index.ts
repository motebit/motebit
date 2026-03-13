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
export function asMotebitId(id: string): MotebitId { return id as MotebitId; }
/** Brand a string as a DeviceId after validation. */
export function asDeviceId(id: string): DeviceId { return id as DeviceId; }
/** Brand a string as a NodeId after validation. */
export function asNodeId(id: string): NodeId { return id as NodeId; }
/** Brand a string as a GoalId after validation. */
export function asGoalId(id: string): GoalId { return id as GoalId; }
/** Brand a string as an EventId after validation. */
export function asEventId(id: string): EventId { return id as EventId; }
/** Brand a string as a ConversationId after validation. */
export function asConversationId(id: string): ConversationId { return id as ConversationId; }
/** Brand a string as a PlanId after validation. */
export function asPlanId(id: string): PlanId { return id as PlanId; }
/** Brand a string as an AllocationId after validation. */
export function asAllocationId(id: string): AllocationId { return id as AllocationId; }
/** Brand a string as a SettlementId after validation. */
export function asSettlementId(id: string): SettlementId { return id as SettlementId; }
/** Brand a string as a ListingId after validation. */
export function asListingId(id: string): ListingId { return id as ListingId; }
/** Brand a string as a ProposalId after validation. */
export function asProposalId(id: string): ProposalId { return id as ProposalId; }

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

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  budgetRemaining?: { calls: number; timeMs: number; cost: number };
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
  collaborative: number;  // 0 | 1 for SQLite wire
}

/** Plan step record for cross-device sync. */
export interface SyncPlanStep {
  step_id: string;
  plan_id: PlanId;
  motebit_id: MotebitId;
  ordinal: number;
  description: string;
  prompt: string;
  depends_on: string;          // JSON-serialized string[] for wire format
  optional: boolean;
  status: StepStatus;
  required_capabilities: string | null;  // JSON-serialized DeviceCapability[] | null
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
}

export interface ExecutionReceipt {
  task_id: string;
  motebit_id: MotebitId;
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
  signature: string;
}

export interface DelegatedStepResult {
  step_id: string;
  task_id: string;
  receipt: ExecutionReceipt;
  result_text: string;
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
  | "goal_completed";

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
  delegation?: { task_id: string; receipt_hash?: string };
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

export interface SettlementRecord {
  settlement_id: SettlementId;
  allocation_id: AllocationId;
  receipt_hash: string;
  ledger_hash: string | null;
  amount_settled: number;
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
  assigned_steps: number[];  // step ordinals
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
}
