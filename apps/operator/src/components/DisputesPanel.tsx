import React, { useState, useEffect, useCallback } from "react";
import { fetchDisputes, type DisputeEntry, type DisputeStats, ApiError } from "../api";

function formatTimestamp(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

export function DisputesPanel(): React.ReactElement {
  const [stats, setStats] = useState<DisputeStats | null>(null);
  const [disputes, setDisputes] = useState<DisputeEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetchDisputes(signal);
      setStats(res.stats);
      setDisputes(res.disputes);
      setError(null);
      setLoaded(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof ApiError ? err.message : String(err));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  if (!loaded) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Disputes"),
      React.createElement("p", { className: "loading" }, "Loading…"),
    );
  }

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Disputes"),
    error != null
      ? React.createElement(
          "p",
          { className: "empty", style: { color: "var(--red)" } },
          `Error: ${error}`,
        )
      : null,
    stats != null
      ? React.createElement(
          "div",
          { className: "stat-grid" },
          React.createElement(
            "div",
            { className: "stat-card" },
            React.createElement("div", { className: "label" }, "Total"),
            React.createElement("div", { className: "value" }, String(stats.total)),
          ),
          React.createElement(
            "div",
            { className: "stat-card" },
            React.createElement("div", { className: "label" }, "Open"),
            React.createElement("div", { className: "value" }, String(stats.opened)),
          ),
          React.createElement(
            "div",
            { className: "stat-card" },
            React.createElement("div", { className: "label" }, "Evidence"),
            React.createElement("div", { className: "value" }, String(stats.evidence)),
          ),
          React.createElement(
            "div",
            { className: "stat-card" },
            React.createElement("div", { className: "label" }, "Resolved"),
            React.createElement("div", { className: "value" }, String(stats.resolved)),
          ),
          React.createElement(
            "div",
            { className: "stat-card" },
            React.createElement("div", { className: "label" }, "Appealed"),
            React.createElement("div", { className: "value" }, String(stats.appealed)),
          ),
        )
      : null,
    disputes.length === 0
      ? React.createElement("p", { className: "empty" }, "(no disputes)")
      : React.createElement(
          "table",
          { className: "fleet-table" },
          React.createElement(
            "thead",
            null,
            React.createElement(
              "tr",
              null,
              React.createElement("th", null, "Dispute"),
              React.createElement("th", null, "Allocation"),
              React.createElement("th", null, "Filing"),
              React.createElement("th", null, "Respondent"),
              React.createElement("th", null, "Status"),
              React.createElement("th", null, "Opened"),
              React.createElement("th", null, "Resolved"),
              React.createElement("th", null, "Resolution"),
            ),
          ),
          React.createElement(
            "tbody",
            null,
            disputes.map((d) =>
              React.createElement(
                "tr",
                { key: d.dispute_id },
                React.createElement("td", null, d.dispute_id.slice(0, 12) + "…"),
                React.createElement("td", null, d.allocation_id.slice(0, 12) + "…"),
                React.createElement("td", null, d.filing_party.slice(0, 12) + "…"),
                React.createElement("td", null, d.respondent.slice(0, 12) + "…"),
                React.createElement("td", { className: `dispute-status ${d.status}` }, d.status),
                React.createElement("td", null, formatTimestamp(d.opened_at)),
                React.createElement("td", null, formatTimestamp(d.resolved_at)),
                React.createElement("td", null, d.resolution ?? "—"),
              ),
            ),
          ),
        ),
  );
}
