/**
 * Plan Execution — plan lifecycle, manifest construction, and event logging.
 *
 * Extracted from MotebitRuntime. Owns the plan execution flow, execution
 * manifest construction, and plan chunk event logging.
 */

import { EventType } from "@motebit/sdk";
import type {
  GoalExecutionManifest,
  ExecutionTimelineEntry,
  ExecutionStepSummary,
  ToolAuditEntry,
} from "@motebit/sdk";
import { sign, toBase64Url, hexToBytes } from "@motebit/encryption";
import type { EventStore } from "@motebit/event-log";
import type { MotebitLoopDependencies } from "@motebit/ai-core";
import type { TaskRouter } from "@motebit/ai-core";
import type { PlanEngine, PlanChunk, PlanStoreAdapter } from "@motebit/planner";
import type { AuditLogSink } from "@motebit/policy";
import type { DeviceCapability } from "@motebit/sdk";
import { replayGoal, hashString, computeTimelineHash } from "./execution-ledger.js";
import type { SlabController } from "./slab-controller.js";

export interface PlanExecutionDeps {
  motebitId: string;
  planEngine: PlanEngine;
  planStore: PlanStoreAdapter;
  toolRegistry: { size: number; list(): { name: string }[] };
  events: EventStore;
  toolAuditSink?: AuditLogSink;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  /** Resolve current loop deps (may be null if provider not set). */
  getLoopDeps(): MotebitLoopDependencies | null;
  /** Resolve current local capabilities. */
  getLocalCapabilities(): DeviceCapability[];
  /** Resolve task router for model selection (may be null). */
  getTaskRouter?(): TaskRouter | null;
  /**
   * Optional slab controller. When provided, plan step lifecycle events
   * open/update/end `plan_step` slab items so renderers can project plan
   * execution onto the Motebit Computer. When absent (tests, headless
   * contexts), plan execution still runs — slab wiring is additive.
   */
  slab?: SlabController;
}

/**
 * Per-step state tracked by the §3.4 ordering guard. Each `step_id` in a
 * plan transitions through these states in exactly the orderings §3.4
 * permits; any out-of-order transition (double-delegation, post-terminal
 * emission) is rejected in-emitter with a logger warning — no event is
 * appended to the log. The map is keyed by `step_id` (globally unique)
 * so we don't have to compose plan_id + step_id.
 */
type StepState = "pending" | "started" | "delegated" | "terminal";

export class PlanExecutionManager {
  private _lastExecutionManifest: GoalExecutionManifest | null = null;
  private _stepStates = new Map<string, StepState>();
  /**
   * Per-step delegation `task_id`, remembered on `step_delegated` so the
   * subsequent terminal event can include it in its payload (spec §3.7).
   * Receivers join the delegation chain payload-directly instead of
   * reconstructing it by scanning sibling events.
   */
  private _stepDelegationTaskIds = new Map<string, string>();

  constructor(private readonly deps: PlanExecutionDeps) {}

