import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";
import {
  createAgentsController,
  collectCapabilities,
  type AgentRecord,
  type AgentsFetchAdapter,
  type AgentsState,
  type DiscoveredAgent,
  type PricingEntry,
  type SortKey,
} from "@motebit/panels";

// === DOM Refs ===

const agentsPanel = document.getElementById("agents-panel") as HTMLDivElement;
const agentsBackdrop = document.getElementById("agents-backdrop") as HTMLDivElement;
const agentsList = document.getElementById("agents-list") as HTMLDivElement;
const agentsEmpty = document.getElementById("agents-empty") as HTMLDivElement;
const agentsBalanceBar = document.getElementById("agents-balance-bar") as HTMLDivElement;
const agentsBalanceValue = document.getElementById("agents-balance-value") as HTMLSpanElement;

// Delegate modal refs (declared in index.html)
const delegateBackdrop = document.getElementById("delegate-backdrop") as HTMLDivElement;
const delegateDialogTargetId = document.getElementById(
  "delegate-dialog-target-id",
) as HTMLDivElement;
const delegateDialogCaps = document.getElementById("delegate-dialog-caps") as HTMLDivElement;
const delegateDialogPrompt = document.getElementById(
  "delegate-dialog-prompt",
) as HTMLTextAreaElement;
const delegateDialogCost = document.getElementById("delegate-dialog-cost") as HTMLSpanElement;
const delegateDialogBalance = document.getElementById("delegate-dialog-balance") as HTMLSpanElement;
const delegateDialogError = document.getElementById("delegate-dialog-error") as HTMLDivElement;
const delegateDialogSubmit = document.getElementById("delegate-dialog-submit") as HTMLButtonElement;
const delegateDialogCancel = document.getElementById("delegate-dialog-cancel") as HTMLButtonElement;

// Sort / filter controls (Discover tab only — desktop-specific affordance)
const discoverSort = document.getElementById("discover-sort") as HTMLSelectElement;
const discoverFilter = document.getElementById("discover-filter") as HTMLSelectElement;

// === Public API ===

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

interface BalanceSnapshot {
  balance: number;
  currency: string;
}

// === Adapter ===

function createDesktopAgentsAdapter(ctx: DesktopContext): AgentsFetchAdapter {
  return {
    get syncUrl() {
      return ctx.getConfig()?.syncUrl ?? null;
    },
    get motebitId() {
      return ctx.app.motebitId || null;
    },
    listTrustedAgents: () => ctx.app.listTrustedAgents(),
    discoverAgents: () => ctx.app.discoverAgents(),
  };
}

// === Init ===

