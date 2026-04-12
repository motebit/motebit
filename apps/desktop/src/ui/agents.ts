import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";

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

// Sort / filter controls (Discover tab only)
const discoverSort = document.getElementById("discover-sort") as HTMLSelectElement;
const discoverFilter = document.getElementById("discover-filter") as HTMLSelectElement;

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

type DiscoveredAgent = Awaited<ReturnType<DesktopContext["app"]["discoverAgents"]>>[number];
type PricingEntry = { capability: string; unit_cost: number; currency: string; per: string };

interface BalanceSnapshot {
  balance: number;
  currency: string;
}

type SortKey = "recent" | "price-asc" | "price-desc" | "trust" | "interactions";

const TRUST_RANK: Record<string, number> = {
  blocked: -1,
  unknown: 0,
  first_contact: 1,
  verified: 2,
  trusted: 3,
};

function minPrice(agent: DiscoveredAgent): number {
  if (!Array.isArray(agent.pricing) || agent.pricing.length === 0) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const p of agent.pricing) {
    if (typeof p.unit_cost === "number" && p.unit_cost < best) best = p.unit_cost;
  }
  return best;
}

function collectCapabilities(agents: DiscoveredAgent[]): string[] {
  const set = new Set<string>();
  for (const a of agents) {
    for (const c of a.capabilities) set.add(c);
  }
  return [...set].sort();
}

function applySortFilter(
  agents: DiscoveredAgent[],
  sort: SortKey,
  capFilter: string,
): DiscoveredAgent[] {
  const filtered =
    capFilter === "" ? agents.slice() : agents.filter((a) => a.capabilities.includes(capFilter));

  switch (sort) {
    case "price-asc":
      filtered.sort((a, b) => minPrice(a) - minPrice(b));
      break;
    case "price-desc":
      filtered.sort((a, b) => {
        const pa = minPrice(a);
        const pb = minPrice(b);
        // Unpriced agents sort last in both directions
        if (pa === Number.POSITIVE_INFINITY && pb === Number.POSITIVE_INFINITY) return 0;
        if (pa === Number.POSITIVE_INFINITY) return 1;
        if (pb === Number.POSITIVE_INFINITY) return -1;
        return pb - pa;
      });
      break;
    case "trust":
      filtered.sort(
        (a, b) =>
          (TRUST_RANK[b.trust_level ?? "unknown"] ?? 0) -
          (TRUST_RANK[a.trust_level ?? "unknown"] ?? 0),
      );
      break;
    case "interactions":
      filtered.sort((a, b) => (b.interaction_count ?? 0) - (a.interaction_count ?? 0));
      break;
    case "recent":
    default:
      filtered.sort((a, b) => (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0));
      break;
  }
  return filtered;
}

export function initAgents(ctx: DesktopContext): AgentsAPI {
  // --- Balance bar ---
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
    // If the delegate modal is open, update its balance line too
    if (delegateBackdrop.classList.contains("open")) {
      delegateDialogBalance.textContent = b ? `$${b.balance.toFixed(2)}` : "unavailable";
    }
  }

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

      // Delegate button — known agents support delegation too
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

  // --- Discover tab ---
  const discoverList = document.getElementById("agents-discover-list") as HTMLDivElement;
  const discoverEmpty = document.getElementById("agents-discover-empty") as HTMLDivElement;
  const discoverControls = document.getElementById("agents-discover-controls") as HTMLDivElement;
  const knownPane = document.getElementById("agents-known-pane") as HTMLDivElement;
  const discoverPane = document.getElementById("agents-discover-pane") as HTMLDivElement;
  const tabBtns = Array.from(agentsPanel.querySelectorAll<HTMLButtonElement>(".agents-tab"));

  let discoveredAgents: DiscoveredAgent[] = [];

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

  function rebuildCapabilityFilter(): void {
    const caps = collectCapabilities(discoveredAgents);
    const current = discoverFilter.value;
    // Rebuild options
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
    // Restore prior selection if still valid
    if (current && caps.includes(current)) {
      discoverFilter.value = current;
    } else {
      discoverFilter.value = "";
    }
  }

  function renderDiscoverList(): void {
    discoverList.innerHTML = "";
    const sort = (discoverSort.value || "recent") as SortKey;
    const capFilter = discoverFilter.value || "";
    const view = applySortFilter(discoveredAgents, sort, capFilter);

    if (view.length === 0) {
      discoverEmpty.textContent =
        discoveredAgents.length === 0
          ? "No agents on the network yet. Connect to a relay to discover."
          : "No agents match the current filter.";
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
          for (const p of agent.pricing) {
            priceByCapability.set(p.capability, {
              capability: p.capability,
              unit_cost: p.unit_cost,
              currency: p.currency,
              per: p.per,
            });
          }
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
        const seen = document.createElement("span");
        seen.className = "agent-last-seen";
        seen.textContent = `seen ${formatTimeAgo(agent.last_seen_at)}`;
        meta.appendChild(seen);
      }
      item.appendChild(meta);

      // Delegate action
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

  async function populateDiscover(): Promise<void> {
    discoverList.innerHTML = "";
    discoverEmpty.textContent = "Discovering agents…";
    discoverEmpty.style.display = "block";
    discoverControls.style.display = "none";

    discoveredAgents = await ctx.app.discoverAgents();

    if (discoveredAgents.length === 0) {
      discoverEmpty.textContent = "No agents on the network yet. Connect to a relay to discover.";
      discoverEmpty.style.display = "block";
      return;
    }

    rebuildCapabilityFilter();
    discoverControls.style.display = "";
    renderDiscoverList();
  }

  discoverSort.addEventListener("change", renderDiscoverList);
  discoverFilter.addEventListener("change", renderDiscoverList);

  // --- Delegate modal ---
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

  function openDelegateModal(agent: DelegateTarget): void {
    currentTarget = agent;
    delegateDialogError.style.display = "none";
    delegateDialogError.textContent = "";
    delegateDialogPrompt.value = "";
    delegateDialogSubmit.disabled = false;
    delegateDialogSubmit.textContent = "Delegate";

    delegateDialogTargetId.textContent = agent.motebit_id;
    delegateDialogTargetId.title = agent.motebit_id;

    // Build capability picker (radio)
    delegateDialogCaps.innerHTML = "";
    const priceByCapability = new Map<string, PricingEntry>();
    if (Array.isArray(agent.pricing)) {
      for (const p of agent.pricing) priceByCapability.set(p.capability, p);
    }
    const caps = agent.capabilities.length > 0 ? agent.capabilities : ["general"];
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

    // Balance line
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

      // Close modal silently (calm software); surface the receipt via chat
      closeDelegateModal();
      ctx.addMessage(
        "system",
        `Delegation submitted to ${targetShort}… (task ${taskShort}…). Result will arrive via the agent network.`,
      );

      // Refresh balance (allocation will have locked some funds)
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
    void populateAgents();
    void refreshBalance();
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
