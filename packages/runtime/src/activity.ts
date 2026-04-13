/**
 * Activity derivation — what the agent is currently doing, as a short label.
 *
 * Doctrine (CLAUDE.md, "Capability rings, not feature parity"):
 * "operator can see what the agent is currently doing" is Ring 1 —
 * every surface (CLI, desktop, mobile, web, spatial) that speaks to a
 * motebit should be able to show a short, current-activity label.
 *
 * The runtime already emits the information via its async chunk streams
 * (StreamChunk from MotebitRuntime; PlanChunk from PlanEngine, re-exported
 * from @motebit/runtime). What was missing was a derivation layer mapping
 * those chunks to a short, human-readable label, plus a subscription
 * model any surface can bind to.
 *
 * Pure functions (`deriveStreamActivity`, `derivePlanActivity`) are
 * testable in isolation. `ActivityTracker` holds the current label and
 * notifies subscribers on change — surfaces subscribe once at startup.
 *
 * Labels are intentionally short (≤40 chars) because the HUD-class
 * bindings have no room for prose. "thinking" is the idle-but-working
 * default. Returning `undefined` from a derivation means "chunk doesn't
 * change the current activity" — the tracker keeps whatever was set.
 */
import type { StreamChunk } from "./index.js";
import type { PlanChunk } from "@motebit/planner";

export type ActivityLabel = string | null;

/**
 * Map a StreamChunk to an activity label, or return "unchanged"
 * (undefined) if the chunk doesn't change the current activity.
 *
 * Returning null means "clear" — the agent is idle. Returning a string
 * means "set this label". Returning undefined means "keep whatever was
 * set".
 */
export function deriveStreamActivity(chunk: StreamChunk): ActivityLabel | undefined {
  switch (chunk.type) {
    case "tool_status":
      return chunk.status === "calling" ? `tool: ${chunk.name}` : "thinking";
    case "delegation_start":
      return `delegating → ${chunk.tool}`;
    case "delegation_complete":
      return "thinking";
    case "approval_request":
      return `approval: ${chunk.name}`;
    case "approval_expired":
      return "thinking";
    case "result":
    case "task_result":
      return null;
    default:
      return undefined;
  }
}

/**
 * Map a PlanChunk to an activity label. Plan-level activities trump
 * stream-level activities because a running plan is a longer-lived
 * context.
 */
export function derivePlanActivity(chunk: PlanChunk): ActivityLabel | undefined {
  switch (chunk.type) {
    case "plan_created":
      return "planning";
    case "step_started":
      return stepLabel(chunk.step.description);
    case "step_delegated":
      return `delegating step: ${truncate(chunk.step.description, 30)}`;
    case "step_completed":
    case "step_failed":
      return "planning";
    case "plan_completed":
    case "plan_failed":
      return null;
    case "approval_request":
      return `approval: ${chunk.step.description}`;
    case "reflection":
      return "reflecting";
    default:
      return undefined;
  }
}

function stepLabel(description: string): string {
  return `step: ${truncate(description, 36)}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Holds the current activity label and fans out change notifications.
 * Surfaces subscribe once; instrumented call sites push via `set()`.
 *
 * Idempotent — `set()` with the same label is a no-op (no listener
 * churn). `clear()` is sugar for `set(null)`.
 */
export class ActivityTracker {
  private _label: ActivityLabel = null;
  private listeners = new Set<(label: ActivityLabel) => void>();

  get label(): ActivityLabel {
    return this._label;
  }

  set(label: ActivityLabel): void {
    if (label === this._label) return;
    this._label = label;
    for (const cb of this.listeners) cb(label);
  }

  clear(): void {
    this.set(null);
  }

  onChange(cb: (label: ActivityLabel) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}
