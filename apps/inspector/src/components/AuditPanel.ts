import React from "react";
import type { ToolAuditEntry } from "@motebit/sdk";

function decisionLabel(entry: ToolAuditEntry): { text: string; className: string } {
  if (entry.decision.requiresApproval)
    return { text: "approval", className: "audit-decision approval" };
  if (entry.decision.allowed) return { text: "allowed", className: "audit-decision allowed" };
  return { text: "denied", className: "audit-decision denied" };
}

export function AuditPanel({ entries }: { entries: ToolAuditEntry[] }): React.ReactElement {
  const recent = entries.slice(-50).reverse();
  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Tool Audit Log"),
    React.createElement("div", { className: "count" }, `${entries.length} entries total`),
    ...recent.map((e) => {
      const badge = decisionLabel(e);
      return React.createElement(
        "div",
        { key: e.callId, className: "event-entry" },
        React.createElement(
          "span",
          { className: "timestamp" },
          new Date(e.timestamp).toISOString(),
        ),
        React.createElement("span", { className: "event-type" }, e.tool),
        React.createElement("span", { className: badge.className }, badge.text),
        React.createElement("span", { className: "clock" }, e.turnId.slice(0, 8)),
      );
    }),
  );
}
