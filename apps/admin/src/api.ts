import type { MotebitState, MemoryNode, MemoryEdge, EventLogEntry, ToolAuditEntry } from "@motebit/sdk";

// === Config ===

export const config = {
  get apiUrl(): string {
    return (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8787";
  },
  get motebitId(): string {
    return (import.meta.env.VITE_MOTEBIT_ID as string | undefined) ?? "default-motebit";
  },
  get apiToken(): string {
    return (import.meta.env.VITE_API_TOKEN as string | undefined) ?? "";
  },
};

// === Error ===

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`API ${status}: ${statusText}`);
    this.name = "ApiError";
  }
}

// === Fetch Helper ===

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${config.apiUrl}${path}`;
  const headers = new Headers(init?.headers);
  if (config.apiToken) {
    headers.set("Authorization", `Bearer ${config.apiToken}`);
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, res.statusText, body);
  }
  return res.json() as Promise<T>;
}

// === Response Types ===

export interface StateResponse {
  motebit_id: string;
  state: MotebitState;
}

export interface MemoryResponse {
  motebit_id: string;
  memories: MemoryNode[];
  edges: MemoryEdge[];
}

export interface EventsResponse {
  motebit_id: string;
  events: EventLogEntry[];
  after_clock: number;
}

export interface DeleteMemoryResponse {
  motebit_id: string;
  node_id: string;
  deleted: boolean;
}

export interface HealthResponse {
  status: string;
  timestamp: number;
}

export interface AuditResponse {
  motebit_id: string;
  entries: ToolAuditEntry[];
}

// === Endpoint Functions ===

export function fetchState(signal?: AbortSignal): Promise<StateResponse> {
  return apiFetch<StateResponse>(`/api/v1/state/${config.motebitId}`, { signal });
}

export function fetchMemory(signal?: AbortSignal): Promise<MemoryResponse> {
  return apiFetch<MemoryResponse>(`/api/v1/memory/${config.motebitId}`, { signal });
}

export function fetchEvents(afterClock: number, signal?: AbortSignal): Promise<EventsResponse> {
  return apiFetch<EventsResponse>(
    `/api/v1/sync/${config.motebitId}/pull?after_clock=${afterClock}`,
    { signal },
  );
}

export function deleteMemoryNode(nodeId: string, signal?: AbortSignal): Promise<DeleteMemoryResponse> {
  return apiFetch<DeleteMemoryResponse>(
    `/api/v1/memory/${config.motebitId}/${nodeId}`,
    { method: "DELETE", signal },
  );
}

export function fetchAudit(signal?: AbortSignal): Promise<AuditResponse> {
  return apiFetch<AuditResponse>(`/api/v1/audit/${config.motebitId}`, { signal });
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/health", { signal });
}

// === Goals ===

export interface GoalEntry {
  goal_id: string;
  motebit_id: string;
  prompt: string;
  interval_ms: number;
  last_run_at: number | null;
  enabled: boolean;
  created_at: number;
  mode: "recurring" | "once";
  status: "active" | "completed" | "failed" | "paused";
  parent_goal_id: string | null;
  max_retries: number;
  consecutive_failures: number;
}

export interface GoalsResponse {
  motebit_id: string;
  goals: GoalEntry[];
}

export function fetchGoals(signal?: AbortSignal): Promise<GoalsResponse> {
  return apiFetch<GoalsResponse>(`/api/v1/goals/${config.motebitId}`, { signal });
}

// === Conversations ===

export interface ConversationEntry {
  conversation_id: string;
  motebit_id: string;
  started_at: number;
  last_active_at: number;
  title: string | null;
  summary: string | null;
  message_count: number;
}

export interface ConversationMessageEntry {
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

export interface ConversationsResponse {
  motebit_id: string;
  conversations: ConversationEntry[];
}

export interface ConversationMessagesResponse {
  motebit_id: string;
  conversation_id: string;
  messages: ConversationMessageEntry[];
}

export function fetchConversations(signal?: AbortSignal): Promise<ConversationsResponse> {
  return apiFetch<ConversationsResponse>(`/api/v1/conversations/${config.motebitId}`, { signal });
}

export function fetchConversationMessages(conversationId: string, signal?: AbortSignal): Promise<ConversationMessagesResponse> {
  return apiFetch<ConversationMessagesResponse>(
    `/api/v1/conversations/${config.motebitId}/${conversationId}/messages`,
    { signal },
  );
}

// === Plans ===

export interface PlanStepEntry {
  step_id: string;
  plan_id: string;
  ordinal: number;
  description: string;
  prompt: string;
  depends_on: string[];
  optional: boolean;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result_summary: string | null;
  error_message: string | null;
  tool_calls_made: number;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
}

export interface PlanEntry {
  plan_id: string;
  goal_id: string;
  motebit_id: string;
  title: string;
  status: "active" | "completed" | "failed" | "paused";
  created_at: number;
  updated_at: number;
  current_step_index: number;
  total_steps: number;
  steps: PlanStepEntry[];
}

export interface PlansResponse {
  motebit_id: string;
  plans: PlanEntry[];
}

export interface SinglePlanResponse {
  motebit_id: string;
  plan: PlanEntry;
}

export function fetchPlans(signal?: AbortSignal): Promise<PlansResponse> {
  return apiFetch<PlansResponse>(`/api/v1/plans/${config.motebitId}`, { signal });
}

export function fetchPlan(planId: string, signal?: AbortSignal): Promise<SinglePlanResponse> {
  return apiFetch<SinglePlanResponse>(`/api/v1/plans/${config.motebitId}/${planId}`, { signal });
}

// === Devices ===

export interface DeviceEntry {
  device_id: string;
  motebit_id: string;
  device_name: string | null;
  public_key: string;
  registered_at: number;
  last_seen_at: number | null;
}

export interface DevicesResponse {
  motebit_id: string;
  devices: DeviceEntry[];
}

export function fetchDevices(signal?: AbortSignal): Promise<DevicesResponse> {
  return apiFetch<DevicesResponse>(`/api/v1/devices/${config.motebitId}`, { signal });
}

// === Gradient ===

export interface GradientSnapshotEntry {
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
  };
}

export interface GradientResponse {
  motebit_id: string;
  current: GradientSnapshotEntry | null;
  history: GradientSnapshotEntry[];
}

export function fetchGradient(signal?: AbortSignal): Promise<GradientResponse> {
  return apiFetch<GradientResponse>(`/api/v1/gradient/${config.motebitId}`, { signal });
}
