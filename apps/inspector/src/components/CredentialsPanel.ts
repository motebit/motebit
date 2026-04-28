import React from "react";
import type { CredentialEntry, BudgetAllocationEntry, SuccessionResponse } from "../api";

const TYPE_COLORS: Record<string, string> = {
  reputation: "#4caf50",
  trust: "#ff9800",
  gradient: "#2196f3",
  capability: "#9c27b0",
  unknown: "#616161",
};

function resolveIssuer(cred: CredentialEntry["credential"]): string {
  if (cred.issuer == null) return "unknown";
  if (typeof cred.issuer === "string") return cred.issuer;
  return cred.issuer.id ?? "unknown";
}

function resolveSubject(cred: CredentialEntry["credential"]): string {
  const subj = cred.credentialSubject;
  if (!subj) return "unknown";
  if (typeof subj.id === "string") return subj.id;
  return "unknown";
}

interface CredentialsPanelProps {
  credentials: CredentialEntry[];
  revokedIds?: Set<string>;
  budgetSummary: { total_locked: number; total_settled: number } | null;
  budgetAllocations: BudgetAllocationEntry[];
  succession: SuccessionResponse | null;
  presentation: Record<string, unknown> | null;
  presentationLoading: boolean;
  onGeneratePresentation: () => void;
}

