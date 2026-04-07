export * from "@motebit/protocol";
export * from "./models.js";
export * from "./provider-mode.js";
export * from "./provider-resolver.js";
export * from "./color-presets.js";
export * from "./approval-presets.js";
export * from "./governance-config.js";

import type {
  SensitivityLevel,
  NodeId,
  MotebitId,
  TrustMode,
  BatteryMode,
  EventLogEntry,
  MemoryContent,
  MemoryCandidate,
  ToolDefinition,
  AgentTrustRecord,
  EventStoreAdapter,
  IdentityStorage,
  AuditLogAdapter,
  StateSnapshotAdapter,
  AuditLogSink,
  ConversationStoreAdapter,
  PlanStoreAdapter,
  AgentTrustStoreAdapter,
  ServiceListingStoreAdapter,
  BudgetAllocationStoreAdapter,
  SettlementStoreAdapter,
  LatencyStatsStoreAdapter,
  CredentialStoreAdapter,
  ApprovalStoreAdapter,
  MotebitIdentity,
  AuditRecord,
} from "@motebit/protocol";

// === Relation Types (product — graph semantics for memory edges) ===

export enum RelationType {
  Related = "related",
  CausedBy = "caused_by",
  FollowedBy = "followed_by",
  ConflictsWith = "conflicts_with",
  Reinforces = "reinforces",
  PartOf = "part_of",
  Supersedes = "supersedes",
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

// === Memory (product extensions) ===

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

// === Export ===

export interface ExportManifest {
  motebit_id: MotebitId;
  exported_at: number;
  identity: MotebitIdentity;
  memories: MemoryNode[];
  edges: MemoryEdge[];
  events: EventLogEntry[];
  audit_log: AuditRecord[];
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

// === Gradient ===

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

// === Root Storage Container ===

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

// === Credential & Verification Boundaries ===
// Canonical definitions — imported by mcp-client, runtime, sync-engine.
// Do not duplicate these types in other packages.

/** Context passed to CredentialSource when requesting a credential. */
export interface CredentialRequest {
  /** URL of the MCP server being called. */
  serverUrl: string;
  /** Tool name being invoked, if known at credential-acquisition time. */
  toolName?: string;
  /** Requested scope or audience for scoped credentials. */
  scope?: string;
  /** Motebit ID of the calling agent, if available. */
  agentId?: string;
}

/**
 * Adapter interface for obtaining credentials at tool-call time.
 * Implementations may read from OS keyring, external vaults, or wrap static tokens.
 */
export interface CredentialSource {
  getCredential(request: CredentialRequest): Promise<string | null>;
}

/** Config fields that server verifiers can update via VerificationResult. */
export interface VerifierConfigUpdates {
  toolManifestHash?: string;
  pinnedToolNames?: string[];
  trusted?: boolean;
  tlsCertFingerprint?: string;
}

/** Result of server verification. */
export interface VerificationResult {
  ok: boolean;
  error?: string;
  configUpdates?: VerifierConfigUpdates;
}

/**
 * Adapter interface for verifying an MCP server's integrity after connect.
 * Fail-closed: ok:false or thrown errors should tear down the connection.
 */
export interface ServerVerifier {
  verify(
    config: {
      name: string;
      url?: string;
      toolManifestHash?: string;
      pinnedToolNames?: string[];
      trusted?: boolean;
      tlsCertFingerprint?: string;
    },
    tools: ToolDefinition[],
  ): Promise<VerificationResult>;
}
