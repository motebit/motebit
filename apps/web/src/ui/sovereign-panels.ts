// === Sovereign Panels: Credentials, Execution Ledger, Budget ===
// Fetches from the relay API to display credential, ledger, and budget data.

import type { WebContext } from "../types";
import { loadSyncUrl } from "../storage";
import { fetchSolanaBalanceUsdc, openSovereignFundingFlow } from "./wallet-balance";

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
  // Withdrawal-gating fields from the relay — surfaced on the operating row
  // when nonzero so users understand why `available_for_withdrawal` may
  // differ from `balance` during the 24h dispute window.
  pending_withdrawals?: number;
  pending_allocations?: number;
  dispute_window_hold?: number;
  available_for_withdrawal?: number;
  // Sovereign-wallet sweep config surfaced by the relay so the UI can render
  // the "operating → sovereign" relationship without a second round-trip.
  // Null when the motebit has not declared a settlement_address + threshold.
  sweep_threshold: number | null;
  settlement_address: string | null;
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

  /** Convert runtime-issued VCs to the same shape as relay CredentialEntry[]. */
  function localCredentialsToEntries(): CredentialEntry[] {
    const runtime = ctx.app.getRuntime();
    if (!runtime) return [];
    return runtime.getIssuedCredentials().map((vc: { type: string[]; validFrom?: string }) => ({
      credential_id: crypto.randomUUID(),
      credential_type:
        vc.type.find((t: string) => t !== "VerifiableCredential") ?? "VerifiableCredential",
      credential: vc as unknown as CredentialEntry["credential"],
      issued_at: vc.validFrom != null ? new Date(vc.validFrom).getTime() : Date.now(),
      _local: true,
    }));
  }

  /** Deduplicate credentials by issuer + type + subject, preferring newest. */
  function deduplicateCredentials(entries: CredentialEntry[]): CredentialEntry[] {
    const seen = new Map<string, CredentialEntry>();
    for (const entry of entries) {
      const issuer =
        typeof entry.credential.issuer === "string"
          ? entry.credential.issuer
          : String(entry.credential.issuer?.id ?? "");
      const subjectRaw = entry.credential.credentialSubject?.id;
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
    // Start with locally-persisted peer-issued credentials
    const localEntries = localCredentialsToEntries();

    // Try to merge with relay credentials if connected
    let relayEntries: CredentialEntry[] = [];
    const syncUrl = loadSyncUrl();
    if (syncUrl) {
      try {
        const data = (await relayFetch(ctx, `/api/v1/agents/${ctx.app.motebitId}/credentials`)) as {
          credentials: CredentialEntry[];
        };
        relayEntries = data.credentials ?? [];
      } catch {
        // Relay fetch failed — local credentials still display
      }
    }

    const allEntries = deduplicateCredentials([...localEntries, ...relayEntries]);

    credList.innerHTML = "";
    if (allEntries.length === 0) {
      credEmpty.style.display = "block";
      credEmpty.textContent = syncUrl
        ? "No credentials issued yet."
        : "No local credentials. Connect to a relay for more.";
      return;
    }

    credEmpty.style.display = "none";

    for (const entry of allEntries) {
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

        detail.innerHTML = "";

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
          ${event.timestamp != null ? `<span class="ledger-event-time">${formatDate(event.timestamp)}</span>` : ""}
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
      // Fetch balance and budget in parallel
      const [balanceData, budgetData] = await Promise.all([
        relayFetch(ctx, `/api/v1/agents/${ctx.app.motebitId}/balance`).catch(
          () => null,
        ) as Promise<BalanceResponse | null>,
        relayFetch(ctx, `/agent/${ctx.app.motebitId}/budget`).catch(
          () => null,
        ) as Promise<BudgetResponse | null>,
      ]);

      budgetEmpty.style.display = "none";
      budgetSummary.innerHTML = "";
      budgetList.innerHTML = "";

      // --- Balances section ---
      //
      // Two balances, two ownership regimes. The UX teaches the distinction
      // so users experience "operating + sovereign with auto-sweep" instead
      // of two numbers in different panels.
      //
      //   Sovereign reserve — onchain USDC at the motebit's Solana address.
      //                       The user owns this outright; nobody can freeze it.
      //   Operating balance — relay ledger claim in USD. Instant settlement,
      //                       escrow, dispute window; a clearinghouse ledger.
      //   Sweep readout     — when both sweep_threshold and settlement_address
      //                       are set, the operating balance auto-drains into
      //                       the sovereign reserve above the threshold. This
      //                       is the mechanism that proves the relay is a
      //                       utility, not a jail — surfacing it makes the
      //                       architecture legible.
      const balancesSection = document.createElement("div");
      balancesSection.className = "budget-balance-section";
      balancesSection.style.cssText = "display:flex;flex-direction:column;gap:10px;";

      // Kick off the sovereign balance RPC in parallel with rendering.
      const runtime = ctx.app.getRuntime();
      const sovereignAddress = runtime?.getSolanaAddress?.() ?? null;
      const sovereignBalancePromise = fetchSolanaBalanceUsdc(runtime);

      // --- Sovereign reserve row ---
      const sovereignRow = document.createElement("div");
      sovereignRow.className = "balance-row balance-row-sovereign";
      sovereignRow.style.cssText =
        "display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-subtle, rgba(255,255,255,0.06));";
      sovereignRow.innerHTML = `
        <div style="flex:1;">
          <div style="font-size:11px;color:var(--text-secondary);">Sovereign reserve</div>
          <div style="font-size:18px;font-weight:600;" id="sov-balance-sovereign">
            ${sovereignAddress ? "Loading…" : "—"}
          </div>
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
          const mid = runtime?.motebitId ?? ctx.app.motebitId;
          if (!mid) {
            ctx.showToast("No motebit identity — cannot create onramp session");
            return;
          }
          fundSovBtn.disabled = true;
          const original = fundSovBtn.textContent;
          fundSovBtn.textContent = "Opening…";
          void openSovereignFundingFlow(ctx, sovereignAddress, mid, () => {
            void loadBudget();
          }).finally(() => {
            fundSovBtn.disabled = false;
            fundSovBtn.textContent = original;
          });
        });
        sovereignRow.appendChild(fundSovBtn);
      }
      balancesSection.appendChild(sovereignRow);

      // Resolve sovereign balance asynchronously — display "—" on null.
      void sovereignBalancePromise.then((usdc) => {
        const el = document.getElementById("sov-balance-sovereign");
        if (!el) return; // Panel may have been re-rendered
        el.textContent = usdc != null ? `${usdc.toFixed(2)} USDC` : "—";
      });

      // --- Operating balance row ---
      if (balanceData) {
        const operatingRow = document.createElement("div");
        operatingRow.className = "balance-row balance-row-operating";
        operatingRow.style.cssText =
          "display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-subtle, rgba(255,255,255,0.06));";

        // Only show hold/available lines when nonzero — reduces visual noise
        // in the happy path. A relay with no recent settlements shows a
        // simpler row.
        const holdLines: string[] = [];
        const disputeHold = balanceData.dispute_window_hold ?? 0;
        if (disputeHold > 0) {
          holdLines.push(
            `<span style="color:var(--text-ghost);">on hold ${disputeHold.toFixed(2)}</span>`,
          );
        }
        const availableForWithdrawal = balanceData.available_for_withdrawal;
        if (availableForWithdrawal != null && availableForWithdrawal !== balanceData.balance) {
          holdLines.push(
            `<span style="color:var(--text-ghost);">available ${availableForWithdrawal.toFixed(2)}</span>`,
          );
        }

        operatingRow.innerHTML = `
          <div style="flex:1;">
            <div style="font-size:11px;color:var(--text-secondary);">Operating balance</div>
            <div style="font-size:18px;font-weight:600;">
              ${balanceData.balance.toFixed(2)} ${escapeHtml(balanceData.currency)}
            </div>
            <div style="font-size:10px;color:var(--text-ghost);margin-top:2px;">
              relay ledger, instant settlement${holdLines.length > 0 ? " · " + holdLines.join(" · ") : ""}
            </div>
          </div>
        `;
        // "Fund operating" lives in the Subscription panel's top-up UI —
        // duplicating the $5/$10/$25 picker here would be two widgets to
        // maintain. The row carries a link instead, staying calm per the
        // "don't confirm what the user can already see" doctrine.
        const fundOpLink = document.createElement("button");
        fundOpLink.className = "btn btn-small btn-ghost";
        fundOpLink.textContent = "Top up";
        fundOpLink.style.cssText = "flex:0 0 auto;";
        fundOpLink.addEventListener("click", () => {
          // Existing subscription panel handles amount selection + checkout.
          // Routing through it keeps one checkout path, one cached balance.
          ctx.showToast("Open the Subscription panel to top up");
        });
        operatingRow.appendChild(fundOpLink);
        balancesSection.appendChild(operatingRow);

        // --- Sweep configuration ---
        //
        // Three states:
        //   (a) threshold + address set → readout with edit + disable affordances
        //   (b) no threshold, address known → "Set auto-sweep threshold" CTA
        //   (c) no address available (no runtime wallet) → omit entirely
        //
        // The inline edit pattern keeps this calm — no modal, no confirm
        // dialog. Commits on Enter or Save click; reverts on Escape or Cancel.
        // On first-time enablement, default the destination to the motebit's
        // sovereign Solana address (the identity key's base58 form) — matches
        // the sovereign-exit thesis: the default destination is your own
        // wallet, not some relay-chosen address.
        const effectiveAddress = balanceData.settlement_address ?? sovereignAddress;
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
              // State (a): configured — readout + edit/disable
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
                void commitSweep(null, undefined);
              });
              line.appendChild(disableBtn);
            } else {
              // State (b): not configured — CTA
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
            editor.innerHTML = `
              <span style="font-style:italic;">Auto-sweep above $</span>
            `;
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
              // Pass the address if this is a first-time enablement so the
              // relay doesn't end up with a threshold but no destination.
              const needsAddress = balanceData.settlement_address !== address;
              void commitSweep(Math.round(dollars * 1_000_000), needsAddress ? address : undefined);
            };

            saveBtn.addEventListener("click", save);
            cancelBtn.addEventListener("click", cancel);
            input.addEventListener("keydown", (e) => {
              if (e.key === "Enter") save();
              else if (e.key === "Escape") cancel();
            });
          };

          const commitSweep = async (
            thresholdMicro: number | null,
            addressOverride: string | undefined,
          ): Promise<void> => {
            try {
              const body: Record<string, unknown> = { sweep_threshold: thresholdMicro };
              if (addressOverride !== undefined) body.settlement_address = addressOverride;
              const updated = (await relayFetch(
                ctx,
                `/api/v1/agents/${ctx.app.motebitId}/sweep-config`,
                { method: "PATCH", body },
              )) as { sweep_threshold: number | null; settlement_address: string | null };
              // Relay returns threshold in micro-units; convert for render.
              const dollars =
                updated.sweep_threshold != null ? updated.sweep_threshold / 1_000_000 : null;
              balanceData.sweep_threshold = dollars;
              balanceData.settlement_address = updated.settlement_address;
              renderSweep(dollars, updated.settlement_address ?? effectiveAddress);
            } catch (err) {
              ctx.showToast(
                `Sweep update failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          };

          renderSweep(balanceData.sweep_threshold, effectiveAddress);
        }
      }

      budgetSummary.appendChild(balancesSection);

      // --- Recent transactions (below balances, unchanged) ---
      if (balanceData) {
        const recentTxns = balanceData.transactions.slice(0, 5);
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

      // --- Budget allocations section ---
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
        budgetSummary.appendChild(allocHeader);

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
              <span class="budget-alloc-time">${formatDate(alloc.created_at)}</span>
              ${alloc.settlement_status ? `<span class="budget-settlement-badge ${alloc.settlement_status}">${alloc.amount_settled?.toFixed(4) ?? ""} settled</span>` : ""}
            `;
            budgetList.appendChild(row);
          }
        }
      }

      // Show empty state only if both failed or returned nothing
      if (!balanceData && !budgetData) {
        budgetEmpty.style.display = "block";
        budgetEmpty.textContent = "No budget data available.";
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
    old_key_signature?: string;
    new_key_signature: string;
    recovery?: boolean;
    guardian_signature?: string;
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
