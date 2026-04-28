import React, { useState, useEffect, useCallback } from "react";
import { fetchAnchoring, type AnchoringResponse, ApiError } from "../api";

function truncate(s: string, len = 16): string {
  if (s.length <= len) return s;
  return s.slice(0, len) + "…";
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function CredentialAnchoringPanel(): React.ReactElement {
  const [data, setData] = useState<AnchoringResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetchAnchoring(signal);
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
      React.createElement("h2", null, "Credential Anchoring"),
      React.createElement("p", { className: "loading" }, "Loading…"),
    );
  }

  if (data == null) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Credential Anchoring"),
      React.createElement(
        "p",
        { className: "empty", style: { color: "var(--red)" } },
        error != null ? `Error: ${error}` : "(no data)",
      ),
    );
  }

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Credential Anchoring"),
    React.createElement(
      "div",
      { className: "stat-grid" },
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Total batches"),
        React.createElement("div", { className: "value" }, String(data.stats.total_batches)),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Confirmed"),
        React.createElement("div", { className: "value" }, String(data.stats.confirmed_batches)),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Anchored credentials"),
        React.createElement(
          "div",
          { className: "value" },
          String(data.stats.total_credentials_anchored),
        ),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Pending"),
        React.createElement("div", { className: "value" }, String(data.stats.pending_credentials)),
      ),
    ),
    React.createElement(
      "p",
      { className: "count" },
      `Anchor address: ${data.anchor_address ?? "(none)"} • on-chain ${data.chain_enabled ? "enabled" : "disabled"}`,
    ),
    data.batches.length === 0
      ? React.createElement("p", { className: "empty" }, "(no batches)")
      : React.createElement(
          "table",
          { className: "fleet-table" },
          React.createElement(
            "thead",
            null,
            React.createElement(
              "tr",
              null,
              React.createElement("th", null, "Batch"),
              React.createElement("th", null, "Merkle root"),
              React.createElement("th", null, "Leaves"),
              React.createElement("th", null, "Issued"),
              React.createElement("th", null, "Anchor"),
            ),
          ),
          React.createElement(
            "tbody",
            null,
            data.batches.map((b) =>
              React.createElement(
                "tr",
                { key: b.batch_id },
                React.createElement("td", null, truncate(b.batch_id)),
                React.createElement("td", null, truncate(b.merkle_root, 24)),
                React.createElement("td", null, String(b.leaf_count)),
                React.createElement("td", null, relativeTime(b.last_issued_at)),
                React.createElement(
                  "td",
                  null,
                  b.anchor != null
                    ? `${b.anchor.chain}/${b.anchor.network} ${truncate(b.anchor.tx_hash, 12)}`
                    : "(pending)",
                ),
              ),
            ),
          ),
        ),
  );
}