export function CredentialsPanel({
  credentials,
  revokedIds,
  budgetSummary,
  budgetAllocations,
  succession,
  presentation,
  presentationLoading,
  onGeneratePresentation,
}: CredentialsPanelProps): React.ReactElement {
  // Count by type
  const typeCounts: Record<string, number> = {};
  for (const c of credentials) {
    const t = c.credential_type;
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  }

  const sorted = [...credentials].sort((a, b) => b.issued_at - a.issued_at);

  return React.createElement(
    "div",
    { className: "panel" },

    // Credentials section
    React.createElement("h2", null, "Credentials"),
    React.createElement(
      "div",
      { className: "count" },
      `${credentials.length} credential${credentials.length !== 1 ? "s" : ""}`,
    ),

    // Type counts
    Object.keys(typeCounts).length > 0
      ? React.createElement(
          "div",
          {
            style: {
              display: "flex",
              gap: "8px",
              flexWrap: "wrap" as const,
              marginBottom: "12px",
            },
          },
          ...Object.entries(typeCounts).map(([type, count]) => {
            const color = TYPE_COLORS[type] ?? TYPE_COLORS.unknown;
            return React.createElement(
              "span",
              {
                key: type,
                style: {
                  color,
                  fontSize: "12px",
                  padding: "2px 8px",
                  borderRadius: "3px",
                  border: `1px solid ${color}`,
                },
              },
              `${type}: ${count}`,
            );
          }),
        )
      : null,

    // Generate Presentation button
    React.createElement(
      "button",
      {
        style: {
          padding: "6px 14px",
          fontSize: "12px",
          borderRadius: "4px",
          border: "1px solid #888",
          background: "transparent",
          cursor: presentationLoading ? "wait" : "pointer",
          marginBottom: "12px",
          opacity: presentationLoading ? 0.6 : 1,
        },
        onClick: onGeneratePresentation,
        disabled: presentationLoading || credentials.length === 0,
      },
      presentationLoading ? "Generating..." : "Generate Presentation",
    ),

    // VP display
    presentation != null
      ? React.createElement(
          "pre",
          {
            style: {
              fontSize: "10px",
              background: "rgba(0,0,0,0.05)",
              padding: "8px",
              borderRadius: "4px",
              overflow: "auto",
              maxHeight: "200px",
              marginBottom: "16px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all" as const,
            },
          },
          JSON.stringify(presentation, null, 2),
        )
      : null,

    // Credential list
    ...sorted.map((c) => {
      const color = TYPE_COLORS[c.credential_type] ?? TYPE_COLORS.unknown;
      const issuer = resolveIssuer(c.credential);
      const subject = resolveSubject(c.credential);
      const issuerShort = issuer.length > 32 ? issuer.slice(0, 32) + "..." : issuer;
      const subjectShort = subject.length > 32 ? subject.slice(0, 32) + "..." : subject;
      const isRevoked = revokedIds?.has(c.credential_id) ?? false;

      return React.createElement(
        "div",
        {
          key: c.credential_id,
          className: "event-entry device-entry",
          style: isRevoked ? { opacity: 0.5 } : undefined,
        },
        React.createElement(
          "div",
          { className: "device-header" },
          React.createElement(
            "span",
            {
              className: "device-name",
              style: isRevoked ? { textDecoration: "line-through" } : undefined,
            },
            c.credential_id.slice(0, 12) + "...",
          ),
          isRevoked
            ? React.createElement(
                "span",
                {
                  style: {
                    color: "#f44336",
                    fontWeight: "bold",
                    fontSize: "11px",
                    padding: "2px 6px",
                    borderRadius: "3px",
                    border: "1px solid #f44336",
                    marginRight: "4px",
                  },
                },
                "REVOKED",
              )
            : null,
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
            c.credential_type,
          ),
        ),
        React.createElement(
          "div",
          { className: "device-meta" },
          React.createElement("span", null, `issuer: ${issuerShort}`),
          React.createElement("span", null, `subject: ${subjectShort}`),
          React.createElement(
            "span",
            { className: "timestamp" },
            `issued ${new Date(c.issued_at).toISOString()}`,
          ),
        ),
      );
    }),

    // Budget section
    React.createElement("h2", { style: { marginTop: "24px" } }, "Budget"),

    budgetSummary != null
      ? React.createElement(
          "div",
          {
            style: {
              display: "flex",
              gap: "16px",
              marginBottom: "12px",
            },
          },
          React.createElement(
            "div",
            {
              style: {
                padding: "8px 14px",
                borderRadius: "4px",
                background: "rgba(0,0,0,0.05)",
                fontSize: "13px",
              },
            },
            React.createElement("div", { style: { fontSize: "10px", opacity: 0.6 } }, "Locked"),
            React.createElement(
              "div",
              { style: { fontWeight: "bold" } },
              String(budgetSummary.total_locked),
            ),
          ),
          React.createElement(
            "div",
            {
              style: {
                padding: "8px 14px",
                borderRadius: "4px",
                background: "rgba(0,0,0,0.05)",
                fontSize: "13px",
              },
            },
            React.createElement("div", { style: { fontSize: "10px", opacity: 0.6 } }, "Settled"),
            React.createElement(
              "div",
              { style: { fontWeight: "bold" } },
              String(budgetSummary.total_settled),
            ),
          ),
        )
      : React.createElement("div", { className: "count" }, "No budget data"),

    // Allocation list
    ...budgetAllocations.map((a) => {
      const settled = a.settlement_status === "settled";
      return React.createElement(
        "div",
        { key: a.allocation_id, className: "event-entry device-entry" },
        React.createElement(
          "div",
          { className: "device-header" },
          React.createElement(
            "span",
            { className: "device-name" },
            a.allocation_id.slice(0, 12) + "...",
          ),
          React.createElement(
            "span",
            {
              style: {
                color: settled ? "#4caf50" : "#ff9800",
                fontWeight: "bold",
                fontSize: "12px",
                padding: "2px 6px",
                borderRadius: "3px",
                border: `1px solid ${settled ? "#4caf50" : "#ff9800"}`,
              },
            },
            a.status,
          ),
        ),
        React.createElement(
          "div",
          { className: "device-meta" },
          React.createElement("span", null, `locked: ${a.amount_locked}`),
          a.amount_settled != null
            ? React.createElement("span", null, `settled: ${a.amount_settled}`)
            : null,
          a.task_id
            ? React.createElement("span", null, `task: ${a.task_id.slice(0, 12)}...`)
            : null,
          React.createElement(
            "span",
            { className: "timestamp" },
            `created ${new Date(a.created_at).toISOString()}`,
          ),
          a.settled_at != null
            ? React.createElement(
                "span",
                { className: "timestamp" },
                `settled ${new Date(a.settled_at).toISOString()}`,
              )
            : null,
        ),
      );
    }),

    // Key Succession section
    React.createElement("h2", { style: { marginTop: "24px" } }, "Key Succession"),

    succession != null && succession.chain.length > 0
      ? React.createElement(
          "div",
          null,
          React.createElement(
            "div",
            {
              style: {
                display: "flex",
                gap: "16px",
                marginBottom: "12px",
              },
            },
            React.createElement(
              "div",
              {
                style: {
                  padding: "8px 14px",
                  borderRadius: "4px",
                  background: "rgba(0,0,0,0.05)",
                  fontSize: "13px",
                },
              },
              React.createElement(
                "div",
                { style: { fontSize: "10px", opacity: 0.6 } },
                "Rotations",
              ),
              React.createElement(
                "div",
                { style: { fontWeight: "bold" } },
                String(succession.chain.length),
              ),
            ),
            React.createElement(
              "div",
              {
                style: {
                  padding: "8px 14px",
                  borderRadius: "4px",
                  background: "rgba(0,0,0,0.05)",
                  fontSize: "13px",
                },
              },
              React.createElement(
                "div",
                { style: { fontSize: "10px", opacity: 0.6 } },
                "Current Key",
              ),
              React.createElement(
                "div",
                {
                  style: { fontWeight: "bold", fontSize: "11px", wordBreak: "break-all" as const },
                },
                succession.current_public_key.slice(0, 24) + "...",
              ),
            ),
          ),
          React.createElement(
            "div",
            {
              style: {
                fontSize: "11px",
                opacity: 0.6,
                marginBottom: "8px",
              },
            },
            `Genesis key: ${succession.chain[0]!.old_public_key.slice(0, 24)}...`,
          ),
          ...succession.chain.map((entry, i) =>
            React.createElement(
              "div",
              {
                key: `succ-${i}`,
                className: "event-entry device-entry",
              },
              React.createElement(
                "div",
                { className: "device-header" },
                React.createElement("span", { className: "device-name" }, `Rotation ${i + 1}`),
                React.createElement(
                  "span",
                  {
                    style: {
                      color: "#f0a030",
                      fontWeight: "bold",
                      fontSize: "12px",
                      padding: "2px 6px",
                      borderRadius: "3px",
                      border: "1px solid #f0a030",
                    },
                  },
                  "rotated",
                ),
              ),
              React.createElement(
                "div",
                { className: "device-meta" },
                React.createElement("span", null, `old: ${entry.old_public_key.slice(0, 16)}...`),
                React.createElement("span", null, `new: ${entry.new_public_key.slice(0, 16)}...`),
                entry.reason ? React.createElement("span", null, `reason: ${entry.reason}`) : null,
                React.createElement(
                  "span",
                  { className: "timestamp" },
                  `rotated ${new Date(entry.timestamp).toISOString()}`,
                ),
              ),
            ),
          ),
        )
      : React.createElement("div", { className: "count" }, "No key rotations"),
  );
}
