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
  // --- Known tab ---
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
    discoverList.innerHTML = "";
    discoverEmpty.textContent = "";
    discoverEmpty.style.display = "block";

    const agents = await ctx.app.discoverAgents();

    if (agents.length === 0) {
      discoverEmpty.textContent = "No agents on the network yet. Connect to a relay to discover.";
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

      if (agent.capabilities && agent.capabilities.length > 0) {
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
  }

  // --- Panel open/close ---

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
