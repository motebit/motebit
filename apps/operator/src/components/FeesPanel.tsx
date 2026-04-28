import React, { useState, useEffect, useCallback } from "react";
import { fetchFees, type FeesResponse, ApiError } from "../api";

function formatMicro(n: number): string {
  return (n / 1_000_000).toFixed(6);
}

function formatRange(startMs: number, endMs: number): string {
  const s = new Date(startMs).toISOString().slice(0, 10);
  const e = new Date(endMs).toISOString().slice(0, 10);
  return s === e ? s : `${s} → ${e}`;
}

export function FeesPanel(): React.ReactElement {
  const [data, setData] = useState<FeesResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetchFees(signal);
      setData(res);
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
      React.createElement("h2", null, "Fees"),
      React.createElement("p", { className: "loading" }, "Loading…"),
    );
  }

  if (data == null) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Fees"),
      error != null
        ? React.createElement(
            "p",
            { className: "empty", style: { color: "var(--red)" } },
            `Error: ${error}`,
          )
        : React.createElement(
            "p",
            { className: "empty" },
            "Endpoint not yet available (/api/v1/admin/fees ships in a follow-up commit). Aggregation panel will render once it's live.",
          ),
    );
  }

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Fees"),
    React.createElement(
      "div",
      { className: "stat-grid" },
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Total collected"),
        React.createElement(
          "div",
          { className: "value" },
          `${formatMicro(data.total_collected_micro)} ${data.total_collected_currency}`,
        ),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Fee rate"),
        React.createElement("div", { className: "value" }, `${(data.fee_rate * 100).toFixed(2)}%`),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Sample window"),
        React.createElement("div", { className: "value" }, `${data.sample_window_days}d`),
      ),
    ),
    React.createElement("h3", null, "By rail"),
    data.by_rail.length === 0
      ? React.createElement("p", { className: "empty" }, "(no fee history)")
      : React.createElement(
          "table",
          { className: "fleet-table" },
          React.createElement(
            "thead",
            null,
            React.createElement(
              "tr",
              null,
              React.createElement("th", null, "Rail"),
              React.createElement("th", null, "Collected (micro)"),
            ),
          ),
          React.createElement(
            "tbody",
            null,
            data.by_rail.map((r) =>
              React.createElement(
                "tr",
                { key: r.rail },
                React.createElement("td", null, r.rail),
                React.createElement("td", null, formatMicro(r.collected_micro)),
              ),
            ),
          ),
        ),
    React.createElement("h3", null, "By period"),
    data.by_period.length === 0
      ? React.createElement("p", { className: "empty" }, "(no period history)")
      : React.createElement(
          "table",
          { className: "fleet-table" },
          React.createElement(
            "thead",
            null,
            React.createElement(
              "tr",
              null,
              React.createElement("th", null, "Period"),
              React.createElement("th", null, "Collected (micro)"),
            ),
          ),
          React.createElement(
            "tbody",
            null,
            data.by_period.map((p) =>
              React.createElement(
                "tr",
                { key: `${p.period_start}-${p.period_end}` },
                React.createElement("td", null, formatRange(p.period_start, p.period_end)),
                React.createElement("td", null, formatMicro(p.collected_micro)),
              ),
            ),
          ),
        ),
  );
}
