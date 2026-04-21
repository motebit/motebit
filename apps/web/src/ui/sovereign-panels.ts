// === Sovereign Panels: Credentials, Execution Ledger, Budget, Succession ===
//
// The data layer — relay fetches, credential dedup, sweep-config state machine,
// revocation batch-check, sovereign balance resolution — lives in
// @motebit/panels. This file renders DOM from controller state and wires
// web-specific affordances (Fund sovereign onramp, top-up hint).

import type { WebContext } from "../types";
import { loadSyncUrl } from "../storage";
import { fetchSolanaBalanceUsdc, openSovereignFundingFlow } from "./wallet-balance";
import {
  createSovereignController,
  type CredentialEntry,
  type LedgerManifest,
  type SovereignController,
  type SovereignFetchAdapter,
  type SovereignFetchInit,
  type SovereignState,
} from "@motebit/panels";

export interface SovereignPanelsAPI {
  open(): void;
  close(): void;
}

// --- Time formatting (web-native) ---

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

// --- Adapter ---

// Web's sync auth is a rotating signed token minted per-call (`createSyncToken`).
// The controller asks the adapter for `fetch(path, init)`; this closure mints
// a fresh token on each request, dodging relay-side replay windows.
function createWebAdapter(ctx: WebContext): SovereignFetchAdapter {
  return {
    get syncUrl() {
      return loadSyncUrl();
    },
    get motebitId() {
      return ctx.app.motebitId || null;
    },
    async fetch(path: string, init?: SovereignFetchInit) {
      const syncUrl = loadSyncUrl();
      if (!syncUrl) throw new Error("No relay URL configured");
      const token = await ctx.app.createSyncToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      return fetch(`${syncUrl}${path}`, {
        method: init?.method ?? "GET",
        headers,
        body: init?.body != null ? JSON.stringify(init.body) : undefined,
      });
    },
    getSolanaAddress: () => ctx.app.getRuntime()?.getSolanaAddress?.() ?? null,
    getSolanaBalanceMicro: async () => {
      // web uses fetchSolanaBalanceUsdc (shared with settings); convert back to
      // micro so the controller's state.sovereignBalanceUsdc is uniform.
      const usdc = await fetchSolanaBalanceUsdc(ctx.app.getRuntime());
      return usdc != null ? Math.round(usdc * 1_000_000) : null;
    },
    getLocalCredentials: () => {
      const runtime = ctx.app.getRuntime();
      if (!runtime) return [];
      return runtime.getIssuedCredentials().map((vc: { type: string[]; validFrom?: string }) => ({
        credential_id: crypto.randomUUID(),
        credential_type:
          vc.type.find((t: string) => t !== "VerifiableCredential") ?? "VerifiableCredential",
        credential: vc as unknown as Record<string, unknown>,
        issued_at: vc.validFrom != null ? new Date(vc.validFrom).getTime() : Date.now(),
      })) as CredentialEntry[];
    },
  };
}

// --- Renderers ---

