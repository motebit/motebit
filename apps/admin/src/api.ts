import type { MotebitState, MemoryNode, MemoryEdge, EventLogEntry } from "@motebit/sdk";

// === Config ===

export const config = {
  get apiUrl(): string {
    return import.meta.env.VITE_API_URL || "http://localhost:8787";
  },
  get motebitId(): string {
    return import.meta.env.VITE_MOTEBIT_ID || "default-motebit";
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
  const res = await fetch(url, init);
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

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/health", { signal });
}
