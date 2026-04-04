import type { SyncPlan, SyncPlanStep, PlanSyncResult } from "@motebit/sdk";
import type { CredentialSource, CredentialRequest } from "./credential-source.js";

// === Plan Sync Store Adapter ===

/**
 * Adapter interface for plan sync storage.
 * Abstracts the local plan store for the sync engine.
 */
export interface PlanSyncStoreAdapter {
  /** Get plans updated since a given timestamp. */
  getPlansSince(motebitId: string, since: number): SyncPlan[];
  /** Get steps for plans updated since a given timestamp. */
  getStepsSince(motebitId: string, since: number): SyncPlanStep[];
  /** Upsert a plan from sync (last-writer-wins on updated_at). */
  upsertPlan(plan: SyncPlan): void;
  /** Upsert a step from sync (status monotonicity — never regress). */
  upsertStep(step: SyncPlanStep): void;
}

// === Plan Sync Remote Adapter ===

/**
 * Remote adapter for plan sync — calls the relay server over HTTP.
 */
export interface PlanSyncRemoteAdapter {
  pushPlans(motebitId: string, plans: SyncPlan[]): Promise<number>;
  pullPlans(motebitId: string, since: number): Promise<SyncPlan[]>;
  pushSteps(motebitId: string, steps: SyncPlanStep[]): Promise<number>;
  pullSteps(motebitId: string, since: number): Promise<SyncPlanStep[]>;
}

// === HTTP Plan Sync Adapter ===

export interface HttpPlanSyncConfig {
  baseUrl: string;
  motebitId: string;
  authToken?: string;
  /** Dynamic credential provider — takes precedence over authToken. */
  credentialSource?: CredentialSource;
}

/**
 * HTTP adapter that talks to the relay server's plan sync endpoints.
 */
export class HttpPlanSyncAdapter implements PlanSyncRemoteAdapter {
  private baseUrl: string;
  private authToken: string | undefined;
  private credentialSource: CredentialSource | undefined;

  constructor(config: HttpPlanSyncConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authToken = config.authToken;
    this.credentialSource = config.credentialSource;
  }

