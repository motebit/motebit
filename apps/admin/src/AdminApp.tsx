import React, { useState, useEffect, useCallback, useRef } from "react";
import type {
  MotebitState,
  MemoryNode,
  MemoryEdge,
  EventLogEntry,
  ToolAuditEntry,
} from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";
import { computeRawCues } from "@motebit/behavior-engine";
import {
  fetchState,
  fetchMemory,
  fetchEvents,
  fetchAudit,
  deleteMemoryNode,
  fetchGoals,
  fetchConversations,
  fetchDevices,
  fetchPlans,
  fetchGradient,
  fetchAgentTrust,
  fetchAgentGraph,
  fetchCredentials,
  fetchBudget,
  fetchSuccession,
  generatePresentation,
  config,
} from "./api";
import type {
  GoalEntry,
  ConversationEntry,
  DeviceEntry,
  PlanEntry,
  GradientSnapshotEntry,
  AgentTrustEntry,
  AgentGraphEdge,
  CredentialEntry,
  BudgetAllocationEntry,
  SuccessionResponse,
} from "./api";
import { useStateHistory } from "./hooks/useStateHistory";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { StateVectorPanel } from "./components/StateVectorPanel";
import { MemoryGraphPanel } from "./components/MemoryGraphPanel";
import { BehaviorPanel } from "./components/BehaviorPanel";
import { EventsPanel } from "./components/EventsPanel";
import { AuditPanel } from "./components/AuditPanel";
import { GoalsPanel } from "./components/GoalsPanel";
import { ConversationsPanel } from "./components/ConversationsPanel";
import { DevicesPanel } from "./components/DevicesPanel";
import { PlansPanel } from "./components/PlansPanel";
import { GradientPanel } from "./components/GradientPanel";
import { TrustPanel } from "./components/TrustPanel";
import { AgentGraphPanel } from "./components/AgentGraphPanel";
import { CredentialsPanel } from "./components/CredentialsPanel";
import { FederationPanel } from "./components/FederationPanel";

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
  const [audit, setAudit] = useState<ToolAuditEntry[]>([]);
  const [goals, setGoals] = useState<GoalEntry[]>([]);
  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [plans, setPlans] = useState<PlanEntry[]>([]);
  const [gradientCurrent, setGradientCurrent] = useState<GradientSnapshotEntry | null>(null);
  const [gradientHistory, setGradientHistory] = useState<GradientSnapshotEntry[]>([]);
  const [trustRecords, setTrustRecords] = useState<AgentTrustEntry[]>([]);
  const [agentGraphNodes, setAgentGraphNodes] = useState<string[]>([]);
  const [agentGraphEdges, setAgentGraphEdges] = useState<AgentGraphEdge[]>([]);
  const [agentGraphNodeCount, setAgentGraphNodeCount] = useState(0);
  const [agentGraphEdgeCount, setAgentGraphEdgeCount] = useState(0);
  const [credentials, setCredentials] = useState<CredentialEntry[]>([]);
  const [budgetSummary, setBudgetSummary] = useState<{
    total_locked: number;
    total_settled: number;
  } | null>(null);
  const [budgetAllocations, setBudgetAllocations] = useState<BudgetAllocationEntry[]>([]);
  const [succession, setSuccession] = useState<SuccessionResponse | null>(null);
  const [presentation, setPresentation] = useState<Record<string, unknown> | null>(null);
  const [presentationLoading, setPresentationLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [activePanel, setActivePanel] = useState<string>("state");
  const maxClockRef = useRef(0);
  const { historyRef, push: pushHistory } = useStateHistory();

  const cues = computeRawCues(state);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const [
          stateRes,
          memoryRes,
          eventsRes,
          auditRes,
          goalsRes,
          convRes,
          devicesRes,
          plansRes,
          gradientRes,
          trustRes,
          agentGraphRes,
          credRes,
          budgetRes,
          successionRes,
        ] = await Promise.all([
          fetchState(signal),
          fetchMemory(signal),
          fetchEvents(maxClockRef.current, signal),
          fetchAudit(signal),
          fetchGoals(signal),
          fetchConversations(signal),
          fetchDevices(signal),
          fetchPlans(signal),
          fetchGradient(signal),
          fetchAgentTrust(signal),
          fetchAgentGraph(signal).catch(() => ({
            motebit_id: config.motebitId,
            nodes: [] as string[],
            edges: [] as AgentGraphEdge[],
            node_count: 0,
            edge_count: 0,
          })),
          fetchCredentials(signal).catch(() => ({ credentials: [] as CredentialEntry[] })),
          fetchBudget(signal).catch(() => ({
            summary: null,
            allocations: [] as BudgetAllocationEntry[],
          })),
          fetchSuccession(signal).catch(() => null as SuccessionResponse | null),
        ]);

        setState(stateRes.state);
        pushHistory(stateRes.state);
        setMemories(memoryRes.memories);
        setEdges(memoryRes.edges);
        setAudit(auditRes.entries);
        setGoals(goalsRes.goals);
        setConversations(convRes.conversations);
        setDevices(devicesRes.devices);
        setPlans(plansRes.plans);
        setGradientCurrent(gradientRes.current);
        setGradientHistory(gradientRes.history);
        setTrustRecords(trustRes.records);
        setAgentGraphNodes(agentGraphRes.nodes);
        setAgentGraphEdges(agentGraphRes.edges);
        setAgentGraphNodeCount(agentGraphRes.node_count);
        setAgentGraphEdgeCount(agentGraphRes.edge_count);
        setCredentials(credRes.credentials);
        if ("summary" in budgetRes && budgetRes.summary != null) {
          setBudgetSummary(budgetRes.summary as { total_locked: number; total_settled: number });
        }
        if ("allocations" in budgetRes) {
          setBudgetAllocations(budgetRes.allocations);
        }
        if (successionRes != null) {
          setSuccession(successionRes);
        }

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
    },
    [pushHistory],
  );

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

  const handleDeleteMemory = useCallback(async (nodeId: string) => {
    try {
      await deleteMemoryNode(nodeId);
      setMemories((prev) => prev.filter((m) => m.node_id !== nodeId));
    } catch {
      // Deletion failed — state remains unchanged
    }
  }, []);

  const nav = React.createElement(
    "nav",
    { className: "admin-nav" },
    [
      "state",
      "memory",
      "behavior",
      "events",
      "audit",
      "goals",
      "plans",
      "conversations",
      "devices",
      "gradient",
      "trust",
      "credentials",
      "federation",
    ].map((panel) =>
      React.createElement(
        "button",
        {
          key: panel,
          className: panel === activePanel ? "active" : "",
          onClick: () => setActivePanel(panel),
        },
        panel,
      ),
    ),
  );

  let content: React.ReactElement;
  switch (activePanel) {
    case "state":
      content = React.createElement(StateVectorPanel, { state, history: historyRef.current });
      break;
    case "memory":
      content = React.createElement(MemoryGraphPanel, {
        memories,
        edges,
        onDelete: (nodeId: string) => {
          void handleDeleteMemory(nodeId);
        },
      });
      break;
    case "behavior":
      content = React.createElement(BehaviorPanel, { cues });
      break;
    case "events":
      content = React.createElement(EventsPanel, { events });
      break;
    case "audit":
      content = React.createElement(AuditPanel, { entries: audit });
      break;
    case "goals":
      content = React.createElement(GoalsPanel, { goals });
      break;
    case "plans":
      content = React.createElement(PlansPanel, { plans });
      break;
    case "conversations":
      content = React.createElement(ConversationsPanel, { conversations });
      break;
    case "devices":
      content = React.createElement(DevicesPanel, { devices });
      break;
    case "gradient":
      content = React.createElement(GradientPanel, {
        current: gradientCurrent,
        history: gradientHistory,
      });
      break;
    case "trust":
      content = React.createElement(
        "div",
        null,
        React.createElement(AgentGraphPanel, {
          nodes: agentGraphNodes,
          edges: agentGraphEdges,
          selfId: config.motebitId,
          nodeCount: agentGraphNodeCount,
          edgeCount: agentGraphEdgeCount,
        }),
        React.createElement(TrustPanel, { records: trustRecords }),
      );
      break;
    case "credentials":
      content = React.createElement(CredentialsPanel, {
        credentials,
        budgetSummary,
        budgetAllocations,
        succession,
        presentation,
        presentationLoading,
        onGeneratePresentation: () => {
          setPresentationLoading(true);
          setPresentation(null);
          void generatePresentation()
            .then((res) => {
              setPresentation(res.presentation);
            })
            .catch(() => {
              // Presentation generation failed — no action needed
            })
            .finally(() => {
              setPresentationLoading(false);
            });
        },
      });
      break;
    case "federation":
      content = React.createElement(FederationPanel, null);
      break;
    default:
      content = React.createElement(
        "div",
        { className: "panel" },
        React.createElement("p", null, "Unknown panel"),
      );
  }

  const header = React.createElement(
    "div",
    { className: "admin-header" },
    React.createElement("h1", null, "Motebit Admin"),
    React.createElement(ConnectionStatus, { connected }),
  );

  return React.createElement("div", { className: "admin-app" }, header, nav, content);
}
