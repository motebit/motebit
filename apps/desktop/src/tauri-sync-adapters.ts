/**
 * Tauri sync-engine adapters — bridge async Tauri stores to the sync
 * engine's synchronous adapter interfaces.
 *
 * The motebit sync engine speaks `ConversationSyncStoreAdapter` and
 * `PlanSyncStoreAdapter` — both synchronous read APIs that return data
 * snapshots in-line. The Tauri-backed conversation + plan stores are
 * fundamentally async (every read crosses the IPC boundary). These two
 * classes bridge the gap with a pre-fetch pattern: call `prefetch(since)`
 * before each sync cycle to materialize the async data into in-memory
 * arrays/maps, then the sync engine reads from those snapshots
 * synchronously.
 *
 * Extracted from `index.ts` as part of the DesktopApp decomposition.
 * Both classes are pure leaves — they hold a store reference and a
 * cache; they don't depend on the runtime, MCP, identity, or any other
 * desktop module.
 */

import type { ConversationSyncStoreAdapter, PlanSyncStoreAdapter } from "@motebit/sync-engine";
import type {
  SyncConversation,
  SyncConversationMessage,
  SyncPlan,
  SyncPlanStep,
  Plan,
  PlanStep,
} from "@motebit/sdk";
import type { PlanStoreAdapter } from "@motebit/planner";
import type { TauriConversationStore, TauriPlanStore } from "./tauri-storage.js";

/**
 * Bridges TauriConversationStore (camelCase, async) to ConversationSyncStoreAdapter
 * (snake_case, sync). Uses a blocking-style approach: pre-fetches data via
 * `prefetch()` before the sync cycle, then serves the cached snapshot
 * synchronously to the sync engine.
 */
export class TauriConversationSyncStoreAdapter implements ConversationSyncStoreAdapter {
  private _conversations: SyncConversation[] = [];
  private _messages: Map<string, SyncConversationMessage[]> = new Map();

  constructor(
    private store: TauriConversationStore,
    private motebitId: string,
  ) {}

  getConversationsSince(motebitId: string, since: number): SyncConversation[] {
    // Return from pre-fetched data. The sync() call pre-loads before use.
    return this._conversations.filter(
      (c) => c.motebit_id === motebitId && c.last_active_at > since,
    );
  }

  getMessagesSince(conversationId: string, since: number): SyncConversationMessage[] {
    const msgs = this._messages.get(conversationId) ?? [];
    return msgs.filter((m) => m.created_at > since);
  }

  upsertConversation(conv: SyncConversation): void {
    void this.store.upsertConversation(conv);
  }

  upsertMessage(msg: SyncConversationMessage): void {
    void this.store.upsertMessage(msg);
  }

  /** Pre-fetch data from async Tauri store. Must be called before sync(). */
  async prefetch(since: number): Promise<void> {
    const convRows = await this.store.getConversationsSince(this.motebitId, since);
    this._conversations = convRows;
    for (const conv of convRows) {
      const msgRows = await this.store.getMessagesSince(conv.conversation_id, since);
      this._messages.set(conv.conversation_id, msgRows);
    }
  }
}

/**
 * Bridges TauriPlanStore (async, in-memory cache) to PlanSyncStoreAdapter (sync).
 * Pre-fetches plans and steps before each sync cycle. Implements step-status
 * monotonicity on upsert: a sync write that would regress a step's status
 * (e.g. completed → running) is dropped.
 */
export class TauriPlanSyncStoreAdapter implements PlanSyncStoreAdapter {
  private _plans: Plan[] = [];
  private _steps: PlanStep[] = [];

  constructor(
    private store: TauriPlanStore | PlanStoreAdapter,
    private motebitId: string,
  ) {}

