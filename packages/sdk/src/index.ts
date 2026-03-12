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

export interface AgentTrustRecord {
  motebit_id: string;
  remote_motebit_id: string;
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
  PlanFailed = "plan_failed",
  HousekeepingRun = "housekeeping_run",
  ReflectionCompleted = "reflection_completed",
  MemoryConsolidated = "memory_consolidated",
  AgentTaskCompleted = "agent_task_completed",
  AgentTaskFailed = "agent_task_failed",
  AgentTaskDenied = "agent_task_denied",
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
  readonly motebit_id: string;
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
  node_id: string;
  motebit_id: string;
  embedding: number[];
  created_at: number;
  last_accessed: number;
  half_life: number;
  tombstoned: boolean;
  pinned: boolean;
}

export interface MemoryEdge {
  edge_id: string;
  source_id: string;
  target_id: string;
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
  event_id: string;
  motebit_id: string;
  /** Device that originated this event (for multi-device conflict resolution) */
  device_id?: string;
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
  motebit_id: string;
  timestamp: number;
  action: string;
  target_type: string;
  target_id: string;
  details: Record<string, unknown>;
}

export interface ExportManifest {
  motebit_id: string;
  exported_at: number;
  identity: MotebitIdentity;
  memories: MemoryNode[];
  edges: MemoryEdge[];
  events: EventLogEntry[];
  audit_log: AuditRecord[];
}

// === Sync ===

export interface SyncCursor {
  motebit_id: string;
  last_event_id: string;
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
  conversation_id: string;
  motebit_id: string;
  started_at: number;
  last_active_at: number;
  title: string | null;
  summary: string | null;
  message_count: number;
}

/** Conversation message for sync. Matches persistence ConversationMessage shape using snake_case for wire format. */
export interface SyncConversationMessage {
  message_id: string;
  conversation_id: string;
  motebit_id: string;
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
  plan_id: string;
  ordinal: number;
  description: string;
  prompt: string;
  depends_on: string[];
  optional: boolean;
  status: StepStatus;
  result_summary: string | null;
  error_message: string | null;
  tool_calls_made: number;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
}

export interface Plan {
  plan_id: string;
  goal_id: string;
  motebit_id: string;
  title: string;
  status: PlanStatus;
  created_at: number;
  updated_at: number;
  current_step_index: number;
  total_steps: number;
}

// === Agent Protocol ===

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
  motebit_id: string;
  prompt: string;
  submitted_at: number;
  submitted_by?: string;
  wall_clock_ms?: number;
  status: AgentTaskStatus;
  claimed_by?: string;
}

export interface ExecutionReceipt {
  task_id: string;
  motebit_id: string;
  device_id: string;
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

export interface AgentCapabilities {
  motebit_id: string;
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
