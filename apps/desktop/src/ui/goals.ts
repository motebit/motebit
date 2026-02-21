import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";
import { addMessage } from "./chat";

// === DOM Refs ===

const goalsPanel = document.getElementById("goals-panel") as HTMLDivElement;
const goalsBackdrop = document.getElementById("goals-backdrop") as HTMLDivElement;
const goalList = document.getElementById("goal-list") as HTMLDivElement;

// === Goals Panel ===

export interface GoalsAPI {
  open(): void;
  close(): void;
}

function formatInterval(ms: number): string {
  if (ms >= 86400000) return `${Math.round(ms / 86400000)}d`;
  if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`;
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function initGoals(ctx: DesktopContext): GoalsAPI {
  function open(): void {
    goalsPanel.classList.add("open");
    goalsBackdrop.classList.add("open");
    refreshGoalList();
  }

  function close(): void {
    goalsPanel.classList.remove("open");
    goalsBackdrop.classList.remove("open");
  }

  function refreshGoalList(): void {
    const config = ctx.getConfig();
    if (!config?.isTauri || !config?.invoke) return;
    const motebitId = ctx.app.motebitId;
    if (!motebitId) return;
    const invoke = config.invoke;

    goalList.innerHTML = "";
    void invoke<Array<Record<string, unknown>>>("goals_list", { motebitId }).then(goals => {
      if (goals.length === 0) {
        const empty = document.createElement("div");
        empty.className = "goal-empty";
        empty.textContent = "No goals yet";
        goalList.appendChild(empty);
        return;
      }

      for (const goal of goals) {
        const item = document.createElement("div");
        item.className = "goal-item";

        const promptDiv = document.createElement("div");
        promptDiv.className = "goal-item-prompt";
        const promptText = String(goal.prompt || "");
        promptDiv.textContent = promptText.length > 60 ? promptText.slice(0, 60) + "..." : promptText;
        promptDiv.title = promptText;
        item.appendChild(promptDiv);

        const metaDiv = document.createElement("div");
        metaDiv.className = "goal-item-meta";

        const statusDot = document.createElement("span");
        const status = String(goal.status || "active");
        statusDot.className = `goal-status-dot ${status}`;
        metaDiv.appendChild(statusDot);

        const statusText = document.createElement("span");
        statusText.textContent = status;
        metaDiv.appendChild(statusText);

        const intervalSpan = document.createElement("span");
        intervalSpan.textContent = formatInterval(Number(goal.interval_ms) || 0);
        metaDiv.appendChild(intervalSpan);

        const modeSpan = document.createElement("span");
        modeSpan.textContent = String(goal.mode || "recurring");
        metaDiv.appendChild(modeSpan);

        item.appendChild(metaDiv);

        const actions = document.createElement("div");
        actions.className = "goal-item-actions";

        const goalId = String(goal.goal_id);

        if (status === "active" || status === "paused") {
          const toggleBtn = document.createElement("button");
          toggleBtn.textContent = status === "active" ? "Pause" : "Resume";
          toggleBtn.addEventListener("click", () => {
            void toggleGoal(goalId);
          });
          actions.appendChild(toggleBtn);
        }

        const historyBtn = document.createElement("button");
        historyBtn.className = "goal-toggle-outcomes";
        historyBtn.textContent = "History";
        actions.appendChild(historyBtn);

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "goal-delete-btn";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", () => {
          void deleteGoal(goalId);
        });
        actions.appendChild(deleteBtn);

        item.appendChild(actions);

        const outcomesDiv = document.createElement("div");
        outcomesDiv.className = "goal-outcomes";
        item.appendChild(outcomesDiv);

        historyBtn.addEventListener("click", () => {
          const isOpen = outcomesDiv.classList.contains("open");
          if (isOpen) {
            outcomesDiv.classList.remove("open");
          } else {
            outcomesDiv.classList.add("open");
            loadGoalOutcomes(goalId, outcomesDiv);
          }
        });

        goalList.appendChild(item);
      }
    }).catch(() => {
      goalList.innerHTML = '<div class="goal-empty">Failed to load goals</div>';
    });
  }

  function loadGoalOutcomes(goalId: string, container: HTMLDivElement): void {
    const config = ctx.getConfig();
    if (!config?.isTauri || !config?.invoke) return;
    const invoke = config.invoke;

    container.innerHTML = '<div style="font-size:11px;color:rgba(0,0,0,0.3);padding:2px 0;">Loading...</div>';
    void invoke<Array<Record<string, unknown>>>("goals_outcomes", { goalId, limit: 5 }).then(outcomes => {
      container.innerHTML = "";
      if (outcomes.length === 0) {
        container.innerHTML = '<div style="font-size:11px;color:rgba(0,0,0,0.3);padding:2px 0;">No runs yet</div>';
        return;
      }
      for (const outcome of outcomes) {
        const row = document.createElement("div");
        row.className = "goal-outcome-row";

        const dot = document.createElement("span");
        const oStatus = String(outcome.status || "");
        dot.className = `goal-status-dot ${oStatus === "completed" ? "active" : "suspended"}`;
        row.appendChild(dot);

        const summary = document.createElement("span");
        summary.className = "goal-outcome-summary";
        if (oStatus === "completed" && outcome.summary) {
          summary.textContent = String(outcome.summary);
        } else if (outcome.error_message) {
          summary.textContent = String(outcome.error_message);
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
    }).catch(() => {
      container.innerHTML = '<div style="font-size:11px;color:rgba(0,0,0,0.3);">Failed to load</div>';
    });
  }

  async function createGoal(): Promise<void> {
    const config = ctx.getConfig();
    if (!config?.isTauri || !config?.invoke) return;
    const motebitId = ctx.app.motebitId;
    if (!motebitId) return;

    const promptEl = document.getElementById("goal-prompt") as HTMLTextAreaElement;
    const intervalEl = document.getElementById("goal-interval") as HTMLSelectElement;
    const modeEl = document.getElementById("goal-mode") as HTMLSelectElement;

    const prompt = promptEl.value.trim();
    if (!prompt) return;

    const intervalMs = parseInt(intervalEl.value, 10);
    const mode = modeEl.value;
    const goalId = crypto.randomUUID();

    try {
      await config.invoke("goals_create", {
        motebitId,
        goalId,
        prompt,
        intervalMs,
        mode,
      });
      promptEl.value = "";
      refreshGoalList();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addMessage("system", `Failed to create goal: ${msg}`);
    }
  }

  async function toggleGoal(goalId: string): Promise<void> {
    const config = ctx.getConfig();
    if (!config?.isTauri || !config?.invoke) return;
    try {
      await config.invoke("goals_toggle", { goalId });
      refreshGoalList();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addMessage("system", `Failed to toggle goal: ${msg}`);
    }
  }

  async function deleteGoal(goalId: string): Promise<void> {
    const config = ctx.getConfig();
    if (!config?.isTauri || !config?.invoke) return;
    try {
      await config.invoke("goals_delete", { goalId });
      refreshGoalList();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addMessage("system", `Failed to delete goal: ${msg}`);
    }
  }

  // Event listeners
  document.getElementById("goals-btn")!.addEventListener("click", open);
  document.getElementById("goals-close-btn")!.addEventListener("click", close);
  goalsBackdrop.addEventListener("click", close);
  document.getElementById("goal-create-btn")!.addEventListener("click", () => {
    void createGoal();
  });

  return { open, close };
}
