import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";
import type { GoalPlanProgressEvent, GoalCompleteEvent } from "../index";
import { parseJsonSafe, classifyDecision, ipcString } from "./audit-utils";
import { addMessage } from "./chat";
import {
  createGoalsController,
  formatCountdownUntil,
  type GoalsFetchAdapter,
  type GoalsState,
  type ScheduledGoal,
} from "@motebit/panels";

// === DOM Refs ===

const goalsPanel = document.getElementById("goals-panel") as HTMLDivElement;
const goalsBackdrop = document.getElementById("goals-backdrop") as HTMLDivElement;
const goalList = document.getElementById("goal-list") as HTMLDivElement;
const goalProgressContainer = document.getElementById("goal-progress-container") as HTMLDivElement;
const goalRecentHeader = document.getElementById("goal-recent-header") as HTMLDivElement;
const goalRecentList = document.getElementById("goal-recent-list") as HTMLDivElement;
const goalsBtn = document.getElementById("goals-btn") as HTMLButtonElement;
const planHistoryHeader = document.getElementById("plan-history-header") as HTMLDivElement;
const planHistoryList = document.getElementById("plan-history-list") as HTMLDivElement;

// === Goals Panel ===

export interface GoalsAPI {
  open(): void;
  close(): void;
  onPlanProgress(event: GoalPlanProgressEvent): void;
  onGoalComplete(event: GoalCompleteEvent): void;
  onGoalExecuting(executing: boolean): void;
}

