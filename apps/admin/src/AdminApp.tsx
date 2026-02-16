import React, { useState } from "react";
import type { MoteState, MemoryNode, AuditRecord } from "@mote/sdk";
import { TrustMode, BatteryMode } from "@mote/sdk";

// === Panel Components ===

function StateVectorPanel({ state }: { state: MoteState }): React.ReactElement {
  const fields = [
    { name: "attention", value: state.attention },
    { name: "processing", value: state.processing },
    { name: "confidence", value: state.confidence },
    { name: "affect_valence", value: state.affect_valence },
    { name: "affect_arousal", value: state.affect_arousal },
    { name: "social_distance", value: state.social_distance },
    { name: "curiosity", value: state.curiosity },
  ];

  return React.createElement("div", { className: "panel" },
    React.createElement("h2", null, "State Vector"),
    ...fields.map((f) =>
      React.createElement("div", { key: f.name, className: "field" },
        React.createElement("span", { className: "label" }, f.name),
        React.createElement("span", { className: "value" }, f.value.toFixed(4)),
        React.createElement("div", { className: "bar", style: { width: `${Math.abs(f.value) * 100}%` } }),
      ),
    ),
    React.createElement("div", { className: "field" },
      React.createElement("span", { className: "label" }, "trust_mode"),
      React.createElement("span", { className: "value" }, state.trust_mode),
    ),
    React.createElement("div", { className: "field" },
      React.createElement("span", { className: "label" }, "battery_mode"),
      React.createElement("span", { className: "value" }, state.battery_mode),
    ),
  );
}

function MemoryGraphPanel({ memories }: { memories: MemoryNode[] }): React.ReactElement {
  return React.createElement("div", { className: "panel" },
    React.createElement("h2", null, "Memory Graph"),
    React.createElement("div", { className: "count" }, `${memories.length} nodes`),
    ...memories.slice(0, 20).map((m) =>
      React.createElement("div", { key: m.node_id, className: "memory-node" },
        React.createElement("span", { className: "content" }, m.content.slice(0, 60)),
        React.createElement("span", { className: "confidence" }, `conf: ${m.confidence.toFixed(2)}`),
        React.createElement("span", { className: "sensitivity" }, m.sensitivity),
      ),
    ),
  );
}

function AuditLogPanel({ records }: { records: AuditRecord[] }): React.ReactElement {
  return React.createElement("div", { className: "panel" },
    React.createElement("h2", null, "Audit Log"),
    ...records.slice(-20).reverse().map((r) =>
      React.createElement("div", { key: r.audit_id, className: "audit-entry" },
        React.createElement("span", { className: "timestamp" }, new Date(r.timestamp).toISOString()),
        React.createElement("span", { className: "action" }, r.action),
        React.createElement("span", { className: "target" }, `${r.target_type}:${r.target_id}`),
      ),
    ),
  );
}

// === Main Admin App ===

const DEFAULT_STATE: MoteState = {
  attention: 0,
  processing: 0,
  confidence: 0.5,
  affect_valence: 0,
  affect_arousal: 0,
  social_distance: 0.5,
  curiosity: 0,
  trust_mode: TrustMode.Guarded,
  battery_mode: BatteryMode.Normal,
};

export function AdminApp(): React.ReactElement {
  const [state] = useState<MoteState>(DEFAULT_STATE);
  const [memories] = useState<MemoryNode[]>([]);
  const [auditLog] = useState<AuditRecord[]>([]);
  const [activePanel, setActivePanel] = useState<string>("state");

  const nav = React.createElement("nav", { className: "admin-nav" },
    ["state", "memory", "behavior", "audit"].map((panel) =>
      React.createElement("button", {
        key: panel,
        className: panel === activePanel ? "active" : "",
        onClick: () => setActivePanel(panel),
      }, panel),
    ),
  );

  let content: React.ReactElement;
  switch (activePanel) {
    case "state":
      content = React.createElement(StateVectorPanel, { state });
      break;
    case "memory":
      content = React.createElement(MemoryGraphPanel, { memories });
      break;
    case "audit":
      content = React.createElement(AuditLogPanel, { records: auditLog });
      break;
    default:
      content = React.createElement("div", { className: "panel" },
        React.createElement("h2", null, "Behavior Debug"),
        React.createElement("p", null, "Behavior overlay coming soon"),
      );
  }

  return React.createElement("div", { className: "admin-app" }, nav, content);
}
