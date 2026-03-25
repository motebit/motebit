// === Gated HUD Panels ===
// Memory panel is functional (IDB-backed via runtime).
// Sync popup is functional (connects to relay via signed tokens).
// Goals panel is functional (one-shot plan execution, IDB-backed).

import type { WebContext } from "../types";
import type { WebSyncStatus } from "../web-app";
import { saveSyncUrl, loadSyncUrl, clearSyncUrl } from "../storage";
import type { PlanChunk } from "@motebit/runtime";

export interface GatedPanelsAPI {
  openMemory(auditNodeIds?: Map<string, string>): void;
  openGoals(): void;
  openAgents(): void;
  closeAll(): void;
}

interface WebGoal {
  goal_id: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "failed";
  created_at: number;
}

const GOALS_STORAGE_KEY = "motebit:goals";

function loadGoals(): WebGoal[] {
  try {
    const raw = localStorage.getItem(GOALS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as WebGoal[];
  } catch {
    // corrupted
  }
  return [];
}

function saveGoals(goals: WebGoal[]): void {
  localStorage.setItem(GOALS_STORAGE_KEY, JSON.stringify(goals));
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
  let goals = loadGoals();

  // === Memory Panel (functional) ===
  const memoryPanel = document.getElementById("memory-panel") as HTMLDivElement;
  const memoryBackdrop = document.getElementById("memory-backdrop") as HTMLDivElement;
  const memoryList = document.getElementById("memory-list") as HTMLDivElement;
  const memoryEmpty = document.getElementById("memory-empty") as HTMLDivElement;

  /** Map of node_id → audit category, set by /audit and cleared on next open. */
  let currentAuditFlags: Map<string, string> | undefined;

  async function populateMemories(): Promise<void> {
    const runtime = ctx.app.getRuntime();
    if (!runtime) {
      memoryList.innerHTML = "";
      memoryEmpty.style.display = "block";
      memoryEmpty.textContent = "Runtime not initialized";
      return;
    }

    const { nodes } = await runtime.memory.exportAll();
    // Filter: exclude tombstoned and sensitive memories (medical/financial/secret)
    // matching CLI export behavior — only none/personal displayed in UI
    const displayAllowed = new Set(["none", "personal"]);
    const now = Date.now();
    const active = nodes.filter(
      (n) =>
        !n.tombstoned &&
        displayAllowed.has(n.sensitivity) &&
        (n.valid_until == null || n.valid_until > now),
    );

    memoryList.innerHTML = "";

    if (active.length === 0) {
      memoryEmpty.style.display = "block";
      memoryEmpty.textContent = "No memories yet. Start a conversation to build memory.";
      return;
    }

    memoryEmpty.style.display = "none";

    const auditFlags = currentAuditFlags;

    // Sort: flagged memories first when audit is active, then by recency
    active.sort((a, b) => {
      if (auditFlags) {
        const aFlag = auditFlags.has(a.node_id) ? 0 : 1;
        const bFlag = auditFlags.has(b.node_id) ? 0 : 1;
        if (aFlag !== bFlag) return aFlag - bFlag;
      }
      return b.created_at - a.created_at;
    });

    for (const node of active) {
      const item = document.createElement("div");
      const auditCategory = auditFlags?.get(node.node_id);
      item.className = "memory-item" + (auditCategory ? ` ${auditCategory}` : "");

      const content = document.createElement("div");
      content.className = "memory-item-content";
      content.textContent = node.content;
      item.appendChild(content);

      const meta = document.createElement("div");
      meta.className = "memory-item-meta";

      // Audit tag (if flagged)
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

      const confidence = document.createElement("span");
      confidence.textContent = `${Math.round(node.confidence * 100)}%`;
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
          void runtime.memory.deleteMemory(node.node_id).then(() => populateMemories());
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

  function openMemory(auditNodeIds?: Map<string, string>): void {
    closeAll();
    currentAuditFlags = auditNodeIds;
    memoryPanel.classList.add("open");
    memoryBackdrop.classList.add("open");
    void populateMemories();
  }

  function closeMemory(): void {
    memoryPanel.classList.remove("open");
    memoryBackdrop.classList.remove("open");
  }

  document.getElementById("memory-btn")!.addEventListener("click", () => openMemory());
  document.getElementById("memory-close-btn")!.addEventListener("click", closeMemory);
  memoryBackdrop.addEventListener("click", closeMemory);

  // === Goals Panel (functional) ===
  const goalsPanel = document.getElementById("goals-panel") as HTMLDivElement;
  const goalsBackdrop = document.getElementById("goals-backdrop") as HTMLDivElement;
  const goalList = document.getElementById("goal-list") as HTMLDivElement;
  const goalEmpty = document.getElementById("goal-empty") as HTMLDivElement;
  const goalPromptInput = document.getElementById("goal-prompt") as HTMLTextAreaElement;
  const goalAddBtn = document.getElementById("goal-add-btn") as HTMLButtonElement;

  function renderGoals(): void {
    goalList.innerHTML = "";
    if (goals.length === 0) {
      goalEmpty.style.display = "block";
      return;
    }
    goalEmpty.style.display = "none";

    for (const goal of goals) {
      const item = document.createElement("div");
      item.className = "goal-item";

      const header = document.createElement("div");
      header.className = "goal-item-header";

      const dot = document.createElement("span");
      dot.className = `goal-status-dot ${goal.status}`;
      header.appendChild(dot);

      const text = document.createElement("span");
      text.className = "goal-prompt-text";
      text.textContent = goal.prompt;
      text.title = goal.prompt;
      header.appendChild(text);

      const actions = document.createElement("div");
      actions.className = "goal-actions";

      if (goal.status === "pending") {
        const execBtn = document.createElement("button");
        execBtn.textContent = "Execute";
        execBtn.addEventListener("click", () => void executeGoal(goal));
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
          goals = goals.filter((g) => g.goal_id !== goal.goal_id);
          saveGoals(goals);
          renderGoals();
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

      // Step progress area
      const stepsEl = document.createElement("div");
      stepsEl.className = "goal-steps";
      stepsEl.id = `goal-steps-${goal.goal_id}`;
      item.appendChild(stepsEl);

      goalList.appendChild(item);
    }
  }

  async function executeGoal(goal: WebGoal): Promise<void> {
    if (!ctx.app.isProviderConnected) {
      ctx.showToast("Connect an AI provider first");
      return;
    }

    goal.status = "running";
    saveGoals(goals);
    renderGoals();

    const goalsBtn = document.getElementById("goals-btn");
    goalsBtn?.classList.add("executing");

    const stepsEl = document.getElementById(`goal-steps-${goal.goal_id}`);

    try {
      const gen: AsyncGenerator<PlanChunk> = ctx.app.executeGoal(goal.goal_id, goal.prompt);
      for await (const chunk of gen) {
        if (stepsEl) {
          renderPlanChunk(stepsEl, chunk);
        }
      }
      goal.status = "completed";
    } catch (err: unknown) {
      goal.status = "failed";
      const msg = err instanceof Error ? err.message : String(err);
      if (stepsEl) {
        const errEl = document.createElement("div");
        errEl.className = "goal-step failed";
        errEl.textContent = `Error: ${msg}`;
        stepsEl.appendChild(errEl);
      }
    } finally {
      goalsBtn?.classList.remove("executing");
      saveGoals(goals);
      renderGoals();
    }
  }

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
        return; // skip text chunks in step view
    }
    container.appendChild(el);
  }

  goalAddBtn.addEventListener("click", () => {
    const prompt = goalPromptInput.value.trim();
    if (!prompt) return;

    const goal: WebGoal = {
      goal_id: crypto.randomUUID(),
      prompt,
      status: "pending",
      created_at: Date.now(),
    };
    goals.unshift(goal);
    saveGoals(goals);
    goalPromptInput.value = "";
    renderGoals();
  });

  function openGoals(): void {
    closeAll();
    goals = loadGoals(); // Refresh from storage
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

  async function populateAgents(): Promise<void> {
    const runtime = ctx.app.getRuntime();
    if (!runtime) {
      agentsList.innerHTML = "";
      agentsEmpty.style.display = "block";
      return;
    }

    const agents = await runtime.listTrustedAgents();

    agentsList.innerHTML = "";

    if (agents.length === 0) {
      agentsEmpty.style.display = "block";
      return;
    }

    agentsEmpty.style.display = "none";

    // Sort by most recently seen
    agents.sort((a, b) => b.last_seen_at - a.last_seen_at);

    for (const agent of agents) {
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
    if (tab === "discover") void populateDiscover();
  }

  for (const btn of tabBtns) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab ?? "known"));
  }

  async function populateDiscover(): Promise<void> {
    const syncUrl = loadSyncUrl();
    if (!syncUrl) {
      discoverList.innerHTML = "";
      discoverEmpty.textContent = "Connect to a relay in Settings to discover agents.";
      discoverEmpty.style.display = "block";
      return;
    }

    discoverList.innerHTML = "";
    discoverEmpty.textContent = "";
    discoverEmpty.style.display = "block";

    try {
      const token = await ctx.app.createSyncToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`${syncUrl}/api/v1/agents/discover`, { headers });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as {
        agents: Array<{
          motebit_id: string;
          capabilities: string[];
          trust_level?: string;
          endpoint_url?: string;
        }>;
      };

      const agents = data.agents ?? [];
      if (agents.length === 0) {
        discoverEmpty.textContent = "No agents on the network yet.";
        discoverEmpty.style.display = "block";
        return;
      }

      discoverEmpty.style.display = "none";

      for (const agent of agents) {
        const item = document.createElement("div");
        item.className = "agent-item";

        const idDiv = document.createElement("div");
        idDiv.className = "agent-item-id";
        idDiv.textContent = agent.motebit_id;
        idDiv.title = agent.motebit_id;
        item.appendChild(idDiv);

        if (agent.capabilities.length > 0) {
          const capsRow = document.createElement("div");
          capsRow.className = "agent-caps-row";
          for (const cap of agent.capabilities) {
            const tag = document.createElement("span");
            tag.className = "agent-cap-tag";
            tag.textContent = cap;
            capsRow.appendChild(tag);
          }
          item.appendChild(capsRow);
        }

        const meta = document.createElement("div");
        meta.className = "agent-item-meta";
        if (agent.trust_level) {
          const badge = document.createElement("span");
          badge.className = `agent-trust-badge ${TRUST_BADGE_CLASS[agent.trust_level] ?? "unknown"}`;
          badge.textContent = agent.trust_level.replace(/_/g, " ");
          meta.appendChild(badge);
        }
        item.appendChild(meta);

        discoverList.appendChild(item);
      }
    } catch {
      discoverEmpty.textContent = "Could not reach relay.";
      discoverEmpty.style.display = "block";
    }
  }

  function openAgents(): void {
    closeAll();
    agentsPanel.classList.add("open");
    agentsBackdrop.classList.add("open");
    void populateAgents();
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

  // Restore saved relay URL
  const savedUrl = loadSyncUrl();
  if (savedUrl) {
    syncRelayUrl.value = savedUrl;
  }

  // Subscribe to sync status changes
  ctx.app.onSyncStatusChange(updateSyncUI);

  // Connect button
  syncConnectBtn.addEventListener("click", () => {
    const url = syncRelayUrl.value.trim();
    if (!url) {
      syncStatusText.textContent = "Enter a relay URL";
      return;
    }
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