function renderCredentials(
  state: SovereignState,
  hasRelay: boolean,
  credList: HTMLDivElement,
  credEmpty: HTMLDivElement,
): void {
  credList.innerHTML = "";
  if (state.credentials.length === 0) {
    credEmpty.style.display = "block";
    credEmpty.textContent = hasRelay
      ? "No credentials issued yet."
      : "No local credentials. Connect to a relay for more.";
    return;
  }

  credEmpty.style.display = "none";

  for (const entry of state.credentials) {
    const item = document.createElement("div");
    item.className = "cred-item";

    const issuerRaw = entry.credential["issuer"];
    const issuerStr =
      typeof issuerRaw === "string"
        ? issuerRaw
        : typeof issuerRaw === "object" && issuerRaw != null && "id" in issuerRaw
          ? String((issuerRaw as Record<string, unknown>).id)
          : "unknown";

    const typeArray = entry.credential["type"] as string[] | undefined;
    const typeName =
      entry.credential_type !== "VerifiableCredential"
        ? entry.credential_type
        : (typeArray?.find((t) => t !== "VerifiableCredential") ?? "VerifiableCredential");

    item.innerHTML = `
      <div class="cred-item-header">
        <span class="cred-type-badge">${escapeHtml(typeName)}</span>
        <span class="cred-time">${formatDate(entry.issued_at)}</span>
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

function renderLedger(
  state: SovereignState,
  hasRelay: boolean,
  ctrl: SovereignController,
  ledgerList: HTMLDivElement,
  ledgerEmpty: HTMLDivElement,
): void {
  ledgerList.innerHTML = "";

  if (!hasRelay) {
    ledgerEmpty.style.display = "block";
    ledgerEmpty.textContent = "Connect to a relay to view execution ledger.";
    return;
  }

  if (state.goals.length === 0) {
    ledgerEmpty.style.display = "block";
    ledgerEmpty.textContent = "No completed goals yet. Execute a goal to generate a ledger.";
    return;
  }

  ledgerEmpty.style.display = "none";

  for (const goal of state.goals) {
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

      void ctrl.loadLedgerDetail(goal.goal_id).then((ledger) => {
        detail.dataset.loaded = "1";
        if (ledger) {
          renderLedgerDetail(detail, ledger);
        } else {
          detail.innerHTML =
            '<div style="font-size:11px;color:var(--text-ghost);padding:8px 0;">No ledger found for this goal.</div>';
        }
      });
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

  const sigBadge = document.createElement("span");
  sigBadge.className = `ledger-sig-badge ${ledger.signature ? "verified" : "unsigned"}`;
  sigBadge.textContent = ledger.signature ? "Signed" : "Unsigned";
  summary.appendChild(sigBadge);

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
        ${event.timestamp != null ? `<span class="ledger-event-time">${formatDate(event.timestamp)}</span>` : ""}
      `;
      timeline.appendChild(entry);
    }

    container.appendChild(timeline);
  }
}

