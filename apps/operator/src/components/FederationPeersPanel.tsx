import React, { useState, useEffect, useCallback } from "react";
import {
  fetchFederationPeers,
  fetchRelayIdentity,
  type PeerEntry,
  type RelayIdentity,
  ApiError,
} from "../api";

function formatTimestamp(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

export function FederationPeersPanel(): React.ReactElement {
  const [identity, setIdentity] = useState<RelayIdentity | null>(null);
  const [peers, setPeers] = useState<PeerEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const [idRes, peersRes] = await Promise.all([
        fetchRelayIdentity(signal),
        fetchFederationPeers(signal),
      ]);
      setIdentity(idRes);
      setPeers(peersRes.peers);
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
      React.createElement("h2", null, "Federation Peers"),
      React.createElement("p", { className: "loading" }, "Loading…"),
    );
  }

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Federation Peers"),
    identity != null
      ? React.createElement(
          "div",
          { className: "stat-grid" },
          React.createElement(
            "div",
            { className: "stat-card" },
            React.createElement("div", { className: "label" }, "Relay ID"),
            React.createElement(
              "div",
              { className: "value", style: { fontFamily: "monospace", fontSize: 12 } },
              identity.relay_motebit_id,
            ),
          ),
          React.createElement(
            "div",
            { className: "stat-card" },
            React.createElement("div", { className: "label" }, "DID"),
            React.createElement(
              "div",
              { className: "value", style: { fontFamily: "monospace", fontSize: 12 } },
              identity.did,
            ),
          ),
          React.createElement(
            "div",
            { className: "stat-card" },
            React.createElement("div", { className: "label" }, "Peers"),
            React.createElement("div", { className: "value" }, String(peers.length)),
          ),
        )
      : null,
    error != null
      ? React.createElement(
          "p",
          { className: "empty", style: { color: "var(--red)" } },
          `Error: ${error}`,
        )
      : null,
    peers.length === 0
      ? React.createElement("p", { className: "empty" }, "(no peers)")
      : React.createElement(
          "table",
          { className: "fleet-table" },
          React.createElement(
            "thead",
            null,
            React.createElement(
              "tr",
              null,
              React.createElement("th", null, "Peer"),
              React.createElement("th", null, "Endpoint"),
              React.createElement("th", null, "State"),
              React.createElement("th", null, "Last heartbeat"),
              React.createElement("th", null, "Missed"),
              React.createElement("th", null, "Agents"),
              React.createElement("th", null, "Trust"),
            ),
          ),
          React.createElement(
            "tbody",
            null,
            peers.map((p) =>
              React.createElement(
                "tr",
                { key: p.peer_relay_id },
                React.createElement(
                  "td",
                  null,
                  p.display_name ?? p.peer_relay_id.slice(0, 12) + "…",
                ),
                React.createElement("td", null, p.endpoint_url),
                React.createElement("td", { className: `peer-state ${p.state}` }, p.state),
                React.createElement("td", null, formatTimestamp(p.last_heartbeat_at)),
                React.createElement("td", null, String(p.missed_heartbeats)),
                React.createElement("td", null, String(p.agent_count)),
                React.createElement("td", null, p.trust_score.toFixed(2)),
              ),
            ),
          ),
        ),
  );
}
