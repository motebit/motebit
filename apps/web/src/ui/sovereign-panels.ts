// === Sovereign Panels: Credentials, Execution Ledger, Budget ===
// Fetches from the relay API to display credential, ledger, and budget data.

import type { WebContext } from "../types";
import { loadSyncUrl } from "../storage";

export interface SovereignPanelsAPI {
  open(): void;
  close(): void;
}

// --- Relay fetch helper ---

async function relayFetch(
  ctx: WebContext,
  path: string,
  opts?: { method?: string; body?: unknown },
): Promise<unknown> {
  const syncUrl = loadSyncUrl();
  if (!syncUrl) throw new Error("No relay URL configured");

  const token = await ctx.app.createSyncToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${syncUrl}${path}`, {
    method: opts?.method ?? "GET",
    headers,
    body: opts?.body != null ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }

  return res.json() as Promise<unknown>;
}

// --- Time formatting ---

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- Credential types (relay response shapes) ---

interface CredentialEntry {
  credential_id: string;
  credential_type: string;
  credential: {
    type?: string[];
    issuer?: string | { id?: string };
    issuanceDate?: string;
    credentialSubject?: Record<string, unknown>;
    [key: string]: unknown;
  };
  issued_at: number;
}

interface LedgerManifest {
  spec: string;
  motebit_id: string;
  goal_id: string;
  plan_id?: string;
  plan_title?: string;
  status?: string;
  content_hash: string;
  timeline?: Array<{
    type: string;
    description?: string;
    timestamp?: number;
    [key: string]: unknown;
  }>;
  signature?: string;
  [key: string]: unknown;
}

interface BudgetAllocation {
  allocation_id: string;
  task_id: string;
  candidate_motebit_id?: string;
  goal_id?: string;
  amount_locked: number;
  currency: string;
  created_at: number;
  status: string;
  settlement_id?: string;
  amount_settled?: number;
  settlement_status?: string;
  settled_at?: number;
}

interface BudgetResponse {
  motebit_id: string;
  total_locked: number;
  total_settled: number;
  allocations: BudgetAllocation[];
}

// --- Panel init ---

export function initSovereignPanels(ctx: WebContext): SovereignPanelsAPI {
  const panel = document.getElementById("sovereign-panel") as HTMLDivElement;
  const backdrop = document.getElementById("sovereign-backdrop") as HTMLDivElement;

  // Tab switching
  const tabBtns = Array.from(panel.querySelectorAll<HTMLButtonElement>(".sov-tab"));
  const tabPanes = Array.from(panel.querySelectorAll<HTMLDivElement>(".sov-pane"));

  function switchTab(tabName: string): void {
    for (const btn of tabBtns) {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    }
    for (const pane of tabPanes) {
      pane.classList.toggle("active", pane.id === `sov-pane-${tabName}`);
    }
  }

  for (const btn of tabBtns) {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      if (tab) switchTab(tab);
    });
  }

  // === Credentials Tab ===
  const credList = document.getElementById("cred-list") as HTMLDivElement;
  const credEmpty = document.getElementById("cred-empty") as HTMLDivElement;
  const credPresentBtn = document.getElementById("cred-present-btn") as HTMLButtonElement;
  const credVpOutput = document.getElementById("cred-vp-output") as HTMLDivElement;
  const credVpJson = document.getElementById("cred-vp-json") as HTMLPreElement;
  const credVpCopyBtn = document.getElementById("cred-vp-copy-btn") as HTMLButtonElement;
  const credVerifyInput = document.getElementById("cred-verify-input") as HTMLTextAreaElement;
  const credVerifyBtn = document.getElementById("cred-verify-btn") as HTMLButtonElement;
  const credVerifyResult = document.getElementById("cred-verify-result") as HTMLDivElement;

  async function loadCredentials(): Promise<void> {
    const syncUrl = loadSyncUrl();
    if (!syncUrl) {
      credList.innerHTML = "";
      credEmpty.style.display = "block";
      credEmpty.textContent = "Connect to a relay to view credentials.";
      return;
    }

    try {
      const data = (await relayFetch(ctx, `/api/v1/agents/${ctx.app.motebitId}/credentials`)) as {
        credentials: CredentialEntry[];
      };

      credList.innerHTML = "";
      if (!data.credentials || data.credentials.length === 0) {
        credEmpty.style.display = "block";
        credEmpty.textContent = "No credentials issued yet.";
        return;
      }

      credEmpty.style.display = "none";

      for (const entry of data.credentials) {
        const item = document.createElement("div");
        item.className = "cred-item";

        const issuerRaw = entry.credential.issuer;
        const issuerStr =
          typeof issuerRaw === "string"
            ? issuerRaw
            : typeof issuerRaw === "object" && issuerRaw != null && "id" in issuerRaw
              ? String(issuerRaw.id)
              : "unknown";

        const typeName =
          entry.credential_type !== "VerifiableCredential"
            ? entry.credential_type
            : (entry.credential.type?.find((t) => t !== "VerifiableCredential") ??
              "VerifiableCredential");

        item.innerHTML = `
          <div class="cred-item-header">
            <span class="cred-type-badge">${escapeHtml(typeName)}</span>
            <span class="cred-time">${formatDate(entry.issued_at)}</span>
          </div>
          <div class="cred-item-issuer">Issuer: ${escapeHtml(truncate(issuerStr, 48))}</div>
        `;

        // Expand on click to show full JSON
        const detail = document.createElement("div");
        detail.className = "cred-item-detail";
        detail.style.display = "none";
        const pre = document.createElement("pre");
        pre.className = "cred-json";
        pre.textContent = JSON.stringify(entry.credential, null, 2);
        detail.appendChild(pre);
        item.appendChild(detail);

        item.addEventListener("click", () => {
          const isOpen = detail.style.display !== "none";
          detail.style.display = isOpen ? "none" : "block";
        });

        credList.appendChild(item);
      }
    } catch (err: unknown) {
      credList.innerHTML = "";
      credEmpty.style.display = "block";
      credEmpty.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Present button
  credPresentBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const data = (await relayFetch(ctx, `/api/v1/agents/${ctx.app.motebitId}/presentation`, {
          method: "POST",
        })) as { presentation: unknown };

        credVpJson.textContent = JSON.stringify(data.presentation, null, 2);
        credVpOutput.style.display = "block";
      } catch (err: unknown) {
        ctx.showToast(`Presentation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });

  // Copy VP
  credVpCopyBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(credVpJson.textContent ?? "");
    ctx.showToast("Copied to clipboard");
  });

  // Verify
  credVerifyBtn.addEventListener("click", () => {
    void (async () => {
      const raw = credVerifyInput.value.trim();
      if (!raw) return;

      try {
        const parsed: unknown = JSON.parse(raw);
        const data = (await relayFetch(ctx, "/api/v1/credentials/verify", {
          method: "POST",
          body: parsed,
        })) as { valid: boolean; reason?: string };

        credVerifyResult.style.display = "block";
        if (data.valid) {
          credVerifyResult.className = "cred-verify-badge valid";
          credVerifyResult.textContent = "Valid";
        } else {
          credVerifyResult.className = "cred-verify-badge invalid";
          credVerifyResult.textContent = `Invalid: ${data.reason ?? "signature check failed"}`;
        }
      } catch (err: unknown) {
        credVerifyResult.style.display = "block";
        credVerifyResult.className = "cred-verify-badge invalid";
        credVerifyResult.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  });

  // === Ledger Tab ===
  const ledgerList = document.getElementById("ledger-list") as HTMLDivElement;
  const ledgerEmpty = document.getElementById("ledger-empty") as HTMLDivElement;

  function loadLedger(): void {
    const syncUrl = loadSyncUrl();
    if (!syncUrl) {
      ledgerList.innerHTML = "";
      ledgerEmpty.style.display = "block";
      ledgerEmpty.textContent = "Connect to a relay to view execution ledger.";
      return;
    }

    // Get goals from localStorage (same store as gated-panels)
    const goalsRaw = localStorage.getItem("motebit:goals");
    let goals: Array<{ goal_id: string; prompt: string; status: string; created_at: number }> = [];
    try {
      if (goalsRaw) goals = JSON.parse(goalsRaw) as typeof goals;
    } catch {
      // corrupted
    }

    // Also check for goals with completed/failed status that might have ledger entries
    const completedGoals = goals.filter((g) => g.status === "completed" || g.status === "failed");

    ledgerList.innerHTML = "";

    if (completedGoals.length === 0) {
      ledgerEmpty.style.display = "block";
      ledgerEmpty.textContent = "No completed goals yet. Execute a goal to generate a ledger.";
      return;
    }

    ledgerEmpty.style.display = "none";

    for (const goal of completedGoals) {
      const item = document.createElement("div");
      item.className = "ledger-item";

      const header = document.createElement("div");
      header.className = "ledger-item-header";

      const statusDot = document.createElement("span");
      statusDot.className = `ledger-status-dot ${goal.status}`;
      header.appendChild(statusDot);

      const text = document.createElement("span");
      text.className = "ledger-item-prompt";
      text.textContent = goal.prompt;
      text.title = goal.prompt;
      header.appendChild(text);

      const time = document.createElement("span");
      time.className = "ledger-item-time";
      time.textContent = formatDate(goal.created_at);
      header.appendChild(time);

      item.appendChild(header);

      // Detail area (lazy-loaded on click)
      const detail = document.createElement("div");
      detail.className = "ledger-detail";
      detail.style.display = "none";
      item.appendChild(detail);

      header.addEventListener("click", () => {
        const isOpen = detail.style.display !== "none";
        if (isOpen) {
          detail.style.display = "none";
          return;
        }
        detail.style.display = "block";
        if (detail.dataset.loaded === "1") return;

        detail.innerHTML =
          '<div class="ledger-loading" style="font-size:11px;color:var(--text-ghost);padding:8px 0;">Fetching ledger...</div>';

        void (async () => {
          try {
            const ledger = (await relayFetch(
              ctx,
              `/agent/${ctx.app.motebitId}/ledger/${goal.goal_id}`,
            )) as LedgerManifest;

            detail.dataset.loaded = "1";
            renderLedgerDetail(detail, ledger);
          } catch {
            detail.innerHTML =
              '<div style="font-size:11px;color:var(--text-ghost);padding:8px 0;">No ledger found for this goal.</div>';
            detail.dataset.loaded = "1";
          }
        })();
      });

      ledgerList.appendChild(item);
    }
  }

  function renderLedgerDetail(container: HTMLElement, ledger: LedgerManifest): void {
    container.innerHTML = "";

    // Summary
    const summary = document.createElement("div");
    summary.className = "ledger-summary";

    const hashRow = document.createElement("div");
    hashRow.className = "ledger-hash-row";
    hashRow.innerHTML = `
      <span class="ledger-label">Content hash</span>
      <code class="ledger-hash">${escapeHtml(truncate(ledger.content_hash, 24))}</code>
    `;
    summary.appendChild(hashRow);

    if (ledger.signature) {
      const sigBadge = document.createElement("span");
      sigBadge.className = "ledger-sig-badge verified";
      sigBadge.textContent = "Signed";
      summary.appendChild(sigBadge);
    } else {
      const sigBadge = document.createElement("span");
      sigBadge.className = "ledger-sig-badge unsigned";
      sigBadge.textContent = "Unsigned";
      summary.appendChild(sigBadge);
    }

    if (ledger.plan_title) {
      const title = document.createElement("div");
      title.className = "ledger-plan-title";
      title.textContent = ledger.plan_title;
      summary.appendChild(title);
    }

    container.appendChild(summary);

    // Timeline
    if (ledger.timeline && ledger.timeline.length > 0) {
      const timelineHeader = document.createElement("div");
      timelineHeader.className = "ledger-timeline-header";
      timelineHeader.textContent = `Timeline (${ledger.timeline.length} events)`;
      container.appendChild(timelineHeader);

      const timeline = document.createElement("div");
      timeline.className = "ledger-timeline";

      for (const event of ledger.timeline) {
        const entry = document.createElement("div");
        entry.className = "ledger-timeline-entry";
        entry.innerHTML = `
          <span class="ledger-event-type">${escapeHtml(event.type)}</span>
          <span class="ledger-event-desc">${escapeHtml(event.description ?? "")}</span>
          ${event.timestamp ? `<span class="ledger-event-time">${formatDate(event.timestamp)}</span>` : ""}
        `;
        timeline.appendChild(entry);
      }

      container.appendChild(timeline);
    }
  }

  // === Budget Tab ===
  const budgetSummary = document.getElementById("budget-summary") as HTMLDivElement;
  const budgetList = document.getElementById("budget-alloc-list") as HTMLDivElement;
  const budgetEmpty = document.getElementById("budget-empty") as HTMLDivElement;

  async function loadBudget(): Promise<void> {
    const syncUrl = loadSyncUrl();
    if (!syncUrl) {
      budgetSummary.innerHTML = "";
      budgetList.innerHTML = "";
      budgetEmpty.style.display = "block";
      budgetEmpty.textContent = "Connect to a relay to view budget.";
      return;
    }

    try {
      const data = (await relayFetch(ctx, `/agent/${ctx.app.motebitId}/budget`)) as BudgetResponse;

      budgetEmpty.style.display = "none";

      // Summary
      budgetSummary.innerHTML = `
        <div class="budget-metric">
          <span class="budget-metric-label">Total Locked</span>
          <span class="budget-metric-value">${data.total_locked.toFixed(4)}</span>
        </div>
        <div class="budget-metric">
          <span class="budget-metric-label">Total Settled</span>
          <span class="budget-metric-value">${data.total_settled.toFixed(4)}</span>
        </div>
      `;

      // Allocation list
      budgetList.innerHTML = "";
      if (!data.allocations || data.allocations.length === 0) {
        budgetEmpty.style.display = "block";
        budgetEmpty.textContent = "No budget allocations yet.";
        return;
      }

      for (const alloc of data.allocations) {
        const row = document.createElement("div");
        row.className = "budget-alloc-row";

        const statusClass =
          alloc.status === "settled"
            ? "settled"
            : alloc.status === "locked"
              ? "locked"
              : "released";

        row.innerHTML = `
          <span class="budget-alloc-status ${statusClass}">${escapeHtml(alloc.status)}</span>
          <span class="budget-alloc-amount">${alloc.amount_locked.toFixed(4)} ${escapeHtml(alloc.currency)}</span>
          <span class="budget-alloc-time">${formatDate(alloc.created_at)}</span>
          ${alloc.settlement_status ? `<span class="budget-settlement-badge ${alloc.settlement_status}">${alloc.amount_settled?.toFixed(4) ?? ""} settled</span>` : ""}
        `;
        budgetList.appendChild(row);
      }
    } catch (err: unknown) {
      budgetSummary.innerHTML = "";
      budgetList.innerHTML = "";
      budgetEmpty.style.display = "block";
      budgetEmpty.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // === Identity / Succession Tab ===
  const successionContent = document.getElementById("succession-content") as HTMLDivElement;
  const successionEmpty = document.getElementById("succession-empty") as HTMLDivElement;

  interface KeySuccessionEntry {
    old_public_key: string;
    new_public_key: string;
    timestamp: number;
    reason?: string;
    old_key_signature: string;
    new_key_signature: string;
  }

  interface SuccessionResponse {
    motebit_id: string;
    chain: KeySuccessionEntry[];
    current_public_key: string;
  }

  async function loadSuccession(): Promise<void> {
    const syncUrl = loadSyncUrl();
    if (!syncUrl) {
      successionContent.innerHTML = "";
      successionEmpty.style.display = "block";
      successionEmpty.textContent = "Connect to a relay to view identity succession.";
      return;
    }

    try {
      const data = (await relayFetch(
        ctx,
        `/api/v1/agents/${ctx.app.motebitId}/succession`,
      )) as SuccessionResponse;

      successionContent.innerHTML = "";
      if (!data.chain || data.chain.length === 0) {
        successionEmpty.style.display = "block";
        successionEmpty.textContent = "No key rotations.";
        return;
      }

      successionEmpty.style.display = "none";

      // Summary
      const summary = document.createElement("div");
      summary.style.cssText = "margin-bottom:12px;";

      const genesisKey = data.chain[0]!.old_public_key;
      summary.innerHTML = `
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">
          <span style="font-weight:600;">Rotations:</span> ${data.chain.length}
        </div>
        <div style="font-size:11px;color:var(--text-ghost);margin-bottom:4px;">
          <span style="font-weight:600;">Genesis key:</span> <code style="font-size:10px;">${escapeHtml(truncate(genesisKey, 24))}</code>
        </div>
        <div style="font-size:11px;color:var(--text-ghost);">
          <span style="font-weight:600;">Current key:</span> <code style="font-size:10px;">${escapeHtml(truncate(data.current_public_key, 24))}</code>
        </div>
      `;
      successionContent.appendChild(summary);

      // Timeline
      const timelineHeader = document.createElement("div");
      timelineHeader.style.cssText =
        "font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;";
      timelineHeader.textContent = "Rotation Timeline";
      successionContent.appendChild(timelineHeader);

      for (const entry of data.chain) {
        const item = document.createElement("div");
        item.style.cssText =
          "padding:8px;margin-bottom:6px;border-radius:6px;background:var(--bg-card, rgba(255,255,255,0.04));font-size:11px;";
        item.innerHTML = `
          <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
            <span style="color:var(--text-secondary);">${formatDate(entry.timestamp)}</span>
            ${entry.reason ? `<span style="color:var(--text-ghost);font-style:italic;">${escapeHtml(entry.reason)}</span>` : ""}
          </div>
          <div style="color:var(--text-ghost);">
            <code style="font-size:10px;">${escapeHtml(truncate(entry.old_public_key, 16))}</code>
            <span style="margin:0 4px;">&#x2192;</span>
            <code style="font-size:10px;">${escapeHtml(truncate(entry.new_public_key, 16))}</code>
          </div>
        `;
        successionContent.appendChild(item);
      }
    } catch (err: unknown) {
      successionContent.innerHTML = "";
      successionEmpty.style.display = "block";
      successionEmpty.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // === Panel open/close ===

  function open(): void {
    panel.classList.add("open");
    backdrop.classList.add("open");
    // Load all tabs
    void loadCredentials();
    void loadLedger();
    void loadBudget();
    void loadSuccession();
  }

  function close(): void {
    panel.classList.remove("open");
    backdrop.classList.remove("open");
  }

  document.getElementById("sovereign-btn")!.addEventListener("click", open);
  document.getElementById("sovereign-close-btn")!.addEventListener("click", close);
  backdrop.addEventListener("click", close);

  return { open, close };
}

// --- Utilities ---

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}