function formatInterval(ms: number): string {
  if (ms >= 86400000) return `${Math.round(ms / 86400000)}d`;
  if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`;
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function initGoals(ctx: DesktopContext): GoalsAPI {
  // Track active progress card state
  let progressCard: HTMLDivElement | null = null;
  let progressDots: HTMLSpanElement[] = [];
  let progressStepEl: HTMLDivElement | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;

  // Scheduled-goal state (list + CRUD) lives in @motebit/panels so desktop
  // and mobile share the state shape. The adapter wraps Tauri IPC; Rust's
  // goals_toggle ignores the explicit target state (it flips based on
  // current). A future Rust-side change can honor the argument — the
  // controller's contract is already in the right shape.
  const goalsAdapter: GoalsFetchAdapter = {
    listGoals: async () => {
      const config = ctx.getConfig();
      if (config?.isTauri !== true || config.invoke == null) return [];
      const motebitId = ctx.app.motebitId;
      if (!motebitId) return [];
      const rows = await config.invoke<Array<Record<string, unknown>>>("goals_list", { motebitId });
      return rows.map((g): ScheduledGoal => {
        const intervalMs = Number(g.interval_ms) || 0;
        const mode = (ipcString(g.mode, "recurring") as "recurring" | "once") ?? "recurring";
        const createdAt = Number(g.created_at) || 0;
        const lastRunAt = g.last_run_at == null ? null : Number(g.last_run_at);
        // next_run_at derivation: recurring goals fire at (last_run_at ?? created_at)
        // + interval_ms. Once goals have no next run. Single source of truth for the
        // formula — same arithmetic the tick loop uses.
        const nextRunAt =
          mode === "recurring" && intervalMs > 0
            ? (lastRunAt ?? createdAt) + intervalMs
            : undefined;
        return {
          goal_id: String(g.goal_id),
          prompt: ipcString(g.prompt),
          interval_ms: intervalMs,
          mode,
          status: ipcString(g.status, "active"),
          last_run_at: lastRunAt,
          ...(nextRunAt !== undefined ? { next_run_at: nextRunAt } : {}),
          created_at: createdAt,
        };
      });
    },
    addGoal: async (input) => {
      const config = ctx.getConfig();
      if (config?.isTauri !== true || config.invoke == null) return;
      const motebitId = ctx.app.motebitId;
      if (!motebitId) return;
      const goalId = crypto.randomUUID();
      await config.invoke("goals_create", {
        motebitId,
        goalId,
        prompt: input.prompt,
        intervalMs: input.interval_ms,
        mode: input.mode,
      });
    },
    setEnabled: async (goalId, _enabled) => {
      const config = ctx.getConfig();
      if (config?.isTauri !== true || config.invoke == null) return;
      // Rust's goals_toggle is stateless (flips current). A future change
      // can accept the explicit target; until then the controller's
      // `enabled` argument is informational and refresh reconciles.
      await config.invoke("goals_toggle", { goalId });
    },
    removeGoal: async (goalId) => {
      const config = ctx.getConfig();
      if (config?.isTauri !== true || config.invoke == null) return;
      await config.invoke("goals_delete", { goalId });
    },
    runNow: async (goalId) => {
      const config = ctx.getConfig();
      if (config?.isTauri !== true || config.invoke == null) return;
      await ctx.app.runGoalNow(config.invoke, goalId);
    },
  };

  const goalsCtrl = createGoalsController(goalsAdapter);
  goalsCtrl.subscribe((state) => {
    renderGoalList(state);
  });

  // Countdown labels on recurring rows drift every second but only need
  // minute-granularity updates to stay honest. A 30s re-render while the
  // panel is open is the same cadence web uses — tight enough that the
  // "in 5m" → "in 4m" transition never surprises, cheap enough that a
  // ≤10-row rebuild is invisible.
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  function open(): void {
    goalsPanel.classList.add("open");
    goalsBackdrop.classList.add("open");
    void goalsCtrl.refresh();
    loadRecentOutcomes();
    loadPlanHistory();
    if (countdownTimer == null) {
      countdownTimer = setInterval(() => {
        renderGoalList(goalsCtrl.getState());
      }, 30_000);
    }
  }

  function close(): void {
    goalsPanel.classList.remove("open");
    goalsBackdrop.classList.remove("open");
    if (countdownTimer != null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  // === Plan Execution Progress ===

  function onGoalExecuting(executing: boolean): void {
    goalsBtn.classList.toggle("executing", executing);
    if (!executing) {
      removeProgressCard();
    }
  }

  function onPlanProgress(event: GoalPlanProgressEvent): void {
    if (event.type === "plan_created") {
      createProgressCard(event.planTitle, event.totalSteps);
    } else if (event.type === "step_started") {
      updateStepDot(event.stepIndex - 1, "running");
      updateStepText(event.stepIndex, event.totalSteps, event.stepDescription);
    } else if (event.type === "step_completed") {
      updateStepDot(event.stepIndex - 1, "completed");
      flashDot(event.stepIndex - 1, "completed");
      updateStepText(event.stepIndex, event.totalSteps, "Done");
    } else if (event.type === "step_failed") {
      updateStepDot(event.stepIndex - 1, "failed");
      flashDot(event.stepIndex - 1, "failed");
      updateStepText(event.stepIndex, event.totalSteps, "Failed");
    }
  }

  function onGoalComplete(event: GoalCompleteEvent): void {
    // Show brief completion summary on the progress card before fading
    if (progressCard && progressStepEl) {
      const statusLabel = event.status === "completed" ? "Completed" : "Failed";
      const summary =
        event.summary != null && event.summary !== "" ? `: ${event.summary.slice(0, 80)}` : "";
      progressStepEl.textContent = `${statusLabel}${summary}`;
      progressStepEl.style.color =
        event.status === "completed" ? "rgba(34, 197, 94, 0.8)" : "rgba(248, 113, 113, 0.8)";
    }

    // Fade the card after a short delay
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      removeProgressCard();
      fadeTimer = null;
    }, 3000);

    // Refresh goal list (status may have changed) plus desktop-specific views
    void goalsCtrl.refresh();
    loadRecentOutcomes();
    loadPlanHistory();
  }

  function createProgressCard(planTitle: string, totalSteps: number): void {
    // Remove any existing card
    if (progressCard) {
      progressCard.remove();
    }
    if (fadeTimer) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }

    progressDots = [];

    const card = document.createElement("div");
    card.className = "goal-progress-card";

    const title = document.createElement("div");
    title.className = "goal-progress-title";
    title.textContent = planTitle;
    card.appendChild(title);

    const dotsRow = document.createElement("div");
    dotsRow.className = "goal-progress-dots";
    for (let i = 0; i < totalSteps; i++) {
      const dot = document.createElement("span");
      dot.className = "goal-step-dot";
      dotsRow.appendChild(dot);
      progressDots.push(dot);
    }
    card.appendChild(dotsRow);

    const stepText = document.createElement("div");
    stepText.className = "goal-progress-step";
    stepText.innerHTML = '<span class="step-index">0/' + totalSteps + "</span>Starting...";
    card.appendChild(stepText);

    goalProgressContainer.innerHTML = "";
    goalProgressContainer.appendChild(card);
    progressCard = card;
    progressStepEl = stepText;
  }

  function updateStepDot(index: number, status: "running" | "completed" | "failed"): void {
    if (index < 0 || index >= progressDots.length) return;
    const dot = progressDots[index]!;
    dot.classList.remove("running", "completed", "failed");
    dot.classList.add(status);
  }

  function flashDot(index: number, _status: "completed" | "failed"): void {
    if (index < 0 || index >= progressDots.length) return;
    const dot = progressDots[index]!;
    dot.classList.add("flash");
    setTimeout(() => dot.classList.remove("flash"), 600);
  }

  function updateStepText(stepIndex: number, totalSteps: number, description: string): void {
    if (!progressStepEl) return;
    progressStepEl.style.color = "";
    progressStepEl.innerHTML = `<span class="step-index">${stepIndex}/${totalSteps}</span>${escapeHtml(description)}`;
  }

  function removeProgressCard(): void {
    if (!progressCard) return;
    progressCard.classList.add("fading");
    setTimeout(() => {
      progressCard?.remove();
      progressCard = null;
      progressDots = [];
      progressStepEl = null;
    }, 400);
  }

  // === Audit Entries for Outcomes ===

  function loadOutcomeAuditEntries(
    outcomeId: string,
    ranAt: number,
    allOutcomes: Array<Record<string, unknown>>,
    currentIndex: number,
    container: HTMLDivElement,
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
  ): void {
    container.innerHTML = "";

    // Helper: timestamp-range fallback for legacy rows without run_id
    const loadFallback = (): void => {
      const startTs = ranAt - 5000;
      const endTs =
        currentIndex > 0 ? Number(allOutcomes[currentIndex - 1]!.ran_at) || Date.now() : Date.now();

      void invoke<Array<Record<string, unknown>>>("db_query", {
        sql: `SELECT tool, decision, result, timestamp FROM tool_audit_log WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC LIMIT 50`,
        params: [startTs, endTs],
      })
        .then((fallbackEntries: Array<Record<string, unknown>>) => {
          renderAuditEntries(fallbackEntries, container, true);
        })
        .catch(() => {
          container.innerHTML =
            '<span style="font-size:10px;color:var(--text-ghost)">Failed to load</span>';
        });
    };

    // Skip run_id query if outcomeId is empty (legacy row)
    if (!outcomeId || !outcomeId.trim()) {
      loadFallback();
      return;
    }

    // Primary: query by run_id (= outcome_id). Falls back to timestamp range for pre-migration data.
    void invoke<Array<Record<string, unknown>>>("db_query", {
      sql: `SELECT tool, decision, result, timestamp FROM tool_audit_log WHERE run_id = ? ORDER BY timestamp ASC LIMIT 50`,
      params: [outcomeId],
    })
      .then((entries: Array<Record<string, unknown>>) => {
        if (entries.length > 0) {
          renderAuditEntries(entries, container, false);
          return;
        }
        loadFallback();
      })
      .catch(() => {
        container.innerHTML =
          '<span style="font-size:10px;color:var(--text-ghost)">Failed to load</span>';
      });
  }

  function renderAuditEntries(
    entries: Array<Record<string, unknown>>,
    container: HTMLDivElement,
    isTimeFallback: boolean,
  ): void {
    container.innerHTML = "";
    if (entries.length === 0) {
      container.innerHTML =
        '<span style="font-size:10px;color:var(--text-ghost)">No tool details</span>';
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "audit-inline-row";

      const toolSpan = document.createElement("span");
      toolSpan.className = "audit-inline-tool";
      toolSpan.textContent = ipcString(entry.tool, "unknown");
      row.appendChild(toolSpan);

      const badgeClass = classifyDecision(entry.decision);

      const badge = document.createElement("span");
      badge.className = `audit-inline-badge ${badgeClass}`;
      badge.textContent = badgeClass;
      row.appendChild(badge);

      const resultData = parseJsonSafe(entry.result) as Record<string, unknown> | null;
      if (resultData != null && typeof resultData === "object" && resultData.durationMs != null) {
        const durSpan = document.createElement("span");
        durSpan.className = "audit-inline-duration";
        durSpan.textContent = `${ipcString(resultData.durationMs)}ms`;
        row.appendChild(durSpan);
      }

      container.appendChild(row);
    }
    if (isTimeFallback) {
      const hint = document.createElement("div");
      hint.style.cssText = "font-size:9px;color:var(--text-ghost);margin-top:2px;";
      hint.textContent = "correlated by time";
      container.appendChild(hint);
    }
  }

  // === Goal List ===

  function renderGoalList(state: GoalsState): void {
    goalList.innerHTML = "";

    if (state.error != null && state.goals.length === 0) {
      goalList.innerHTML = '<div class="goal-empty">Failed to load goals</div>';
      return;
    }

    if (state.goals.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goal-empty";
      empty.textContent = "No goals yet";
      goalList.appendChild(empty);
      return;
    }

    const config = ctx.getConfig();
    const invoke = config?.invoke;

    for (const goal of state.goals) {
      const item = document.createElement("div");
      item.className = "goal-item";

      const promptDiv = document.createElement("div");
      promptDiv.className = "goal-item-prompt";
      const promptText = goal.prompt;
      promptDiv.textContent = promptText.length > 60 ? promptText.slice(0, 60) + "..." : promptText;
      promptDiv.title = promptText;
      item.appendChild(promptDiv);

      const metaDiv = document.createElement("div");
      metaDiv.className = "goal-item-meta";

      const statusDot = document.createElement("span");
      const status = String(goal.status);
      statusDot.className = `goal-status-dot ${status}`;
      metaDiv.appendChild(statusDot);

      const statusText = document.createElement("span");
      statusText.textContent = status;
      metaDiv.appendChild(statusText);

      const intervalSpan = document.createElement("span");
      intervalSpan.textContent = formatInterval(goal.interval_ms);
      metaDiv.appendChild(intervalSpan);

      const modeSpan = document.createElement("span");
      modeSpan.textContent = goal.mode;
      metaDiv.appendChild(modeSpan);

      // Countdown label — recurring + active rows only. Paused rows
      // show "paused" in place of the countdown (matching web's
      // gated-panels.ts treatment). Once rows have no next run so the
      // label is omitted. Refreshes every 30s via countdownTimer.
      if (goal.mode === "recurring" && status !== "completed" && status !== "failed") {
        const countdownSpan = document.createElement("span");
        countdownSpan.className = "goal-countdown";
        if (status === "paused") {
          countdownSpan.textContent = "paused";
        } else if (typeof goal.next_run_at === "number") {
          countdownSpan.textContent = formatCountdownUntil(goal.next_run_at, Date.now());
        }
        if (countdownSpan.textContent !== "") {
          metaDiv.appendChild(countdownSpan);
        }
      }

      item.appendChild(metaDiv);

      const actions = document.createElement("div");
      actions.className = "goal-item-actions";

      const goalId = goal.goal_id;

      if (status === "active" || status === "paused") {
        const toggleBtn = document.createElement("button");
        toggleBtn.textContent = status === "active" ? "Pause" : "Resume";
        toggleBtn.addEventListener("click", () => {
          void goalsCtrl.setEnabled(goalId, status !== "active").then(() => goalsCtrl.refresh());
        });
        actions.appendChild(toggleBtn);
      }

      // Run-now button — recurring + active rows only, and only when
      // the controller actually exposes runNow (desktop does; surfaces
      // without a daemon-side fire path won't). Clicking fires the goal
      // immediately through executeGoalOnce; next_run_at shifts on the
      // adapter's post-run refresh.
      if (goal.mode === "recurring" && status === "active" && goalsCtrl.runNow) {
        const runNowFn = goalsCtrl.runNow;
        const runNowBtn = document.createElement("button");
        runNowBtn.textContent = "Run now";
        runNowBtn.addEventListener("click", () => {
          void runNowFn(goalId);
        });
        actions.appendChild(runNowBtn);
      }

      const historyBtn = document.createElement("button");
      historyBtn.className = "goal-toggle-outcomes";
      historyBtn.textContent = "History";
      actions.appendChild(historyBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "goal-delete-btn";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => {
        void goalsCtrl.removeGoal(goalId);
      });
      actions.appendChild(deleteBtn);

      item.appendChild(actions);

      const outcomesDiv = document.createElement("div");
      outcomesDiv.className = "goal-outcomes";
      item.appendChild(outcomesDiv);

      if (invoke != null) {
        historyBtn.addEventListener("click", () => {
          const isOpen = outcomesDiv.classList.contains("open");
          if (isOpen) {
            outcomesDiv.classList.remove("open");
          } else {
            outcomesDiv.classList.add("open");
            loadGoalOutcomes(goalId, outcomesDiv);
          }
        });
      }

      goalList.appendChild(item);
    }
  }

  function loadGoalOutcomes(goalId: string, container: HTMLDivElement): void {
    const config = ctx.getConfig();
    if (config?.isTauri !== true || config.invoke == null) return;
    const invoke = config.invoke;

    container.innerHTML = "";
    void invoke<Array<Record<string, unknown>>>("goals_outcomes", { goalId, limit: 5 })
      .then((outcomes) => {
        container.innerHTML = "";
        if (outcomes.length === 0) {
          container.innerHTML =
            '<div style="font-size:11px;color:rgba(0,0,0,0.3);padding:2px 0;">No runs yet</div>';
          return;
        }
        for (const outcome of outcomes) {
          const row = document.createElement("div");
          row.className = "goal-outcome-row";

          const dot = document.createElement("span");
          const oStatus = ipcString(outcome.status);
          dot.className = `goal-status-dot ${oStatus === "completed" ? "active" : "suspended"}`;
          row.appendChild(dot);

          const summary = document.createElement("span");
          summary.className = "goal-outcome-summary";
          if (oStatus === "completed" && outcome.summary != null) {
            summary.textContent = ipcString(outcome.summary);
          } else if (outcome.error_message != null) {
            summary.textContent = ipcString(outcome.error_message);
            summary.style.color = "rgba(248,113,113,0.8)";
          } else {
            summary.textContent = oStatus;
          }
          row.appendChild(summary);

          const time = document.createElement("span");
          time.className = "goal-outcome-time";
          time.textContent = formatTimeAgo(Number(outcome.ran_at) || 0);
          row.appendChild(time);

          container.appendChild(row);
        }
      })
      .catch(() => {
        container.innerHTML =
          '<div style="font-size:11px;color:rgba(0,0,0,0.3);">Failed to load</div>';
      });
  }

  // === Recent Outcomes (cross-goal) ===

  function loadRecentOutcomes(): void {
    const config = ctx.getConfig();
    if (config?.isTauri !== true || config.invoke == null) return;
    const motebitId = ctx.app.motebitId;
    if (!motebitId) return;
    const invoke = config.invoke;

    void invoke<Array<Record<string, unknown>>>("db_query", {
      sql: `SELECT o.outcome_id, o.goal_id, o.ran_at, o.status, o.summary, o.error_message, o.tool_calls_made, g.prompt
            FROM goal_outcomes o
            LEFT JOIN goals g ON o.goal_id = g.goal_id
            WHERE o.motebit_id = ?
            ORDER BY o.ran_at DESC
            LIMIT 15`,
      params: [motebitId],
    })
      .then((outcomes: Array<Record<string, unknown>>) => {
        goalRecentList.innerHTML = "";
        if (outcomes.length === 0) {
          goalRecentHeader.style.display = "none";
          return;
        }
        goalRecentHeader.style.display = "flex";

        for (let i = 0; i < outcomes.length; i++) {
          const outcome = outcomes[i]!;
          const row = document.createElement("div");
          row.className = "goal-recent-row";

          const header = document.createElement("div");
          header.className = "goal-recent-row-header";

          const statusBadge = document.createElement("span");
          const oStatus = ipcString(outcome.status);
          statusBadge.className = `goal-recent-status ${oStatus}`;
          statusBadge.textContent = oStatus;
          header.appendChild(statusBadge);

          const prompt = document.createElement("span");
          prompt.className = "goal-recent-prompt";
          const promptText = ipcString(outcome.prompt);
          prompt.textContent =
            promptText.length > 40 ? promptText.slice(0, 40) + "..." : promptText;
          prompt.title = promptText;
          header.appendChild(prompt);

          const time = document.createElement("span");
          time.className = "goal-recent-time";
          time.textContent = formatTimeAgo(Number(outcome.ran_at) || 0);
          header.appendChild(time);

          row.appendChild(header);

          // Expandable detail
          const detail = document.createElement("div");
          detail.className = "goal-recent-detail";

          const summaryDiv = document.createElement("div");
          if (oStatus === "completed" && outcome.summary != null) {
            summaryDiv.className = "goal-recent-summary";
            summaryDiv.textContent = ipcString(outcome.summary);
          } else if (outcome.error_message != null) {
            summaryDiv.className = "goal-recent-summary error";
            summaryDiv.textContent = ipcString(outcome.error_message);
          }
          if (summaryDiv.textContent) {
            detail.appendChild(summaryDiv);
          }

          const meta = document.createElement("div");
          meta.className = "goal-recent-meta";
          const toolCalls = Number(outcome.tool_calls_made) || 0;
          if (toolCalls > 0) {
            const toolSpan = document.createElement("span");
            toolSpan.textContent = `${toolCalls} tool call${toolCalls !== 1 ? "s" : ""}`;
            meta.appendChild(toolSpan);
          }
          if (meta.children.length > 0) {
            detail.appendChild(meta);
          }

          // Audit inline container for tool call details
          const auditContainer = document.createElement("div");
          auditContainer.className = "audit-inline-list";
          if (toolCalls > 0) {
            detail.appendChild(auditContainer);
          }

          row.appendChild(detail);

          // Toggle expand with lazy audit loading
          let auditLoaded = false;
          const outcomeIndex = i;
          row.addEventListener("click", () => {
            row.classList.toggle("expanded");
            if (row.classList.contains("expanded") && toolCalls > 0 && !auditLoaded) {
              auditLoaded = true;
              const oId = ipcString(outcome.outcome_id);
              const ranAt = Number(outcome.ran_at) || 0;
              loadOutcomeAuditEntries(oId, ranAt, outcomes, outcomeIndex, auditContainer, invoke);
            }
          });

          goalRecentList.appendChild(row);
        }
      })
      .catch(() => {
        goalRecentHeader.style.display = "none";
        goalRecentList.innerHTML = "";
      });
  }

  // === Plan History ===

  let planHistoryOpen = false;

  function loadPlanHistory(): void {
    const config = ctx.getConfig();
    if (config?.isTauri !== true || config.invoke == null) return;
    const motebitId = ctx.app.motebitId;
    if (!motebitId) return;
    const invoke = config.invoke;

    void invoke<Array<Record<string, unknown>>>("db_query", {
      sql: `SELECT * FROM plans WHERE motebit_id = ? ORDER BY created_at DESC LIMIT 10`,
      params: [motebitId],
    })
      .then((plans: Array<Record<string, unknown>>) => {
        if (plans.length === 0) {
          planHistoryHeader.style.display = "none";
          planHistoryList.innerHTML = "";
          planHistoryList.classList.remove("open");
          return;
        }
        planHistoryHeader.style.display = "flex";
        renderPlanList(plans, invoke);
      })
      .catch(() => {
        planHistoryHeader.style.display = "none";
        planHistoryList.innerHTML = "";
      });
  }

  function renderPlanList(
    plans: Array<Record<string, unknown>>,
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
  ): void {
    planHistoryList.innerHTML = "";

    for (const plan of plans) {
      const entry = document.createElement("div");
      entry.className = "plan-entry";

      const header = document.createElement("div");
      header.className = "plan-entry-header";

      // Status badge
      const badge = document.createElement("span");
      const status = ipcString(plan.status, "active");
      badge.className = `plan-status-badge ${status}`;
      badge.textContent = status;
      header.appendChild(badge);

      // Title
      const title = document.createElement("span");
      title.className = "plan-entry-title";
      const titleText = ipcString(plan.title, "Untitled plan");
      title.textContent = titleText.length > 30 ? titleText.slice(0, 30) + "..." : titleText;
      title.title = titleText;
      header.appendChild(title);

      // Step count
      const stepsSpan = document.createElement("span");
      stepsSpan.className = "plan-entry-steps";
      const currentStep = Number(plan.current_step_index) || 0;
      const totalSteps = Number(plan.total_steps) || 0;
      stepsSpan.textContent = `${currentStep}/${totalSteps}`;
      header.appendChild(stepsSpan);

      // Time
      const time = document.createElement("span");
      time.className = "plan-entry-time";
      time.textContent = formatTimeAgo(Number(plan.created_at) || 0);
      header.appendChild(time);

      // Expand indicator
      const expand = document.createElement("span");
      expand.className = "plan-entry-expand";
      expand.textContent = "\u25BC";
      header.appendChild(expand);

      entry.appendChild(header);

      // Expandable steps detail container
      const stepsDetail = document.createElement("div");
      stepsDetail.className = "plan-steps-detail";
      entry.appendChild(stepsDetail);

      // Toggle expand
      let stepsLoaded = false;
      header.addEventListener("click", () => {
        const isExpanded = entry.classList.contains("expanded");
        if (isExpanded) {
          entry.classList.remove("expanded");
        } else {
          entry.classList.add("expanded");
          if (!stepsLoaded) {
            stepsLoaded = true;
            loadPlanSteps(String(plan.plan_id), stepsDetail, invoke);
          }
        }
      });

      planHistoryList.appendChild(entry);
    }

    // Update open state
    if (planHistoryOpen) {
      planHistoryList.classList.add("open");
    }
  }

  function loadPlanSteps(
    planId: string,
    container: HTMLDivElement,
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
  ): void {
    container.innerHTML = "";

    void invoke<Array<Record<string, unknown>>>("db_query", {
      sql: `SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY ordinal ASC`,
      params: [planId],
    })
      .then((steps: Array<Record<string, unknown>>) => {
        container.innerHTML = "";
        if (steps.length === 0) {
          container.innerHTML = '<div class="plan-history-empty">No steps</div>';
          return;
        }

        for (const step of steps) {
          const row = document.createElement("div");
          row.className = "plan-step-row";

          // Status dot
          const dot = document.createElement("span");
          const stepStatus = ipcString(step.status, "pending");
          dot.className = `plan-step-dot ${stepStatus}`;
          row.appendChild(dot);

          // Content column
          const content = document.createElement("div");
          content.className = "plan-step-content";

          // Description
          const desc = document.createElement("div");
          desc.className = "plan-step-desc";
          const ordinal = Number(step.ordinal) + 1;
          desc.textContent = `${ordinal}. ${ipcString(step.description)}`;
          content.appendChild(desc);

          // Meta (duration, tool calls, retries)
          const meta = document.createElement("div");
          meta.className = "plan-step-meta";

          const startedAt = step.started_at != null ? Number(step.started_at) : null;
          const completedAt = step.completed_at != null ? Number(step.completed_at) : null;
          if (startedAt != null) {
            const duration = formatStepDuration(startedAt, completedAt);
            if (duration) {
              const durationSpan = document.createElement("span");
              durationSpan.textContent = duration;
              meta.appendChild(durationSpan);
            }
          }

          const toolCalls = Number(step.tool_calls_made) || 0;
          if (toolCalls > 0) {
            const toolSpan = document.createElement("span");
            toolSpan.textContent = `${toolCalls} tool${toolCalls !== 1 ? "s" : ""}`;
            meta.appendChild(toolSpan);
          }

          const retries = Number(step.retry_count) || 0;
          if (retries > 0) {
            const retrySpan = document.createElement("span");
            retrySpan.textContent = `${retries} retr${retries !== 1 ? "ies" : "y"}`;
            meta.appendChild(retrySpan);
          }

          if (meta.children.length > 0) {
            content.appendChild(meta);
          }

          // Result summary (truncated, expandable)
          if (step.result_summary != null) {
            const result = document.createElement("div");
            result.className = "plan-step-result";
            result.textContent = ipcString(step.result_summary);
            result.addEventListener("click", (e) => {
              e.stopPropagation();
              result.classList.toggle("expanded-text");
            });
            content.appendChild(result);
          }

          // Error message
          if (step.error_message != null) {
            const error = document.createElement("div");
            error.className = "plan-step-error";
            error.textContent = ipcString(step.error_message);
            content.appendChild(error);
          }

          row.appendChild(content);
          container.appendChild(row);
        }
      })
      .catch(() => {
        container.innerHTML = '<div class="plan-history-empty">Failed to load steps</div>';
      });
  }

  function formatStepDuration(startedAt: number, completedAt: number | null): string {
    const end = completedAt ?? Date.now();
    const ms = end - startedAt;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
  }

  // Plan history toggle
  planHistoryHeader.addEventListener("click", () => {
    planHistoryOpen = !planHistoryOpen;
    planHistoryHeader.classList.toggle("open", planHistoryOpen);
    planHistoryList.classList.toggle("open", planHistoryOpen);
  });

  // === Goal CRUD ===
  // Add-form wiring only — CRUD state lives in goalsCtrl.

  async function createGoal(): Promise<void> {
    const promptEl = document.getElementById("goal-prompt") as HTMLTextAreaElement;
    const intervalEl = document.getElementById("goal-interval") as HTMLSelectElement;
    const modeEl = document.getElementById("goal-mode") as HTMLSelectElement;

    const prompt = promptEl.value.trim();
    if (!prompt) return;

    const intervalMs = parseInt(intervalEl.value, 10);
    const mode = (modeEl.value as "recurring" | "once") ?? "recurring";

    const before = goalsCtrl.getState().error;
    await goalsCtrl.addGoal({ prompt, interval_ms: intervalMs, mode });
    const s = goalsCtrl.getState();
    if (s.error && s.error !== before) {
      addMessage("system", `Failed to create goal: ${s.error}`);
      return;
    }
    promptEl.value = "";
  }

  // Event listeners
  document.getElementById("goals-btn")!.addEventListener("click", open);
  document.getElementById("goals-close-btn")!.addEventListener("click", close);
  goalsBackdrop.addEventListener("click", close);
  document.getElementById("goal-create-btn")!.addEventListener("click", () => {
    void createGoal();
  });

  return { open, close, onPlanProgress, onGoalComplete, onGoalExecuting };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