  async pushPlans(motebitId: string, plans: SyncPlan[]): Promise<number> {
    const url = `${this.baseUrl}/sync/${motebitId}/plans`;
    const res = await fetch(url, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ plans }),
    });
    if (!res.ok) {
      throw new Error(`Push plans failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { accepted: number };
    return body.accepted;
  }

  async pullPlans(motebitId: string, since: number): Promise<SyncPlan[]> {
    const url = `${this.baseUrl}/sync/${motebitId}/plans?since=${since}`;
    const res = await fetch(url, {
      method: "GET",
      headers: await this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Pull plans failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { plans: SyncPlan[] };
    return body.plans;
  }

  async pushSteps(motebitId: string, steps: SyncPlanStep[]): Promise<number> {
    const url = `${this.baseUrl}/sync/${motebitId}/plan-steps`;
    const res = await fetch(url, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ steps }),
    });
    if (!res.ok) {
      throw new Error(`Push plan steps failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { accepted: number };
    return body.accepted;
  }

  async pullSteps(motebitId: string, since: number): Promise<SyncPlanStep[]> {
    const url = `${this.baseUrl}/sync/${motebitId}/plan-steps?since=${since}`;
    const res = await fetch(url, {
      method: "GET",
      headers: await this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Pull plan steps failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { steps: SyncPlanStep[] };
    return body.steps;
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const token = await this.resolveToken();
    if (token != null && token !== "") {
      h["Authorization"] = `Bearer ${token}`;
    }
    return h;
  }

  private async resolveToken(): Promise<string | null> {
    if (this.credentialSource) {
      const request: CredentialRequest = { serverUrl: this.baseUrl };
      return this.credentialSource.getCredential(request);
    }
    return this.authToken ?? null;
  }
}

// === In-Memory Plan Sync Store (for testing) ===

/** Step status ordinal for monotonicity enforcement. */
const STEP_STATUS_ORDER: Record<string, number> = {
  pending: 0,
  running: 1,
  completed: 2,
  failed: 2,
  skipped: 2,
};

export class InMemoryPlanSyncStore implements PlanSyncStoreAdapter {
  plans: Map<string, SyncPlan> = new Map();
  steps: Map<string, SyncPlanStep> = new Map();

  getPlansSince(motebitId: string, since: number): SyncPlan[] {
    return Array.from(this.plans.values())
      .filter((p) => p.motebit_id === motebitId && p.updated_at > since)
      .sort((a, b) => a.updated_at - b.updated_at);
  }

  getStepsSince(motebitId: string, since: number): SyncPlanStep[] {
    return Array.from(this.steps.values())
      .filter((s) => s.motebit_id === motebitId && s.updated_at > since)
      .sort((a, b) => a.updated_at - b.updated_at);
  }

  upsertPlan(plan: SyncPlan): void {
    const existing = this.plans.get(plan.plan_id);
    if (!existing) {
      this.plans.set(plan.plan_id, { ...plan });
      return;
    }
    // Last-writer-wins on updated_at
    if (plan.updated_at >= existing.updated_at) {
      this.plans.set(plan.plan_id, { ...plan });
    }
  }

  upsertStep(step: SyncPlanStep): void {
    const existing = this.steps.get(step.step_id);
    if (!existing) {
      this.steps.set(step.step_id, { ...step });
      return;
    }
    // Status monotonicity: never regress
    const incomingOrder = STEP_STATUS_ORDER[step.status] ?? 0;
    const existingOrder = STEP_STATUS_ORDER[existing.status] ?? 0;
    if (incomingOrder < existingOrder) return;

    // If same status tier, use updated_at as tiebreaker
    if (incomingOrder === existingOrder && step.updated_at < existing.updated_at) return;

    this.steps.set(step.step_id, { ...step });
  }
}

// === Plan Sync Engine ===

export interface PlanSyncConfig {
  /** How often to attempt sync (ms) */
  sync_interval_ms: number;
  /** Retry attempts on failure */
  max_retries: number;
  /** Backoff base (ms) */
  retry_backoff_ms: number;
}

const DEFAULT_PLAN_SYNC_CONFIG: PlanSyncConfig = {
  sync_interval_ms: 30_000,
  max_retries: 3,
  retry_backoff_ms: 1_000,
};

export type PlanSyncStatus = "idle" | "syncing" | "error" | "offline";

/**
 * Sync engine for plans. Manages push/pull of plan metadata
 * and steps between local store and remote relay.
 *
 * Conflict resolution:
 * - Plan metadata: last-writer-wins (by updated_at)
 * - Steps: status monotonicity (never regress Completed → Running)
 */
export class PlanSyncEngine {
  private config: PlanSyncConfig;
  private localStore: PlanSyncStoreAdapter;
  private remoteAdapter: PlanSyncRemoteAdapter | null = null;
  private motebitId: string;
  private lastSyncTimestamp = 0;
  private status: PlanSyncStatus = "idle";
  private statusListeners: Set<(status: PlanSyncStatus) => void> = new Set();
  private syncInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    localStore: PlanSyncStoreAdapter,
    motebitId: string,
    config: Partial<PlanSyncConfig> = {},
  ) {
    this.config = { ...DEFAULT_PLAN_SYNC_CONFIG, ...config };
    this.localStore = localStore;
    this.motebitId = motebitId;
  }

  /** Connect to a remote plan sync adapter. */
  connectRemote(remoteAdapter: PlanSyncRemoteAdapter): void {
    this.remoteAdapter = remoteAdapter;
  }

  /** Start background sync loop. */
  start(): void {
    if (this.syncInterval !== null) return;
    this.syncInterval = setInterval(() => {
      void this.sync();
    }, this.config.sync_interval_ms);
  }

  /** Stop background sync. */
  stop(): void {
    if (this.syncInterval !== null) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  /** Perform a single sync cycle. */
  async sync(): Promise<PlanSyncResult> {
    if (this.remoteAdapter === null) {
      this.setStatus("offline");
      return { plans_pushed: 0, plans_pulled: 0, steps_pushed: 0, steps_pulled: 0 };
    }

    this.setStatus("syncing");

    try {
      // Push local plans updated since last sync
      const localPlans = this.localStore.getPlansSince(this.motebitId, this.lastSyncTimestamp);
      let plansPushed = 0;
      if (localPlans.length > 0) {
        plansPushed = await this.remoteAdapter.pushPlans(this.motebitId, localPlans);
      }

      // Push local steps updated since last sync
      const localSteps = this.localStore.getStepsSince(this.motebitId, this.lastSyncTimestamp);
      let stepsPushed = 0;
      if (localSteps.length > 0) {
        stepsPushed = await this.remoteAdapter.pushSteps(this.motebitId, localSteps);
      }

      // Pull remote plans updated since last sync
      const remotePlans = await this.remoteAdapter.pullPlans(
        this.motebitId,
        this.lastSyncTimestamp,
      );
      let plansPulled = 0;
      for (const plan of remotePlans) {
        this.localStore.upsertPlan(plan);
        plansPulled++;
      }

      // Pull remote steps updated since last sync
      const remoteSteps = await this.remoteAdapter.pullSteps(
        this.motebitId,
        this.lastSyncTimestamp,
      );
      let stepsPulled = 0;
      for (const step of remoteSteps) {
        this.localStore.upsertStep(step);
        stepsPulled++;
      }

      this.lastSyncTimestamp = Date.now();
      this.setStatus("idle");

      return {
        plans_pushed: plansPushed,
        plans_pulled: plansPulled,
        steps_pushed: stepsPushed,
        steps_pulled: stepsPulled,
      };
    } catch {
      this.setStatus("error");
      return { plans_pushed: 0, plans_pulled: 0, steps_pushed: 0, steps_pulled: 0 };
    }
  }

  /** Subscribe to status changes. */
  onStatusChange(listener: (status: PlanSyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Get current sync status. */
  getStatus(): PlanSyncStatus {
    return this.status;
  }

  /** Get the last sync timestamp. */
  getLastSyncTimestamp(): number {
    return this.lastSyncTimestamp;
  }

  private setStatus(status: PlanSyncStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}
