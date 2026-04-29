import React, { useState, useEffect, useCallback } from "react";
import { fetchReconciliation, type ReconciliationResult, ApiError } from "../api";

export function ReconciliationPanel(): React.ReactElement {
  const [result, setResult] = useState<ReconciliationResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetchReconciliation(signal);
      setResult(res);
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
      React.createElement("h2", null, "Reconciliation"),
      React.createElement("p", { className: "loading" }, "Loading…"),
    );
  }

  if (result == null) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Reconciliation"),
      React.createElement(
        "p",
        { className: "empty", style: { color: "var(--red)" } },
        error != null ? `Error: ${error}` : "(no data)",
      ),
    );
  }

  const consistentColor = result.consistent ? "var(--green)" : "var(--red)";
  const consistentLabel = result.consistent ? "✓ consistent" : "✗ inconsistent";

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Reconciliation"),
    React.createElement(
      "div",
      { className: "stat-grid" },
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Ledger state"),
        React.createElement(
          "div",
          { className: "value", style: { color: consistentColor } },
          consistentLabel,
        ),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Errors"),
        React.createElement(
          "div",
          {
            className: "value",
            style: { color: result.errors.length === 0 ? "var(--green)" : "var(--red)" },
          },
          String(result.errors.length),
        ),
      ),
    ),
    React.createElement(
      "p",
      { className: "count" },
      "Checks: balance equation, no negative balances, settled-allocation ↔ settlement match, no double-settled allocations, no orphaned settlements.",
    ),
    result.errors.length === 0
      ? React.createElement(
          "p",
          { className: "empty", style: { color: "var(--green)" } },
          "All invariants hold.",
        )
      : React.createElement(
          "div",
          null,
          React.createElement("h3", null, "Violations"),
          React.createElement(
            "ul",
            { style: { paddingLeft: 20, fontFamily: "monospace", fontSize: 11 } },
            result.errors.map((e, i) =>
              React.createElement(
                "li",
                { key: i, style: { color: "var(--red)", marginBottom: 4 } },
                e,
              ),
            ),
          ),
        ),
  );
}
