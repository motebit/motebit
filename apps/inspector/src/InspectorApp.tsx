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

export function InspectorApp(): React.ReactElement {
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
  const [revokedCredIds, setRevokedCredIds] = useState<Set<string>>(new Set());
  const [budgetSummary, setBudgetSummary] = useState<{
    total_locked: number;
    total_settled: number;
  } | null>(null);
  const [budgetAllocations, setBudgetAllocations] = useState<BudgetAllocationEntry[]>([]);
  const [succession, setSuccession] = useState<SuccessionResponse | null>(null);
  const [presentation, setPresentation] = useState<Record<string, unknown> | null>(null);
  // Aggregate verification status across all state-export fetches.
  // Calm-software register: silent when verified=verified (motebit
  // anti-pattern: don't confirm what the user can already see); a
  // failure surface only renders when at least one panel's manifest
  // failed verification — that's the tampering / mis-signed signal
  // operators need to see.
  const [verificationStatus, setVerificationStatus] = useState<{
    readonly verifiedCount: number;
    readonly totalCount: number;
    readonly failures: ReadonlyArray<{ readonly endpoint: string; readonly reason: string }>;
  }>({ verifiedCount: 0, totalCount: 0, failures: [] });
  const [presentationLoading, setPresentationLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [activePanel, setActivePanel] = useState<string>("state");
  const maxClockRef = useRef(0);
  const consecutiveErrorsRef = useRef(0);
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

        // State-export endpoints return VerifiedStateExportResponse —
        // body is null when verification fails. Pull out body if valid;
        // collect verification result for aggregate UI status. Never
        // render unverified state (when body is null, leave the
        // previous render in place — better than a flicker to empty).
        const verifiedRefs = [
          { endpoint: "state", res: stateRes },
          { endpoint: "memory", res: memoryRes },
          { endpoint: "events", res: eventsRes },
          { endpoint: "audit", res: auditRes },
          { endpoint: "goals", res: goalsRes },
          { endpoint: "conversations", res: convRes },
          { endpoint: "devices", res: devicesRes },
          { endpoint: "plans", res: plansRes },
          { endpoint: "gradient", res: gradientRes },
        ];
        const failures = verifiedRefs
          .filter((ref) => !ref.res.verification.valid)
          .map((ref) => ({
            endpoint: ref.endpoint,
            reason: ref.res.verification.valid === false ? ref.res.verification.reason : "unknown",
          }));
        setVerificationStatus({
          verifiedCount: verifiedRefs.length - failures.length,
          totalCount: verifiedRefs.length,
          failures,
        });

        if (stateRes.body !== null) {
          setState(stateRes.body.state);
          pushHistory(stateRes.body.state);
        }
        if (memoryRes.body !== null) {
          setMemories(memoryRes.body.memories);
          setEdges(memoryRes.body.edges);
        }
        if (auditRes.body !== null) setAudit(auditRes.body.entries);
        if (goalsRes.body !== null) setGoals(goalsRes.body.goals);
        if (convRes.body !== null) setConversations(convRes.body.conversations);
        if (devicesRes.body !== null) setDevices(devicesRes.body.devices);
        if (plansRes.body !== null) setPlans(plansRes.body.plans);
        if (gradientRes.body !== null) {
          setGradientCurrent(gradientRes.body.current);
          setGradientHistory(gradientRes.body.history);
        }
        setTrustRecords(trustRes.records);
        setAgentGraphNodes(agentGraphRes.nodes);
        setAgentGraphEdges(agentGraphRes.edges);
        setAgentGraphNodeCount(agentGraphRes.node_count);
        setAgentGraphEdgeCount(agentGraphRes.edge_count);
        setCredentials(credRes.credentials);

        // Check credential revocation status via batch endpoint
        if (credRes.credentials.length > 0) {
          try {
            const batchRes = await fetch(`${config.apiUrl}/api/v1/credentials/batch-status`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.apiToken}`,
              },
              body: JSON.stringify({
                credential_ids: credRes.credentials.map((c: CredentialEntry) => c.credential_id),
              }),
            });
            if (batchRes.ok) {
              const batchData = (await batchRes.json()) as {
                results: Array<{ credential_id: string; revoked: boolean }>;
              };
              const revIds = new Set(
                batchData.results.filter((r) => r.revoked).map((r) => r.credential_id),
              );
              setRevokedCredIds(revIds);
            }
          } catch {
            /* batch check failed */
          }
        }

        if ("summary" in budgetRes && budgetRes.summary != null) {
          setBudgetSummary(budgetRes.summary as { total_locked: number; total_settled: number });
        }
        if ("allocations" in budgetRes) {
          setBudgetAllocations(budgetRes.allocations);
        }
        if (successionRes != null) {
          setSuccession(successionRes);
        }

        if (eventsRes.body !== null && eventsRes.body.events.length > 0) {
          const eventsBody = eventsRes.body;
          setEvents((prev) => {
            const existingIds = new Set(prev.map((e) => e.event_id));
            const newEvents = eventsBody.events.filter((e) => !existingIds.has(e.event_id));
            return [...prev, ...newEvents];
          });
          const maxClock = Math.max(...eventsBody.events.map((e) => e.version_clock));
          if (maxClock > maxClockRef.current) {
            maxClockRef.current = maxClock;
          }
        }

        setConnected(true);
        consecutiveErrorsRef.current = 0;
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          consecutiveErrorsRef.current++;
          setConnected(false);
        }
      }
    },
    [pushHistory],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    // Adaptive polling: 2s normally, backs off to 10s on consecutive errors
    // to avoid saturating the relay's read rate limit under failure.
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      const delay =
        consecutiveErrorsRef.current > 0
          ? Math.min(2000 * 2 ** consecutiveErrorsRef.current, 10_000)
          : 2000;
      timer = setTimeout(() => {
        void refresh(controller.signal).finally(schedule);
      }, delay);
    };
    schedule();
    return () => {
      controller.abort();
      clearTimeout(timer);
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
    { className: "inspector-nav" },
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
        revokedIds: revokedCredIds,
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
    default:
      content = React.createElement(
        "div",
        { className: "panel" },
        React.createElement("p", null, "Unknown panel"),
      );
  }

  // Calm-software register: render a verification chip only when at
  // least one state-export response failed verification. On the
  // verified path the chip is invisible — every panel rendered means
  // the producer-signed manifest verified against the body bytes,
  // and confirming what the user can already see is anti-pattern.
  const verificationChip =
    verificationStatus.totalCount > 0 && verificationStatus.failures.length > 0
      ? React.createElement(
          "div",
          {
            className: "verification-chip verification-chip-failed",
            title: verificationStatus.failures.map((f) => `${f.endpoint}: ${f.reason}`).join("\n"),
            style: {
              padding: "2px 8px",
              borderRadius: "4px",
              fontSize: "0.8em",
              background: "rgba(220, 50, 50, 0.15)",
              color: "rgb(180, 30, 30)",
              border: "1px solid rgba(220, 50, 50, 0.4)",
            },
          },
          `✗ ${verificationStatus.failures.length}/${verificationStatus.totalCount} panels failed verification`,
        )
      : null;

  const header = React.createElement(
    "div",
    { className: "inspector-header" },
    React.createElement("h1", null, "Motebit Inspector"),
    React.createElement(ConnectionStatus, { connected }),
    verificationChip,
  );

  return React.createElement("div", { className: "inspector-app" }, header, nav, content);
}
