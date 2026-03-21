import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";

// === DOM Refs ===

const sovereignPanel = document.getElementById("sovereign-panel") as HTMLDivElement;
const sovereignBackdrop = document.getElementById("sovereign-backdrop") as HTMLDivElement;

// Tab elements
const tabBtns = Array.from(sovereignPanel.querySelectorAll<HTMLButtonElement>(".sov-tab"));
const tabPanes = Array.from(sovereignPanel.querySelectorAll<HTMLDivElement>(".sov-pane"));

// Credentials
const credList = document.getElementById("cred-list") as HTMLDivElement;
const credEmpty = document.getElementById("cred-empty") as HTMLDivElement;
const credPresentBtn = document.getElementById("cred-present-btn") as HTMLButtonElement;
const credVpOutput = document.getElementById("cred-vp-output") as HTMLDivElement;
const credVpJson = document.getElementById("cred-vp-json") as HTMLPreElement;
const credVpCopyBtn = document.getElementById("cred-vp-copy-btn") as HTMLButtonElement;
const credVerifyInput = document.getElementById("cred-verify-input") as HTMLTextAreaElement;
const credVerifyBtn = document.getElementById("cred-verify-btn") as HTMLButtonElement;
const credVerifyResult = document.getElementById("cred-verify-result") as HTMLDivElement;

// Ledger
const ledgerList = document.getElementById("ledger-list") as HTMLDivElement;
const ledgerEmpty = document.getElementById("ledger-empty") as HTMLDivElement;

// Budget
const budgetSummary = document.getElementById("budget-summary-sov") as HTMLDivElement;
const budgetAllocList = document.getElementById("budget-alloc-list-sov") as HTMLDivElement;
const budgetEmpty = document.getElementById("budget-empty-sov") as HTMLDivElement;

// Succession
const successionContent = document.getElementById("succession-content") as HTMLDivElement;
const successionEmpty = document.getElementById("succession-empty") as HTMLDivElement;

// === Types ===

interface CredEntry {
  credential_id: string;
  credential_type: string;
  credential: Record<string, unknown>;
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
  amount_locked: number;
  currency: string;
  created_at: number;
  status: string;
  amount_settled?: number;
  settlement_status?: string;
}

interface BalanceTransaction {
  transaction_id: string;
  type: string;
  amount: number;
  balance_after: number;
  description: string | null;
  created_at: number;
}

interface BalanceResponse {
  motebit_id: string;
  balance: number;
  currency: string;
  transactions: BalanceTransaction[];
}

interface BudgetResponse {
  motebit_id: string;
  total_locked: number;
  total_settled: number;
  allocations: BudgetAllocation[];
}

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

// === Public API ===

export interface SovereignAPI {
  open(): void;
  close(): void;
}

// === Utilities ===

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

// === Relay fetch helper ===

function getRelayHeaders(ctx: DesktopContext): {
  syncUrl: string;
  headers: Record<string, string>;
  motebitId: string;
} | null {
  const config = ctx.getConfig();
  const syncUrl = config?.syncUrl;
  const motebitId = ctx.app.motebitId;
  if (!syncUrl || !motebitId) return null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.syncMasterToken) {
    headers["Authorization"] = `Bearer ${config.syncMasterToken}`;
  }
  return { syncUrl, headers, motebitId };
}

// === Init ===

