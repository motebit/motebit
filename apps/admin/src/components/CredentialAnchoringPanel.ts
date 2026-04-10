import React, { useState, useEffect, useCallback } from "react";
import { config } from "../api";

// === Types ===

interface AnchorBatchEntry {
  batch_id: string;
  relay_id: string;
  merkle_root: string;
  leaf_count: number;
  first_issued_at: number;
  last_issued_at: number;
  signature: string;
  anchor: {
    chain: string;
    network: string;
    tx_hash: string;
    anchored_at: number;
  } | null;
}

interface AnchoringStats {
  total_batches: number;
  confirmed_batches: number;
  total_credentials_anchored: number;
  pending_credentials: number;
}

interface AnchoringResponse {
  stats: AnchoringStats;
  batches: AnchorBatchEntry[];
  anchor_address: string | null;
  chain_enabled: boolean;
}

// === Helpers ===

function truncate(s: string, len = 16): string {
  if (s.length <= len) return s;
  return s.slice(0, len) + "\u2026";
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

// === Fetch ===

async function fetchAnchoring(signal?: AbortSignal): Promise<AnchoringResponse | null> {
  const url = `${config.apiUrl}/api/v1/admin/credential-anchoring`;
  const headers: HeadersInit = {};
  if (config.apiToken) headers["Authorization"] = `Bearer ${config.apiToken}`;
  const res = await fetch(url, { signal, headers });
  if (!res.ok) return null;
  return res.json() as Promise<AnchoringResponse>;
}

// === Component ===

const th = { padding: "6px 8px" } as const;
const td = { padding: "6px 8px", fontFamily: "monospace", fontSize: "11px" } as const;

export function CredentialAnchoringPanel(): React.ReactElement {
  const [data, setData] = useState<AnchoringResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetchAnchoring(signal);
      setData(res);
      setLoaded(true);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = setInterval(() => {
      void refresh(controller.signal);
    }, 2000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [refresh]);

  if (!loaded) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Credential Anchoring"),
      React.createElement("div", { className: "count" }, "Loading\u2026"),
    );
  }

  if (!data) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Credential Anchoring"),
      React.createElement("div", { className: "count" }, "Endpoint unreachable"),
    );
  }

  const { stats, batches, anchor_address, chain_enabled } = data;

  return React.createElement(
    "div",
    { className: "panel" },

    // ── Status ──
    React.createElement("h2", null, "Credential Anchoring"),
    React.createElement(
      "div",
      {
        className: "event-entry device-entry",
        style: { marginBottom: "16px" },
      },
      React.createElement(
        "div",
        { className: "device-meta" },
        React.createElement(
          "span",
          null,
          `chain: ${chain_enabled ? "enabled" : "disabled (set SOLANA_RPC_URL)"}`,
        ),
        anchor_address
          ? React.createElement(
              "span",
              { style: { fontFamily: "monospace" } },
              `anchor address: ${anchor_address}`,
            )
          : null,
        React.createElement("span", null, `batches: ${stats.total_batches}`),
        React.createElement("span", null, `confirmed onchain: ${stats.confirmed_batches}`),
        React.createElement(
          "span",
          null,
          `credentials anchored: ${stats.total_credentials_anchored}`,
        ),
        React.createElement("span", null, `pending: ${stats.pending_credentials}`),
      ),
    ),

    // ── Batches Table ──
    React.createElement("h2", { style: { marginTop: "24px" } }, "Anchor Batches"),
    React.createElement(
      "div",
      { className: "count" },
      `${batches.length} batch${batches.length !== 1 ? "es" : ""}`,
    ),
    batches.length > 0
      ? React.createElement(
          "table",
          {
            style: {
              width: "100%",
              borderCollapse: "collapse" as const,
              fontSize: "12px",
            },
          },
          React.createElement(
            "thead",
            null,
            React.createElement(
              "tr",
              {
                style: {
                  borderBottom: "1px solid rgba(255,255,255,0.1)",
                  textAlign: "left" as const,
                },
              },
              React.createElement("th", { style: th }, "Batch"),
              React.createElement("th", { style: th }, "Credentials"),
              React.createElement("th", { style: th }, "Root"),
              React.createElement("th", { style: th }, "Status"),
              React.createElement("th", { style: th }, "Tx"),
              React.createElement("th", { style: th }, "Age"),
            ),
          ),
          React.createElement(
            "tbody",
            null,
            ...batches.map((b) => {
              const confirmed = b.anchor != null;
              const statusColor = confirmed ? "#4caf50" : "#ff9800";
              return React.createElement(
                "tr",
                {
                  key: b.batch_id,
                  style: { borderBottom: "1px solid rgba(255,255,255,0.05)" },
                },
                React.createElement("td", { style: td }, truncate(b.batch_id, 12)),
                React.createElement(
                  "td",
                  { style: { ...td, textAlign: "center" as const } },
                  String(b.leaf_count),
                ),
                React.createElement("td", { style: td }, truncate(b.merkle_root, 16)),
                React.createElement(
                  "td",
                  { style: td },
                  React.createElement(
                    "span",
                    {
                      style: {
                        color: statusColor,
                        fontWeight: "bold",
                        fontSize: "11px",
                        padding: "2px 6px",
                        borderRadius: "3px",
                        border: `1px solid ${statusColor}`,
                      },
                    },
                    confirmed ? "confirmed" : "signed",
                  ),
                ),
                React.createElement(
                  "td",
                  { style: td },
                  b.anchor ? truncate(b.anchor.tx_hash, 16) : "\u2014",
                ),
                React.createElement(
                  "td",
                  { style: { ...td, opacity: 0.6 } },
                  relativeTime(b.last_issued_at),
                ),
              );
            }),
          ),
        )
      : React.createElement(
          "div",
          { style: { opacity: 0.5, padding: "12px 0" } },
          "No batches yet. Credentials will be batched when the count or time threshold is met.",
        ),
  );
}
