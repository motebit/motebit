import React from "react";
import type { AgentTrustEntry } from "../api";

const TRUST_COLORS: Record<string, string> = {
  trusted: "#4caf50",
  verified: "#ff9800",
  first_contact: "#9e9e9e",
  blocked: "#f44336",
  unknown: "#616161",
};

/** Inline reputation score (same formula as @motebit/policy, avoids importing runtime code). */
function reputationScore(r: AgentTrustEntry): number {
  if (r.trust_level === "blocked" || r.trust_level === "unknown") return 0;
  const successful = r.successful_tasks ?? 0;
  const failed = r.failed_tasks ?? 0;
  const total = successful + failed;
  const successRate = total > 0 ? successful / total : 0.5;
  const volumeScore = Math.min(r.interaction_count / 50, 1.0);
  const daysSince = (Date.now() - r.last_seen_at) / 86_400_000;
  const recencyScore = Math.exp(-daysSince / 90);
  return Math.max(0, Math.min(1, (successRate + volumeScore + recencyScore) / 3));
}

export function TrustPanel({ records }: { records: AgentTrustEntry[] }): React.ReactElement {
  const sorted = [...records].sort((a, b) => b.last_seen_at - a.last_seen_at);

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Agent Trust"),
    React.createElement("div", { className: "count" }, `${records.length} known agents`),
    ...sorted.map((r) => {
      const rep = reputationScore(r);
      const successful = r.successful_tasks ?? 0;
      const failed = r.failed_tasks ?? 0;
      const total = successful + failed;
      const color = TRUST_COLORS[r.trust_level] ?? "#616161";

      return React.createElement(
        "div",
        { key: r.remote_motebit_id, className: "event-entry device-entry" },
        React.createElement(
          "div",
          { className: "device-header" },
          React.createElement(
            "span",
            { className: "device-name" },
            r.remote_motebit_id.slice(0, 12) + "...",
          ),
          React.createElement(
            "span",
            {
              style: {
                color,
                fontWeight: "bold",
                fontSize: "12px",
                padding: "2px 6px",
                borderRadius: "3px",
                border: `1px solid ${color}`,
              },
            },
            r.trust_level,
          ),
        ),
        React.createElement(
          "div",
          { className: "device-meta" },
          React.createElement("span", null, `reputation: ${(rep * 100).toFixed(0)}%`),
          React.createElement(
            "span",
            null,
            total > 0 ? `tasks: ${successful}/${total}` : "tasks: none",
          ),
          React.createElement("span", null, `interactions: ${r.interaction_count}`),
          React.createElement(
            "span",
            { className: "timestamp" },
            `first seen ${new Date(r.first_seen_at).toISOString()}`,
          ),
          React.createElement(
            "span",
            { className: "timestamp" },
            `last seen ${new Date(r.last_seen_at).toISOString()}`,
          ),
          r.notes ? React.createElement("span", { className: "timestamp" }, r.notes) : null,
        ),
      );
    }),
  );
}
