import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";

// === DOM Refs ===

const agentsPanel = document.getElementById("agents-panel") as HTMLDivElement;
const agentsBackdrop = document.getElementById("agents-backdrop") as HTMLDivElement;
const agentsList = document.getElementById("agents-list") as HTMLDivElement;
const agentsEmpty = document.getElementById("agents-empty") as HTMLDivElement;

// === Agents Panel ===

export interface AgentsAPI {
  open(): void;
  close(): void;
}

const TRUST_BADGE_CLASS: Record<string, string> = {
  unknown: "unknown",
  first_contact: "first-contact",
  verified: "verified",
  trusted: "trusted",
  blocked: "blocked",
};

export function initAgents(ctx: DesktopContext): AgentsAPI {
  async function populateAgents(): Promise<void> {
    const agents = await ctx.app.listTrustedAgents();

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

  function open(): void {
    agentsPanel.classList.add("open");
    agentsBackdrop.classList.add("open");
    void populateAgents();
  }

  function close(): void {
    agentsPanel.classList.remove("open");
    agentsBackdrop.classList.remove("open");
  }

  // === Event Wiring ===

  document.getElementById("agents-btn")!.addEventListener("click", open);
  document.getElementById("agents-close-btn")!.addEventListener("click", close);
  agentsBackdrop.addEventListener("click", close);

  return { open, close };
}
