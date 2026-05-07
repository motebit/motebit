// === Config ===
//
// Operator surface is fleet-scoped — no VITE_MOTEBIT_ID. Same auth model
// as apps/inspector: static bearer via VITE_API_TOKEN. The relay's
// /api/v1/admin/* routes use bearerAuth({ token: apiToken }) with no
// audience binding (master-token only).

export const config = {
  get apiUrl(): string {
    return (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3000";
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

// === Fetch helper ===

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

// === Withdrawals ===

export interface WithdrawalRequest {
  withdrawal_id: string;
  motebit_id: string;
  amount: number;
  destination: string;
  requested_at: number;
}

export interface PendingWithdrawalsResponse {
  withdrawals: WithdrawalRequest[];
  count: number;
}

export function fetchPendingWithdrawals(signal?: AbortSignal): Promise<PendingWithdrawalsResponse> {
  return apiFetch<PendingWithdrawalsResponse>(`/api/v1/admin/withdrawals/pending`, { signal });
}

export function completeWithdrawal(
  withdrawalId: string,
  payoutReference: string,
): Promise<{ withdrawal_id: string; status: string }> {
  return apiFetch<{ withdrawal_id: string; status: string }>(
    `/api/v1/admin/withdrawals/${withdrawalId}/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payout_reference: payoutReference }),
    },
  );
}

export function failWithdrawal(
  withdrawalId: string,
  reason: string,
): Promise<{ withdrawal_id: string; status: string; refunded: boolean }> {
  return apiFetch<{ withdrawal_id: string; status: string; refunded: boolean }>(
    `/api/v1/admin/withdrawals/${withdrawalId}/fail`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
}

// === Federation peers ===

export interface PeerEntry {
  peer_relay_id: string;
  public_key: string;
  endpoint_url: string;
  display_name: string | null;
  state: string;
  peered_at: number | null;
  last_heartbeat_at: number | null;
  missed_heartbeats: number;
  agent_count: number;
  trust_score: number;
}

export interface PeersResponse {
  peers: PeerEntry[];
}

export function fetchFederationPeers(signal?: AbortSignal): Promise<PeersResponse> {
  // /federation/v1/peers is public; bearer is harmless if attached.
  return apiFetch<PeersResponse>(`/federation/v1/peers`, { signal });
}

export interface RelayIdentity {
  spec: string;
  relay_motebit_id: string;
  public_key: string;
  did: string;
}

export function fetchRelayIdentity(signal?: AbortSignal): Promise<RelayIdentity> {
  return apiFetch<RelayIdentity>(`/federation/v1/identity`, { signal });
}

// === Transparency ===

export interface TransparencyDeclared {
  spec: string;
  declared_at: number;
  relay_id: string;
  relay_public_key: string;
  content: Record<string, unknown>;
  signature: string;
}

export interface TransparencyProven {
  declaration: Record<string, unknown>;
  onchain_anchor: { status: string; rationale?: string };
  doctrine: Record<string, unknown> | null;
}

export function fetchTransparencyDeclared(signal?: AbortSignal): Promise<TransparencyDeclared> {
  return apiFetch<TransparencyDeclared>(`/.well-known/motebit-transparency.json`, { signal });
}

export function fetchTransparencyProven(signal?: AbortSignal): Promise<TransparencyProven> {
  return apiFetch<TransparencyProven>(`/api/v1/admin/transparency`, { signal });
}

// === Disputes ===

export interface DisputeStats {
  total: number;
  opened: number;
  evidence: number;
  resolved: number;
  appealed: number;
}

export interface DisputeEntry {
  dispute_id: string;
  allocation_id: string;
  filing_party: string;
  respondent: string;
  status: string;
  opened_at: number;
  resolved_at: number | null;
  resolution: string | null;
  rationale: string | null;
}

export interface DisputesResponse {
  disputes: DisputeEntry[];
  stats: DisputeStats;
}

export function fetchDisputes(signal?: AbortSignal): Promise<DisputesResponse> {
  return apiFetch<DisputesResponse>(`/api/v1/admin/disputes`, { signal });
}

// === Fees ===
//
// Endpoint shipped in commit 4. Until then, fetchFees returns null and the
// FeesPanel renders an "endpoint pending" state — no client-side fabrication.

export interface FeesByPeriod {
  period_start: number;
  period_end: number;
  collected_micro: number;
}

export interface FeesByRail {
  rail: string;
  collected_micro: number;
}

export interface FeesResponse {
  total_collected_micro: number;
  total_collected_currency: string;
  by_period: FeesByPeriod[];
  by_rail: FeesByRail[];
  fee_rate: number;
  sample_window_days: number;
}

export function fetchFees(signal?: AbortSignal): Promise<FeesResponse | null> {
  return apiFetch<FeesResponse>(`/api/v1/admin/fees`, { signal }).catch((err) => {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  });
}

// === Credential anchoring ===

export interface AnchorBatchEntry {
  batch_id: string;
  relay_id: string;
  merkle_root: string;
  leaf_count: number;
  first_issued_at: number;
  last_issued_at: number;
  signature: string;
  anchor: {
    chain: string;
    network: string;
    tx_hash: string;
    anchored_at: number;
  } | null;
}

export interface AnchoringStats {
  total_batches: number;
  confirmed_batches: number;
  total_credentials_anchored: number;
  pending_credentials: number;
}

export interface AnchoringResponse {
  stats: AnchoringStats;
  batches: AnchorBatchEntry[];
  anchor_address: string | null;
  chain_enabled: boolean;
}

export function fetchAnchoring(signal?: AbortSignal): Promise<AnchoringResponse> {
  return apiFetch<AnchoringResponse>(`/api/v1/admin/credential-anchoring`, { signal });
}

// === Reconciliation ===

export interface ReconciliationResult {
  consistent: boolean;
  errors: string[];
}

export function fetchReconciliation(signal?: AbortSignal): Promise<ReconciliationResult> {
  return apiFetch<ReconciliationResult>(`/api/v1/admin/reconciliation`, { signal });
}

// === Receipts ===
//
// The relay returns the byte-identical canonical JSON of the stored
// ExecutionReceipt — same bytes that were signed at ingestion. Consumers
// can re-canonicalize and re-verify the signature offline; the operator
// console renders the raw JSON for inspection.

export async function fetchReceipt(
  motebitId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${config.apiUrl}/api/v1/admin/receipts/${encodeURIComponent(motebitId)}/${encodeURIComponent(taskId)}`;
  const headers = new Headers();
  if (config.apiToken) headers.set("Authorization", `Bearer ${config.apiToken}`);
  const res = await fetch(url, { signal, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, res.statusText, body);
  }
  return res.text();
}

// === Freeze / Unfreeze ===

export interface FreezeStatus {
  frozen: boolean;
  reason: string | null;
}

export function fetchFreezeStatus(signal?: AbortSignal): Promise<FreezeStatus> {
  return apiFetch<FreezeStatus>(`/api/v1/admin/freeze-status`, { signal });
}

export function triggerFreeze(
  reason: string,
): Promise<{ status: string; message: string; reason: string }> {
  return apiFetch(`/api/v1/admin/freeze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}

export function triggerUnfreeze(): Promise<{ status: string; message: string }> {
  return apiFetch(`/api/v1/admin/unfreeze`, { method: "POST" });
}

// === Health ===

export interface HealthMotebits {
  total_registered: number;
  active_24h: number;
  active_7d: number;
  active_30d: number;
}

export interface HealthFederation {
  peer_count: number;
  active_peers: number;
  suspended_peers: number;
  federation_settlements_7d: number;
  federation_volume_7d_micro: number;
}

export interface HealthTasks {
  settlements_7d: number;
  settlements_30d: number;
  volume_7d_micro: number;
  volume_30d_micro: number;
  fees_7d_micro: number;
  fees_30d_micro: number;
}

export interface HealthSubscribers {
  total_active: number;
  total_lifetime: number;
  created_7d: number;
  created_30d: number;
  /** Stripe statuses keyed verbatim (active, canceled, past_due, …); zero buckets are omitted. */
  status_counts: Record<string, number>;
}

export interface HealthSummary {
  motebits: HealthMotebits;
  federation: HealthFederation;
  tasks: HealthTasks;
  subscribers: HealthSubscribers;
  generated_at: number;
}

export function fetchHealthSummary(signal?: AbortSignal): Promise<HealthSummary> {
  return apiFetch<HealthSummary>(`/api/v1/admin/health`, { signal });
}
