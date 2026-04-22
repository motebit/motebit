// === Gated HUD Panels ===
// Memory panel is functional (IDB-backed via runtime).
// Sync popup is functional (connects to relay via signed tokens).
// Goals panel is functional — reads/writes the shared GoalsRunner in
// @motebit/panels, filtered to one-shot goals (mode: "once"). Recurring
// goals render in the Workstation plane instead.

import type { WebContext } from "../types";
import type { WebSyncStatus } from "../web-app";
import {
  saveSyncUrl,
  loadSyncUrl,
  clearSyncUrl,
  DEFAULT_RELAY_URL,
  normalizeRelayUrl,
} from "../storage";
import type { PlanChunk } from "@motebit/runtime";
import { renderMarkdown } from "./chat";
import {
  createAgentsController,
  createMemoryController,
  classifyCertainty,
  type AgentRecord,
  type AgentsFetchAdapter,
  type AgentsState,
  type DiscoveredAgent,
  type GoalRunRecord,
  type MemoryFetchAdapter,
  type MemoryState,
  type PricingEntry,
  type ScheduledGoal,
} from "@motebit/panels";
import { computeDecayedConfidence } from "@motebit/memory-graph";

export interface GatedPanelsAPI {
  openMemory(auditNodeIds?: Map<string, string>): void;
  openGoals(): void;
  openAgents(): void;
  closeAll(): void;
}

/**
 * UI-facing status for the Goals panel, derived from (goal.status, latest
 * run for this goal).
 *
 *   pending   — active, never run
 *   running   — has an in-flight run
 *   completed — terminal success
 *   failed    — terminal failure
 */
type GoalPanelStatus = "pending" | "running" | "completed" | "failed";