function renderBudget(
  state: SovereignState,
  hasRelay: boolean,
  ctx: WebContext,
  ctrl: SovereignController,
  budgetSummary: HTMLDivElement,
  budgetList: HTMLDivElement,
  budgetEmpty: HTMLDivElement,
): void {
  budgetSummary.innerHTML = "";
  budgetList.innerHTML = "";

  if (!hasRelay) {
    budgetEmpty.style.display = "block";
    budgetEmpty.textContent = "Connect to a relay to view budget.";
    return;
  }

  // Always render the Sovereign reserve row (below) — it carries the onchain
  // USDC balance + "Fund sovereign" button, which is the user's only deposit
  // path. Short-circuiting on missing state.balance / state.budget blocked
  // fresh motebits from ever seeing the fund button; they'd land on "No
  // budget data available" and have no way to deposit. The row gracefully
  // degrades to "no wallet configured" when the sovereign address isn't
  // resolvable, so there's no scenario where hiding it reads cleaner than
  // showing it. Operating balance + budget allocations below are already
  // individually guarded.
  budgetEmpty.style.display = "none";

  // Sovereign reserve + operating balance, rendered with the sweep readout so
  // the UX teaches "relay is a utility, not a jail". Web adds a "Fund sovereign"
  // CTA that routes through openSovereignFundingFlow (Stripe onramp session).
  const balancesSection = document.createElement("div");
  balancesSection.className = "budget-balance-section";
  balancesSection.style.cssText = "display:flex;flex-direction:column;gap:10px;";

  const sovereignAddress = state.sovereignAddress;

  const sovereignRow = document.createElement("div");
  sovereignRow.className = "balance-row balance-row-sovereign";
  sovereignRow.style.cssText =
    "display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-subtle, rgba(255,255,255,0.06));";
  const sovText =
    state.sovereignBalanceUsdc != null
      ? `${state.sovereignBalanceUsdc.toFixed(2)} USDC`
      : sovereignAddress
        ? "Loading…"
        : "—";
  sovereignRow.innerHTML = `
    <div style="flex:1;">
      <div style="font-size:11px;color:var(--text-secondary);">Sovereign reserve</div>
      <div style="font-size:18px;font-weight:600;">${sovText}</div>
      <div style="font-size:10px;color:var(--text-ghost);margin-top:2px;">
        ${sovereignAddress ? "onchain USDC, yours" : "no wallet configured"}
      </div>
    </div>
  `;
  if (sovereignAddress) {
    const fundSovBtn = document.createElement("button");
    fundSovBtn.className = "btn btn-small";
    fundSovBtn.textContent = "Fund sovereign";
    fundSovBtn.style.cssText = "flex:0 0 auto;";
    fundSovBtn.addEventListener("click", () => {
      const mid = ctx.app.motebitId;
      if (!mid) {
        ctx.showToast("No motebit identity — cannot create onramp session");
        return;
      }
      fundSovBtn.disabled = true;
      const original = fundSovBtn.textContent;
      fundSovBtn.textContent = "Opening…";
      void openSovereignFundingFlow(ctx, sovereignAddress, mid, () => {
        void ctrl.refresh();
      }).finally(() => {
        fundSovBtn.disabled = false;
        fundSovBtn.textContent = original;
      });
    });
    sovereignRow.appendChild(fundSovBtn);
  }
  balancesSection.appendChild(sovereignRow);

  if (state.balance) {
    const balance = state.balance;
    const operatingRow = document.createElement("div");
    operatingRow.className = "balance-row balance-row-operating";
    operatingRow.style.cssText =
      "display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-subtle, rgba(255,255,255,0.06));";

    const holdLines: string[] = [];
    const disputeHold = balance.dispute_window_hold ?? 0;
    if (disputeHold > 0) {
      holdLines.push(
        `<span style="color:var(--text-ghost);">on hold ${disputeHold.toFixed(2)}</span>`,
      );
    }
    const availableForWithdrawal = balance.available_for_withdrawal;
    if (availableForWithdrawal != null && availableForWithdrawal !== balance.balance) {
      holdLines.push(
        `<span style="color:var(--text-ghost);">available ${availableForWithdrawal.toFixed(2)}</span>`,
      );
    }

    operatingRow.innerHTML = `
      <div style="flex:1;">
        <div style="font-size:11px;color:var(--text-secondary);">Operating balance</div>
        <div style="font-size:18px;font-weight:600;">
          ${balance.balance.toFixed(2)} ${escapeHtml(balance.currency)}
        </div>
        <div style="font-size:10px;color:var(--text-ghost);margin-top:2px;">
          relay ledger, instant settlement${holdLines.length > 0 ? " · " + holdLines.join(" · ") : ""}
        </div>
      </div>
    `;

    // "Fund operating" lives in the Subscription panel's top-up UI — routing
    // through it keeps one checkout path, one cached balance.
    const fundOpLink = document.createElement("button");
    fundOpLink.className = "btn btn-small btn-ghost";
    fundOpLink.textContent = "Top up";
    fundOpLink.style.cssText = "flex:0 0 auto;";
    fundOpLink.addEventListener("click", () => {
      ctx.showToast("Open the Subscription panel to top up");
    });
    operatingRow.appendChild(fundOpLink);
    balancesSection.appendChild(operatingRow);

    // Sweep-config inline editor — three states per the desktop pattern.
    const effectiveAddress = balance.settlement_address ?? sovereignAddress;
    if (effectiveAddress) {
      const sweepBlock = document.createElement("div");
      sweepBlock.style.cssText = "padding:4px 0 8px;";
      balancesSection.appendChild(sweepBlock);

      const renderSweep = (threshold: number | null, address: string): void => {
        sweepBlock.innerHTML = "";
        const line = document.createElement("div");
        line.style.cssText =
          "display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-ghost);";

        if (threshold != null) {
          const txt = document.createElement("span");
          txt.style.cssText = "font-style:italic;flex:1;";
          txt.textContent = `Auto-sweep above $${threshold.toFixed(2)} → your sovereign wallet`;
          line.appendChild(txt);

          const editBtn = document.createElement("button");
          editBtn.className = "btn btn-small btn-ghost";
          editBtn.textContent = "edit";
          editBtn.style.cssText = "font-size:10px;padding:2px 6px;";
          editBtn.addEventListener("click", () => openEditor(threshold, address));
          line.appendChild(editBtn);

          const disableBtn = document.createElement("button");
          disableBtn.className = "btn btn-small btn-ghost";
          disableBtn.textContent = "disable";
          disableBtn.style.cssText = "font-size:10px;padding:2px 6px;";
          disableBtn.addEventListener("click", () => {
            void commitSweepAndRender(null, undefined);
          });
          line.appendChild(disableBtn);
        } else {
          const cta = document.createElement("button");
          cta.className = "btn btn-small btn-ghost";
          cta.style.cssText = "font-size:11px;font-style:italic;";
          cta.textContent = "+ Set auto-sweep threshold";
          cta.addEventListener("click", () => openEditor(null, address));
          line.appendChild(cta);
        }

        sweepBlock.appendChild(line);
      };

      const openEditor = (currentThreshold: number | null, address: string): void => {
        sweepBlock.innerHTML = "";
        const editor = document.createElement("div");
        editor.style.cssText =
          "display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-ghost);";
        editor.innerHTML = `<span style="font-style:italic;">Auto-sweep above $</span>`;
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "0.01";
        input.style.cssText =
          "width:64px;padding:2px 6px;border:1px solid var(--border-subtle,rgba(255,255,255,0.15));border-radius:3px;background:transparent;color:var(--text-heading);font-size:11px;";
        input.value = currentThreshold != null ? String(currentThreshold) : "";
        input.placeholder = "50";
        editor.appendChild(input);
        const trailing = document.createElement("span");
        trailing.style.cssText = "font-style:italic;flex:1;";
        trailing.textContent = " → your sovereign wallet";
        editor.appendChild(trailing);

        const saveBtn = document.createElement("button");
        saveBtn.className = "btn btn-small";
        saveBtn.textContent = "save";
        saveBtn.style.cssText = "font-size:10px;padding:2px 6px;";
        editor.appendChild(saveBtn);

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "btn btn-small btn-ghost";
        cancelBtn.textContent = "cancel";
        cancelBtn.style.cssText = "font-size:10px;padding:2px 6px;";
        editor.appendChild(cancelBtn);

        sweepBlock.appendChild(editor);
        input.focus();
        input.select();

        const cancel = (): void => renderSweep(currentThreshold, address);
        const save = (): void => {
          const dollars = Number(input.value);
          if (!Number.isFinite(dollars) || dollars < 0) {
            ctx.showToast("Threshold must be a non-negative number");
            return;
          }
          const needsAddress = balance.settlement_address !== address;
          void commitSweepAndRender(
            Math.round(dollars * 1_000_000),
            needsAddress ? address : undefined,
          );
        };

        saveBtn.addEventListener("click", save);
        cancelBtn.addEventListener("click", cancel);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") save();
          else if (e.key === "Escape") cancel();
        });
      };

      const commitSweepAndRender = async (
        thresholdMicro: number | null,
        addressOverride: string | undefined,
      ): Promise<void> => {
        const before = ctrl.getState().error;
        await ctrl.commitSweep(thresholdMicro, addressOverride);
        const s = ctrl.getState();
        if (s.error && s.error !== before) {
          ctx.showToast(`Sweep update failed: ${s.error}`);
          return;
        }
        renderSweep(
          s.balance?.sweep_threshold ?? null,
          s.balance?.settlement_address ?? effectiveAddress,
        );
      };

      renderSweep(balance.sweep_threshold, effectiveAddress);
    }
  }

  budgetSummary.appendChild(balancesSection);

  // Recent transactions
  if (state.balance) {
    const recentTxns = state.balance.transactions.slice(0, 5);
    if (recentTxns.length > 0) {
      const txnSection = document.createElement("div");
      const txnHeader = document.createElement("div");
      txnHeader.style.cssText =
        "font-size:11px;font-weight:600;color:var(--text-secondary);margin:8px 0 4px;";
      txnHeader.textContent = "Recent Transactions";
      txnSection.appendChild(txnHeader);

      for (const txn of recentTxns) {
        const txnRow = document.createElement("div");
        txnRow.style.cssText =
          "display:flex;align-items:center;gap:8px;padding:4px 0;font-size:11px;border-bottom:1px solid var(--border-subtle, rgba(255,255,255,0.06));";

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
          <span style="color:var(--text-ghost);font-size:10px;white-space:nowrap;">${formatDate(txn.created_at)}</span>
        `;
        txnSection.appendChild(txnRow);
      }
      budgetSummary.appendChild(txnSection);
    }
  }

  // Budget allocations
  if (state.budget) {
    const budget = state.budget;
    const allocHeader = document.createElement("div");
    allocHeader.style.cssText = "display:flex;gap:12px;margin:8px 0;";
    allocHeader.innerHTML = `
      <div class="budget-metric">
        <span class="budget-metric-label">Total Locked</span>
        <span class="budget-metric-value">${budget.total_locked.toFixed(4)}</span>
      </div>
      <div class="budget-metric">
        <span class="budget-metric-label">Total Settled</span>
        <span class="budget-metric-value">${budget.total_settled.toFixed(4)}</span>
      </div>
    `;
    budgetSummary.appendChild(allocHeader);

    if (budget.allocations.length > 0) {
      for (const alloc of budget.allocations) {
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
    }
  }
}

function renderSuccession(
  state: SovereignState,
  hasRelay: boolean,
  successionContent: HTMLDivElement,
  successionEmpty: HTMLDivElement,
): void {
  successionContent.innerHTML = "";

  if (!hasRelay) {
    successionEmpty.style.display = "block";
    successionEmpty.textContent = "Connect to a relay to view identity succession.";
    return;
  }

  const data = state.succession;
  if (!data || data.chain.length === 0) {
    successionEmpty.style.display = "block";
    successionEmpty.textContent = data ? "No key rotations." : "Failed to load succession chain.";
    return;
  }

  successionEmpty.style.display = "none";

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
}

// --- Init ---

export function initSovereignPanels(ctx: WebContext): SovereignPanelsAPI {
  const panel = document.getElementById("sovereign-panel") as HTMLDivElement;
  const backdrop = document.getElementById("sovereign-backdrop") as HTMLDivElement;

  const tabBtns = Array.from(panel.querySelectorAll<HTMLButtonElement>(".sov-tab"));
  const tabPanes = Array.from(panel.querySelectorAll<HTMLDivElement>(".sov-pane"));

  const credList = document.getElementById("cred-list") as HTMLDivElement;
  const credEmpty = document.getElementById("cred-empty") as HTMLDivElement;
  const credPresentBtn = document.getElementById("cred-present-btn") as HTMLButtonElement;
  const credVpOutput = document.getElementById("cred-vp-output") as HTMLDivElement;
  const credVpJson = document.getElementById("cred-vp-json") as HTMLPreElement;
  const credVpCopyBtn = document.getElementById("cred-vp-copy-btn") as HTMLButtonElement;
  const credVerifyInput = document.getElementById("cred-verify-input") as HTMLTextAreaElement;
  const credVerifyBtn = document.getElementById("cred-verify-btn") as HTMLButtonElement;
  const credVerifyResult = document.getElementById("cred-verify-result") as HTMLDivElement;

  const ledgerList = document.getElementById("ledger-list") as HTMLDivElement;
  const ledgerEmpty = document.getElementById("ledger-empty") as HTMLDivElement;

  const budgetSummary = document.getElementById("budget-summary") as HTMLDivElement;
  const budgetList = document.getElementById("budget-alloc-list") as HTMLDivElement;
  const budgetEmpty = document.getElementById("budget-empty") as HTMLDivElement;

  const successionContent = document.getElementById("succession-content") as HTMLDivElement;
  const successionEmpty = document.getElementById("succession-empty") as HTMLDivElement;

  const adapter = createWebAdapter(ctx);
  const ctrl = createSovereignController(adapter);

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

  function renderAll(state: SovereignState): void {
    const hasRelayConfigured = adapter.syncUrl != null;
    renderCredentials(state, hasRelayConfigured, credList, credEmpty);
    renderLedger(state, hasRelayConfigured, ctrl, ledgerList, ledgerEmpty);
    renderBudget(state, hasRelayConfigured, ctx, ctrl, budgetSummary, budgetList, budgetEmpty);
    renderSuccession(state, hasRelayConfigured, successionContent, successionEmpty);
  }

  ctrl.subscribe(renderAll);

  // Present / verify / copy
  credPresentBtn.addEventListener("click", () => {
    void ctrl.present().then((presentation) => {
      if (presentation) {
        credVpJson.textContent = JSON.stringify(presentation, null, 2);
        credVpOutput.style.display = "block";
      } else {
        const err = ctrl.getState().error;
        ctx.showToast(`Presentation failed: ${err ?? "unknown"}`);
      }
    });
  });

  credVpCopyBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(credVpJson.textContent ?? "");
    ctx.showToast("Copied to clipboard");
  });

  credVerifyBtn.addEventListener("click", () => {
    const raw = credVerifyInput.value.trim();
    if (!raw) return;
    void (async () => {
      try {
        const parsed: unknown = JSON.parse(raw);
        const result = await ctrl.verify(parsed);
        credVerifyResult.style.display = "block";
        if (result.valid) {
          credVerifyResult.className = "cred-verify-badge valid";
          credVerifyResult.textContent = "Valid";
        } else {
          credVerifyResult.className = "cred-verify-badge invalid";
          credVerifyResult.textContent = `Invalid: ${result.reason ?? "signature check failed"}`;
        }
      } catch (err: unknown) {
        credVerifyResult.style.display = "block";
        credVerifyResult.className = "cred-verify-badge invalid";
        credVerifyResult.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  });

  function open(): void {
    panel.classList.add("open");
    backdrop.classList.add("open");
    void ctrl.refresh();
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
