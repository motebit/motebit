import { attachedNotice } from "./attached-notice.js";
import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";
import {
  createAgentsController,
  collectCapabilities,
  formatHardwarePlatform,
  formatLatency,
  shortMotebitId,
  trustAuraClass,
  economicForPeer,
  formatPeerEconomics,
  type AgentEconomicSummary,
  type AgentHardwareAttestation,
  type AgentLatencyStats,
  type AgentRecord,
  type AgentsFetchAdapter,
  type AgentsState,
  type DiscoveredAgent,
  type PricingEntry,
  type SortKey,
} from "@motebit/panels";
import { deriveAgentSigil } from "@motebit/sdk";
import { sigilToSvg } from "./agent-sigil";
import {
  verifiedSettlementSummaryFetch,
  fetchTransparencyAnchor,
  type TransparencyAnchor,
} from "@motebit/state-export-client";

// Relay transparency anchor for the settlement-summary producer-key pin —
// same posture as web (gated-panels.ts). Cached per session; degrades to
// anchor-less signature verification on bootstrap failure.
let cachedSettlementAnchor: TransparencyAnchor | undefined;
async function settlementAnchor(syncUrl: string): Promise<TransparencyAnchor | undefined> {
  if (cachedSettlementAnchor !== undefined) return cachedSettlementAnchor;
  try {
    const result = await fetchTransparencyAnchor(syncUrl);
    if (result.ok) cachedSettlementAnchor = result.anchor;
    return cachedSettlementAnchor;
  } catch {
    return undefined;
  }
}

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

/**
 * Render the hardware-attested badge for a peer when the relay/runtime
 * forwarded a verified `hardware_attestation` claim. Renders nothing when
 * absent — rows without a claim stay visually unchanged. Tooltip carries
 * the verifier name + score so a user can answer "why did motebit prefer
 * that peer" (the doctrine-completeness probe `ha_surface_badge_agents_panel_gap`
 * was deferred for). Badge text is verbatim "hardware-attested" — never
 * "secure" or "verified" (those collide with the skills provenance
 * vocabulary in `spec/skills-v1.md` §7.1).
 */
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

