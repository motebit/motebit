import React from "react";
import { computeReputationScore } from "@motebit/policy";
import { AgentTrustLevel } from "@motebit/sdk";
import type { AgentTrustRecord } from "@motebit/sdk";
import type { AgentTrustEntry } from "../api";

const TRUST_COLORS: Record<string, string> = {
  trusted: "#4caf50",
  verified: "#ff9800",
  first_contact: "#9e9e9e",
  blocked: "#f44336",
  unknown: "#616161",
};

/**
 * Convert the API's `AgentTrustEntry` shape to `@motebit/policy`'s
 * `AgentTrustRecord` and delegate to the canonical reputation formula.
 * Previously this file reinvented the formula inline and diverged on
 * the Beta-binomial prior — admin showed different scores than AI-core
 * computed for the same record. Gone.
 */
function reputationScore(r: AgentTrustEntry): number {
  // AgentTrustLevel is a string enum; API values ("trusted" etc.) align
  // with enum values verbatim, so the cast is structurally safe.
  const record: AgentTrustRecord = {
    motebit_id: r.motebit_id,
    remote_motebit_id: r.remote_motebit_id,
    trust_level: r.trust_level as AgentTrustLevel,
    public_key: r.public_key,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    interaction_count: r.interaction_count,
    successful_tasks: r.successful_tasks,
    failed_tasks: r.failed_tasks,
    notes: r.notes,
  };
  return computeReputationScore(record);
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