  getPlansSince(_motebitId: string, since: number): SyncPlan[] {
    return this._plans
      .filter((p) => p.updated_at > since)
      .map((p) => ({
        plan_id: p.plan_id,
        goal_id: p.goal_id,
        motebit_id: p.motebit_id,
        title: p.title,
        status: p.status,
        created_at: p.created_at,
        updated_at: p.updated_at,
        current_step_index: p.current_step_index,
        total_steps: p.total_steps,
        proposal_id: p.proposal_id ?? null,
        collaborative: p.collaborative ? 1 : 0,
      }));
  }

  getStepsSince(_motebitId: string, since: number): SyncPlanStep[] {
    return this._steps
      .filter((s) => s.updated_at > since)
      .map((s) => ({
        step_id: s.step_id,
        plan_id: s.plan_id,
        motebit_id: this.motebitId,
        ordinal: s.ordinal,
        description: s.description,
        prompt: s.prompt,
        depends_on: JSON.stringify(s.depends_on),
        optional: s.optional,
        status: s.status,
        required_capabilities:
          s.required_capabilities != null ? JSON.stringify(s.required_capabilities) : null,
        delegation_task_id: s.delegation_task_id ?? null,
        assigned_motebit_id: s.assigned_motebit_id ?? null,
        result_summary: s.result_summary,
        error_message: s.error_message,
        tool_calls_made: s.tool_calls_made,
        started_at: s.started_at,
        completed_at: s.completed_at,
        retry_count: s.retry_count,
        updated_at: s.updated_at,
      }));
  }

  upsertPlan(plan: SyncPlan): void {
    const existing = this.store.getPlan(plan.plan_id);
    if (!existing || plan.updated_at >= existing.updated_at) {
      this.store.savePlan({
        plan_id: plan.plan_id,
        goal_id: plan.goal_id,
        motebit_id: plan.motebit_id,
        title: plan.title,
        status: plan.status,
        created_at: plan.created_at,
        updated_at: plan.updated_at,
        current_step_index: plan.current_step_index,
        total_steps: plan.total_steps,
        proposal_id: plan.proposal_id ?? undefined,
        collaborative: plan.collaborative === 1,
      });
    }
  }

  upsertStep(step: SyncPlanStep): void {
    const existing = this.store.getStep(step.step_id);
    if (existing) {
      const STATUS_ORDER: Record<string, number> = {
        pending: 0,
        running: 1,
        completed: 2,
        failed: 2,
        skipped: 2,
      };
      const incomingOrder = STATUS_ORDER[step.status] ?? 0;
      const existingOrder = STATUS_ORDER[existing.status] ?? 0;
      if (incomingOrder < existingOrder) return;
    }
    this.store.saveStep({
      step_id: step.step_id,
      plan_id: step.plan_id,
      ordinal: step.ordinal,
      description: step.description,
      prompt: step.prompt,
      depends_on:
        typeof step.depends_on === "string" ? (JSON.parse(step.depends_on) as string[]) : [],
      optional: step.optional,
      status: step.status,
      required_capabilities:
        step.required_capabilities != null
          ? (JSON.parse(step.required_capabilities) as PlanStep["required_capabilities"])
          : undefined,
      delegation_task_id: step.delegation_task_id ?? undefined,
      assigned_motebit_id: step.assigned_motebit_id ?? undefined,
      result_summary: step.result_summary,
      error_message: step.error_message,
      tool_calls_made: step.tool_calls_made,
      started_at: step.started_at,
      completed_at: step.completed_at,
      retry_count: step.retry_count,
      updated_at: step.updated_at,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async interface
  async prefetch(_since: number): Promise<void> {
    if ("listAllPlans" in this.store && typeof this.store.listAllPlans === "function") {
      this._plans = this.store.listAllPlans(this.motebitId);
    } else if (
      "listActivePlans" in this.store &&
      typeof this.store.listActivePlans === "function"
    ) {
      this._plans = this.store.listActivePlans(this.motebitId);
    }
    const allSteps: PlanStep[] = [];
    for (const plan of this._plans) {
      allSteps.push(...this.store.getStepsForPlan(plan.plan_id));
    }
    this._steps = allSteps;
  }
}
