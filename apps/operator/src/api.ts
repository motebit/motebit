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
  /** Decimal USD — the relay converts micro-units at the admin boundary. */
  amount: number;
  destination: string;
  requested_at: number;
  /**
   * `pending` (no payout attempted) or `processing` (a payout claimed it and
   * was handed to a rail — "payout in flight", #921). Absent on an older
   * relay: read as `pending`.
   */
  status?: string;
  /** When a payout claimed the withdrawal; null/absent when none did. */
  claimed_at?: number | null;
  /** On a `processing` row, why its payout outcome is unresolved. */
  failure_reason?: string | null;
  /**
   * A `pending` row written before the relay claimed payouts, to a Solana or
   * 0x destination: its payout may have been attempted — check the chain
   * before failing it.
   */
  payout_may_have_been_attempted?: boolean;
  /**
   * On a `processing` row: when the relay's reconcile door opens — the
   * payout's own horizon (the rail's signed validity, or the last moment the
   * relay could have broadcast plus a blockhash lifetime), floored. Null
   * while the relay is still handling the payout itself.
   */
  reconcile_opens_at?: number | null;
  /** The relay is handling this payout right now (claim → outcome written). */
  payout_in_flight_here?: boolean;
  /**
   * The relay's verdict on a `processing` row's reconcile door:
   * `in_flight_here` (the relay is handling it), `undetermined` (the relay
   * cannot place the payout's horizon yet — fail closed), `horizon` (closed
   * until `reconcile_opens_at`), `open`. Absent on an older relay.
   */
  reconcile_state?: "in_flight_here" | "undetermined" | "horizon" | "open" | null;
}

export interface PendingWithdrawalsResponse {
  withdrawals: WithdrawalRequest[];
  count: number;
  /** The reconcile floor after a claim; the per-row `reconcile_opens_at` is authoritative. */
  reconcile_min_age_ms?: number;
}

export function fetchPendingWithdrawals(signal?: AbortSignal): Promise<PendingWithdrawalsResponse> {
  return apiFetch<PendingWithdrawalsResponse>(`/api/v1/admin/withdrawals/pending`, { signal });
}

/**
 * Read-only: every `pending` withdrawal that predates the relay's claim-
 * before-send (#921), to a Solana or 0x destination. Check each on chain
 * before failing it.
 */
export function fetchPreClaimWithdrawals(
  signal?: AbortSignal,
): Promise<{ withdrawals: WithdrawalRequest[]; count: number }> {
  return apiFetch(`/api/v1/admin/withdrawals/pre-claim`, { signal });
}

export type ReconcileOutcome = "paid" | "not_paid";

export interface ReconcileArgs {
  outcome: ReconcileOutcome;
  /** What the operator verified on chain. Required by the relay. */
  attestation: string;
  /** Required for `paid`: the transfer that paid it. */
  payoutReference?: string;
}

/**
 * Settle a `processing` withdrawal whose payout outcome is unknown (#921).
 * The relay refuses (409) while the payout may still be in flight.
 */
export function reconcileWithdrawal(
  withdrawalId: string,
  args: ReconcileArgs,
): Promise<{ withdrawal_id: string; status: string; refunded?: boolean }> {
  const body: Record<string, string> = { outcome: args.outcome, attestation: args.attestation };
  if (args.payoutReference != null && args.payoutReference !== "") {
    body["payout_reference"] = args.payoutReference;
  }
  return apiFetch(`/api/v1/admin/withdrawals/${withdrawalId}/reconcile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The relay's answer to acting on a withdrawal whose payout is in flight (#921). */
export function isPayoutInFlight(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    err.body.includes("WITHDRAWAL_PAYOUT_IN_FLIGHT")
  );
}

/**
 * When a `processing` withdrawal becomes reconcilable, or null when it is
 * not `processing`. The relay's own `reconcile_opens_at` is authoritative;
 * a payout the relay is still handling is never reconcilable (Infinity).
 * Only an older relay that reports neither falls back to claim + floor.
 */
export function reconcilableAt(w: WithdrawalRequest, minAgeMs: number): number | null {
  if (w.status !== "processing") return null;
  if (w.payout_in_flight_here === true) return Number.POSITIVE_INFINITY;
  if (w.reconcile_state === "in_flight_here" || w.reconcile_state === "undetermined") {
    return Number.POSITIVE_INFINITY;
  }
  if (w.reconcile_opens_at != null) return w.reconcile_opens_at;
  // Only a relay that reports no verdict at all falls back to claim + floor;
  // a relay that says "unknown" is never second-guessed.
  if (w.reconcile_state !== undefined) return Number.POSITIVE_INFINITY;
  return w.claimed_at != null ? w.claimed_at + minAgeMs : 0;
}

/** Why a `processing` row's reconcile is closed, in the operator's words. */
export function reconcileClosedReason(w: WithdrawalRequest): string | null {
  if (w.payout_in_flight_here === true || w.reconcile_state === "in_flight_here") {
    return "The relay is still handling this payout";
  }
  if (w.reconcile_state === "undetermined") {
    return "Cannot open yet — the relay can't determine the payout's horizon";
  }
  return null;
}

/** The `reason` a 409 payout-in-flight answer carries, if any. */
export function inFlightReason(err: unknown): string | null {
  if (!isPayoutInFlight(err)) return null;
  try {
    const body = JSON.parse((err as ApiError).body) as { reason?: unknown };
    return typeof body.reason === "string" ? body.reason : null;
  } catch {
    return null;
  }
}

/** The `reconcile_opens_at` a 409 payout-in-flight answer carries, if any. */
export function inFlightOpensAt(err: unknown): number | null {
  if (!isPayoutInFlight(err)) return null;
  try {
    const body = JSON.parse((err as ApiError).body) as { reconcile_opens_at?: unknown };
    return typeof body.reconcile_opens_at === "number" ? body.reconcile_opens_at : null;
  } catch {
    return null;
  }
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

export function fetchFees(signal?: AbortSignal): Promise<FeesResponse> {
  // `/api/v1/admin/fees` is live (relay `index.ts`). It previously caught a 404
  // and returned `null` to render a "ships in a follow-up" placeholder; now a
  // 404 means a misconfigured or out-of-date relay and surfaces as an honest
  // error like any other failure, not a permanent "pending" state.
  return apiFetch<FeesResponse>(`/api/v1/admin/fees`, { signal });
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
  /** Serving (on the shelf) — not delisted. */
  total_registered: number;
  /** Every registry row, serving or delisted; ≥ total_registered (#703). */
  total_known: number;
  /** Identity-key population (registry ∪ devices ∪ successions) and how many of them the relay can name one key for without guessing (#703 Inc 2, D5). */
  identity_keys_total: number;
  identity_keys_unambiguous: number;
  identity_keys_ambiguous: number;
  identity_keys_keyless: number;
  active_24h: number;
  active_7d: number;
  active_30d: number;
  /** Lifetime cumulative motebits onboarded — the durable, monotonic userbase number. */
  total_announced: number;
  /** Newly announced (acquired) motebits within each window — the funnel's intake curve. */
  new_24h: number;
  new_7d: number;
  new_30d: number;
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
