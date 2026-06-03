// Surface-agnostic state controller for the Sovereign panel.
//
// The four tabs (credentials, ledger, budget, succession) share identical
// relay fetch paths and state derivation across desktop, web, and mobile.
// Pushing that logic here lets each surface render from a common state shape
// instead of re-implementing five fetchers, a dedup algorithm, a sweep-config
// state machine, and a sovereign-balance resolver three times.
//
// The adapter inverts the dependency on @motebit/runtime so the package stays
// at Layer 5 without promoting. See ./CLAUDE.md for rules.

import { fromMicro } from "@motebit/protocol";

// ── Response shapes (relay wire format) ───────────────────────────────

export interface CredentialEntry {
  credential_id: string;
  credential_type: string;
  credential: Record<string, unknown>;
  issued_at: number;
}

export interface BalanceTransaction {
  transaction_id: string;
  type: string;
  amount: number;
  balance_after: number;
  description: string | null;
  created_at: number;
}

export interface BalanceResponse {
  motebit_id: string;
  balance: number;
  currency: string;
  transactions: BalanceTransaction[];
  pending_withdrawals?: number;
  pending_allocations?: number;
  dispute_window_hold?: number;
  available_for_withdrawal?: number;
  sweep_threshold: number | null;
  settlement_address: string | null;
}

export interface BudgetAllocation {
  allocation_id: string;
  task_id: string;
  amount_locked: number;
  currency: string;
  created_at: number;
  status: string;
  amount_settled?: number;
  settlement_status?: string;
}

export interface BudgetResponse {
  motebit_id: string;
  total_locked: number;
  total_settled: number;
  allocations: BudgetAllocation[];
}

export interface GoalRow {
  goal_id: string;
  prompt: string;
  status: string;
  created_at: number;
}