  /**
   * Create and execute a plan for a goal. Yields PlanChunk events as execution proceeds.
   * Builds and caches a signed GoalExecutionManifest on completion per the
   * execution-ledger@1.0 spec.
   */
  async *executePlan(
    goalId: string,
    goalPrompt: string,
    runId?: string,
    privateKey?: Uint8Array,
  ): AsyncGenerator<PlanChunk> {
    const loopDeps = this.deps.getLoopDeps();
    if (!loopDeps) throw new Error("AI not initialized — call setProvider() first");

    const availableTools =
      this.deps.toolRegistry.size > 0
        ? this.deps.toolRegistry.list().map((t) => t.name)
        : undefined;

    const localCapabilities = this.deps.getLocalCapabilities();

    // Resolve planning model — use strongest available for decomposition + reflection
    const taskRouter = this.deps.getTaskRouter?.();
    const planningConfig = taskRouter?.resolve("planning") ?? undefined;
    const reflectionConfig = taskRouter?.resolve("plan_reflection") ?? undefined;

    const { plan } = await this.deps.planEngine.createPlan(
      goalId,
      this.deps.motebitId,
      {
        goalPrompt,
        availableTools,
        localCapabilities: localCapabilities.length > 0 ? localCapabilities : undefined,
      },
      loopDeps,
      planningConfig,
    );

    const executionStartedAt = Date.now();
    let finalStatus: GoalExecutionManifest["status"] = "active";

    for await (const chunk of this.deps.planEngine.executePlan(
      plan.plan_id,
      loopDeps,
      undefined,
      runId,
      reflectionConfig,
    )) {
      this._logPlanChunkEvent(chunk, goalId);
      if (chunk.type === "plan_completed") finalStatus = "completed";
      else if (chunk.type === "plan_failed") finalStatus = "failed";
      yield chunk;
    }

    // Build execution manifest from PlanEngine timeline + tool audit data
    try {
      this._lastExecutionManifest = await this._buildLiveManifest(
        goalId,
        plan.plan_id,
        executionStartedAt,
        finalStatus,
        privateKey,
      );
    } catch (err: unknown) {
      this.deps.logger.warn("manifest construction failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Return the execution manifest produced by the last `executePlan()` call.
   * Returns null if no execution has completed or manifest construction failed.
   */
  getLastExecutionManifest(): GoalExecutionManifest | null {
    return this._lastExecutionManifest;
  }

  /**
   * Build a signed GoalExecutionManifest from the PlanEngine's accumulated
   * timeline, augmented with tool audit data (args hashes, call IDs, durations).
   */
  private async _buildLiveManifest(
    goalId: string,
    planId: string,
    startedAt: number,
    status: GoalExecutionManifest["status"],
    privateKey?: Uint8Array,
  ): Promise<GoalExecutionManifest> {
    // 1. Collect structural timeline from PlanEngine
    const timeline: ExecutionTimelineEntry[] = [];

    // goal_started
    timeline.push({
      timestamp: startedAt,
      type: "goal_started",
      payload: { goal_id: goalId },
    });

    // Plan engine timeline (plan_created, step events, plan outcome)
    const engineTimeline = this.deps.planEngine.takeTimeline();

    // 2. Augment tool events with audit data (args_hash, call_id, precise ok/duration)
    const toolEntries: ToolAuditEntry[] = [];
    if (this.deps.toolAuditSink?.queryByRunId != null) {
      toolEntries.push(...this.deps.toolAuditSink.queryByRunId(planId));
    }

    // Build a map from tool audit entries keyed by approximate timestamp + tool name
    // to match with PlanEngine's tool_invoked/tool_result events
    let auditIndex = 0;
    for (const entry of engineTimeline) {
      if (entry.type === "tool_invoked") {
        // Try to match with an audit entry
        const auditEntry = toolEntries[auditIndex];
        if (auditEntry && auditEntry.decision.allowed) {
          const argsHash = await hashString(
            JSON.stringify(auditEntry.args, Object.keys(auditEntry.args).sort()),
          );
          entry.payload = {
            tool: auditEntry.tool,
            args_hash: argsHash,
            call_id: auditEntry.callId,
          };
        }
      } else if (entry.type === "tool_result") {
        const auditEntry = toolEntries[auditIndex];
        if (auditEntry && auditEntry.decision.allowed && auditEntry.result) {
          entry.payload = {
            tool: auditEntry.tool,
            ok: auditEntry.result.ok,
            duration_ms: auditEntry.result.durationMs,
            call_id: auditEntry.callId,
          };
          auditIndex++;
        } else if (auditEntry) {
          auditIndex++;
        }
      }
      timeline.push(entry);
    }

    // goal_completed
    const completedAt = Date.now();
    timeline.push({
      timestamp: completedAt,
      type: "goal_completed",
      payload: { goal_id: goalId, status },
    });

    // 3. Build step summaries from the plan store
    const steps = this.deps.planStore.getStepsForPlan(planId);
    const stepSummaries: ExecutionStepSummary[] = steps.map((s) => {
      const stepToolEntries = toolEntries.filter((t) => {
        if (s.started_at == null) return false;
        const end = s.completed_at ?? Infinity;
        return t.timestamp >= s.started_at && t.timestamp <= end;
      });
      const uniqueTools = [...new Set(stepToolEntries.map((t) => t.tool))];

      const summary: ExecutionStepSummary = {
        step_id: s.step_id,
        ordinal: s.ordinal,
        description: s.description,
        status: s.status,
        tools_used: uniqueTools,
        tool_calls: s.tool_calls_made,
        started_at: s.started_at,
        completed_at: s.completed_at,
      };

      if (s.delegation_task_id) {
        // Find the step_delegated event for this step to extract routing provenance
        const delegatedEvent = timeline.find(
          (e) => e.type === "step_delegated" && e.payload.step_id === s.step_id,
        );
        const routingChoice = delegatedEvent?.payload.routing_choice as
          | NonNullable<ExecutionStepSummary["delegation"]>["routing_choice"]
          | undefined;

        summary.delegation = {
          task_id: s.delegation_task_id,
          routing_choice: routingChoice,
        };
      }

      return summary;
    });

    // 4. Compute content hash
    const contentHash = await computeTimelineHash(timeline);

    // 5. Assemble manifest
    const manifest: GoalExecutionManifest = {
      spec: "motebit/execution-ledger@1.0",
      motebit_id: this.deps.motebitId,
      goal_id: goalId,
      plan_id: planId,
      started_at: startedAt,
      completed_at: completedAt,
      status,
      timeline,
      steps: stepSummaries,
      delegation_receipts: [],
      content_hash: contentHash,
    };

    // 6. Sign if private key provided
    if (privateKey) {
      const hashBytes = hexToBytes(contentHash);
      const sig = await sign(hashBytes, privateKey);
      manifest.signature = toBase64Url(sig);
    }

    return manifest;
  }

  /**
   * Resume an existing plan that was paused (e.g. waiting for approval).
   * Streams PlanChunk events starting from where the plan left off.
   */
  async *resumePlan(planId: string, runId?: string): AsyncGenerator<PlanChunk> {
    const loopDeps = this.deps.getLoopDeps();
    if (!loopDeps) throw new Error("AI not initialized — call setProvider() first");
    const plan = this.deps.planStore.getPlan(planId);
    const goalId = plan?.goal_id;
    for await (const chunk of this.deps.planEngine.resumePlan(planId, loopDeps, undefined, runId)) {
      this._logPlanChunkEvent(chunk, goalId);
      yield chunk;
    }
  }

  /**
   * Recover delegated steps that were orphaned (e.g. tab closed during delegation).
   * Polls relay for results and resumes plans where possible.
   */
  async *recoverDelegatedSteps(loopDeps: MotebitLoopDependencies): AsyncGenerator<PlanChunk> {
    for await (const chunk of this.deps.planEngine.recoverDelegatedSteps(
      this.deps.motebitId,
      loopDeps,
    )) {
      this._logPlanChunkEvent(chunk);
      yield chunk;
    }
  }

  /**
   * Log plan lifecycle events centrally. Single authorship site for every
   * `plan_*` event shape pinned by `spec/plan-lifecycle-v1.md`.
   *
   * Two invariants enforced here in addition to payload construction:
   *
   *  1. **§3.4 step-lifecycle ordering.** Each `step_id` transitions
   *     pending → started → (delegated)? → terminal. Out-of-order chunks
   *     (a second delegation for the same step, a completion before a
   *     start, any event after a terminal) are rejected — the event is
   *     not appended and a warning is logged. The map is reset on
   *     `plan_created` so re-running a plan (or running a plan with
   *     recycled step ids across test fixtures) starts clean.
   *
   *  2. **§3.7 delegation correlation.** When a step is delegated we
   *     remember its `task_id`; when the step's terminal event fires we
   *     include that `task_id` in the payload. Receivers join the
   *     delegation chain payload-directly.
   */
  private _logPlanChunkEvent(chunk: PlanChunk, goalId?: string): void {
    let eventType: EventType | undefined;
    let payload: Record<string, unknown> | undefined;

    switch (chunk.type) {
      case "plan_created":
        // Reset per-step state on a new plan materialization.
        for (const s of chunk.steps) {
          this._stepStates.delete(s.step_id);
          this._stepDelegationTaskIds.delete(s.step_id);
        }
        eventType = EventType.PlanCreated;
        payload = {
          plan_id: chunk.plan.plan_id,
          title: chunk.plan.title,
          total_steps: chunk.steps.length,
        };
        break;
      case "step_started":
        if (!this._advanceStep(chunk.step.step_id, "started", "plan_step_started")) return;
        eventType = EventType.PlanStepStarted;
        payload = {
          plan_id: chunk.step.plan_id,
          step_id: chunk.step.step_id,
          ordinal: chunk.step.ordinal,
          description: chunk.step.description,
        };
        // Slab wiring — one `plan_step` item per step, keyed by step_id.
        this.deps.slab?.openItem({
          id: `slab-step-${chunk.step.step_id}`,
          kind: "plan_step",
          payload: {
            plan_id: chunk.step.plan_id,
            step_id: chunk.step.step_id,
            ordinal: chunk.step.ordinal,
            description: chunk.step.description,
            status: "running",
          },
        });
        break;
      case "step_completed": {
        if (!this._advanceStep(chunk.step.step_id, "terminal", "plan_step_completed")) return;
        eventType = EventType.PlanStepCompleted;
        const base: Record<string, unknown> = {
          plan_id: chunk.step.plan_id,
          step_id: chunk.step.step_id,
          ordinal: chunk.step.ordinal,
          tool_calls_made: chunk.step.tool_calls_made,
        };
        const taskId = this._stepDelegationTaskIds.get(chunk.step.step_id);
        if (taskId != null) base.task_id = taskId;
        payload = base;
        // Slab: end with completed (default policy dissolves; individual
        // steps don't graduate to artifacts — the completed plan as a
        // whole does, via the plan_completed case's callback).
        this.deps.slab?.endItem(`slab-step-${chunk.step.step_id}`, {
          kind: "completed",
          result: { tool_calls_made: chunk.step.tool_calls_made },
        });
        break;
      }
      case "step_failed": {
        if (!this._advanceStep(chunk.step.step_id, "terminal", "plan_step_failed")) return;
        eventType = EventType.PlanStepFailed;
        const base: Record<string, unknown> = {
          plan_id: chunk.step.plan_id,
          step_id: chunk.step.step_id,
          ordinal: chunk.step.ordinal,
          error: chunk.error,
        };
        const taskId = this._stepDelegationTaskIds.get(chunk.step.step_id);
        if (taskId != null) base.task_id = taskId;
        payload = base;
        this.deps.slab?.endItem(`slab-step-${chunk.step.step_id}`, {
          kind: "failed",
          error: chunk.error,
        });
        break;
      }
      case "step_delegated":
        if (!this._advanceStep(chunk.step.step_id, "delegated", "plan_step_delegated")) return;
        this._stepDelegationTaskIds.set(chunk.step.step_id, chunk.task_id);
        eventType = EventType.PlanStepDelegated;
        payload = {
          plan_id: chunk.step.plan_id,
          step_id: chunk.step.step_id,
          ordinal: chunk.step.ordinal,
          task_id: chunk.task_id,
          routing_choice: chunk.routing_choice,
        };
        // Slab: step is mid-flight via delegation — update payload so
        // the renderer can show "delegated to task X" but don't end
        // the item yet; the terminal step_completed/step_failed closes it.
        this.deps.slab?.updateItem(`slab-step-${chunk.step.step_id}`, {
          plan_id: chunk.step.plan_id,
          step_id: chunk.step.step_id,
          ordinal: chunk.step.ordinal,
          status: "delegated",
          task_id: chunk.task_id,
          routing_choice: chunk.routing_choice,
        });
        break;
      case "plan_completed":
        eventType = EventType.PlanCompleted;
        payload = { plan_id: chunk.plan.plan_id };
        break;
      case "plan_failed":
        eventType = EventType.PlanFailed;
        payload = { plan_id: chunk.plan.plan_id, reason: chunk.reason };
        break;
      default:
        return; // step_chunk, approval_request, reflection, plan_retrying, plan_truncated — handled by consumers
    }

    if (goalId != null) {
      payload.goal_id = goalId;
    }

    void (async () => {
      try {
        await this.deps.events.appendWithClock({
          event_id: crypto.randomUUID(),
          motebit_id: this.deps.motebitId,
          timestamp: Date.now(),
          event_type: eventType,
          payload,
          tombstoned: false,
        });
      } catch {
        // Fire-and-forget — consistent with existing event logging patterns
      }
    })();
  }

  /**
   * State-machine transition for one `step_id`. Returns `true` if the
   * transition is valid (and records the new state); returns `false`
   * and logs a warning if the transition violates §3.4.
   *
   * Valid edges:
   *   - `pending` → `started`
   *   - `started` → `delegated`
   *   - `started` → `terminal`
   *   - `delegated` → `terminal`
   *
   * The `pending` state is implicit (absent from the map). No edge into
   * `started` from `delegated` or `terminal`; no re-delegation; no
   * post-terminal emission.
   */
  private _advanceStep(
    stepId: string,
    next: Exclude<StepState, "pending">,
    chunkKind: string,
  ): boolean {
    const current: StepState = this._stepStates.get(stepId) ?? "pending";
    const valid =
      (current === "pending" && next === "started") ||
      (current === "started" && next === "delegated") ||
      (current === "started" && next === "terminal") ||
      (current === "delegated" && next === "terminal");
    if (!valid) {
      this.deps.logger.warn("plan step event suppressed — invalid transition (spec §3.4)", {
        step_id: stepId,
        from: current,
        attempted: next,
        chunk: chunkKind,
      });
      return false;
    }
    this._stepStates.set(stepId, next);
    return true;
  }

  /**
   * Reconstruct a complete execution manifest for a goal from the event log
   * and tool audit trail. The manifest is a verifiable, replayable record
   * of everything the agent did during goal execution.
   *
   * If `privateKey` is provided, the content_hash is Ed25519-signed, making
   * the manifest independently verifiable by any party with the public key.
   */
  async replayGoal(goalId: string, privateKey?: Uint8Array): Promise<GoalExecutionManifest | null> {
    return replayGoal(
      {
        motebitId: this.deps.motebitId,
        planStore: this.deps.planStore,
        events: this.deps.events,
        auditSink: this.deps.toolAuditSink,
      },
      goalId,
      privateKey,
    );
  }
}
