import React, { useState } from "react";
import type { PlanEntry, PlanStepEntry } from "../api";

function planStatusBadge(status: PlanEntry["status"]): { text: string; className: string } {
  switch (status) {
    case "active": return { text: "active", className: "plan-status active" };
    case "completed": return { text: "completed", className: "plan-status completed" };
    case "failed": return { text: "failed", className: "plan-status failed" };
    case "paused": return { text: "paused", className: "plan-status paused" };
    default: return { text: status, className: "plan-status" };
  }
}

function stepStatusBadge(status: PlanStepEntry["status"]): { text: string; className: string } {
  switch (status) {
    case "pending": return { text: "pending", className: "step-status pending" };
    case "running": return { text: "running", className: "step-status running" };
    case "completed": return { text: "completed", className: "step-status completed" };
    case "failed": return { text: "failed", className: "step-status failed" };
    case "skipped": return { text: "skipped", className: "step-status skipped" };
    default: return { text: status, className: "step-status" };
  }
}

function formatDuration(startedAt: number | null, completedAt: number | null): string {
  if (!startedAt) return "";
  const end = completedAt ?? Date.now();
  const ms = end - startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function truncate(s: string | null, maxLen: number): string {
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}

function formatTime(ts: number): string {
  return new Date(ts).toISOString();
}

function StepRow({ step }: { step: PlanStepEntry }): React.ReactElement {
  const badge = stepStatusBadge(step.status);
  const duration = formatDuration(step.started_at, step.completed_at);

  return React.createElement("div", { className: "plan-step" },
    React.createElement("div", { className: "plan-step-header" },
      React.createElement("span", { className: "step-ordinal" }, `#${step.ordinal + 1}`),
      React.createElement("span", { className: badge.className }, badge.text),
      React.createElement("span", { className: "step-description" }, step.description),
    ),
    React.createElement("div", { className: "plan-step-meta" },
      step.tool_calls_made > 0
        ? React.createElement("span", { className: "step-tools" },
          `${step.tool_calls_made} tool call${step.tool_calls_made !== 1 ? "s" : ""}`,
        )
        : null,
      step.retry_count > 0
        ? React.createElement("span", { className: "step-retries" },
          `${step.retry_count} retr${step.retry_count !== 1 ? "ies" : "y"}`,
        )
        : null,
      duration
        ? React.createElement("span", { className: "step-duration" }, duration)
        : null,
    ),
    step.result_summary
      ? React.createElement("div", { className: "step-result" },
        truncate(step.result_summary, 200),
      )
      : null,
    step.error_message
      ? React.createElement("div", { className: "step-error" },
        truncate(step.error_message, 200),
      )
      : null,
  );
}

export function PlansPanel({ plans }: { plans: PlanEntry[] }): React.ReactElement {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sorted = [...plans].sort((a, b) => {
    // Active first, then paused, then failed, then completed
    const order: Record<string, number> = { active: 0, paused: 1, failed: 2, completed: 3 };
    const diff = (order[a.status] ?? 4) - (order[b.status] ?? 4);
    if (diff !== 0) return diff;
    return b.created_at - a.created_at;
  });

  return React.createElement("div", { className: "panel" },
    React.createElement("h2", null, "Plans"),
    React.createElement("div", { className: "count" }, `${plans.length} plans total`),
    ...sorted.map((plan) => {
      const badge = planStatusBadge(plan.status);
      const isExpanded = expandedId === plan.plan_id;
      const completedSteps = plan.steps.filter((s) => s.status === "completed").length;
      const failedSteps = plan.steps.filter((s) => s.status === "failed").length;
      const runningSteps = plan.steps.filter((s) => s.status === "running").length;

      return React.createElement("div", { key: plan.plan_id, className: "plan-entry" },
        React.createElement("div", {
          className: "plan-header",
          onClick: () => setExpandedId(isExpanded ? null : plan.plan_id),
          style: { cursor: "pointer" },
        },
          React.createElement("span", { className: badge.className }, badge.text),
          React.createElement("span", { className: "plan-title" }, plan.title),
          React.createElement("span", { className: "plan-progress" },
            `${completedSteps}/${plan.total_steps} steps`,
          ),
          runningSteps > 0
            ? React.createElement("span", { className: "plan-running" }, `${runningSteps} running`)
            : null,
          failedSteps > 0
            ? React.createElement("span", { className: "plan-failed-count" }, `${failedSteps} failed`)
            : null,
          React.createElement("span", { className: "expand-indicator" },
            isExpanded ? "\u25B2" : "\u25BC",
          ),
        ),
        React.createElement("div", { className: "plan-meta" },
          React.createElement("span", { className: "timestamp" },
            `created ${formatTime(plan.created_at)}`,
          ),
          React.createElement("span", { className: "plan-goal-id" },
            `goal ${plan.goal_id.slice(0, 8)}`,
          ),
        ),
        isExpanded
          ? React.createElement("div", { className: "plan-steps" },
            plan.steps.length === 0
              ? React.createElement("div", { className: "empty" }, "No steps")
              : plan.steps.map((step) =>
                React.createElement(StepRow, { key: step.step_id, step }),
              ),
          )
          : null,
      );
    }),
  );
}