/**
 * Render the observed-latency readout for a peer when the relay/runtime
 * forwarded a non-zero `latency_stats` snapshot. Renders nothing when
 * absent or when avg_ms is zero (defensive: zero-avg with samples would
 * only appear from a malformed window). Tooltip carries the sample
 * count so a user can judge confidence — same self-attesting-system
 * doctrine probe as the HA badge: every routing-input MUST be visible.
 */
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
    setPetname: (remoteMotebitId, petname) => ctx.app.setAgentPetname(remoteMotebitId, petname),
    // Money side of the trust graph (doctrine §6): the caller's own per-peer
    // economic history, verified against the relay's pinned key. Desktop auths
    // with the static master token (panels CLAUDE.md rule 3); null on
    // no-relay / verification failure (fail-closed — mark + trust still render).
    listSettlementSummary: async (): Promise<AgentEconomicSummary | null> => {
      const config = ctx.getConfig();
      const syncUrl = config?.syncUrl;
      const motebitId = ctx.app.motebitId;
      if (!syncUrl || !motebitId) return null;
      const anchor = await settlementAnchor(syncUrl);
      const init = config.syncMasterToken
        ? { headers: { Authorization: `Bearer ${config.syncMasterToken}` } }
        : undefined;
      const res = await verifiedSettlementSummaryFetch(syncUrl, motebitId, { anchor, init });
      return res.verification.valid ? res.body : null;
    },
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

  // Identity header for an agent row: the key-derived sigil face + the
  // human-readable handle (petname when known, else the short motebit_id), with
  // the full id on `title`. "The face is the key" — doctrine §4. Sibling of
  // web's `renderAgentIdentity` (apps/web/src/ui/gated-panels.ts). The sigil
  // title is the UUID-safe short id (never user text → no untrusted text in the
  // SVG string); the petname goes through textContent. `onSetPetname` (Known
  // only) makes the label an inline local petname editor — a record edit, inline
  // (no modal). Trust aura (Known only) wraps the mark; omitted on Discover,
  // where trust would be the relay's claim, not yours.
  function renderAgentIdentity(opts: {
    fullId: string;
    petname?: string;
    trustLevel?: string;
    onSetPetname?: (petname: string | undefined) => void;
  }): HTMLElement {
    const header = document.createElement("div");
    header.className = "agent-item-identity";

    const face = document.createElement("span");
    face.className = "agent-sigil";
    if (opts.trustLevel != null) {
      const aura = trustAuraClass(opts.trustLevel);
      if (aura.length > 0) face.classList.add(aura);
    }
    if (opts.fullId.length > 0) {
      face.innerHTML = sigilToSvg(deriveAgentSigil(opts.fullId), {
        size: 32,
        title: shortMotebitId(opts.fullId),
        ground: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      });
    } else {
      face.classList.add("agent-sigil-empty");
    }
    header.appendChild(face);

    const col = document.createElement("div");
    col.className = "agent-id-col";
    col.title = opts.fullId;
    const short = shortMotebitId(opts.fullId);
    const hasPetname = opts.petname != null && opts.petname.length > 0;

    const startEdit = (): void => {
      const onSet = opts.onSetPetname;
      if (onSet == null) return;
      col.innerHTML = "";
      const input = document.createElement("input");
      input.className = "agent-petname-input";
      input.value = opts.petname ?? "";
      input.placeholder = "name this agent";
      input.maxLength = 40;
      col.appendChild(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (save: boolean): void => {
        if (done) return;
        done = true;
        if (save) onSet(input.value);
        else buildView();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(false));
    };

    function buildView(): void {
      col.innerHTML = "";
      const label = document.createElement("div");
      label.className = "agent-item-id";
      label.textContent = hasPetname ? opts.petname! : short;
      col.appendChild(label);

      if (hasPetname) {
        const fp = document.createElement("div");
        fp.className = "agent-item-fingerprint";
        fp.textContent = short;
        col.appendChild(fp);
        if (opts.onSetPetname != null) {
          label.classList.add("agent-petname-editable");
          label.title = "Rename (local)";
          label.addEventListener("click", startEdit);
        }
      } else if (opts.onSetPetname != null) {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "agent-add-name";
        add.textContent = "+ name";
        add.title = "Give this agent a local name";
        add.addEventListener("click", startEdit);
        col.appendChild(add);
      }
    }

    buildView();
    header.appendChild(col);
    return header;
  }

  function renderKnown(state: AgentsState): void {
    agentsList.innerHTML = "";
    if (state.known.length === 0) {
      // Attached frontend ⇒ the trust graph is not void, it lives in the
      // coordinator — the empty pulse must say so, not promise records
      // that will never arrive in this window. Discover (relay-backed)
      // keeps working either way.
      const host = ctx.app.runtimeHostStatus();
      const titleEl = agentsEmpty.querySelector(".panel-empty-pulse-title");
      const subEl = agentsEmpty.querySelector(".panel-empty-pulse-sub");
      if (host.role === "attached" && titleEl !== null && subEl !== null) {
        const notice = attachedNotice(host.coordinatorPid, "Known agents");
        titleEl.textContent = notice.title;
        subEl.textContent = notice.sub;
      }
      agentsEmpty.style.display = "block";
      return;
    }
    agentsEmpty.style.display = "none";

    for (const agent of state.known) {
      const item = document.createElement("div");
      item.className = "agent-item";

      item.appendChild(
        renderAgentIdentity({
          fullId: agent.remote_motebit_id,
          petname: agent.petname,
          trustLevel: agent.trust_level,
          onSetPetname: (petname) => void ctrl.setPetname(agent.remote_motebit_id, petname),
        }),
      );

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

      // Money side of the trust graph: net earned/paid with this peer, derived
      // from the relay's signed settlement ledger. Honest-empty — rendered only
      // when there's settled history (never a fabricated $0).
      const money = formatPeerEconomics(economicForPeer(state.economic, agent.remote_motebit_id));
      if (money != null) {
        const moneyEl = document.createElement("span");
        moneyEl.className = "agent-item-money";
        moneyEl.textContent = money;
        meta.appendChild(moneyEl);
      }

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

      item.appendChild(renderAgentIdentity({ fullId: agent.motebit_id }));

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
            motebit_id: agent.remote_motebit_id,
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
      // `cap` and `price.per` are relay-supplied DiscoveredAgent fields —
      // untrusted. Build via textContent, never innerHTML: a capability named
      // `x<img src=q onerror=...>` would otherwise reach the privileged Tauri
      // webview's IPC. (docs/doctrine/surface-authority-model.md — frontends
      // render untrusted peer data; the slab path sandboxes, this one must escape.)
      text.textContent = cap;
      if (price && price.unit_cost > 0) {
        const priceEl = document.createElement("span");
        priceEl.className = "delegate-cap-price";
        priceEl.textContent = `· $${price.unit_cost.toFixed(2)}/${price.per}`;
        text.append(" ", priceEl);
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
    void ctrl.refreshEconomic();
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