export function initSovereign(ctx: DesktopContext): SovereignAPI {
  // Tab switching
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

  function deduplicateCredentials(entries: CredEntry[]): CredEntry[] {
    const seen = new Map<string, CredEntry>();
    for (const entry of entries) {
      const issuer =
        typeof entry.credential.issuer === "string"
          ? entry.credential.issuer
          : String(((entry.credential.issuer as Record<string, unknown>)?.id as string) ?? "");
      const subjectRaw = (entry.credential.credentialSubject as Record<string, unknown>)?.id;
      const subject = typeof subjectRaw === "string" ? subjectRaw : "";
      const key = `${issuer}:${entry.credential_type}:${subject}:${entry.issued_at}`;
      const existing = seen.get(key);
      if (!existing || entry.issued_at > existing.issued_at) {
        seen.set(key, entry);
      }
    }
    return [...seen.values()].sort((a, b) => b.issued_at - a.issued_at);
  }

  async function loadCredentials(): Promise<void> {
    const localEntries = ctx.app.getLocalCredentials();

    let relayEntries: CredEntry[] = [];
    const relay = getRelayHeaders(ctx);
    if (relay) {
      try {
        const res = await fetch(`${relay.syncUrl}/api/v1/agents/${relay.motebitId}/credentials`, {
          headers: relay.headers,
        });
        if (res.ok) {
          const data = (await res.json()) as { credentials: CredEntry[] };
          relayEntries = data.credentials ?? [];
        }
      } catch {
        // Relay fetch failed — local credentials still display
      }
    }

    const allEntries = deduplicateCredentials([...localEntries, ...relayEntries]);

    credList.innerHTML = "";
    if (allEntries.length === 0) {
      credEmpty.style.display = "block";
      credEmpty.textContent = relay
        ? "No credentials issued yet."
        : "No local credentials. Connect to a relay for more.";
      credPresentBtn.disabled = true;
      return;
    }

    credEmpty.style.display = "none";
    credPresentBtn.disabled = false;

    for (const entry of allEntries) {
      const item = document.createElement("div");
      item.className = "cred-item";

      const issuerRaw = entry.credential.issuer;
      const issuerStr =
        typeof issuerRaw === "string"
          ? issuerRaw
          : typeof issuerRaw === "object" &&
              issuerRaw != null &&
              "id" in (issuerRaw as Record<string, unknown>)
            ? String((issuerRaw as Record<string, unknown>).id)
            : "unknown";

      const typeName =
        entry.credential_type !== "VerifiableCredential"
          ? entry.credential_type
          : ((entry.credential.type as string[])?.find((t) => t !== "VerifiableCredential") ??
            "VerifiableCredential");

      item.innerHTML = `
        <div class="cred-item-header">
          <span class="cred-type-badge">${escapeHtml(typeName)}</span>
          <span class="cred-time">${formatTimeAgo(entry.issued_at)}</span>
        </div>
        <div class="cred-item-issuer">Issuer: ${escapeHtml(truncate(issuerStr, 48))}</div>
      `;

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
  }

  // Present button
  credPresentBtn.addEventListener("click", () => {
    const relay = getRelayHeaders(ctx);
    if (!relay) return;

    void (async () => {
      try {
        const res = await fetch(`${relay.syncUrl}/api/v1/agents/${relay.motebitId}/presentation`, {
          method: "POST",
          headers: relay.headers,
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as { presentation: unknown };
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
    const relay = getRelayHeaders(ctx);
    if (!relay) return;

    void (async () => {
      const raw = credVerifyInput.value.trim();
      if (!raw) return;

      try {
        const parsed: unknown = JSON.parse(raw);
        const res = await fetch(`${relay.syncUrl}/api/v1/credentials/verify`, {
          method: "POST",
          headers: relay.headers,
          body: JSON.stringify(parsed),
        });
        const data = (await res.json()) as { valid: boolean; reason?: string };

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

  async function loadLedger(): Promise<void> {
    const relay = getRelayHeaders(ctx);
    if (!relay) {
      ledgerList.innerHTML = "";
      ledgerEmpty.style.display = "block";
      ledgerEmpty.textContent = "Connect to a relay to view execution ledger.";
      return;
    }

    // Fetch goals from relay API
    interface GoalRow {
      goal_id: string;
      prompt: string;
      status: string;
      created_at: number;
    }

    let goals: GoalRow[] = [];
    try {
      const res = await fetch(`${relay.syncUrl}/api/v1/goals/${relay.motebitId}`, {
        headers: relay.headers,
      });
      if (res.ok) {
        const data = (await res.json()) as { goals: GoalRow[] };
        goals = data.goals ?? [];
      }
    } catch {
      // Goal fetch failed
    }

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
      time.textContent = formatTimeAgo(goal.created_at);
      header.appendChild(time);

      item.appendChild(header);

      // Detail area (lazy-loaded on click)
      const detail = document.createElement("div");
      detail.className = "ledger-detail";
      detail.style.display = "none";
      item.appendChild(detail);

      const goalId = goal.goal_id;
      header.addEventListener("click", () => {
        const isOpen = detail.style.display !== "none";
        if (isOpen) {
          detail.style.display = "none";
          return;
        }
        detail.style.display = "block";
        if (detail.dataset.loaded === "1") return;

        detail.innerHTML =
          '<div style="font-size:11px;color:var(--text-ghost);padding:8px 0;">Fetching ledger...</div>';

        void (async () => {
          try {
            const res = await fetch(`${relay.syncUrl}/agent/${relay.motebitId}/ledger/${goalId}`, {
              headers: relay.headers,
            });
            if (!res.ok) throw new Error(`${res.status}`);
            const ledger = (await res.json()) as LedgerManifest;
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
          ${event.timestamp != null ? `<span class="ledger-event-time">${formatTimeAgo(event.timestamp)}</span>` : ""}
        `;
        timeline.appendChild(entry);
      }

      container.appendChild(timeline);
    }
  }

  // === Budget Tab ===

  async function loadBudget(): Promise<void> {
    const relay = getRelayHeaders(ctx);
    if (!relay) {
      budgetSummary.innerHTML = "";
      budgetAllocList.innerHTML = "";
      budgetEmpty.style.display = "block";
      budgetEmpty.textContent = "Connect to a relay to view budget.";
      return;
    }

    try {
      const [balanceData, budgetData] = await Promise.all([
        fetch(`${relay.syncUrl}/api/v1/agents/${relay.motebitId}/balance`, {
          headers: relay.headers,
        })
          .then((r) => (r.ok ? (r.json() as Promise<BalanceResponse>) : null))
          .catch(() => null),
        fetch(`${relay.syncUrl}/agent/${relay.motebitId}/budget`, {
          headers: relay.headers,
        })
          .then((r) => (r.ok ? (r.json() as Promise<BudgetResponse>) : null))
          .catch(() => null),
      ]);

      budgetEmpty.style.display = "none";
      budgetSummary.innerHTML = "";
      budgetAllocList.innerHTML = "";

      // Balance section
      if (balanceData) {
        const balLabel = document.createElement("div");
        balLabel.style.cssText =
          "font-size:10px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-faint);margin-bottom:4px;";
        balLabel.textContent = "Balance";
        budgetSummary.appendChild(balLabel);

        const balValue = document.createElement("div");
        balValue.style.cssText =
          "font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--text-heading);margin-bottom:8px;";
        balValue.textContent = `${balanceData.balance.toFixed(2)} ${escapeHtml(balanceData.currency)}`;
        budgetSummary.appendChild(balValue);

        // Recent transactions (last 5)
        const recentTxns = balanceData.transactions.slice(0, 5);
        if (recentTxns.length > 0) {
          const txnHeader = document.createElement("div");
          txnHeader.style.cssText =
            "font-size:11px;font-weight:600;color:var(--text-secondary);margin:4px 0;";
          txnHeader.textContent = "Recent Transactions";
          budgetSummary.appendChild(txnHeader);

          for (const txn of recentTxns) {
            const txnRow = document.createElement("div");
            txnRow.style.cssText =
              "display:flex;align-items:center;gap:8px;padding:4px 0;font-size:11px;border-bottom:1px solid var(--border-light, rgba(255,255,255,0.06));";

            const isCredit =
              txn.type === "deposit" ||
              txn.type === "settlement_credit" ||
              txn.type === "allocation_release";
            const sign = isCredit ? "+" : "\u2212";
            const color = isCredit ? "var(--accent-green, #4ade80)" : "var(--text-secondary)";

            txnRow.innerHTML = `
              <span style="flex:0 0 auto;padding:1px 6px;border-radius:3px;background:var(--bg-card, rgba(255,255,255,0.04));color:var(--text-ghost);font-size:10px;">${escapeHtml(txn.type)}</span>
              <span style="flex:1;color:var(--text-ghost);">${escapeHtml(txn.description ?? "")}</span>
              <span style="color:${color};font-weight:500;white-space:nowrap;">${sign}${Math.abs(txn.amount).toFixed(4)}</span>
              <span style="color:var(--text-ghost);font-size:10px;white-space:nowrap;">${formatTimeAgo(txn.created_at)}</span>
            `;
            budgetSummary.appendChild(txnRow);
          }
        }
      }

      // Budget allocations
      if (budgetData) {
        const allocHeader = document.createElement("div");
        allocHeader.style.cssText = "display:flex;gap:12px;margin:8px 0;";
        allocHeader.innerHTML = `
          <div class="budget-metric">
            <span class="budget-metric-label">Total Locked</span>
            <span class="budget-metric-value">${budgetData.total_locked.toFixed(4)}</span>
          </div>
          <div class="budget-metric">
            <span class="budget-metric-label">Total Settled</span>
            <span class="budget-metric-value">${budgetData.total_settled.toFixed(4)}</span>
          </div>
        `;
        budgetAllocList.appendChild(allocHeader);

        if (budgetData.allocations != null && budgetData.allocations.length > 0) {
          for (const alloc of budgetData.allocations) {
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
              <span class="budget-alloc-time">${formatTimeAgo(alloc.created_at)}</span>
              ${alloc.settlement_status ? `<span class="budget-settlement-badge ${alloc.settlement_status}">${alloc.amount_settled?.toFixed(4) ?? ""} settled</span>` : ""}
            `;
            budgetAllocList.appendChild(row);
          }
        }
      }

      if (!balanceData && !budgetData) {
        budgetEmpty.style.display = "block";
        budgetEmpty.textContent = "No budget data available.";
      }
    } catch (err: unknown) {
      budgetSummary.innerHTML = "";
      budgetAllocList.innerHTML = "";
      budgetEmpty.style.display = "block";
      budgetEmpty.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // === Succession Tab ===

  async function loadSuccession(): Promise<void> {
    const relay = getRelayHeaders(ctx);
    if (!relay) {
      successionContent.innerHTML = "";
      successionEmpty.style.display = "block";
      successionEmpty.textContent = "Connect to a relay to view identity succession.";
      return;
    }

    try {
      const res = await fetch(`${relay.syncUrl}/api/v1/agents/${relay.motebitId}/succession`, {
        headers: relay.headers,
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as SuccessionResponse;

      successionContent.innerHTML = "";
      if (data.chain == null || data.chain.length === 0) {
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
            <span style="color:var(--text-secondary);">${formatTimeAgo(entry.timestamp)}</span>
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

  // === Open / Close ===

  function open(): void {
    sovereignPanel.classList.add("open");
    sovereignBackdrop.classList.add("open");
    void loadCredentials();
    void loadLedger();
    void loadBudget();
    void loadSuccession();
  }

  function close(): void {
    sovereignPanel.classList.remove("open");
    sovereignBackdrop.classList.remove("open");
  }

  // Event listeners
  document.getElementById("sovereign-btn")!.addEventListener("click", open);
  document.getElementById("sovereign-close-btn")!.addEventListener("click", close);
  sovereignBackdrop.addEventListener("click", close);

  return { open, close };
}
