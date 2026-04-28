import React, { useState, useEffect, useCallback } from "react";
import {
  fetchTransparencyDeclared,
  fetchTransparencyProven,
  type TransparencyDeclared,
  type TransparencyProven,
  ApiError,
} from "../api";

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

export function TransparencyPanel(): React.ReactElement {
  const [declared, setDeclared] = useState<TransparencyDeclared | null>(null);
  const [proven, setProven] = useState<TransparencyProven | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const [d, p] = await Promise.all([
        fetchTransparencyDeclared(signal).catch(() => null),
        fetchTransparencyProven(signal).catch(() => null),
      ]);
      setDeclared(d);
      setProven(p);
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
      React.createElement("h2", null, "Transparency posture"),
      React.createElement("p", { className: "loading" }, "Loading…"),
    );
  }

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Transparency posture"),
    error != null
      ? React.createElement(
          "p",
          { className: "empty", style: { color: "var(--red)" } },
          `Error: ${error}`,
        )
      : null,
    React.createElement(
      "div",
      { className: "posture-grid" },
      React.createElement(
        "div",
        null,
        React.createElement("h3", null, "Declared (signed JSON)"),
        declared == null
          ? React.createElement("p", { className: "empty" }, "(no signed declaration found)")
          : React.createElement(
              "div",
              null,
              React.createElement(
                "p",
                { className: "count" },
                `Signed at ${formatTimestamp(declared.declared_at)} • spec ${declared.spec}`,
              ),
              React.createElement(
                "pre",
                { className: "json-block" },
                JSON.stringify(declared.content, null, 2),
              ),
              React.createElement(
                "p",
                { className: "count", style: { wordBreak: "break-all", fontFamily: "monospace" } },
                `sig: ${declared.signature.slice(0, 32)}…`,
              ),
            ),
      ),
      React.createElement(
        "div",
        null,
        React.createElement("h3", null, "Proven (operator-internal)"),
        proven == null
          ? React.createElement(
              "p",
              { className: "empty" },
              "(endpoint unavailable — likely unauth'd or not gated yet)",
            )
          : React.createElement(
              "div",
              null,
              React.createElement(
                "p",
                { className: "count" },
                `On-chain anchor: ${proven.onchain_anchor.status}` +
                  (proven.onchain_anchor.rationale != null
                    ? ` (${proven.onchain_anchor.rationale})`
                    : ""),
              ),
              React.createElement(
                "pre",
                { className: "json-block" },
                JSON.stringify(proven.declaration, null, 2),
              ),
            ),
      ),
    ),
  );
}
