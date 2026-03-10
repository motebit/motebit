import React from "react";
import type { GoalEntry } from "../api";

function statusBadge(goal: GoalEntry): { text: string; className: string } {
  if (goal.status === "completed") return { text: "completed", className: "goal-status completed" };
  if (goal.status === "failed") return { text: "failed", className: "goal-status failed" };
  if (goal.status === "paused" || !goal.enabled)
    return { text: "paused", className: "goal-status paused" };
  return { text: "active", className: "goal-status active" };
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export function GoalsPanel({ goals }: { goals: GoalEntry[] }): React.ReactElement {
  const sorted = [...goals].sort((a, b) => {
    // Active first, then paused, then completed/failed
    const order: Record<string, number> = { active: 0, paused: 1, failed: 2, completed: 3 };
    const diff = (order[a.status] ?? 4) - (order[b.status] ?? 4);
    if (diff !== 0) return diff;
    return b.created_at - a.created_at;
  });

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Goals"),
    React.createElement("div", { className: "count" }, `${goals.length} goals total`),
    ...sorted.map((g) => {
      const badge = statusBadge(g);
      return React.createElement(
        "div",
        { key: g.goal_id, className: "event-entry goal-entry" },
        React.createElement(
          "div",
          { className: "goal-header" },
          React.createElement("span", { className: badge.className }, badge.text),
          React.createElement("span", { className: "goal-mode" }, g.mode),
          React.createElement(
            "span",
            { className: "goal-interval" },
            formatInterval(g.interval_ms),
          ),
          g.consecutive_failures > 0
            ? React.createElement(
                "span",
                { className: "goal-failures" },
                `${g.consecutive_failures} failures`,
              )
            : null,
        ),
        React.createElement("div", { className: "goal-prompt" }, g.prompt),
        React.createElement(
          "div",
          { className: "goal-meta" },
          React.createElement(
            "span",
            { className: "timestamp" },
            `created ${new Date(g.created_at).toISOString()}`,
          ),
          g.last_run_at != null
            ? React.createElement(
                "span",
                { className: "timestamp" },
                `last run ${new Date(g.last_run_at).toISOString()}`,
              )
            : React.createElement("span", { className: "timestamp" }, "never run"),
        ),
      );
    }),
  );
}