export function initAgents(ctx: DesktopContext): AgentsAPI {
  const adapter = createDesktopAgentsAdapter(ctx);
  const ctrl = createAgentsController(adapter);

  // --- Balance bar (desktop-only; kept out of the panel controller since the
  // sovereign controller already owns the balance fetch and mobile/web don't
  // show this bar) ---

  let latestBalance: BalanceSnapshot | null = null;

  async function fetchBalance(): Promise<BalanceSnapshot | null> {
    const config = ctx.getConfig();
    const syncUrl = config?.syncUrl;
    const motebitId = ctx.app.motebitId;
    if (!syncUrl || !motebitId) return null;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.syncMasterToken) {
      headers["Authorization"] = `Bearer ${config.syncMasterToken}`;
    }

    try {
      const resp = await fetch(`${syncUrl}/api/v1/agents/${motebitId}/balance`, { headers });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { balance: number; currency: string };
      return { balance: data.balance, currency: data.currency };
    } catch {
      return null;
    }
  }

  async function refreshBalance(): Promise<void> {
    const b = await fetchBalance();
    latestBalance = b;
    if (b) {
      agentsBalanceValue.textContent = `$${b.balance.toFixed(2)}`;
      agentsBalanceBar.style.display = "";
    } else {
      agentsBalanceBar.style.display = "none";
    }
    if (delegateBackdrop.classList.contains("open")) {
      delegateDialogBalance.textContent = b ? `$${b.balance.toFixed(2)}` : "unavailable";
    }
  }

  // --- Renderers ---

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

      // Known agents support delegation too
      const actions = document.createElement("div");
      actions.className = "agent-item-actions";
      const btn = document.createElement("button");
      btn.className = "agent-delegate-btn";
      btn.textContent = "Delegate";
      btn.addEventListener("click", () => {
        openDelegateModal({
          motebit_id: agent.remote_motebit_id,
          capabilities: [],
          pricing: null,
        });
      });
      actions.appendChild(btn);
      item.appendChild(actions);

      agentsList.appendChild(item);
    }
  }

  // --- Discover tab DOM refs ---
  const discoverList = document.getElementById("agents-discover-list") as HTMLDivElement;
  const discoverEmpty = document.getElementById("agents-discover-empty") as HTMLDivElement;
  const discoverControls = document.getElementById("agents-discover-controls") as HTMLDivElement;
  const knownPane = document.getElementById("agents-known-pane") as HTMLDivElement;
  const discoverPane = document.getElementById("agents-discover-pane") as HTMLDivElement;
  const tabBtns = Array.from(agentsPanel.querySelectorAll<HTMLButtonElement>(".agents-tab"));

  function switchTab(tab: string): void {
    for (const btn of tabBtns) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    }
    knownPane.style.display = tab === "known" ? "" : "none";
    discoverPane.style.display = tab === "discover" ? "" : "none";
    if (tab === "known") ctrl.setActiveTab("known");
    else if (tab === "discover") {
      ctrl.setActiveTab("discover");
      void ctrl.refreshDiscover();
    }
  }

  for (const btn of tabBtns) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab ?? "known"));
  }

  function rebuildCapabilityFilter(state: AgentsState): void {
    const caps = collectCapabilities(state.discovered);
    const current = discoverFilter.value;
    discoverFilter.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All capabilities";
    discoverFilter.appendChild(all);
    for (const c of caps) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      discoverFilter.appendChild(opt);
    }
    // Restore prior selection if still valid; otherwise reset to "all".
    if (current && caps.includes(current)) {
      discoverFilter.value = current;
    } else {
      discoverFilter.value = "";
      if (state.capabilityFilter !== "") ctrl.setCapabilityFilter("");
    }
  }

  function renderDiscover(state: AgentsState): void {
    if (state.discovered.length === 0) {
      discoverList.innerHTML = "";
      discoverEmpty.textContent =
        state.error != null
          ? "Could not reach relay."
          : "No agents on the network yet. Connect to a relay to discover.";
      discoverEmpty.style.display = "block";
      discoverControls.style.display = "none";
      return;
    }

    discoverControls.style.display = "";
    const view = ctrl.discoveredView();

    discoverList.innerHTML = "";
    if (view.length === 0) {
      discoverEmpty.textContent = "No agents match the current filter.";
      discoverEmpty.style.display = "block";
      return;
    }
    discoverEmpty.style.display = "none";

    for (const agent of view) {
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

      const actions = document.createElement("div");
      actions.className = "agent-item-actions";
      const btn = document.createElement("button");
      btn.className = "agent-delegate-btn";
      btn.textContent = "Delegate";
      btn.addEventListener("click", () => openDelegateModal(agent));
      actions.appendChild(btn);
      item.appendChild(actions);

      discoverList.appendChild(item);
    }
  }

  function renderAll(state: AgentsState): void {
    renderKnown(state);
    rebuildCapabilityFilter(state);
    renderDiscover(state);
  }

  ctrl.subscribe(renderAll);

  discoverSort.addEventListener("change", () => {
    ctrl.setSort((discoverSort.value || "recent") as SortKey);
  });
  discoverFilter.addEventListener("change", () => {
    ctrl.setCapabilityFilter(discoverFilter.value || "");
  });

  // --- Delegate modal (desktop-only today) ---

  type DelegateTarget = {
    motebit_id: string;
    capabilities: string[];
    pricing?: PricingEntry[] | null;
  };

  let currentTarget: DelegateTarget | null = null;

  function updateEstimatedCost(): void {
    if (!currentTarget) {
      delegateDialogCost.textContent = "free";
      return;
    }
    const selectedCap = (
      delegateDialogCaps.querySelector<HTMLInputElement>('input[name="delegate-cap"]:checked') ??
      null
    )?.value;
    if (!selectedCap || !Array.isArray(currentTarget.pricing)) {
      delegateDialogCost.textContent = "free";
      return;
    }
    const price = currentTarget.pricing.find((p) => p.capability === selectedCap);
    if (!price || price.unit_cost <= 0) {
      delegateDialogCost.textContent = "free";
      return;
    }
    delegateDialogCost.textContent = `≈ $${price.unit_cost.toFixed(2)}/${price.per}`;
  }

  function openDelegateModal(agent: DelegateTarget | DiscoveredAgent | AgentRecord): void {
    // Normalize the three shapes the Delegate button can pass — discovered
    // agents carry capabilities + pricing, known agents carry neither.
    const target: DelegateTarget =
      "motebit_id" in agent
        ? {
            motebit_id: agent.motebit_id,
            capabilities: agent.capabilities ?? [],
            pricing: agent.pricing ?? null,
          }
        : {
            motebit_id: (agent as AgentRecord).remote_motebit_id,
            capabilities: [],
            pricing: null,
          };
    currentTarget = target;
    delegateDialogError.style.display = "none";
    delegateDialogError.textContent = "";
    delegateDialogPrompt.value = "";
    delegateDialogSubmit.disabled = false;
    delegateDialogSubmit.textContent = "Delegate";

    delegateDialogTargetId.textContent = target.motebit_id;
    delegateDialogTargetId.title = target.motebit_id;

    delegateDialogCaps.innerHTML = "";
    const priceByCapability = new Map<string, PricingEntry>();
    if (Array.isArray(target.pricing)) {
      for (const p of target.pricing) priceByCapability.set(p.capability, p);
    }
    const caps = target.capabilities.length > 0 ? target.capabilities : ["general"];
    caps.forEach((cap, idx) => {
      const label = document.createElement("label");
      label.className = "delegate-cap-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "delegate-cap";
      input.value = cap;
      if (idx === 0) input.checked = true;
      input.addEventListener("change", updateEstimatedCost);
      label.appendChild(input);

      const text = document.createElement("span");
      const price = priceByCapability.get(cap);
      if (price && price.unit_cost > 0) {
        text.innerHTML = `${cap} <span class="delegate-cap-price">· $${price.unit_cost.toFixed(2)}/${price.per}</span>`;
      } else {
        text.textContent = cap;
      }
      label.appendChild(text);
      delegateDialogCaps.appendChild(label);
    });

    updateEstimatedCost();

    delegateDialogBalance.textContent = latestBalance
      ? `$${latestBalance.balance.toFixed(2)}`
      : "—";

    delegateBackdrop.classList.add("open");
    delegateDialogPrompt.focus();
  }

  function closeDelegateModal(): void {
    delegateBackdrop.classList.remove("open");
    currentTarget = null;
  }

  async function submitDelegation(): Promise<void> {
    if (!currentTarget) return;
    const prompt = delegateDialogPrompt.value.trim();
    if (!prompt) {
      delegateDialogError.textContent = "Enter a prompt.";
      delegateDialogError.style.display = "block";
      return;
    }

    const config = ctx.getConfig();
    const syncUrl = config?.syncUrl;
    const motebitId = ctx.app.motebitId;
    if (!syncUrl || !motebitId || !config?.invoke) {
      delegateDialogError.textContent = "Not connected to a relay.";
      delegateDialogError.style.display = "block";
      return;
    }

    delegateDialogSubmit.disabled = true;
    delegateDialogSubmit.textContent = "Delegating…";
    delegateDialogError.style.display = "none";

    try {
      const keypair = await ctx.app.getDeviceKeypair(config.invoke);
      if (!keypair) throw new Error("Device keypair unavailable");
      const token = await ctx.app.createSyncToken(keypair.privateKey, "task:submit");

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };

      const resp = await fetch(`${syncUrl}/agent/${currentTarget.motebit_id}/task`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt, submitted_by: motebitId }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        if (resp.status === 402) {
          throw new Error("Insufficient balance. Add funds and try again.");
        }
        throw new Error(`Relay returned ${resp.status}: ${text || resp.statusText}`);
      }

      const data = (await resp.json()) as { task_id: string };
      const targetShort = currentTarget.motebit_id.slice(0, 12);
      const taskShort = data.task_id.slice(0, 12);

      closeDelegateModal();
      ctx.addMessage(
        "system",
        `Delegation submitted to ${targetShort}… (task ${taskShort}…). Result will arrive via the agent network.`,
      );

      void refreshBalance();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      delegateDialogError.textContent = msg;
      delegateDialogError.style.display = "block";
      delegateDialogSubmit.disabled = false;
      delegateDialogSubmit.textContent = "Delegate";
    }
  }

  delegateDialogSubmit.addEventListener("click", () => {
    void submitDelegation();
  });
  delegateDialogCancel.addEventListener("click", closeDelegateModal);
  delegateBackdrop.addEventListener("click", (e) => {
    if (e.target === delegateBackdrop) closeDelegateModal();
  });

  // --- Panel open/close ---

  function open(): void {
    agentsPanel.classList.add("open");
    agentsBackdrop.classList.add("open");
    void ctrl.refreshKnown();
    void refreshBalance();
  }

  function close(): void {
    agentsPanel.classList.remove("open");
    agentsBackdrop.classList.remove("open");
  }

  document.getElementById("agents-btn")!.addEventListener("click", open);
  document.getElementById("agents-close-btn")!.addEventListener("click", close);
  agentsBackdrop.addEventListener("click", close);

  return { open, close };
}
