import React, { useState, useEffect, useCallback, useRef } from "react";
import type { MotebitState, MemoryNode, MemoryEdge, EventLogEntry, BehaviorCues } from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";
import { computeRawCues } from "@motebit/behavior-engine";
import { fetchState, fetchMemory, fetchEvents, deleteMemoryNode } from "./api";

// === Panel Components ===

function ConnectionStatus({ connected }: { connected: boolean }): React.ReactElement {
  return React.createElement("div", { className: "connection-status" },
    React.createElement("div", {
      className: `status-dot ${connected ? "connected" : "disconnected"}`,
    }),
    React.createElement("span", null, connected ? "Connected" : "Disconnected"),
  );
}

function StateVectorPanel({ state }: { state: MotebitState }): React.ReactElement {
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

function MemoryGraphPanel({ memories, edges, onDelete }: {
  memories: MemoryNode[];
  edges: MemoryEdge[];
  onDelete: (nodeId: string) => void;
}): React.ReactElement {
  return React.createElement("div", { className: "panel" },
    React.createElement("h2", null, "Memory Graph"),
    React.createElement("div", { className: "count" },
      `${memories.length} nodes, ${edges.length} edges`,
    ),
    ...memories.slice(0, 20).map((m) =>
      React.createElement("div", { key: m.node_id, className: "memory-node" },
        React.createElement("span", { className: "content" }, m.content.slice(0, 60)),
        React.createElement("span", { className: "confidence" }, `conf: ${m.confidence.toFixed(2)}`),
        React.createElement("span", { className: "sensitivity" }, m.sensitivity),
        React.createElement("button", {
          className: "delete-btn",
          onClick: () => onDelete(m.node_id),
          "aria-label": `Delete memory ${m.node_id}`,
        }, "\u00d7"),
      ),
    ),
  );
}

function BehaviorPanel({ cues }: { cues: BehaviorCues }): React.ReactElement {
  const fields = [
    { name: "hover_distance", value: cues.hover_distance },
    { name: "drift_amplitude", value: cues.drift_amplitude },
    { name: "glow_intensity", value: cues.glow_intensity },
    { name: "eye_dilation", value: cues.eye_dilation },
    { name: "smile_curvature", value: cues.smile_curvature },
    { name: "skirt_deformation", value: cues.skirt_deformation },
  ];

  return React.createElement("div", { className: "panel" },
    React.createElement("h2", null, "Behavior Cues"),
    ...fields.map((f) =>
      React.createElement("div", { key: f.name, className: "field" },
        React.createElement("span", { className: "label" }, f.name),
        React.createElement("span", { className: "value" }, f.value.toFixed(4)),
        React.createElement("div", { className: "bar", style: { width: `${Math.abs(f.value) * 100}%` } }),
      ),
    ),
  );
}

function EventsPanel({ events }: { events: EventLogEntry[] }): React.ReactElement {
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

// === Main Admin App ===

const DEFAULT_STATE: MotebitState = {
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
  const [state, setState] = useState<MotebitState>(DEFAULT_STATE);
  const [memories, setMemories] = useState<MemoryNode[]>([]);
  const [edges, setEdges] = useState<MemoryEdge[]>([]);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [activePanel, setActivePanel] = useState<string>("state");
  const maxClockRef = useRef(0);

  const cues = computeRawCues(state);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const [stateRes, memoryRes, eventsRes] = await Promise.all([
        fetchState(signal),
        fetchMemory(signal),
        fetchEvents(maxClockRef.current, signal),
      ]);

      setState(stateRes.state);
      setMemories(memoryRes.memories);
      setEdges(memoryRes.edges);

      if (eventsRes.events.length > 0) {
        setEvents((prev) => {
          const existingIds = new Set(prev.map((e) => e.event_id));
          const newEvents = eventsRes.events.filter((e) => !existingIds.has(e.event_id));
          return [...prev, ...newEvents];
        });
        const maxClock = Math.max(...eventsRes.events.map((e) => e.version_clock));
        if (maxClock > maxClockRef.current) {
          maxClockRef.current = maxClock;
        }
      }

      setConnected(true);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setConnected(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    const interval = setInterval(() => refresh(controller.signal), 2000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [refresh]);

  const handleDeleteMemory = useCallback(async (nodeId: string) => {
    try {
      await deleteMemoryNode(nodeId);
      setMemories((prev) => prev.filter((m) => m.node_id !== nodeId));
    } catch {
      // Deletion failed — state remains unchanged
    }
  }, []);

  const nav = React.createElement("nav", { className: "admin-nav" },
    ["state", "memory", "behavior", "events"].map((panel) =>
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
      content = React.createElement(MemoryGraphPanel, { memories, edges, onDelete: handleDeleteMemory });
      break;
    case "behavior":
      content = React.createElement(BehaviorPanel, { cues });
      break;
    case "events":
      content = React.createElement(EventsPanel, { events });
      break;
    default:
      content = React.createElement("div", { className: "panel" },
        React.createElement("p", null, "Unknown panel"),
      );
  }

  const header = React.createElement("div", { className: "admin-header" },
    React.createElement("h1", null, "Motebit Admin"),
    React.createElement(ConnectionStatus, { connected }),
  );

  return React.createElement("div", { className: "admin-app" }, header, nav, content);
}
