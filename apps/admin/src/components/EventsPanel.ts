import React, { useState } from "react";
import type { EventLogEntry } from "@motebit/sdk";

/** Minimal receipt shape as stored in event payloads. */
interface ReceiptSummary {
  task_id?: string;
  motebit_id?: string;
  device_id?: string;
  status?: string;
  completed_at?: number;
  tools_used?: string[];
  memories_formed?: number;
  signature?: string;
  delegation_receipts?: ReceiptSummary[];
}

const h = React.createElement;

function truncate(s: string | undefined, n: number): string {
  if (!s) return "—";
  return s.length > n ? s.slice(0, n) + "..." : s;
}

function statusColor(status: string | undefined): string {
  if (status === "completed") return "var(--green)";
  if (status === "failed" || status === "denied") return "var(--red)";
  return "var(--text)";
}

function DelegationNode({
  receipt,
  depth,
}: {
  receipt: ReceiptSummary;
  depth: number;
}): React.ReactElement {
  const indent = depth * 20;
  const hasDelegations = receipt.delegation_receipts && receipt.delegation_receipts.length > 0;

  return h(
    "div",
    { className: "delegation-node" },
    h(
      "div",
      { className: "delegation-row", style: { paddingLeft: `${indent}px` } },
      h("span", { className: "delegation-connector" }, depth > 0 ? "\u2514\u2500 " : ""),
      h(
        "span",
        { className: "delegation-status", style: { color: statusColor(receipt.status) } },
        receipt.status === "completed"
          ? "\u2713"
          : receipt.status === "failed"
            ? "\u2717"
            : "\u25CB",
      ),
      h("span", { className: "delegation-id" }, `task:${truncate(receipt.task_id, 8)}`),
      h("span", { className: "delegation-motebit" }, `mote:${truncate(receipt.motebit_id, 8)}`),
      receipt.tools_used && receipt.tools_used.length > 0
        ? h("span", { className: "delegation-tools" }, `[${receipt.tools_used.join(", ")}]`)
        : null,
      receipt.signature
        ? h("span", { className: "delegation-sig" }, `sig:${receipt.signature}`)
        : null,
    ),
    ...(hasDelegations
      ? receipt.delegation_receipts!.map((dr, i) =>
          h(DelegationNode, { key: `${dr.task_id ?? i}-${depth}`, receipt: dr, depth: depth + 1 }),
        )
      : []),
  );
}

function DelegationChain({ receipt }: { receipt: ReceiptSummary }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const delegationCount = receipt.delegation_receipts?.length ?? 0;

  if (delegationCount === 0) {
    return h("span", { className: "delegation-badge none" }, "no delegations");
  }

  return h(
    "div",
    { className: "delegation-chain" },
    h(
      "button",
      {
        className: "delegation-toggle",
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation();
          setExpanded(!expanded);
        },
      },
      `${expanded ? "\u25BC" : "\u25B6"} ${delegationCount} delegation${delegationCount > 1 ? "s" : ""}`,
    ),
    expanded
      ? h(
          "div",
          { className: "delegation-tree" },
          ...receipt.delegation_receipts!.map((dr, i) =>
            h(DelegationNode, { key: `${dr.task_id ?? i}`, receipt: dr, depth: 0 }),
          ),
        )
      : null,
  );
}

const TASK_EVENT_TYPES = new Set([
  "agent_task_completed",
  "agent_task_failed",
  "agent_task_denied",
]);

export function EventsPanel({ events }: { events: EventLogEntry[] }): React.ReactElement {
  const recent = events.slice(-30).reverse();
  return h(
    "div",
    { className: "panel" },
    h("h2", null, "Event Log"),
    h("div", { className: "count" }, `${events.length} events total`),
    ...recent.map((e) => {
      const isTaskEvent = TASK_EVENT_TYPES.has(e.event_type);
      const receipt = isTaskEvent ? (e.payload.receipt as ReceiptSummary | undefined) : undefined;

      return h(
        "div",
        { key: e.event_id, className: `event-entry${isTaskEvent ? " task-event" : ""}` },
        h(
          "div",
          { className: "event-entry-main" },
          h("span", { className: "timestamp" }, new Date(e.timestamp).toISOString()),
          h("span", { className: "event-type" }, e.event_type),
          h("span", { className: "clock" }, `v${e.version_clock}`),
          // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- payload fields are Record<string, unknown>
          isTaskEvent && e.payload.task_id
            ? h(
                "span",
                { className: "event-task-id" },
                `task:${truncate(e.payload.task_id as string, 8)}`,
              )
            : null,
        ),
        receipt ? h(DelegationChain, { receipt }) : null,
      );
    }),
  );
}
