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

export interface SovereignFetchAdapter {
  readonly syncUrl: string | null;
  readonly motebitId: string | null;
  // Surface-supplied auth'd fetch. Desktop injects `syncMasterToken`, web
  // mints a signed sync token per call, mobile currently passes none.
  fetch(path: string, init?: SovereignFetchInit): Promise<Response>;
  // Runtime accessors — surface wires its runtime instance here so the
  // controller never imports @motebit/runtime directly.
  getSolanaAddress(): string | null;
  getSolanaBalanceMicro(): Promise<number | null>;
  getLocalCredentials(): CredentialEntry[];
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
  goals: GoalRow[];
  ledgerDetails: ReadonlyMap<string, LedgerManifest>;
  succession: SuccessionResponse | null;
  presentation: unknown | null;
  verifyResult: { valid: boolean; reason?: string } | null;
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
    goals: [],
    ledgerDetails: new Map(),
    succession: null,
    presentation: null,
    verifyResult: null,
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
  present(): Promise<unknown | null>;
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
      const issuer =
        typeof issuerRaw === "string"
          ? issuerRaw
          : typeof issuerRaw === "object" && issuerRaw != null
            ? String((issuerRaw as Record<string, unknown>)["id"] ?? "")
            : "";
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
    if (!adapter.syncUrl || !adapter.motebitId) return [];
    try {
      const res = await adapter.fetch(`/api/v1/goals/${adapter.motebitId}`);
      if (!res.ok) return [];
      const data = (await res.json()) as { goals?: GoalRow[] };
      return (data.goals ?? []).filter((g) => g.status === "completed" || g.status === "failed");
    } catch {
      return [];
    }
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
  }> {
    const address = adapter.getSolanaAddress();
    if (!address) return { address: null, usdc: null };
    try {
      const micro = await adapter.getSolanaBalanceMicro();
      return { address, usdc: micro != null ? Number(micro) / 1_000_000 : null };
    } catch {
      return { address, usdc: null };
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  async function refresh(): Promise<void> {
    if (disposed) return;
    patch({ loading: true, error: null });

    try {
      const [credResult, goals, balance, budget, succession, sovereign] = await Promise.all([
        fetchCredentials(),
        fetchGoals(),
        fetchBalance(),
        fetchBudget(),
        fetchSuccession(),
        fetchSovereignBalance(),
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

  async function present(): Promise<unknown | null> {
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
      const dollars = updated.sweep_threshold != null ? updated.sweep_threshold / 1_000_000 : null;
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
