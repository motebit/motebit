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