function panelStatus(goal: ScheduledGoal, runs: GoalRunRecord[]): GoalPanelStatus {
  if (goal.status === "completed") return "completed";
  if (goal.status === "failed") return "failed";
  const latest = runs.find((r) => r.goal_id === goal.goal_id);
  if (latest?.status === "running") return "running";
  return "pending";
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const SYNC_STATUS_LABELS: Record<WebSyncStatus, string> = {
  offline: "",
  connecting: "Connecting...",
  connected: "Connected",
  syncing: "Syncing...",
  error: "Connection failed",
  disconnected: "Disconnected",
};

export function initGatedPanels(ctx: WebContext): GatedPanelsAPI {
  // === Memory Panel (functional) ===
  // Fetch + filter + delete live in @motebit/panels MemoryController.
  // This block owns DOM rendering + markdown + the inline delete-confirm UX.
  // Sensitivity floor ["none", "personal"] is passed explicitly — matches
  // CLI export behavior and is now a declared config, not a silent
  // per-surface divergence.
  const memoryPanel = document.getElementById("memory-panel") as HTMLDivElement;
  const memoryBackdrop = document.getElementById("memory-backdrop") as HTMLDivElement;
  const memoryList = document.getElementById("memory-list") as HTMLDivElement;
  const memoryEmpty = document.getElementById("memory-empty") as HTMLDivElement;

  const memoryAdapter: MemoryFetchAdapter = {
    listMemories: async () => {
      const runtime = ctx.app.getRuntime();
      if (!runtime) return [];
      const { nodes } = await runtime.memory.exportAll();
      return nodes;
    },
    deleteMemory: async (nodeId) => {
      const runtime = ctx.app.getRuntime();
      if (!runtime) return null;
      await runtime.memory.deleteMemory(nodeId);
      // Web's runtime.memory doesn't surface the certificate today — the
      // tombstone hash lives in the event log. Returning null is correct
      // until the runtime plumbs it up.
      return null;
    },
    pinMemory: async () => {
      // Web doesn't expose pin today. No-op keeps the interface satisfied.
    },
    getDecayedConfidence: (node) =>
      computeDecayedConfidence(node.confidence, node.half_life, Date.now() - node.created_at),
  };

  const memoryCtrl = createMemoryController(memoryAdapter, {
    sensitivityFilter: ["none", "personal"],
  });

  function renderMemories(state: MemoryState): void {
    const runtime = ctx.app.getRuntime();
    if (!runtime) {
      memoryList.innerHTML = "";
      memoryEmpty.style.display = "block";
      memoryEmpty.textContent = "Runtime not initialized";
      return;
    }

    const view = memoryCtrl.filteredView();
    memoryList.innerHTML = "";

    if (view.length === 0) {
      memoryEmpty.style.display = "block";
      memoryEmpty.textContent =
        state.memories.length === 0
          ? "No memories yet. Start a conversation to build memory."
          : "No matching memories.";
      return;
    }

    memoryEmpty.style.display = "none";

    for (const node of view) {
      const item = document.createElement("div");
      const auditCategory = state.auditFlags.get(node.node_id);
      item.className = "memory-item" + (auditCategory ? ` ${auditCategory}` : "");

      const content = document.createElement("div");
      content.className = "memory-item-content";
      content.innerHTML = renderMarkdown(node.content);
      item.appendChild(content);

      const meta = document.createElement("div");
      meta.className = "memory-item-meta";

      if (auditCategory) {
        const tag = document.createElement("span");
        tag.className = `memory-audit-tag ${auditCategory}`;
        const labels: Record<string, string> = {
          phantom: "phantom",
          conflict: "conflict",
          "near-death": "fading",
        };
        tag.textContent = labels[auditCategory] ?? auditCategory;
        meta.appendChild(tag);
      }

      // Decayed confidence — previously web rendered raw node.confidence,
      // diverging from desktop/mobile. Controller-canonical now.
      const decayed = memoryCtrl.getDecayedConfidence(node);
      const certainty = classifyCertainty(decayed);
      const confidence = document.createElement("span");
      confidence.className = `memory-item-certainty memory-certainty-${certainty}`;
      // Three-state label surfaces the `memory_promoted` state (§5.8) —
      // when the agent's Layer-1 index sees `(absolute)` for a node,
      // the panel renders the same badge here. Percentage stays for
      // the fine-grained numeric reader; the label is the at-a-glance
      // certainty cue.
      confidence.textContent = `${certainty} · ${Math.round(decayed * 100)}%`;
      meta.appendChild(confidence);

      const time = document.createElement("span");
      time.textContent = formatTimeAgo(node.created_at);
      meta.appendChild(time);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "memory-delete-btn";
      deleteBtn.title = "Forget this memory";
      deleteBtn.textContent = "\u00d7";
      let confirmTimer: ReturnType<typeof setTimeout> | null = null;
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (deleteBtn.classList.contains("confirming")) {
          if (confirmTimer != null) clearTimeout(confirmTimer);
          void memoryCtrl.deleteMemory(node.node_id).finally(() => {
            void memoryCtrl.refresh();
          });
        } else {
          deleteBtn.classList.add("confirming");
          deleteBtn.textContent = "Forget?";
          confirmTimer = setTimeout(() => {
            deleteBtn.classList.remove("confirming");
            deleteBtn.textContent = "\u00d7";
          }, 3000);
        }
      });
      meta.appendChild(deleteBtn);

      item.appendChild(meta);
      memoryList.appendChild(item);
    }
  }

  memoryCtrl.subscribe(renderMemories);

  function openMemory(auditNodeIds?: Map<string, string>): void {
    closeAll();
    memoryCtrl.setAuditFlags(auditNodeIds ?? new Map<string, string>());
    memoryPanel.classList.add("open");
    memoryBackdrop.classList.add("open");
    void memoryCtrl.refresh();
  }

  function closeMemory(): void {
    memoryPanel.classList.remove("open");
    memoryBackdrop.classList.remove("open");
  }

  document.getElementById("memory-btn")!.addEventListener("click", () => openMemory());
  document.getElementById("memory-close-btn")!.addEventListener("click", closeMemory);
  memoryBackdrop.addEventListener("click", closeMemory);

  // === Goals Panel (functional) ===
  // Reads from the shared GoalsRunner in @motebit/panels, filtered to
  // one-shot goals (mode: "once"). Recurring goals render in the
  // Workstation plane. Plan chunks stream inline via the runner's
  // onChunk callback so the panel shows step-by-step progress.
  const goalsPanel = document.getElementById("goals-panel") as HTMLDivElement;
  const goalsBackdrop = document.getElementById("goals-backdrop") as HTMLDivElement;
  const goalList = document.getElementById("goal-list") as HTMLDivElement;
  const goalEmpty = document.getElementById("goal-empty") as HTMLDivElement;
  const goalPromptInput = document.getElementById("goal-prompt") as HTMLTextAreaElement;
  const goalAddBtn = document.getElementById("goal-add-btn") as HTMLButtonElement;

  let goalsSubscribed = false;

  function renderPlanChunk(container: HTMLElement, chunk: PlanChunk): void {
    const el = document.createElement("div");
    el.className = "goal-step";
    switch (chunk.type) {
      case "plan_created":
        el.textContent = `Plan: ${chunk.plan.title} (${chunk.plan.total_steps} steps)`;
        break;
      case "step_started":
        el.className = "goal-step running";
        el.textContent = `Running: ${chunk.step.description}`;
        break;
      case "step_completed":
        el.className = "goal-step completed";
        el.textContent = `Done: ${chunk.step.description}`;
        break;
      case "step_failed":
        el.className = "goal-step failed";
        el.textContent = `Failed: ${chunk.step.description}`;
        break;
      case "plan_completed":
        el.className = "goal-step completed";
        el.textContent = "Plan completed";
        break;
      case "plan_failed":
        el.className = "goal-step failed";
        el.textContent = `Plan failed: ${chunk.reason}`;
        break;
      default:
        return;
    }
    container.appendChild(el);
  }

  function renderGoals(): void {
    const runner = ctx.app.getGoalsRunner?.();
    if (!runner) {
      goalList.innerHTML = "";
      goalEmpty.style.display = "block";
      return;
    }
    const state = runner.getState();
    const panelGoals = state.goals
      .filter((g) => g.mode === "once")
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

    goalList.innerHTML = "";
    if (panelGoals.length === 0) {
      goalEmpty.style.display = "block";
      return;
    }
    goalEmpty.style.display = "none";

    for (const goal of panelGoals) {
      const status = panelStatus(goal, state.runs);

      const item = document.createElement("div");
      item.className = "goal-item";

      const header = document.createElement("div");
      header.className = "goal-item-header";

      const dot = document.createElement("span");
      dot.className = `goal-status-dot ${status}`;
      header.appendChild(dot);

      const text = document.createElement("span");
      text.className = "goal-prompt-text";
      text.textContent = goal.prompt;
      text.title = goal.prompt;
      header.appendChild(text);

      const actions = document.createElement("div");
      actions.className = "goal-actions";

      if (status === "pending") {
        const execBtn = document.createElement("button");
        execBtn.textContent = "Execute";
        execBtn.addEventListener("click", () => void executeGoal(goal.goal_id));
        actions.appendChild(execBtn);
      }

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "\u00d7";
      deleteBtn.className = "goal-delete-btn";
      let goalConfirmTimer: ReturnType<typeof setTimeout> | null = null;
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (deleteBtn.classList.contains("confirming")) {
          if (goalConfirmTimer != null) clearTimeout(goalConfirmTimer);
          runner.removeGoal(goal.goal_id);
        } else {
          deleteBtn.classList.add("confirming");
          deleteBtn.textContent = "Delete?";
          goalConfirmTimer = setTimeout(() => {
            deleteBtn.classList.remove("confirming");
            deleteBtn.textContent = "\u00d7";
          }, 3000);
        }
      });
      actions.appendChild(deleteBtn);

      header.appendChild(actions);
      item.appendChild(header);

      const stepsEl = document.createElement("div");
      stepsEl.className = "goal-steps";
      stepsEl.id = `goal-steps-${goal.goal_id}`;
      item.appendChild(stepsEl);

      goalList.appendChild(item);
    }
  }

  async function executeGoal(goalId: string): Promise<void> {
    const runner = ctx.app.getGoalsRunner?.();
    if (!runner) return;
    if (!ctx.app.isProviderConnected) {
      ctx.showToast("Connect an AI provider first");
      return;
    }

    const goalsBtn = document.getElementById("goals-btn");
    goalsBtn?.classList.add("executing");

    try {
      await runner.runNow(goalId, (chunk) => {
        const stepsEl = document.getElementById(`goal-steps-${goalId}`);
        if (!stepsEl) return;
        if (chunk && typeof chunk === "object" && "type" in chunk) {
          renderPlanChunk(stepsEl, chunk as PlanChunk);
        }
      });
    } finally {
      goalsBtn?.classList.remove("executing");
    }
  }

  goalAddBtn.addEventListener("click", () => {
    const runner = ctx.app.getGoalsRunner?.();
    if (!runner) return;
    const prompt = goalPromptInput.value.trim();
    if (!prompt) return;
    runner.addGoal({ prompt, mode: "once" });
    goalPromptInput.value = "";
  });

  function openGoals(): void {
    closeAll();
    // Lazy-attach the runner subscription on first open — the runner is
    // constructed during `app.bootstrap()`, which runs AFTER
    // `initGatedPanels`, so an init-time subscription would see null.
    if (!goalsSubscribed) {
      const runner = ctx.app.getGoalsRunner?.();
      if (runner) {
        runner.subscribe(() => renderGoals());
        goalsSubscribed = true;
      }
    }
    renderGoals();
    goalsPanel.classList.add("open");
    goalsBackdrop.classList.add("open");
  }

  function closeGoals(): void {
    goalsPanel.classList.remove("open");
    goalsBackdrop.classList.remove("open");
  }

  document.getElementById("goals-btn")!.addEventListener("click", openGoals);
  document.getElementById("goals-close-btn")!.addEventListener("click", closeGoals);
  goalsBackdrop.addEventListener("click", closeGoals);

  // === Agents Panel (functional) ===
  // Fetching + state live in @motebit/panels AgentsController. This block
  // owns the DOM rendering + the "route discoverAgents through signed sync
  // token" adapter. When web adopts sort/filter, wire discoverSort/
  // discoverFilter to ctrl.setSort / ctrl.setCapabilityFilter — the state
  // is already there.
  const agentsPanel = document.getElementById("agents-panel") as HTMLDivElement;
  const agentsBackdrop = document.getElementById("agents-backdrop") as HTMLDivElement;
  const agentsList = document.getElementById("agents-list") as HTMLDivElement;
  const agentsEmpty = document.getElementById("agents-empty") as HTMLDivElement;

  const TRUST_BADGE_CLASS: Record<string, string> = {
    unknown: "unknown",
    first_contact: "first-contact",
    verified: "verified",
    trusted: "trusted",
    blocked: "blocked",
  };

  const agentsAdapter: AgentsFetchAdapter = {
    get syncUrl() {
      return loadSyncUrl();
    },
    get motebitId() {
      return ctx.app.motebitId || null;
    },
    listTrustedAgents: async (): Promise<AgentRecord[]> => {
      const runtime = ctx.app.getRuntime();
      if (!runtime) return [];
      return (await runtime.listTrustedAgents()) as AgentRecord[];
    },
    discoverAgents: async (): Promise<DiscoveredAgent[]> => {
      const syncUrl = loadSyncUrl();
      if (!syncUrl) return [];
      const token = await ctx.app.createSyncToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`${syncUrl}/api/v1/agents/discover`, { headers });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as { agents?: DiscoveredAgent[] };
      return data.agents ?? [];
    },
  };

  const agentsCtrl = createAgentsController(agentsAdapter);

  function renderKnown(state: AgentsState): void {
    agentsList.innerHTML = "";
    if (state.known.length === 0) {
      agentsEmpty.style.display = "block";
      return;
    }
    agentsEmpty.style.display = "none";

    for (const agent of state.known) {
      const item = document.createElement("div");
      item.className = "agent-item";

      const idDiv = document.createElement("div");
      idDiv.className = "agent-item-id";
      idDiv.textContent = agent.remote_motebit_id;
      idDiv.title = agent.remote_motebit_id;
      item.appendChild(idDiv);

      const meta = document.createElement("div");
      meta.className = "agent-item-meta";

      const badge = document.createElement("span");
      badge.className = `agent-trust-badge ${TRUST_BADGE_CLASS[agent.trust_level] ?? "unknown"}`;
      badge.textContent = agent.trust_level.replace(/_/g, " ");
      meta.appendChild(badge);

      const tasks = document.createElement("span");
      const ok = agent.successful_tasks ?? 0;
      const fail = agent.failed_tasks ?? 0;
      if (ok + fail > 0) {
        tasks.textContent = `${ok}/${ok + fail} tasks`;
      } else {
        tasks.textContent = `${agent.interaction_count} interaction${agent.interaction_count !== 1 ? "s" : ""}`;
      }
      meta.appendChild(tasks);

      const time = document.createElement("span");
      time.textContent = formatTimeAgo(agent.last_seen_at);
      meta.appendChild(time);

      item.appendChild(meta);
      agentsList.appendChild(item);
    }
  }

  // --- Discover tab ---
  const discoverList = document.getElementById("agents-discover-list") as HTMLDivElement;
  const discoverEmpty = document.getElementById("agents-discover-empty") as HTMLDivElement;
  const knownPane = document.getElementById("agents-known-pane") as HTMLDivElement;
  const discoverPane = document.getElementById("agents-discover-pane") as HTMLDivElement;
  const tabBtns = Array.from(agentsPanel.querySelectorAll<HTMLButtonElement>(".agents-tab"));

  function switchTab(tab: string): void {
    for (const btn of tabBtns) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    }
    knownPane.style.display = tab === "known" ? "" : "none";
    discoverPane.style.display = tab === "discover" ? "" : "none";
    if (tab === "known") agentsCtrl.setActiveTab("known");
    else if (tab === "discover") {
      agentsCtrl.setActiveTab("discover");
      void agentsCtrl.refreshDiscover();
    }
  }

  for (const btn of tabBtns) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab ?? "known"));
  }

  function renderDiscover(state: AgentsState): void {
    const syncUrl = loadSyncUrl();
    if (!syncUrl) {
      discoverList.innerHTML = "";
      discoverEmpty.textContent = "Connect to a relay in Settings to discover agents.";
      discoverEmpty.style.display = "block";
      return;
    }

    if (state.discovered.length === 0) {
      discoverList.innerHTML = "";
      discoverEmpty.textContent =
        state.error != null ? "Could not reach relay." : "No agents on the network yet.";
      discoverEmpty.style.display = "block";
      return;
    }

    discoverEmpty.style.display = "none";
    discoverList.innerHTML = "";

    for (const agent of state.discovered) {
      const item = document.createElement("div");
      item.className = "agent-item";

      const idDiv = document.createElement("div");
      idDiv.className = "agent-item-id";
      idDiv.textContent = agent.motebit_id;
      idDiv.title = agent.motebit_id;
      item.appendChild(idDiv);

      if (agent.capabilities.length > 0) {
        const priceByCapability = new Map<string, PricingEntry>();
        if (Array.isArray(agent.pricing)) {
          for (const p of agent.pricing) priceByCapability.set(p.capability, p);
        }

        const capsRow = document.createElement("div");
        capsRow.className = "agent-caps-row";
        for (const cap of agent.capabilities) {
          const tag = document.createElement("span");
          tag.className = "agent-cap-tag";
          const price = priceByCapability.get(cap);
          if (price && price.unit_cost > 0) {
            tag.textContent = `${cap} · $${price.unit_cost.toFixed(2)}/${price.per}`;
            tag.classList.add("priced");
            tag.title = `${price.unit_cost} ${price.currency} per ${price.per}`;
          } else {
            tag.textContent = cap;
          }
          capsRow.appendChild(tag);
        }
        item.appendChild(capsRow);
      }

      const meta = document.createElement("div");
      meta.className = "agent-item-meta";
      if (agent.trust_level) {
        const badge = document.createElement("span");
        badge.className = `agent-trust-badge ${TRUST_BADGE_CLASS[agent.trust_level] ?? "unknown"}`;
        const interactionSuffix =
          typeof agent.interaction_count === "number" && agent.interaction_count > 0
            ? ` · ${agent.interaction_count} interaction${agent.interaction_count === 1 ? "" : "s"}`
            : "";
        badge.textContent = agent.trust_level.replace(/_/g, " ") + interactionSuffix;
        meta.appendChild(badge);
      }
      if (typeof agent.last_seen_at === "number" && agent.last_seen_at > 0) {
        if (agent.freshness) {
          const dot = document.createElement("span");
          dot.className = `agent-freshness-dot agent-freshness-${agent.freshness}`;
          dot.title =
            agent.freshness === "awake"
              ? "Heartbeating now"
              : agent.freshness === "recently_seen"
                ? "Missed a heartbeat; still likely reachable"
                : agent.freshness === "dormant"
                  ? "Asleep — woken on delegation"
                  : "Long asleep — wake latency uncertain";
          meta.appendChild(dot);
        }
        const seen = document.createElement("span");
        seen.className = "agent-last-seen";
        seen.textContent = `seen ${formatTimeAgo(agent.last_seen_at)}`;
        meta.appendChild(seen);
      }
      item.appendChild(meta);

      discoverList.appendChild(item);
    }
  }

  agentsCtrl.subscribe((state) => {
    renderKnown(state);
    renderDiscover(state);
  });

  function openAgents(): void {
    closeAll();
    agentsPanel.classList.add("open");
    agentsBackdrop.classList.add("open");
    void agentsCtrl.refreshKnown();
  }

  function closeAgents(): void {
    agentsPanel.classList.remove("open");
    agentsBackdrop.classList.remove("open");
  }

  document.getElementById("agents-btn")!.addEventListener("click", openAgents);
  document.getElementById("agents-close-btn")!.addEventListener("click", closeAgents);
  agentsBackdrop.addEventListener("click", closeAgents);

  // === Sync Popup (functional) ===
  const syncStatusEl = document.getElementById("sync-status") as HTMLDivElement;
  const syncPopup = document.getElementById("sync-popup") as HTMLDivElement;
  const syncRelayUrl = document.getElementById("sync-relay-url") as HTMLInputElement;
  const syncConnectBtn = document.getElementById("sync-connect-btn") as HTMLButtonElement;
  const syncDisconnectBtn = document.getElementById("sync-disconnect-btn") as HTMLButtonElement;
  const syncStatusText = document.getElementById("sync-status-text") as HTMLDivElement;

  function updateSyncUI(status: WebSyncStatus): void {
    // Update the HUD indicator class
    syncStatusEl.className = status === "offline" ? "disconnected" : status;

    // Update tooltip
    const label = SYNC_STATUS_LABELS[status] || status;
    syncStatusEl.title = label ? `Sync: ${label}` : "Sync: Not connected";

    // Update popup text
    syncStatusText.textContent = label;

    // Toggle connect/disconnect buttons
    const isActive = status === "connected" || status === "syncing" || status === "connecting";
    syncConnectBtn.style.display = isActive ? "none" : "";
    syncDisconnectBtn.style.display = isActive ? "" : "none";
  }

  syncRelayUrl.value = loadSyncUrl() ?? DEFAULT_RELAY_URL;

  // Subscribe to sync status changes
  ctx.app.onSyncStatusChange(updateSyncUI);

  // Connect button
  syncConnectBtn.addEventListener("click", () => {
    const url = normalizeRelayUrl(syncRelayUrl.value);
    if (!url) {
      syncStatusText.textContent = "Relay URL is required";
      return;
    }
    syncRelayUrl.value = url;
    saveSyncUrl(url);
    syncStatusText.textContent = "Connecting...";
    ctx.app.startSync(url).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      syncStatusText.textContent = `Failed: ${msg}`;
      ctx.showToast(`Sync failed: ${msg}`);
    });
  });

  // Disconnect button
  syncDisconnectBtn.addEventListener("click", () => {
    ctx.app.stopSync();
    clearSyncUrl();
    syncStatusText.textContent = "";
  });

  function toggleSync(): void {
    if (syncPopup.classList.contains("open")) {
      syncPopup.classList.remove("open");
    } else {
      closeAll();
      // Position popup below the sync status indicator
      const rect = syncStatusEl.getBoundingClientRect();
      syncPopup.style.top = `${rect.bottom + 8}px`;
      syncPopup.style.left = `${rect.left + rect.width / 2}px`;
      syncPopup.style.transform = "translateX(-50%)";
      syncPopup.classList.add("open");
    }
  }

  syncStatusEl.addEventListener("click", toggleSync);

  // Close sync popup on outside click
  document.addEventListener("click", (e) => {
    if (
      syncPopup.classList.contains("open") &&
      !syncPopup.contains(e.target as Node) &&
      !syncStatusEl.contains(e.target as Node)
    ) {
      syncPopup.classList.remove("open");
    }
  });

  // === Close All ===
  function closeAll(): void {
    closeMemory();
    closeGoals();
    closeAgents();
    syncPopup.classList.remove("open");
  }

  return { openMemory, openGoals, openAgents, closeAll };
}
