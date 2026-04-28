import React, { useState } from "react";
import { EventType } from "@motebit/sdk";
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

/** Minimal reflection payload shape stored in event log. */
interface ReflectionPayload {
  insights?: string[];
  plan_adjustments?: string[];
  patterns?: string[];
  self_assessment?: string;
}

function ReflectionDetail({ payload }: { payload: ReflectionPayload }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const insightCount = payload.insights?.length ?? 0;
  const adjustmentCount = payload.plan_adjustments?.length ?? 0;
  const patternCount = payload.patterns?.length ?? 0;
  const parts = [
    `${insightCount} insight${insightCount !== 1 ? "s" : ""}`,
    `${adjustmentCount} adjustment${adjustmentCount !== 1 ? "s" : ""}`,
  ];
  if (patternCount > 0) parts.push(`${patternCount} pattern${patternCount !== 1 ? "s" : ""}`);
  const label = parts.join(", ");

  return h(
    "div",
    { className: "reflection-detail" },
    h(
      "button",
      {
        className: "delegation-toggle",
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation();
          setExpanded(!expanded);
        },
      },
      `${expanded ? "\u25BC" : "\u25B6"} ${label}`,
    ),
    expanded
      ? h(
          "div",
          { style: { paddingLeft: 12, fontSize: 12, lineHeight: 1.6 } },
          payload.self_assessment
            ? h(
                "div",
                { style: { color: "var(--text)", marginTop: 4 } },
                `Assessment: ${payload.self_assessment}`,
              )
            : null,
          insightCount > 0
            ? h(
                "div",
                null,
                h("span", { style: { color: "#8888aa" } }, "Insights:"),
                ...(payload.insights ?? []).map((ins, i) =>
                  h("div", { key: i, style: { paddingLeft: 8 } }, `- ${ins}`),
                ),
              )
            : null,
          adjustmentCount > 0
            ? h(
                "div",
                null,
                h("span", { style: { color: "#8888aa" } }, "Adjustments:"),
                ...(payload.plan_adjustments ?? []).map((adj, i) =>
                  h("div", { key: i, style: { paddingLeft: 8 } }, `- ${adj}`),
                ),
              )
            : null,
          patternCount > 0
            ? h(
                "div",
                null,
                h("span", { style: { color: "#f59e0b" } }, "Recurring patterns:"),
                ...(payload.patterns ?? []).map((pat, i) =>
                  h("div", { key: i, style: { paddingLeft: 8 } }, `- ${pat}`),
                ),
              )
            : null,
        )
      : null,
  );
}

export function EventsPanel({ events }: { events: EventLogEntry[] }): React.ReactElement {
  const recent = events.slice(-30).reverse();
  return h(
    "div",
    { className: "panel" },
    h("h2", null, "Event Log"),
    h("div", { className: "count" }, `${events.length} events total`),
    ...recent.map((e) => {
      const isTaskEvent = TASK_EVENT_TYPES.has(e.event_type);
      const isReflection = e.event_type === EventType.ReflectionCompleted;
      const receipt = isTaskEvent ? (e.payload.receipt as ReceiptSummary | undefined) : undefined;

      return h(
        "div",
        {
          key: e.event_id,
          className: `event-entry${isTaskEvent ? " task-event" : ""}${isReflection ? " reflection-event" : ""}`,
        },
        h(
          "div",
          { className: "event-entry-main" },
          h("span", { className: "timestamp" }, new Date(e.timestamp).toISOString()),
          h(
            "span",
            { className: "event-type", style: isReflection ? { color: "#a78bfa" } : undefined },
            e.event_type,
          ),
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
        isReflection
          ? h(ReflectionDetail, { payload: e.payload as unknown as ReflectionPayload })
          : null,
      );
    }),
  );
}
