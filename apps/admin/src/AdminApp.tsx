import React, { useState, useEffect, useCallback, useRef } from "react";
import type { MotebitState, MemoryNode, MemoryEdge, EventLogEntry } from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";
import { computeRawCues } from "@motebit/behavior-engine";
import { fetchState, fetchMemory, fetchEvents, deleteMemoryNode } from "./api";
import { useStateHistory } from "./hooks/useStateHistory";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { StateVectorPanel } from "./components/StateVectorPanel";
import { MemoryGraphPanel } from "./components/MemoryGraphPanel";
import { BehaviorPanel } from "./components/BehaviorPanel";
import { EventsPanel } from "./components/EventsPanel";

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
  const { historyRef, push: pushHistory } = useStateHistory();

  const cues = computeRawCues(state);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const [stateRes, memoryRes, eventsRes] = await Promise.all([
        fetchState(signal),
        fetchMemory(signal),
        fetchEvents(maxClockRef.current, signal),
      ]);

      setState(stateRes.state);
      pushHistory(stateRes.state);
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
  }, [pushHistory]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = setInterval(() => { void refresh(controller.signal); }, 2000);
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
      content = React.createElement(StateVectorPanel, { state, history: historyRef.current });
      break;
    case "memory":
      content = React.createElement(MemoryGraphPanel, { memories, edges, onDelete: (nodeId: string) => { void handleDeleteMemory(nodeId); } });
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
