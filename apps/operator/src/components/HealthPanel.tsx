import React, { useState, useEffect, useCallback } from "react";
import { fetchHealthSummary, type HealthSummary, ApiError } from "../api";

function formatMicro(n: number): string {
  return (n / 1_000_000).toFixed(6);
}

function relativeTime(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function HealthPanel(): React.ReactElement {
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetchHealthSummary(signal);
      setSummary(res);
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
      React.createElement("h2", null, "Health"),
      React.createElement("p", { className: "loading" }, "Loading…"),
    );
  }

  if (summary == null) {
    return React.createElement(
      "div",
      { className: "panel" },
      React.createElement("h2", null, "Health"),
      React.createElement(
        "p",
        { className: "empty", style: { color: "var(--red)" } },
        error != null ? `Error: ${error}` : "(no data)",
      ),
    );
  }

  const { motebits, federation, tasks, subscribers, generated_at } = summary;
  const now = Date.now();

  // Color the headline numbers honestly: zero is zero, not "low" or
  // "warning." The point of the panel is to show truth, not soften it.
  const motebitsColor =
    motebits.active_30d === 0
      ? "var(--red)"
      : motebits.active_30d < 3
        ? "var(--yellow)"
        : "var(--green)";
  const tasksColor =
    tasks.settlements_30d === 0
      ? "var(--red)"
      : tasks.settlements_30d < 5
        ? "var(--yellow)"
        : "var(--green)";
  const subscribersColor =
    subscribers.total_active === 0
      ? "var(--red)"
      : subscribers.total_active < 3
        ? "var(--yellow)"
        : "var(--green)";

  const statusBuckets = Object.entries(subscribers.status_counts).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return React.createElement(
    "div",
    { className: "panel" },
    React.createElement("h2", null, "Health"),
    React.createElement(
      "p",
      { className: "count" },
      `Snapshot ${relativeTime(generated_at, now)}. Single SQL aggregation pass over agent_registry / relay_peers / relay_settlements / relay_federation_settlements / relay_subscriptions. Honest zeros — empty means empty.`,
    ),
    React.createElement("h3", null, "Motebits"),
    React.createElement(
      "div",
      { className: "stat-grid" },
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Total registered"),
        React.createElement(
          "div",
          { className: "value", style: { color: motebitsColor } },
          String(motebits.total_registered),
        ),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Active 24h"),
        React.createElement("div", { className: "value" }, String(motebits.active_24h)),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Active 7d"),
        React.createElement("div", { className: "value" }, String(motebits.active_7d)),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Active 30d"),
        React.createElement("div", { className: "value" }, String(motebits.active_30d)),
      ),
    ),
    React.createElement("h3", null, "Subscribers"),
    React.createElement(
      "p",
      { className: "count" },
      "Stripe-synced from relay_subscriptions. Joined to motebits, settlements, and federation for relay-shaped correlation; not a Stripe Billing replacement.",
    ),
    React.createElement(
      "div",
      { className: "stat-grid" },
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Active (paying)"),
        React.createElement(
          "div",
          { className: "value", style: { color: subscribersColor } },
          String(subscribers.total_active),
        ),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Lifetime"),
        React.createElement("div", { className: "value" }, String(subscribers.total_lifetime)),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "New 7d / 30d"),
        React.createElement(
          "div",
          { className: "value" },
          `${subscribers.created_7d} / ${subscribers.created_30d}`,
        ),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "By status"),
        React.createElement(
          "div",
          { className: "value" },
          statusBuckets.length === 0 ? "—" : statusBuckets.map(([s, n]) => `${s} ${n}`).join(" · "),
        ),
      ),
    ),
    React.createElement("h3", null, "Federation"),
    React.createElement(
      "div",
      { className: "stat-grid" },
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Peers (active)"),
        React.createElement(
          "div",
          { className: "value" },
          `${federation.active_peers} / ${federation.peer_count}`,
        ),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Suspended peers"),
        React.createElement(
          "div",
          {
            className: "value",
            style: { color: federation.suspended_peers > 0 ? "var(--yellow)" : undefined },
          },
          String(federation.suspended_peers),
        ),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Federation settlements 7d"),
        React.createElement(
          "div",
          { className: "value" },
          String(federation.federation_settlements_7d),
        ),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Federation volume 7d"),
        React.createElement(
          "div",
          { className: "value" },
          formatMicro(federation.federation_volume_7d_micro),
        ),
      ),
    ),
    React.createElement("h3", null, "Tasks + money"),
    React.createElement(
      "div",
      { className: "stat-grid" },
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Settlements 7d / 30d"),
        React.createElement(
          "div",
          { className: "value", style: { color: tasksColor } },
          `${tasks.settlements_7d} / ${tasks.settlements_30d}`,
        ),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Volume 7d (micro)"),
        React.createElement("div", { className: "value" }, formatMicro(tasks.volume_7d_micro)),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Volume 30d (micro)"),
        React.createElement("div", { className: "value" }, formatMicro(tasks.volume_30d_micro)),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Fees 7d (5%)"),
        React.createElement("div", { className: "value" }, formatMicro(tasks.fees_7d_micro)),
      ),
      React.createElement(
        "div",
        { className: "stat-card" },
        React.createElement("div", { className: "label" }, "Fees 30d (5%)"),
        React.createElement("div", { className: "value" }, formatMicro(tasks.fees_30d_micro)),
      ),
    ),
    motebits.active_30d === 0 && federation.peer_count <= 2
      ? React.createElement(
          "p",
          {
            className: "count",
            style: {
              color: "var(--yellow)",
              borderTop: "1px solid var(--border)",
              paddingTop: 12,
              marginTop: 16,
            },
          },
          "Signal: zero motebit activity in 30d, ≤2 federation peers. The relay is operationally idle. The next architectural pick is partnership / outreach, not more code.",
        )
      : null,
  );
}
