/**
 * Plan Execution View Model — normalizes streaming PlanChunks into a
 * consistent snapshot that surfaces can render without interpretation.
 *
 * This is NOT a command handler (plans are streaming, not request/response).
 * It's an aggregator: feed it chunks, read the current state.
 *
 * Surfaces call:
 *   const evm = new PlanExecutionVM();
 *   for await (const chunk of runtime.executePlan(...)) {
 *     evm.apply(chunk);
 *     renderPlanState(evm.snapshot());  // surface-specific rendering
 *   }
 */

import type { PlanChunk } from "@motebit/planner";

/** Maximum recent events retained in the snapshot. */
const MAX_RECENT_EVENTS = 20;

export interface PlanEvent {
  type:
    | "plan_created"
    | "step_started"
    | "step_completed"
    | "step_failed"
    | "step_delegated"
    | "plan_completed"
    | "plan_failed"
    | "plan_retrying"
    | "reflection"
    | "approval_request";
  summary: string;
  timestamp: number;
}

export interface PlanSnapshot {
  status: "idle" | "running" | "completed" | "failed";

  /** Current plan title. Updates on plan_retrying. */
  title: string;

  /** Currently executing step, if any. */
  currentStep: { id: string; description: string } | null;

  /** Progress through the current plan. Resets on plan_retrying. */
  progress: { completed: number; total: number };

  /** Rolling window of recent events (capped at MAX_RECENT_EVENTS). */
  recentEvents: PlanEvent[];

  /** Last reflection summary, if any. */
  reflection: string | null;

  /** Last failure reason, if any. */
  failureReason: string | null;
}

/**
 * Stateful aggregator that consumes PlanChunk stream and produces
 * a consistent PlanSnapshot at any point during execution.
 */
export class PlanExecutionVM {
  private _status: PlanSnapshot["status"] = "idle";
  private _title = "";
  private _currentStep: PlanSnapshot["currentStep"] = null;
  private _completed = 0;
  private _total = 0;
  private _events: PlanEvent[] = [];
  private _reflection: string | null = null;
  private _failureReason: string | null = null;

  /** Apply a PlanChunk to update internal state. */
  apply(chunk: PlanChunk): void {
    switch (chunk.type) {
      case "plan_created":
        this._status = "running";
        this._title = chunk.plan.title;
        this._total = chunk.steps.length;
        this._completed = 0;
        this._currentStep = null;
        this.pushEvent("plan_created", `Plan: ${chunk.plan.title} (${chunk.steps.length} steps)`);
        break;

      case "step_started":
        this._currentStep = {
          id: chunk.step.step_id,
          description: chunk.step.description,
        };
        this.pushEvent("step_started", chunk.step.description);
        break;

      case "step_completed":
        this._completed++;
        this._currentStep = null;
        this.pushEvent("step_completed", chunk.step.description);
        break;

      case "step_failed":
        this._currentStep = null;
        this.pushEvent("step_failed", `${chunk.step.description}: ${chunk.error}`);
        break;

      case "step_delegated":
        this.pushEvent("step_delegated", `Delegated: ${chunk.step.description}`);
        break;

      case "plan_completed":
        this._status = "completed";
        this._currentStep = null;
        this.pushEvent("plan_completed", `Complete: ${chunk.plan.title}`);
        break;

      case "plan_failed":
        this._status = "failed";
        this._currentStep = null;
        this._failureReason = chunk.reason;
        this.pushEvent("plan_failed", chunk.reason);
        break;

      case "plan_retrying":
        // Plan replaced — reset progress, keep events
        this._title = chunk.newPlan.title;
        this._total = chunk.newPlan.total_steps;
        this._completed = 0;
        this._currentStep = null;
        this._status = "running";
        this.pushEvent("plan_retrying", `Retrying: ${chunk.newPlan.title}`);
        break;

      case "reflection":
        this._reflection = chunk.result.summary ?? null;
        if (this._reflection) {
          this.pushEvent("reflection", this._reflection);
        }
        break;

      case "approval_request":
        this.pushEvent("approval_request", `Approval needed: ${chunk.step.description}`);
        break;

      case "step_chunk":
      case "plan_truncated":
        // No snapshot-level state change
        break;
    }
  }

  /** Get the current snapshot. Cheap — no allocations except the return object. */
  snapshot(): PlanSnapshot {
    return {
      status: this._status,
      title: this._title,
      currentStep: this._currentStep,
      progress: { completed: this._completed, total: this._total },
      recentEvents: this._events,
      reflection: this._reflection,
      failureReason: this._failureReason,
    };
  }

  /** Reset to idle state. */
  reset(): void {
    this._status = "idle";
    this._title = "";
    this._currentStep = null;
    this._completed = 0;
    this._total = 0;
    this._events = [];
    this._reflection = null;
    this._failureReason = null;
  }

  private pushEvent(type: PlanEvent["type"], summary: string): void {
    this._events.push({ type, summary, timestamp: Date.now() });
    if (this._events.length > MAX_RECENT_EVENTS) {
      this._events = this._events.slice(-MAX_RECENT_EVENTS);
    }
  }
}
