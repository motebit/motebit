// === Gated HUD Panels ===
// Memory panel is functional (IDB-backed via runtime).
// Sync popup is functional (connects to relay via signed tokens).
// Goals panel is functional — reads/writes the shared GoalsRunner in
// @motebit/panels, filtered to one-shot goals (mode: "once"). Recurring
// goals execute via GoalsRunner and surface through the slab.

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
  formatHardwarePlatform,
  formatLatency,
  type AgentHardwareAttestation,
  type AgentLatencyStats,
  type AgentRecord,
  type AgentsFetchAdapter,
  formatCountdownUntil,
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
      // Route through the privacy-layer choke point so user-driven
      // deletion is signed (mutable_pruning cert), audited, and lands
      // a `DeleteRequested` event on the append-only log — the same
      // sovereignty contract every surface honors.
      return await runtime.privacy.deleteMemory(nodeId, "user_request");
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
        state.memories.length === 0 ? "Memories appear here as conversations build" : "No matches";
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
  // Runtime register per docs/doctrine/panel-temporal-registers.md —
  // cards-as-commitments, status pulses, axis-native budget envelopes.
  // Each card is a living commitment; click expands per-card detail
  // (last response, next run, raise budget, pause, remove).
  //
  // Layout per docs/doctrine/panel-presentation-modes.md §"Inline >
  // transition > modal-forbidden": single-page, form always visible
  // at the bottom of the panel (Apple Reminders bottom-bar pattern).
  // Cards (or the empty caption) scroll in the area above; the form
  // is perpetual. No register transition, no separate page — the
  // form is light enough to coexist with the list, so the inline
  // affordance is the right shape.
  const goalsPanel = document.getElementById("goals-panel") as HTMLDivElement;
  const goalsBackdrop = document.getElementById("goals-backdrop") as HTMLDivElement;
  const goalList = document.getElementById("goal-list") as HTMLDivElement;
  const goalEmpty = document.getElementById("goal-empty") as HTMLDivElement;
  const goalCommitPrompt = document.getElementById("goal-commit-prompt") as HTMLTextAreaElement;
  const goalCommitCadenceChips = document.getElementById(
    "goal-commit-cadence-chips",
  ) as HTMLDivElement;
  const goalCommitBudgetChips = document.getElementById(
    "goal-commit-budget-chips",
  ) as HTMLDivElement;
  const goalCommitBudgetCustom = document.getElementById(
    "goal-commit-budget-custom",
  ) as HTMLInputElement;
  const goalCommitSubmit = document.getElementById("goal-commit-submit") as HTMLButtonElement;

  let goalsSubscribed = false;
  // Per-card expansion is renderer-state, not runner-state: lives in
  // this Set so the runtime-register card behaves like Reminders /
  // Focus — tap to reveal the commitment's full body, tap to collapse.
  const expandedGoalIds = new Set<string>();

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

  function cadenceLabel(goal: ScheduledGoal): string {
    switch (goal.interval_ms) {
      case 3_600_000:
        return "hourly";
      case 86_400_000:
        return "daily";
      case 604_800_000:
        return "weekly";
      default:
        return goal.mode === "once" ? "once" : "custom";
    }
  }

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
    return String(n);
  }

  // The pulse class drives both color and breathing animation.
  // Recurring + active = breathing at 0.3Hz (Liquescentia rate, so
  // the card is medium-coherent with the slab and the creature);
  // running = faster fire pulse; budget_exhausted = static red with
  // shadow ring; etc.
  function pulseClass(goal: ScheduledGoal, runs: GoalRunRecord[]): string {
    const latestRun = runs.find((r) => r.goal_id === goal.goal_id);
    if (latestRun?.status === "running") return "running";
    if (goal.status === "budget_exhausted") return "budget_exhausted";
    if (goal.status === "paused") return "paused";
    if (goal.status === "completed") return "completed";
    if (goal.status === "failed") return "failed";
    return "active";
  }

  const formatCountdown = formatCountdownUntil;

  function renderGoals(): void {
    const runner = ctx.app.getGoalsRunner?.();
    if (!runner) {
      goalList.innerHTML = "";
      goalEmpty.style.display = "block";
      return;
    }
    const state = runner.getState();
    const panelGoals = state.goals
      .slice()
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

    goalList.innerHTML = "";
    if (panelGoals.length === 0) {
      goalEmpty.style.display = "block";
      return;
    }
    goalEmpty.style.display = "none";

    const now = Date.now();

    for (const goal of panelGoals) {
      const goalStatus = String(goal.status);
      const isExpanded = expandedGoalIds.has(goal.goal_id);

      const card = document.createElement("div");
      card.className = `goal-card ${goalStatus}${isExpanded ? " expanded" : ""}`;

      // Header row: pulse \u00b7 prompt \u00b7 cadence \u00b7 countdown.
      const headerRow = document.createElement("div");
      headerRow.className = "goal-card-row";

      const pulse = document.createElement("span");
      pulse.className = `goal-pulse ${pulseClass(goal, state.runs)}`;
      headerRow.appendChild(pulse);

      const promptText = document.createElement("span");
      promptText.className = "goal-card-prompt";
      promptText.textContent = goal.prompt;
      promptText.title = goal.prompt;
      headerRow.appendChild(promptText);

      const cadence = document.createElement("span");
      cadence.className = "goal-card-cadence";
      cadence.textContent = cadenceLabel(goal);
      headerRow.appendChild(cadence);

      if (goal.mode === "recurring" && typeof goal.next_run_at === "number") {
        const countdown = document.createElement("span");
        countdown.className = "goal-card-countdown";
        if (goal.status === "paused") countdown.textContent = "paused";
        else if (goal.status === "budget_exhausted") countdown.textContent = "over cap";
        else countdown.textContent = formatCountdown(goal.next_run_at, now);
        headerRow.appendChild(countdown);
      }

      card.appendChild(headerRow);

      // Budget envelope \u2014 axis-native unit is the headline ("12k / 50k
      // tokens"); cost translation would land as additive disclosure
      // when computable, never as the headline (per panel-temporal-
      // registers.md \u00a7"Bounded commitment is multi-dimensional").
      const cap = goal.budget_tokens;
      if (cap != null) {
        const spent = goal.spent_tokens ?? 0;
        const ratio = cap > 0 ? Math.min(spent / cap, 1.2) : 1;
        const fillPct = Math.min(ratio * 100, 100);
        const fillClass = ratio >= 1 ? "over" : ratio >= 0.8 ? "near" : "";

        const budget = document.createElement("div");
        budget.className = "goal-card-budget";

        const label = document.createElement("div");
        const exhausted = goal.status === "budget_exhausted";
        label.className = `goal-card-budget-label${exhausted ? " exhausted" : ""}`;
        const headline = document.createElement("span");
        headline.textContent = exhausted
          ? "Token budget exhausted"
          : `${formatTokens(spent)} / ${formatTokens(cap)} tokens`;
        label.appendChild(headline);
        if (!exhausted && cap > 0) {
          const ratioSpan = document.createElement("span");
          ratioSpan.textContent = `${Math.round((spent / cap) * 100)}%`;
          label.appendChild(ratioSpan);
        }
        budget.appendChild(label);

        const bar = document.createElement("div");
        bar.className = "goal-card-budget-bar";
        const fill = document.createElement("div");
        fill.className = `goal-card-budget-fill ${fillClass}`.trim();
        fill.style.width = `${fillPct}%`;
        bar.appendChild(fill);
        budget.appendChild(bar);

        card.appendChild(budget);
      }

      // Expanded detail block \u2014 preview + meta + actions + step trace.
      const expand = document.createElement("div");
      expand.className = "goal-card-expand";
      const expandInner = document.createElement("div");
      expandInner.className = "goal-card-expand-inner";

      if (goal.last_response_preview != null && goal.last_response_preview !== "") {
        const preview = document.createElement("div");
        preview.className = "goal-card-expand-preview";
        preview.textContent = goal.last_response_preview;
        expandInner.appendChild(preview);
      } else if (goal.last_error != null && goal.last_error !== "") {
        const errPreview = document.createElement("div");
        errPreview.className = "goal-card-expand-preview";
        errPreview.style.color = "var(--status-error-fg)";
        errPreview.textContent = `Last error: ${goal.last_error}`;
        expandInner.appendChild(errPreview);
      }

      const meta = document.createElement("div");
      meta.className = "goal-card-expand-meta";
      if (goal.last_run_at != null) {
        const ran = document.createElement("span");
        const seconds = Math.floor((now - goal.last_run_at) / 1000);
        ran.textContent =
          seconds < 60
            ? "ran just now"
            : seconds < 3600
              ? `ran ${Math.floor(seconds / 60)}m ago`
              : seconds < 86400
                ? `ran ${Math.floor(seconds / 3600)}h ago`
                : `ran ${Math.floor(seconds / 86400)}d ago`;
        meta.appendChild(ran);
      }
      if (
        goal.consecutive_failures != null &&
        goal.consecutive_failures > 0 &&
        goal.max_retries != null
      ) {
        const fails = document.createElement("span");
        fails.style.color = "var(--status-warning-fg)";
        fails.textContent = `${goal.consecutive_failures}/${goal.max_retries} failures`;
        meta.appendChild(fails);
      }
      if (meta.children.length > 0) expandInner.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "goal-card-expand-actions";

      if (goal.status === "budget_exhausted" && cap != null) {
        const raiseBtn = document.createElement("button");
        raiseBtn.className = "raise-cap";
        raiseBtn.textContent = `Raise to ${formatTokens(cap * 2)}`;
        raiseBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          runner.setBudgetTokens(goal.goal_id, cap * 2);
        });
        actions.appendChild(raiseBtn);
      }

      if (goal.mode === "once" && (goalStatus === "active" || goalStatus === "paused")) {
        const execBtn = document.createElement("button");
        execBtn.textContent = "Execute";
        execBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          void executeGoal(goal.goal_id);
        });
        actions.appendChild(execBtn);
      }

      if (
        goal.mode === "recurring" &&
        goal.status !== "completed" &&
        goal.status !== "failed" &&
        goal.status !== "budget_exhausted"
      ) {
        const paused = goal.status === "paused";
        const toggleBtn = document.createElement("button");
        toggleBtn.textContent = paused ? "Resume" : "Pause";
        toggleBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          runner.setPaused(goal.goal_id, !paused);
        });
        actions.appendChild(toggleBtn);

        if (!paused) {
          const runBtn = document.createElement("button");
          runBtn.textContent = "Run now";
          runBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            void runner.runNow(goal.goal_id);
          });
          actions.appendChild(runBtn);
        }
      }

      const removeBtn = document.createElement("button");
      removeBtn.className = "remove";
      removeBtn.textContent = "Remove";
      let confirmTimer: ReturnType<typeof setTimeout> | null = null;
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (removeBtn.classList.contains("confirming")) {
          if (confirmTimer != null) clearTimeout(confirmTimer);
          runner.removeGoal(goal.goal_id);
        } else {
          removeBtn.classList.add("confirming");
          removeBtn.textContent = "Confirm";
          confirmTimer = setTimeout(() => {
            removeBtn.classList.remove("confirming");
            removeBtn.textContent = "Remove";
          }, 3000);
        }
      });
      actions.appendChild(removeBtn);

      expandInner.appendChild(actions);

      const stepsEl = document.createElement("div");
      stepsEl.className = "goal-card-steps";
      stepsEl.id = `goal-steps-${goal.goal_id}`;
      expandInner.appendChild(stepsEl);

      expand.appendChild(expandInner);
      card.appendChild(expand);

      card.addEventListener("click", () => {
        if (expandedGoalIds.has(goal.goal_id)) {
          expandedGoalIds.delete(goal.goal_id);
          card.classList.remove("expanded");
        } else {
          expandedGoalIds.add(goal.goal_id);
          card.classList.add("expanded");
        }
      });

      goalList.appendChild(card);
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

    // Auto-expand the card so plan chunks land in a visible container.
    expandedGoalIds.add(goalId);
    renderGoals();

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

  // === Commit-goal modal ===
  // Default selections mirror the chip layout in index.html.
  let commitCadence: "once" | "hourly" | "daily" | "weekly" = "daily";
  // `null` = no cap. `0` from the "No cap" chip also maps to null
  // (the chip's affordance is named for what the user sees, not the
  // numeric value).
  let commitBudgetTokens: number | null = 50_000;

  function selectChip(container: HTMLDivElement, value: string, attr: string): void {
    for (const child of Array.from(container.children)) {
      const btn = child as HTMLElement;
      btn.classList.toggle("selected", btn.getAttribute(attr) === value);
    }
  }

  goalCommitCadenceChips.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const cadence = target.getAttribute("data-cadence");
    if (!cadence) return;
    commitCadence = cadence as typeof commitCadence;
    selectChip(goalCommitCadenceChips, cadence, "data-cadence");
  });

  goalCommitBudgetChips.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const raw = target.getAttribute("data-budget");
    if (raw == null) return;
    const n = Number(raw);
    commitBudgetTokens = n > 0 ? n : null;
    selectChip(goalCommitBudgetChips, raw, "data-budget");
    goalCommitBudgetCustom.value = "";
  });

  goalCommitBudgetCustom.addEventListener("input", () => {
    const raw = goalCommitBudgetCustom.value.trim();
    if (raw === "") return;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      commitBudgetTokens = Math.floor(n);
      for (const child of Array.from(goalCommitBudgetChips.children)) {
        (child as HTMLElement).classList.remove("selected");
      }
    }
  });

  function resetCommitForm(): void {
    goalCommitPrompt.value = "";
    goalCommitBudgetCustom.value = "";
    commitCadence = "daily";
    commitBudgetTokens = 50_000;
    selectChip(goalCommitCadenceChips, "daily", "data-cadence");
    selectChip(goalCommitBudgetChips, "50000", "data-budget");
  }

  goalCommitSubmit.addEventListener("click", () => {
    const runner = ctx.app.getGoalsRunner?.();
    if (!runner) return;
    const prompt = goalCommitPrompt.value.trim();
    if (!prompt) return;
    if (commitCadence === "once") {
      runner.addGoal({ prompt, mode: "once", budget_tokens: commitBudgetTokens });
    } else {
      runner.addGoal({
        prompt,
        mode: "recurring",
        cadence: commitCadence,
        budget_tokens: commitBudgetTokens,
      });
    }
    // Form-always-visible: clear in place after submit; defaults
    // re-seed (Daily cadence, 50k tokens) so consecutive commits
    // require minimum effort. No transition, no dismiss.
    resetCommitForm();
  });

  function openGoals(): void {
    closeAll();
    // Lazy-attach the runner subscription on first open — the runner is
    // constructed during `app.bootstrap()`, which runs AFTER
    // `initGatedPanels`, so an init-time subscription would see null.
    // Also starts a 30s countdown refresh so recurring-goal "in 12m"
    // labels tick down without waiting for a fire event.
    if (!goalsSubscribed) {
      const runner = ctx.app.getGoalsRunner?.();
      if (runner) {
        runner.subscribe(() => renderGoals());
        setInterval(() => {
          if (goalsPanel.classList.contains("open")) renderGoals();
        }, 30_000);
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

  // Render the hardware-attested badge when the relay forwarded a verified
  // claim. Renders nothing when absent — rows without a claim stay
  // visually unchanged. Badge text is verbatim "hardware-attested" to
  // avoid colliding with skills provenance vocabulary (`spec/skills-v1.md`
  // §7.1). Tooltip carries verifier name + score for "why did motebit
  // prefer that peer".
  function appendHardwareBadge(
    meta: HTMLElement,
    attestation: AgentHardwareAttestation | undefined,
  ): void {
    if (attestation == null) return;
    const badge = document.createElement("span");
    badge.className = "agent-ha-badge";
    badge.textContent = "hardware-attested";
    const verifier = formatHardwarePlatform(attestation.platform);
    const exportedSuffix = attestation.key_exported === true ? " · exported" : "";
    badge.title = `${verifier} (score ${attestation.score.toFixed(2)})${exportedSuffix}`;
    meta.appendChild(badge);
  }

  // Render the observed-latency readout for a peer when stats are
  // present. Same self-attesting-system doctrine probe as the HA badge:
  // every routing-input the runtime/relay computes against MUST be
  // visible to the user. Tooltip carries sample count for confidence.
  function appendLatencyReadout(
    meta: HTMLElement,
    latency_stats: AgentLatencyStats | undefined,
  ): void {
    if (latency_stats == null || latency_stats.avg_ms === 0) return;
    const readout = document.createElement("span");
    readout.className = "agent-latency-readout";
    readout.textContent = formatLatency(latency_stats);
    readout.title = `${latency_stats.sample_count} sample${latency_stats.sample_count === 1 ? "" : "s"}`;
    meta.appendChild(readout);
  }

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
      // sov-list-card carries glass material + lift; agent-item is
      // preserved for trust-badge / hardware-attestation selector hooks.
      item.className = "sov-list-card agent-item";

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

      appendHardwareBadge(meta, agent.hardware_attestation);
      appendLatencyReadout(meta, agent.latency_stats);

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
      discoverEmpty.textContent = "Connect to a relay in Settings to discover agents";
      discoverEmpty.style.display = "block";
      return;
    }

    if (state.discovered.length === 0) {
      discoverList.innerHTML = "";
      discoverEmpty.textContent =
        state.error != null
          ? "Couldn't reach the relay"
          : "Agents appear here as the network grows";
      discoverEmpty.style.display = "block";
      return;
    }

    discoverEmpty.style.display = "none";
    discoverList.innerHTML = "";

    for (const agent of state.discovered) {
      const item = document.createElement("div");
      // sov-list-card carries glass material + lift; agent-item is
      // preserved for trust-badge / hardware-attestation selector hooks.
      item.className = "sov-list-card agent-item";

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
      appendHardwareBadge(meta, agent.hardware_attestation);
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
      appendLatencyReadout(meta, agent.latency_stats);
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
