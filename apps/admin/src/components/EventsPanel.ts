import React from "react";
import type { EventLogEntry } from "@motebit/sdk";

export function EventsPanel({ events }: { events: EventLogEntry[] }): React.ReactElement {
  const recent = events.slice(-30).reverse();
  return React.createElement("div", { className: "panel" },
    React.createElement("h2", null, "Event Log"),
    React.createElement("div", { className: "count" }, `${events.length} events total`),
    ...recent.map((e) =>
      React.createElement("div", { key: e.event_id, className: "event-entry" },
        React.createElement("span", { className: "timestamp" },
          new Date(e.timestamp).toISOString(),
        ),
        React.createElement("span", { className: "event-type" }, e.event_type),
        React.createElement("span", { className: "clock" }, `v${e.version_clock}`),
      ),
    ),
  );
}