export interface LedgerTimelineEvent {
  type: string;
  description?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface LedgerManifest {
  spec: string;
  motebit_id: string;
  goal_id: string;
  plan_id?: string;
  plan_title?: string;
  status?: string;
  content_hash: string;
  timeline?: LedgerTimelineEvent[];
  signature?: string;
  [key: string]: unknown;
}

export interface KeySuccessionEntry {
  old_public_key: string;
  new_public_key: string;
  timestamp: number;
  reason?: string;
  old_key_signature?: string;
  new_key_signature: string;
  recovery?: boolean;
  guardian_signature?: string;
}

export interface SuccessionResponse {
  motebit_id: string;
  chain: KeySuccessionEntry[];
  current_public_key: string;
}

// ── Adapter ───────────────────────────────────────────────────────────

export type SovereignFetchInit = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

/**
 * Local identity snapshot — the bootstrap `IdentityCreated` event's
 * essentials, queryable without a relay. Per protocol-primacy doctrine,
 * a user without a connected relay must still see their own identity:
 * who they are, when they were born, what key they currently sign with.
 * The Sovereign Identity tab renders this as the always-present
 * "Current identity" hero card; relay-fetched succession history (key
 * rotations across devices) appends below.
 */
export interface LocalIdentitySnapshot {
  readonly motebitId: string;
  readonly createdAt: number; // ms epoch
  readonly publicKeyHex: string;
  readonly ownerId: string | null; // null if event payload lacks owner_id
}

/**
 * Whether a relay state-export response was cryptographically verified
 * against its `X-Motebit-Content-Manifest` (the self-attesting moat made
 * legible on the surface the user trusts most — their own ledger):
 *
 *   - `verified`   — manifest checked against the body and the relay's
 *                    pinned transparency anchor; the relay cannot have
 *                    equivocated about this data undetected.
 *   - `unverified` — the surface did not verify (no `verifiedFetch`
 *                    adapter, or local-only data). Honest "we didn't
 *                    check," not a claim of safety.
 *   - `failed`     — verification ran and the manifest did NOT match the
 *                    body. A tampering / equivocation signal — surface it
 *                    loudly per UI doctrine (system message, not a toast).
 */
export type StateExportVerificationStatus = "verified" | "unverified" | "failed";

/**
 * Result of an adapter-supplied verified fetch of a relay state-export
 * endpoint. The body is already parsed (the verifier must read the bytes
 * to check the manifest, so the controller cannot re-read a `Response`).
 */
export interface VerifiedFetchResult {
  /** HTTP-level ok (status 2xx). */
  readonly ok: boolean;
  /** Parsed JSON body, or null when `!ok`. */
  readonly json: unknown;
  /** Cryptographic verification status of the signed manifest. */
  readonly verification: StateExportVerificationStatus;
}

export interface SovereignFetchAdapter {
  readonly syncUrl: string | null;
  readonly motebitId: string | null;
  // Surface-supplied auth'd fetch. Desktop injects `syncMasterToken`, web
  // mints a signed sync token per call, mobile currently passes none.
  fetch(path: string, init?: SovereignFetchInit): Promise<Response>;
  /**
   * Optional verified fetch for relay state-export endpoints (the families
   * `services/relay/src/state-export.ts` signs with
   * `X-Motebit-Content-Manifest` — `goals`, `state`, `audit`, …). When the
   * surface implements it, the controller routes signed-family fetches
   * through it and records the {@link StateExportVerificationStatus} in
   * state so the renderer can show the user that their own sovereign data
   * was verified, not merely trusted. Verification is adapter-supplied for
   * the same reason auth is (panels Rule 3): the browser-safe verifier +
   * transparency-anchor store live at the surface, not in this zero-dep
   * BSL package. Surfaces that omit it fall back to {@link fetch} and the
   * status is `"unverified"` — no regression. Staged like
   * {@link getLocalIdentity} / {@link getLocalLedger}: web first, then
   * desktop + mobile.
   */
  verifiedFetch?(path: string, init?: SovereignFetchInit): Promise<VerifiedFetchResult>;
  // Runtime accessors — surface wires its runtime instance here so the
  // controller never imports @motebit/runtime directly.
  getSolanaAddress(): string | null;
  getSolanaBalanceMicro(): Promise<number | null>;
  getLocalCredentials(): CredentialEntry[];
  /**
   * Optional local-identity accessor. Surfaces that implement it expose
   * the bootstrap `IdentityCreated` event to the renderer; surfaces that
   * leave it undefined silently fall back to relay-only succession data
   * (no regression — controller stores `localIdentity: null` in state).
   * Adding this expanded the protocol-primacy audit pass surface for the
   * Identity tab without forcing a one-pass mirror across web/desktop/
   * mobile. The right end state has all three implementing it; staged
   * delivery is acceptable because the contract is opt-in.
   */
  getLocalIdentity?(): Promise<LocalIdentitySnapshot | null>;
  /**
   * Optional local-ledger accessor. Returns the locally-known goal
   * execution rows — goals the motebit has executed at least once, plus
   * goals in terminal states (completed / failed). Surfaces that
   * implement this expose execution proof-of-work without requiring a
   * relay round-trip; the controller merges local + relay (dedup by
   * goal_id, local wins) into the unified state.goals shape.
   *
   * Tonight's implementation reads from GoalsRunner state (the local
   * source of truth for scheduled goals across mode/status/last-run).
   * Future arc swaps in per-fire signed ExecutionReceipt aggregation
   * via `replayGoal()` from packages/runtime/src/execution-ledger.ts —
   * each fire becomes a row, signature-verified locally before display.
   * That swap is contract-preserving: the GoalRow shape stays; only
   * the source of truth deepens. Doctrine: receipts-unified.md.
   */
  getLocalLedger?(): Promise<GoalRow[]>;
}

// ── State ─────────────────────────────────────────────────────────────

export type SovereignTab = "credentials" | "ledger" | "budget" | "succession";

export interface SovereignState {
  activeTab: SovereignTab;
  credentials: CredentialEntry[];
  revokedIds: ReadonlySet<string>;
  balance: BalanceResponse | null;
  budget: BudgetResponse | null;
  sovereignAddress: string | null;
  sovereignBalanceUsdc: number | null;
  // True when the onchain balance read FAILED (RPC unreachable), distinct
  // from `sovereignBalanceUsdc: null` meaning unfunded/no-wallet. The render
  // shows "—" + a retry on error, and a substrate-honest `0.00` only when
  // there's a wallet, no error, and no balance yet. Never assert a zero you
  // didn't read.
  sovereignBalanceError: boolean;
  goals: GoalRow[];
  ledgerDetails: ReadonlyMap<string, LedgerManifest>;
  succession: SuccessionResponse | null;
  // Always-locally-available identity snapshot from the bootstrap
  // IdentityCreated event. Populated whenever the adapter implements
  // `getLocalIdentity`; null on surfaces that don't yet implement it
  // (no regression — renderer reads succession-only in that case).
  // Doctrine: docs/doctrine/protocol-primacy.md — Identity tab passes
  // the audit ("does this work identically for a user who never
  // subscribes?") when localIdentity is present, since it renders
  // without any relay call.
  localIdentity: LocalIdentitySnapshot | null;
  presentation: unknown;
  verifyResult: { valid: boolean; reason?: string } | null;
  // Verification status of the last relay goals/ledger state-export fetch
  // (signed with X-Motebit-Content-Manifest). `unverified` until a fetch
  // with an adapter that implements `verifiedFetch` completes. The Ledger
  // tab renders this so the user sees their own data was verified, not
  // merely trusted. Doctrine: docs/doctrine/self-attesting-system.md.
  ledgerVerification: StateExportVerificationStatus;
  loading: boolean;
  error: string | null;
}

function initialState(): SovereignState {
  return {
    activeTab: "credentials",
    credentials: [],
    revokedIds: new Set(),
    balance: null,
    budget: null,
    sovereignAddress: null,
    sovereignBalanceUsdc: null,
    sovereignBalanceError: false,
    goals: [],
    ledgerDetails: new Map(),
    succession: null,
    localIdentity: null,
    presentation: null,
    verifyResult: null,
    ledgerVerification: "unverified",
    loading: false,
    error: null,
  };
}

// ── Controller ────────────────────────────────────────────────────────

export interface SovereignController {
  getState(): SovereignState;
  subscribe(listener: (state: SovereignState) => void): () => void;
  setActiveTab(tab: SovereignTab): void;
  refresh(): Promise<void>;
  loadLedgerDetail(goalId: string): Promise<LedgerManifest | null>;
  present(): Promise<unknown>;
  verify(vp: unknown): Promise<{ valid: boolean; reason?: string }>;
  commitSweep(
    thresholdMicro: number | null,
    addressOverride?: string,
  ): Promise<BalanceResponse | null>;
  dispose(): void;
}

export function createSovereignController(adapter: SovereignFetchAdapter): SovereignController {
  let state = initialState();
  const listeners = new Set<(state: SovereignState) => void>();
  let disposed = false;

  function emit(next: SovereignState): void {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function patch(partial: Partial<SovereignState>): void {
    if (disposed) return;
    emit({ ...state, ...partial });
  }

  async function readJson<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status}${text ? `: ${text}` : ""}`);
    }
    return (await res.json()) as T;
  }

  // ── Credentials ─────────────────────────────────────────────────────

  // Deduplicate by (issuer, type, subject, issued_at) — a credential that
  // landed locally and then got synced back from the relay shows up twice
  // with identical identity + timestamp; we keep the newest instance.
  function dedupCredentials(entries: CredentialEntry[]): CredentialEntry[] {
    const seen = new Map<string, CredentialEntry>();
    for (const entry of entries) {
      const issuerRaw = entry.credential["issuer"];
      let issuer = "";
      if (typeof issuerRaw === "string") {
        issuer = issuerRaw;
      } else if (typeof issuerRaw === "object" && issuerRaw != null) {
        const id = (issuerRaw as Record<string, unknown>)["id"];
        issuer = typeof id === "string" ? id : "";
      }
      const subjectField = entry.credential["credentialSubject"];
      const subjectRaw =
        typeof subjectField === "object" && subjectField != null
          ? (subjectField as Record<string, unknown>)["id"]
          : undefined;
      const subject = typeof subjectRaw === "string" ? subjectRaw : "";
      const key = `${issuer}:${entry.credential_type}:${subject}:${entry.issued_at}`;
      const existing = seen.get(key);
      if (!existing || entry.issued_at > existing.issued_at) {
        seen.set(key, entry);
      }
    }
    return [...seen.values()].sort((a, b) => b.issued_at - a.issued_at);
  }

  async function fetchCredentials(): Promise<{
    entries: CredentialEntry[];
    revokedIds: Set<string>;
  }> {
    const local = adapter.getLocalCredentials();

    let relay: CredentialEntry[] = [];
    if (adapter.syncUrl && adapter.motebitId) {
      try {
        const res = await adapter.fetch(`/api/v1/agents/${adapter.motebitId}/credentials`);
        if (res.ok) {
          const data = (await res.json()) as { credentials?: CredentialEntry[] };
          relay = data.credentials ?? [];
        }
      } catch {
        // Relay failure is non-fatal — local credentials still render.
      }
    }

    const merged = dedupCredentials([...local, ...relay]);

    let revokedIds = new Set<string>();
    if (merged.length > 0 && adapter.syncUrl && adapter.motebitId) {
      try {
        const res = await adapter.fetch(`/api/v1/credentials/batch-status`, {
          method: "POST",
          body: { credential_ids: merged.map((c) => c.credential_id) },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            results?: Array<{ credential_id: string; revoked: boolean }>;
          };
          revokedIds = new Set(
            (data.results ?? []).filter((r) => r.revoked).map((r) => r.credential_id),
          );
        }
      } catch {
        // Batch-status failure is non-fatal — display without revocation state.
      }
    }

    return { entries: merged, revokedIds };
  }

  // ── Ledger ─────────────────────────────────────────────────────────

  async function fetchGoals(): Promise<GoalRow[]> {
    // Local-first per protocol-primacy: query the local ledger source
    // first (always available, no relay dependency), then merge with
    // relay-fetched goals (dedup by goal_id, local wins as the
    // signed-locally truth). Surfaces that haven't implemented
    // `getLocalLedger` yet contribute an empty local list — no
    // regression on relay-only behavior. Doctrine:
    // docs/doctrine/receipts-unified.md (the canonical source of
    // proof-of-work is the motebit's locally-signed receipts).
    const local = adapter.getLocalLedger
      ? await (async () => {
          try {
            return await adapter.getLocalLedger!();
          } catch {
            return [];
          }
        })()
      : [];

    let relay: GoalRow[] = [];
    if (adapter.syncUrl && adapter.motebitId) {
      const path = `/api/v1/goals/${adapter.motebitId}`;
      try {
        // `/api/v1/goals/...` is a relay state-export family signed with
        // X-Motebit-Content-Manifest. Route through the adapter's verified
        // fetch when it implements one (web today; desktop/mobile staged)
        // so the relay cannot equivocate about the user's own ledger
        // undetected — the self-attesting moat on the surface that needs
        // it most. Surfaces without `verifiedFetch` fall back to the raw
        // fetch and the status stays `unverified` (honest, no regression).
        if (adapter.verifiedFetch) {
          const vr = await adapter.verifiedFetch(path);
          // `json` is null when verification failed (the verifier withholds
          // unverified bytes) — guard the access so the `failed` status is
          // still recorded rather than thrown past.
          const data = (vr.ok ? vr.json : null) as { goals?: GoalRow[] } | null;
          relay = (data?.goals ?? []).filter(
            (g) => g.status === "completed" || g.status === "failed",
          );
          patch({ ledgerVerification: vr.verification });
        } else {
          const res = await adapter.fetch(path);
          if (res.ok) {
            const data = (await res.json()) as { goals?: GoalRow[] };
            relay = (data.goals ?? []).filter(
              (g) => g.status === "completed" || g.status === "failed",
            );
          }
          patch({ ledgerVerification: "unverified" });
        }
      } catch {
        // Relay failure is non-fatal — local goals still render.
      }
    }

    // Merge with goal_id dedup; local wins (it's the signed-locally
    // truth source; relay is a mirror).
    const merged = new Map<string, GoalRow>();
    for (const g of relay) merged.set(g.goal_id, g);
    for (const g of local) merged.set(g.goal_id, g);
    return Array.from(merged.values()).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  }

  async function loadLedgerDetail(goalId: string): Promise<LedgerManifest | null> {
    if (!adapter.syncUrl || !adapter.motebitId) return null;
    const cached = state.ledgerDetails.get(goalId);
    if (cached) return cached;
    try {
      const res = await adapter.fetch(`/agent/${adapter.motebitId}/ledger/${goalId}`);
      if (!res.ok) return null;
      const ledger = (await res.json()) as LedgerManifest;
      const next = new Map(state.ledgerDetails);
      next.set(goalId, ledger);
      patch({ ledgerDetails: next });
      return ledger;
    } catch {
      return null;
    }
  }

  // ── Balance + budget + sovereign wallet ─────────────────────────────

  async function fetchBalance(): Promise<BalanceResponse | null> {
    if (!adapter.syncUrl || !adapter.motebitId) return null;
    try {
      const res = await adapter.fetch(`/api/v1/agents/${adapter.motebitId}/balance`);
      if (!res.ok) return null;
      return (await res.json()) as BalanceResponse;
    } catch {
      return null;
    }
  }

  async function fetchBudget(): Promise<BudgetResponse | null> {
    if (!adapter.syncUrl || !adapter.motebitId) return null;
    try {
      const res = await adapter.fetch(`/agent/${adapter.motebitId}/budget`);
      if (!res.ok) return null;
      return (await res.json()) as BudgetResponse;
    } catch {
      return null;
    }
  }

  async function fetchSuccession(): Promise<SuccessionResponse | null> {
    if (!adapter.syncUrl || !adapter.motebitId) return null;
    try {
      const res = await adapter.fetch(`/api/v1/agents/${adapter.motebitId}/succession`);
      if (!res.ok) return null;
      return (await res.json()) as SuccessionResponse;
    } catch {
      return null;
    }
  }

  async function fetchSovereignBalance(): Promise<{
    address: string | null;
    usdc: number | null;
    error: boolean;
  }> {
    const address = adapter.getSolanaAddress();
    if (!address) return { address: null, usdc: null, error: false };
    try {
      const micro = await adapter.getSolanaBalanceMicro();
      return { address, usdc: micro != null ? fromMicro(Number(micro)) : null, error: false };
    } catch {
      // Read failure (e.g. an RPC the browser can't reach) — do NOT collapse
      // to `usdc: null`, which the renderer shows as a substrate-honest
      // `0.00`. A balance we couldn't read is unknown, not zero. Surface it
      // as `error: true` so the surface renders "—" + a retry, never a false
      // $0. Per CLAUDE.md rule 5: errors surface as state, prior-good intact
      // (the address still renders; only the amount slot reads "—").
      return { address, usdc: null, error: true };
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  async function fetchLocalIdentity(): Promise<LocalIdentitySnapshot | null> {
    // Optional adapter method — surfaces opt in. Failure is non-fatal
    // (returns null, renderer falls back to relay-only succession data).
    if (!adapter.getLocalIdentity) return null;
    try {
      return await adapter.getLocalIdentity();
    } catch {
      return null;
    }
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    patch({ loading: true, error: null });

    try {
      const [credResult, goals, balance, budget, succession, sovereign, localIdentity] =
        await Promise.all([
          fetchCredentials(),
          fetchGoals(),
          fetchBalance(),
          fetchBudget(),
          fetchSuccession(),
          fetchSovereignBalance(),
          fetchLocalIdentity(),
        ]);

      if (disposed) return;

      patch({
        credentials: credResult.entries,
        revokedIds: credResult.revokedIds,
        goals,
        balance,
        budget,
        succession,
        sovereignAddress: sovereign.address,
        sovereignBalanceUsdc: sovereign.usdc,
        sovereignBalanceError: sovereign.error,
        localIdentity,
        loading: false,
      });
    } catch (err) {
      if (disposed) return;
      patch({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function present(): Promise<unknown> {
    if (!adapter.syncUrl || !adapter.motebitId) return null;
    try {
      const res = await adapter.fetch(`/api/v1/agents/${adapter.motebitId}/presentation`, {
        method: "POST",
      });
      const data = await readJson<{ presentation: unknown }>(res);
      patch({ presentation: data.presentation });
      return data.presentation;
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async function verify(vp: unknown): Promise<{ valid: boolean; reason?: string }> {
    try {
      const res = await adapter.fetch(`/api/v1/credentials/verify`, {
        method: "POST",
        body: vp,
      });
      const data = (await res.json()) as { valid: boolean; reason?: string };
      patch({ verifyResult: data });
      return data;
    } catch (err) {
      const result = { valid: false, reason: err instanceof Error ? err.message : String(err) };
      patch({ verifyResult: result });
      return result;
    }
  }

  async function commitSweep(
    thresholdMicro: number | null,
    addressOverride?: string,
  ): Promise<BalanceResponse | null> {
    if (!adapter.syncUrl || !adapter.motebitId) {
      patch({ error: "No relay configured" });
      return null;
    }
    try {
      const body: Record<string, unknown> = { sweep_threshold: thresholdMicro };
      if (addressOverride !== undefined) body.settlement_address = addressOverride;
      const res = await adapter.fetch(`/api/v1/agents/${adapter.motebitId}/sweep-config`, {
        method: "PATCH",
        body,
      });
      const updated = await readJson<{
        sweep_threshold: number | null;
        settlement_address: string | null;
      }>(res);
      // Relay returns threshold in micro-units; the balance shape carries
      // it in dollars, so convert before writing state.
      const dollars = updated.sweep_threshold != null ? fromMicro(updated.sweep_threshold) : null;
      const nextBalance: BalanceResponse | null = state.balance
        ? {
            ...state.balance,
            sweep_threshold: dollars,
            settlement_address: updated.settlement_address,
          }
        : null;
      patch({ balance: nextBalance });
      return nextBalance;
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  function setActiveTab(tab: SovereignTab): void {
    if (state.activeTab === tab) return;
    patch({ activeTab: tab });
  }

  function subscribe(listener: (state: SovereignState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getState(): SovereignState {
    return state;
  }

  function dispose(): void {
    disposed = true;
    listeners.clear();
  }

  return {
    getState,
    subscribe,
    setActiveTab,
    refresh,
    loadLedgerDetail,
    present,
    verify,
    commitSweep,
    dispose,
  };
}
