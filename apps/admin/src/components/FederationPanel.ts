import React, { useState, useEffect, useCallback } from "react";
import { config } from "../api";

// === Types ===

interface RelayIdentityData {
  spec: string;
  relay_motebit_id: string;
  public_key: string;
  did: string;
}

interface PeerEntry {
  peer_relay_id: string;
  public_key: string;
  endpoint_url: string;
  display_name: string | null;
  state: string;
  peered_at: number | null;
  last_heartbeat_at: number | null;
  missed_heartbeats: number;
  agent_count: number;
  trust_score: number;
}

interface SettlementEntry {
  settlement_id: string;
  task_id: string;
  upstream_relay_id: string;
  downstream_relay_id: string | null;
  agent_id: string | null;
  gross_amount: number;
  fee_amount: number;
  net_amount: number;
  fee_rate: number;
  settled_at: number;
  receipt_hash: string;
}

// === Helpers ===

function truncateId(id: string, len = 12): string {
  if (id.length <= len) return id;
  return id.slice(0, len) + "...";
}

function relativeTime(ts: number | null): string {
  if (ts == null) return "never";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STATE_COLORS: Record<string, string> = {
  active: "#4caf50",
  suspended: "#ff9800",
  removed: "#f44336",
  pending: "#9e9e9e",
};

// === Fetch ===

async function fetchFederationIdentity(signal?: AbortSignal): Promise<RelayIdentityData | null> {
  const url = `${config.apiUrl}/federation/v1/identity`;
  const headers: HeadersInit = {};
  if (config.apiToken) headers["Authorization"] = `Bearer ${config.apiToken}`;
  const res = await fetch(url, { signal, headers });
  if (!res.ok) return null;
  return res.json() as Promise<RelayIdentityData>;
}

async function fetchFederationPeers(signal?: AbortSignal): Promise<PeerEntry[]> {
  const url = `${config.apiUrl}/federation/v1/peers`;
  const headers: HeadersInit = {};
  if (config.apiToken) headers["Authorization"] = `Bearer ${config.apiToken}`;
  const res = await fetch(url, { signal, headers });
  if (!res.ok) return [];
  const data = (await res.json()) as { peers: PeerEntry[] };
  return data.peers;
}

async function fetchFederationSettlements(signal?: AbortSignal): Promise<SettlementEntry[]> {
  const url = `${config.apiUrl}/federation/v1/settlements?limit=20`;
  const headers: HeadersInit = {};
  if (config.apiToken) headers["Authorization"] = `Bearer ${config.apiToken}`;
  const res = await fetch(url, { signal, headers });
  if (!res.ok) return [];
  const data = (await res.json()) as { settlements: SettlementEntry[] };
  return data.settlements;
}

// === Component ===

export function FederationPanel(): React.ReactElement {
  const [identity, setIdentity] = useState<RelayIdentityData | null>(null);
  const [peers, setPeers] = useState<PeerEntry[]>([]);
  const [settlements, setSettlements] = useState<SettlementEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const [id, p, s] = await Promise.all([
        fetchFederationIdentity(signal).catch(() => null),
        fetchFederationPeers(signal).catch(() => [] as PeerEntry[]),
        fetchFederationSettlements(signal).catch(() => [] as SettlementEntry[]),
      ]);
      setIdentity(id);
      setPeers(p);
      setSettlements(s);
      setError(id == null);
      setLoaded(true);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(true);
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
      React.createElement("h2", null, "Federation"),
      React.createElement("div", { className: "count" }, "Loading..."),
    );
  }

  if (error && identity == null) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Federation"),
      React.createElement(
        "div",
        { className: "count" },
        "Federation not enabled on this relay, or the endpoint is unreachable.",
      ),
    );
  }

  return React.createElement(
    "div",
    { className: "panel" },

    // ── Relay Identity ──
    React.createElement("h2", null, "Relay Identity"),
    identity != null
      ? React.createElement(
          "div",
          {
            className: "event-entry device-entry",
            style: { marginBottom: "16px" },
          },
          React.createElement(
            "div",
            { className: "device-meta" },
            React.createElement("span", null, `relay_id: ${identity.relay_motebit_id}`),
            React.createElement("span", null, `did: ${identity.did}`),
            React.createElement("span", null, `public_key: ${truncateId(identity.public_key, 24)}`),
            React.createElement(
              "span",
              { style: { fontSize: "10px", opacity: 0.5 } },
              identity.spec,
            ),
          ),
        )
      : React.createElement(
          "div",
          { className: "count" },
          "No relay identity (federation not enabled or endpoint unreachable)",
        ),

    // ── Active Peers ──
    React.createElement("h2", { style: { marginTop: "24px" } }, "Active Peers"),
    React.createElement(
      "div",
      { className: "count" },
      `${peers.length} peer${peers.length !== 1 ? "s" : ""}`,
    ),
    peers.length > 0
      ? React.createElement(
          "table",
          {
            style: {
              width: "100%",
              borderCollapse: "collapse" as const,
              fontSize: "12px",
              marginBottom: "16px",
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
              React.createElement("th", { style: { padding: "6px 8px" } }, "Peer Relay"),
              React.createElement("th", { style: { padding: "6px 8px" } }, "Name"),
              React.createElement("th", { style: { padding: "6px 8px" } }, "State"),
              React.createElement("th", { style: { padding: "6px 8px" } }, "Trust"),
              React.createElement("th", { style: { padding: "6px 8px" } }, "Agents"),
              React.createElement("th", { style: { padding: "6px 8px" } }, "Last Heartbeat"),
              React.createElement("th", { style: { padding: "6px 8px" } }, "Missed"),
            ),
          ),
          React.createElement(
            "tbody",
            null,
            ...peers.map((p) => {
              const stateColor = STATE_COLORS[p.state] ?? "#9e9e9e";
              return React.createElement(
                "tr",
                {
                  key: p.peer_relay_id,
                  style: { borderBottom: "1px solid rgba(255,255,255,0.05)" },
                },
                React.createElement(
                  "td",
                  { style: { padding: "6px 8px", fontFamily: "monospace" } },
                  truncateId(p.peer_relay_id),
                ),
                React.createElement("td", { style: { padding: "6px 8px" } }, p.display_name ?? "-"),
                React.createElement(
                  "td",
                  { style: { padding: "6px 8px" } },
                  React.createElement(
                    "span",
                    {
                      style: {
                        color: stateColor,
                        fontWeight: "bold",
                        fontSize: "11px",
                        padding: "2px 6px",
                        borderRadius: "3px",
                        border: `1px solid ${stateColor}`,
                      },
                    },
                    p.state,
                  ),
                ),
                React.createElement(
                  "td",
                  { style: { padding: "6px 8px" } },
                  p.trust_score.toFixed(2),
                ),
                React.createElement("td", { style: { padding: "6px 8px" } }, String(p.agent_count)),
                React.createElement(
                  "td",
                  { style: { padding: "6px 8px" } },
                  relativeTime(p.last_heartbeat_at),
                ),
                React.createElement(
                  "td",
                  { style: { padding: "6px 8px" } },
                  String(p.missed_heartbeats),
                ),
              );
            }),
          ),
        )
      : null,

    // ── Federation Settlements ──
    React.createElement("h2", { style: { marginTop: "24px" } }, "Federation Settlements"),
    React.createElement(
      "div",
      { className: "count" },
      `${settlements.length} settlement${settlements.length !== 1 ? "s" : ""}`,
    ),
    settlements.length > 0
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
              React.createElement("th", { style: { padding: "6px 8px" } }, "Settlement"),
              React.createElement("th", { style: { padding: "6px 8px" } }, "Task"),
              React.createElement("th", { style: { padding: "6px 8px" } }, "Upstream"),
              React.createElement("th", { style: { padding: "6px 8px" } }, "Gross"),
              React.createElement("th", { style: { padding: "6px 8px" } }, "Fee"),
              React.createElement("th", { style: { padding: "6px 8px" } }, "Net"),
              React.createElement("th", { style: { padding: "6px 8px" } }, "Settled"),
            ),
          ),
          React.createElement(
            "tbody",
            null,
            ...settlements.map((s) =>
              React.createElement(
                "tr",
                {
                  key: s.settlement_id,
                  style: { borderBottom: "1px solid rgba(255,255,255,0.05)" },
                },
                React.createElement(
                  "td",
                  { style: { padding: "6px 8px", fontFamily: "monospace" } },
                  truncateId(s.settlement_id),
                ),
                React.createElement(
                  "td",
                  { style: { padding: "6px 8px", fontFamily: "monospace" } },
                  truncateId(s.task_id),
                ),
                React.createElement(
                  "td",
                  { style: { padding: "6px 8px", fontFamily: "monospace" } },
                  truncateId(s.upstream_relay_id),
                ),
                React.createElement(
                  "td",
                  { style: { padding: "6px 8px" } },
                  s.gross_amount.toFixed(4),
                ),
                React.createElement(
                  "td",
                  { style: { padding: "6px 8px" } },
                  s.fee_amount.toFixed(4),
                ),
                React.createElement(
                  "td",
                  { style: { padding: "6px 8px" } },
                  s.net_amount.toFixed(4),
                ),
                React.createElement(
                  "td",
                  { style: { padding: "6px 8px" } },
                  relativeTime(s.settled_at),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}
