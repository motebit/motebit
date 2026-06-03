// === Sovereign Panels: Credentials, Execution Ledger, Budget, Succession ===
//
// The data layer — relay fetches, credential dedup, sweep-config state machine,
// revocation batch-check, sovereign balance resolution — lives in
// @motebit/panels. This file renders DOM from controller state and wires
// web-specific affordances (Fund sovereign onramp, top-up hint).

import type { WebContext } from "../types";
import { toMicro, ACCOUNT_BALANCE_AUDIENCE } from "@motebit/sdk";
import { loadSyncUrl } from "../storage";
import { fetchSolanaBalanceUsdc, openSovereignFundingFlow } from "./wallet-balance";
import { setEmptyPulse } from "./empty-states";
import {
  createSovereignController,
  type CredentialEntry,
  type LedgerManifest,
  type SovereignController,
  type SovereignFetchAdapter,
  type SovereignFetchInit,
  type SovereignState,
  type VerifiedFetchResult,
} from "@motebit/panels";
import {
  fetchTransparencyAnchor,
  verifiedStateExportFetch,
  type TransparencyAnchor,
} from "@motebit/state-export-client";

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

function truncate(text: string | null | undefined, max: number): string {
  // A render utility must never throw on partial/null data (CLAUDE.md UI
  // doctrine — degrade honestly). Nullish in → empty out; callers that want
  // a visible placeholder substitute their own ("—") before calling.
  if (text == null) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

// --- Trust-anchor bootstrap (TOFU, one fetch per session) ---
//
// `/.well-known/motebit-transparency.json` pins the relay's signing key.
// Cached after the first successful fetch so every verified state-export
// call checks against the same pinned key (a key swap → producer_key_mismatch
// rather than silent acceptance). Mirrors apps/inspector/src/api.ts. A failed
// bootstrap is non-fatal: verification proceeds anchor-less (self-consistency
// only), matching the inspector's degrade path.
let cachedAnchor: TransparencyAnchor | undefined;
let anchorInflight: Promise<TransparencyAnchor | undefined> | undefined;

async function bootstrapAnchor(syncUrl: string): Promise<TransparencyAnchor | undefined> {
  if (cachedAnchor !== undefined) return cachedAnchor;
  if (anchorInflight !== undefined) return anchorInflight;
  anchorInflight = (async () => {
    try {
      const result = await fetchTransparencyAnchor(syncUrl);
      if (result.ok) {
        cachedAnchor = result.anchor;
        return result.anchor;
      }
    } catch {
      // Network/parse failure — degrade to anchor-less verification.
    }
    return undefined;
  })();
  try {
    return await anchorInflight;
  } finally {
    anchorInflight = undefined;
  }
}

// --- Adapter ---

// Audience binding is per-endpoint (relay CLAUDE.md rule 5 — a token minted
// for one purpose is rejected by an endpoint expecting another). The balance
// endpoint's `dualAuth` enforces `account:balance` (services/relay/middleware.ts);
// a `sync`-audience token there fails verification → 401, which the controller
// swallowed into a null balance → the panel showed a false `0.00` operating
// balance even with funds in the relay ledger. Mint the audience the route
// expects. Default stays `sync` (the general relay-state audience) for every
// other path. Only canonical `TokenAudience` values appear here so
// `check-audience-canonical` stays green.
function audienceForPath(path: string): string {
  if (path.includes("/balance")) return ACCOUNT_BALANCE_AUDIENCE;
  return "sync";
}

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
      const token = await ctx.app.createSyncToken(audienceForPath(path));
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
    // Verified fetch for relay state-export endpoints (the controller routes
    // `/api/v1/goals/...` through this). Same per-call signed-token auth as
    // `fetch`, then verifies the `X-Motebit-Content-Manifest` against the
    // body and the pinned transparency anchor — so the relay cannot
    // equivocate about the user's own ledger undetected. Doctrine:
    // docs/doctrine/self-attesting-system.md.
    async verifiedFetch(path: string, init?: SovereignFetchInit): Promise<VerifiedFetchResult> {
      const syncUrl = loadSyncUrl();
      if (!syncUrl) throw new Error("No relay URL configured");
      const token = await ctx.app.createSyncToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const anchor = await bootstrapAnchor(syncUrl);
      const res = await verifiedStateExportFetch<unknown>(`${syncUrl}${path}`, {
        ...(anchor !== undefined && { anchor }),
        init: {
          method: init?.method ?? "GET",
          headers,
          body: init?.body != null ? JSON.stringify(init.body) : undefined,
        },
      });
      // Never surface unverified bytes: body is null unless the manifest
      // verified. `valid:false` → tampering/equivocation signal.
      return {
        ok: true,
        json: res.verification.valid ? res.body : null,
        verification: res.verification.valid ? "verified" : "failed",
      };
    },
    getSolanaAddress: () => ctx.app.getRuntime()?.getSolanaAddress?.() ?? null,
    getSolanaBalanceMicro: async () => {
      // web uses fetchSolanaBalanceUsdc (shared with settings); convert back to
      // micro so the controller's state.sovereignBalanceUsdc is uniform.
      const usdc = await fetchSolanaBalanceUsdc(ctx.app.getRuntime());
      return usdc != null ? toMicro(usdc) : null;
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
    // Local-first Identity tab support — reads the bootstrap
    // IdentityCreated event from the local event store. Closes the
    // protocol-primacy audit gap for the Identity tab: a user without
    // a relay can now see "who they are, when they were born, what key
    // they currently sign with" without any relay call. Relay-fetched
    // succession history (cross-device key rotations) appends on top
    // when present. Doctrine: docs/doctrine/protocol-primacy.md.
    getLocalIdentity: async () => {
      const local = await ctx.app.getLocalIdentity();
      if (!local) return null;
      return {
        motebitId: local.motebitId,
        createdAt: local.createdAt,
        publicKeyHex: local.publicKeyHex,
        ownerId: local.ownerId,
      };
    },
    // Local-first Ledger tab support — reads executed goals from the
    // GoalsRunner state (the local source of truth). Controller merges
    // with relay-fetched goals; local wins on goal_id collision (signed
    // locally is canonical, relay is mirror). Sync underneath; wrapped
    // in Promise.resolve to match the adapter's Promise return type
    // (the future ExecutionReceipt-aggregation arc will become genuinely
    // async — verifying signatures takes IO).
    // Doctrine: docs/doctrine/receipts-unified.md (the motebit's own
    // signed receipts are the source of execution proof-of-work).
    getLocalLedger: () => Promise.resolve(ctx.app.getLocalLedger()),
  };
}

// --- Renderers ---

function renderCredentials(
  state: SovereignState,
  _hasRelay: boolean,
  credList: HTMLDivElement,
  credEmpty: HTMLDivElement,
): void {
  credList.innerHTML = "";
  // Local-first per protocol-primacy: the controller's fetchCredentials()
  // already merges adapter.getLocalCredentials() (motebit's self-issued
  // VCs) with relay-augmented credentials. The renderer reads from state,
  // never from relay-connection status. If state.credentials is empty,
  // it's because the local credential store is empty AND no relay
  // augmentation arrived — flat ghost text per the non-voided carve-out
  // (this tab always has Bundle Presentation + Verify Credential CTAs
  // below as sibling content).
  if (state.credentials.length === 0) {
    credEmpty.className = "panel-empty-row";
    credEmpty.textContent = "Issued credentials appear here";
    credEmpty.style.display = "block";
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
  _hasRelay: boolean,
  ctrl: SovereignController,
  ledgerList: HTMLDivElement,
  ledgerEmpty: HTMLDivElement,
): void {
  ledgerList.innerHTML = "";

  // Local-first per protocol-primacy: the renderer reads from state,
  // not from relay-availability. state.goals is currently populated
  // via relay-only fetch (the controller's fetchGoals path). A proper
  // local-first fix needs a getLocalLedger() adapter accessor that
  // queries the local event store for execution receipts — deferred
  // to the local-event-store-integration arc. For now the empty
  // caption describes what fills the panel without invoking the relay.
  if (state.goals.length === 0) {
    setEmptyPulse(ledgerEmpty, "Execution history appears here", "as goals complete");
    return;
  }

  ledgerEmpty.style.display = "none";

  // Self-attesting payoff: show that the relay-fetched ledger was
  // cryptographically verified, not merely trusted. Calm — `verified` is a
  // muted line (the user need not act); `failed` is a prominent warning (a
  // tampering/equivocation signal, per UI doctrine a security message);
  // `unverified` shows nothing (no relay verification ran — don't clutter).
  // Doctrine: docs/doctrine/self-attesting-system.md.
  if (state.ledgerVerification !== "unverified") {
    const verified = state.ledgerVerification === "verified";
    const badge = document.createElement("div");
    badge.className = "ledger-verification";
    badge.style.cssText = `font-size:11px;margin-bottom:8px;letter-spacing:0.02em;${
      verified ? "opacity:0.55;" : "color:#c0392b;font-weight:600;"
    }`;
    badge.textContent = verified
      ? "✓ Verified — signed by the relay, checked against the pinned key"
      : "⚠ Verification failed — this ledger may have been altered in transit";
    ledgerList.appendChild(badge);
  }

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
  _hasRelay: boolean,
  ctx: WebContext,
  ctrl: SovereignController,
  budgetSummary: HTMLDivElement,
  budgetList: HTMLDivElement,
  budgetEmpty: HTMLDivElement,
): void {
  budgetSummary.innerHTML = "";
  budgetList.innerHTML = "";

  // Local-first per protocol-primacy: the Sovereign reserve row reads
  // its USDC balance via direct Solana RPC (no relay needed); the
  // operating balance + budget allocations below are relay-augmented
  // and individually guarded on state.balance / state.budget being
  // null. The pre-existing early-return on !hasRelay was a doctrine
  // violation — it hid the Sovereign reserve (and the Fund button)
  // from users without a relay, even though their on-chain balance is
  // viewable + depositable without one. The relay is a sync layer,
  // not a gate on viewing your own wallet.

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
  // Both balances render as .sov-hero-card sub-surfaces: the number is the
  // hero (display weight + tabular-nums), label sits small above it, subtitle
  // below. Two registers, paired:
  //   - Substrate-honest default — when state has no value AND no error, render
  //     `0.00 USDC` (the protocol-default; an unfunded motebit IS at zero). Not
  //     a skeleton — the skeleton was the same anti-pattern as a literal
  //     "Loading…" string in another shape, hedging "we don't know" over a
  //     truth we know.
  //   - Failure-explicit register — when refresh failed AND we have no prior
  //     value to fall back on, show one `.sov-error-row` with a Retry above the
  //     cards, and render "—" in each card's value slot. Reading them together
  //     resolves to "we tried, we couldn't" instead of the lie "$0" would tell
  //     when the actual balance is unknown.
  // The pair is the full application of "fail-explicit, not fail-hedged" — the
  // substrate is honest, the exception is loud.
  const balancesSection = document.createElement("div");
  balancesSection.className = "budget-balance-section";
  balancesSection.style.cssText = "display:flex;flex-direction:column;gap:12px;";

  const sovereignAddress = state.sovereignAddress;

  // Failure-explicit register — the controller's refresh runs all
  // fetches under a single Promise.all so any failure trips the shared
  // `state.error` and leaves prior-good state intact (per
  // packages/panels/CLAUDE.md rule 5). The first-load case is the one
  // where both balance slots are also still null — that's a true
  // unknown, not a refresh-after-success drop. Surface it once at the
  // top of the section with a retry, then the cards below render "—"
  // in their value slots so the user reads "we tried, we couldn't"
  // instead of "you have $0" (the lie in the wrong direction). The
  // mirror of the succession-tab error row, narrowed to the cold-load
  // path where the substrate-honest default would mislead.
  // A balance is "unknown" (show "—" + retry) when either the whole refresh
  // tripped `state.error` on a cold load, OR the onchain balance read itself
  // failed (`sovereignBalanceError` — e.g. the browser's Solana RPC 403-ing).
  // The latter is the load-bearing case: without it, an unreachable RPC reads
  // as a false `0.00` (the lie that told the user their funded wallet was empty).
  const balancesFailedToLoad =
    (state.error != null || state.sovereignBalanceError) &&
    state.balance == null &&
    state.sovereignBalanceUsdc == null;
  if (balancesFailedToLoad) {
    const errorRow = document.createElement("div");
    errorRow.className = "sov-error-row";
    errorRow.style.margin = "0";
    const errorText = document.createElement("span");
    errorText.className = "sov-error-row-text";
    errorText.textContent = "Couldn't refresh balances";
    const retryBtn = document.createElement("button");
    retryBtn.className = "sov-error-row-retry";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", () => {
      retryBtn.disabled = true;
      retryBtn.textContent = "Retrying…";
      void ctrl.refresh().finally(() => {
        retryBtn.disabled = false;
        retryBtn.textContent = "Retry";
      });
    });
    errorRow.appendChild(errorText);
    errorRow.appendChild(retryBtn);
    balancesSection.appendChild(errorRow);
  }

  const sovereignCard = document.createElement("div");
  sovereignCard.className = "sov-hero-card";

  const sovBody = document.createElement("div");
  sovBody.className = "sov-hero-body";

  const sovLabel = document.createElement("div");
  sovLabel.className = "sov-hero-label";
  sovLabel.textContent = "Sovereign reserve";
  sovBody.appendChild(sovLabel);

  if (state.sovereignBalanceUsdc != null) {
    const sovValue = document.createElement("div");
    sovValue.className = "sov-hero-value";
    sovValue.innerHTML = `${escapeHtml(state.sovereignBalanceUsdc.toFixed(2))}<span class="sov-hero-unit">USDC</span>`;
    sovBody.appendChild(sovValue);
  } else if (sovereignAddress) {
    const sovValue = document.createElement("div");
    sovValue.className = "sov-hero-value";
    if (balancesFailedToLoad || state.sovereignBalanceError) {
      // Failure-explicit: refresh tried, refresh couldn't. "—" here
      // resolves cleanly to "we don't know" instead of the lie
      // "$0.00" would tell when the actual balance is unknown. Keyed
      // on `sovereignBalanceError` directly (not just the cold-load
      // `balancesFailedToLoad`) so a failed onchain read shows "—"
      // even when the relay operating balance loaded fine.
      sovValue.textContent = "—";
    } else {
      // Substrate-honest default: an unfunded motebit IS at $0
      // onchain. The slot is always-already there, the value is
      // always-already zero until a deposit lands. When the Solana
      // RPC fetch resolves, a non-zero balance overwrites this; the
      // typical case (new motebit) sees $0 → $0 (no visible change).
      // No skeleton, no shimmer — those would hedge "loading" over
      // a truth we know.
      sovValue.innerHTML = `0.00<span class="sov-hero-unit">USDC</span>`;
    }
    sovBody.appendChild(sovValue);
  } else {
    const sovValue = document.createElement("div");
    sovValue.className = "sov-hero-value";
    sovValue.textContent = "—";
    sovBody.appendChild(sovValue);
  }

  const sovSubtitle = document.createElement("div");
  sovSubtitle.className = "sov-hero-subtitle";
  sovSubtitle.textContent = sovereignAddress ? "onchain USDC, yours" : "no wallet configured";
  sovBody.appendChild(sovSubtitle);

  sovereignCard.appendChild(sovBody);

  if (sovereignAddress) {
    const fundSovBtn = document.createElement("button");
    fundSovBtn.className = "panel-action-pill";
    fundSovBtn.textContent = "Fund";
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
    sovereignCard.appendChild(fundSovBtn);
  }
  balancesSection.appendChild(sovereignCard);

  // Operating balance card — always rendered (symmetric with sovereign
  // reserve above), so the slab carries both balance slots regardless
  // of whether relay data has landed yet. Substrate-honest $0.00 USDC
  // default when state.balance is null (a brand-new motebit has nothing
  // in the relay ledger yet); real number + sweep config + Top-up
  // affordance when loaded.
  const operatingCard = document.createElement("div");
  operatingCard.className = "sov-hero-card";

  const opBody = document.createElement("div");
  opBody.className = "sov-hero-body";

  const opLabel = document.createElement("div");
  opLabel.className = "sov-hero-label";
  opLabel.textContent = "Operating balance";
  opBody.appendChild(opLabel);

  if (state.balance) {
    const balance = state.balance;

    const opValue = document.createElement("div");
    opValue.className = "sov-hero-value";
    opValue.innerHTML = `${escapeHtml(balance.balance.toFixed(2))}<span class="sov-hero-unit">${escapeHtml(balance.currency)}</span>`;
    opBody.appendChild(opValue);

    const opSubParts: string[] = ["relay ledger, instant settlement"];
    const disputeHold = balance.dispute_window_hold ?? 0;
    if (disputeHold > 0) opSubParts.push(`on hold ${disputeHold.toFixed(2)}`);
    const availableForWithdrawal = balance.available_for_withdrawal;
    if (availableForWithdrawal != null && availableForWithdrawal !== balance.balance) {
      opSubParts.push(`available ${availableForWithdrawal.toFixed(2)}`);
    }
    const opSubtitle = document.createElement("div");
    opSubtitle.className = "sov-hero-subtitle";
    opSubtitle.textContent = opSubParts.join(" · ");
    opBody.appendChild(opSubtitle);
  } else {
    const opValue = document.createElement("div");
    opValue.className = "sov-hero-value";
    if (balancesFailedToLoad) {
      // Failure-explicit, paired with the error row above. Same
      // logic as the sovereign reserve card.
      opValue.textContent = "—";
    } else {
      // Substrate-honest default — symmetric with sovereign reserve
      // above. A new motebit's relay ledger starts at zero; render
      // the truth, not a shimmer. When the fetch resolves, a
      // non-zero balance overwrites; the typical case sees $0 → $0.
      opValue.innerHTML = `0.00<span class="sov-hero-unit">USDC</span>`;
    }
    opBody.appendChild(opValue);
    const opSubtitle = document.createElement("div");
    opSubtitle.className = "sov-hero-subtitle";
    opSubtitle.textContent = "relay ledger, instant settlement";
    opBody.appendChild(opSubtitle);
  }

  operatingCard.appendChild(opBody);

  if (state.balance) {
    // "Fund operating" lives in the Subscription panel's top-up UI —
    // routing through it keeps one checkout path, one cached balance.
    // Only render the affordance when balance data exists; pre-data
    // there's nothing meaningful to top up.
    const fundOpLink = document.createElement("button");
    fundOpLink.className = "panel-action-ghost";
    fundOpLink.textContent = "Top up";
    fundOpLink.addEventListener("click", () => {
      ctx.showToast("Open the Subscription panel to top up");
    });
    operatingCard.appendChild(fundOpLink);
  }
  balancesSection.appendChild(operatingCard);

  if (state.balance) {
    const balance = state.balance;

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
          void commitSweepAndRender(toMicro(dollars), needsAddress ? address : undefined);
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

  // Activity slot \u2014 intent-gated-slab: the section header + container
  // render whether or not transactions exist. Empty state is a dashed
  // calm row, not absent. The panel reads "inhabited but empty" instead
  // of "incomplete render."
  const activityHeader = document.createElement("div");
  activityHeader.className = "panel-section-header";
  activityHeader.textContent = "Activity";
  budgetSummary.appendChild(activityHeader);

  const recentTxns = state.balance?.transactions.slice(0, 5) ?? [];
  if (recentTxns.length > 0) {
    const txnSection = document.createElement("div");
    txnSection.style.cssText = "margin:0 4px;";
    for (const txn of recentTxns) {
      const txnRow = document.createElement("div");
      txnRow.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:6px 8px;font-size:11px;border-bottom:1px solid var(--border-light);";

      const isCredit =
        txn.type === "deposit" ||
        txn.type === "settlement_credit" ||
        txn.type === "allocation_release";
      const sign = isCredit ? "+" : "\u2212";
      const color = isCredit ? "var(--accent-green, #4ade80)" : "var(--text-secondary)";

      txnRow.innerHTML = `
        <span style="flex:0 0 auto;padding:1px 6px;border-radius:3px;background:var(--bg-btn);color:var(--text-ghost);font-size:10px;">${escapeHtml(txn.type)}</span>
        <span style="flex:1;color:var(--text-ghost);">${escapeHtml(txn.description ?? "")}</span>
        <span style="color:${color};font-weight:500;white-space:nowrap;font-variant-numeric:tabular-nums;">${sign}${Math.abs(txn.amount).toFixed(4)}</span>
        <span style="color:var(--text-ghost);font-size:10px;white-space:nowrap;">${formatDate(txn.created_at)}</span>
      `;
      txnSection.appendChild(txnRow);
    }
    budgetSummary.appendChild(txnSection);
  } else {
    // Forward-framed empty register — describes what the slot holds,
    // not what it lacks (intent-gated-slab: slot is READY). Same
    // shape as slab-home.ts's "Anywhere." watermark — the affordance
    // is the antecedent, not the absence.
    const activityEmpty = document.createElement("div");
    activityEmpty.className = "panel-empty-row";
    activityEmpty.textContent = "Recent transactions appear here";
    budgetSummary.appendChild(activityEmpty);
  }

  // Allocations slot \u2014 same always-rendered pattern. When budget data
  // exists, show the metric pair + per-allocation rows. When absent,
  // show a calm dashed empty register so the slab reads inhabited.
  const allocSectionHeader = document.createElement("div");
  allocSectionHeader.className = "panel-section-header";
  allocSectionHeader.textContent = "Allocations";
  budgetSummary.appendChild(allocSectionHeader);

  if (state.budget) {
    const budget = state.budget;
    const allocHeader = document.createElement("div");
    allocHeader.style.cssText = "display:flex;gap:12px;margin:0 4px 8px;";
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
    } else {
      const allocEmpty = document.createElement("div");
      allocEmpty.className = "panel-empty-row";
      allocEmpty.textContent = "Allocations appear when budgets are locked";
      budgetSummary.appendChild(allocEmpty);
    }
  } else {
    const allocEmpty = document.createElement("div");
    allocEmpty.className = "panel-empty-row";
    allocEmpty.textContent = "Allocations appear when budgets are locked";
    budgetSummary.appendChild(allocEmpty);
  }
}

function renderSuccession(
  state: SovereignState,
  hasRelay: boolean,
  ctrl: SovereignController,
  successionContent: HTMLDivElement,
  successionEmpty: HTMLDivElement,
): void {
  successionContent.innerHTML = "";
  successionEmpty.style.display = "none";

  // Local-first per protocol-primacy: render the bootstrap-event
  // identity hero card FIRST, regardless of relay state. Relay-fetched
  // succession history (cross-device key rotations) appends on top
  // when present. A user without a relay still sees their own identity
  // (who they are, when they were born, what key they sign with) from
  // second zero. Doctrine: docs/doctrine/protocol-primacy.md.
  if (state.localIdentity) {
    const localHero = document.createElement("div");
    localHero.className = "sov-hero-card";

    const lhBody = document.createElement("div");
    lhBody.className = "sov-hero-body";

    const lhLabel = document.createElement("div");
    lhLabel.className = "sov-hero-label";
    lhLabel.textContent = "Current identity";
    lhBody.appendChild(lhLabel);

    const lhId = document.createElement("div");
    lhId.className = "sov-hero-value";
    lhId.style.cssText = "font-family:Menlo,monospace;font-size:11px;word-break:break-all;";
    lhId.textContent = state.localIdentity.motebitId;
    lhBody.appendChild(lhId);

    const lhSub = document.createElement("div");
    lhSub.className = "sov-hero-sub";
    lhSub.style.cssText = "font-size:11px;color:var(--text-muted);margin-top:4px;";
    const born = new Date(state.localIdentity.createdAt);
    lhSub.textContent = `Born ${born.toLocaleDateString()} · ${born.toLocaleTimeString()}`;
    lhBody.appendChild(lhSub);

    const lhKey = document.createElement("div");
    lhKey.style.cssText =
      "font-size:10px;color:var(--text-ghost);font-family:Menlo,monospace;margin-top:2px;word-break:break-all;";
    lhKey.textContent = `pubkey: ${state.localIdentity.publicKeyHex.slice(0, 32)}…`;
    lhBody.appendChild(lhKey);

    localHero.appendChild(lhBody);
    successionContent.appendChild(localHero);
  }

  // If we have the local identity AND no relay-fetched succession data,
  // we're done — the hero card is the meaningful render. Skip the
  // error/empty branches that follow (they're for the relay-succession
  // history path, which is augmentation, not gate).
  const data = state.succession;

  if (!data && state.localIdentity) {
    // Local identity rendered above; relay succession history just isn't
    // available (no relay or fetch hasn't completed). Add a calm hint at
    // the bottom that explains what relay-fetched data would augment.
    const hint = document.createElement("div");
    hint.className = "panel-empty-row";
    hint.style.cssText = "font-size:11px;color:var(--text-ghost);margin-top:12px;";
    hint.textContent = hasRelay
      ? "Key rotations appear here as your identity transitions across devices"
      : "Connect a relay to see cross-device succession history";
    successionContent.appendChild(hint);
    return;
  }

  if (!data && !hasRelay) {
    // No local identity (older surfaces / event store unavailable) and
    // no relay — the universal empty-pulse register.
    setEmptyPulse(
      successionEmpty,
      "Key rotations appear here",
      "as your identity transitions across devices",
    );
    return;
  }

  // Error register — fetch failed (relay configured but no data, and
  // no local identity to fall back on). Distinct from empty by
  // presenting a Retry affordance.
  if (!data) {
    const errorRow = document.createElement("div");
    errorRow.className = "sov-error-row";
    const errorText = document.createElement("span");
    errorText.className = "sov-error-row-text";
    errorText.textContent = "Couldn't load succession chain";
    const retryBtn = document.createElement("button");
    retryBtn.className = "sov-error-row-retry";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", () => {
      retryBtn.disabled = true;
      retryBtn.textContent = "Retrying…";
      void ctrl.refresh().finally(() => {
        retryBtn.disabled = false;
        retryBtn.textContent = "Retry";
      });
    });
    errorRow.appendChild(errorText);
    errorRow.appendChild(retryBtn);
    successionContent.appendChild(errorRow);
    return;
  }

  // Loaded — always render the current identity as the hero card. The
  // identity is the most foundational fact in this tab; per the same
  // hero-card pattern as Sovereign reserve in Budget, it gets display
  // material weight whether or not rotations exist.
  const identityCard = document.createElement("div");
  identityCard.className = "sov-hero-card";

  const idBody = document.createElement("div");
  idBody.className = "sov-hero-body";

  const idLabel = document.createElement("div");
  idLabel.className = "sov-hero-label";
  idLabel.textContent = "Current identity";
  idBody.appendChild(idLabel);

  const idValue = document.createElement("div");
  idValue.className = "sov-hero-value-code";
  // The relay returns `current_public_key: null` for a motebit with no
  // `agent_registry` row (a sovereign wallet that paired for sync but never
  // registered as a discoverable agent — the common web case). Fall back to
  // the locally-known signing key, then "—". Never feed null to `truncate`.
  const currentKey = data.current_public_key ?? state.localIdentity?.publicKeyHex ?? null;
  idValue.textContent = currentKey ? truncate(currentKey, 32) : "—";
  idBody.appendChild(idValue);

  const idSubtitle = document.createElement("div");
  idSubtitle.className = "sov-hero-subtitle";
  if (data.chain.length > 0) {
    const genesisKey = data.chain[0]!.old_public_key;
    const rotationWord = data.chain.length === 1 ? "rotation" : "rotations";
    idSubtitle.textContent = `${data.chain.length} ${rotationWord} · genesis ${truncate(genesisKey, 12)}`;
  } else {
    idSubtitle.textContent = "Ed25519 sovereign key";
  }
  idBody.appendChild(idSubtitle);

  identityCard.appendChild(idBody);
  successionContent.appendChild(identityCard);

  // Key rotations section — always rendered, holds either the timeline
  // (when rotations exist) or a forward-framed empty register.
  const rotationsHeader = document.createElement("div");
  rotationsHeader.className = "panel-section-header";
  rotationsHeader.textContent = "Key rotations";
  successionContent.appendChild(rotationsHeader);

  if (data.chain.length === 0) {
    const empty = document.createElement("div");
    empty.className = "panel-empty-row";
    empty.textContent = "Rotations appear here as the identity evolves";
    successionContent.appendChild(empty);
    return;
  }

  const timeline = document.createElement("div");
  timeline.style.cssText = "margin: 0 14px;";
  for (const entry of data.chain) {
    const item = document.createElement("div");
    item.style.cssText =
      "padding: 10px 14px; margin-bottom: 6px; border-radius: 10px; background: var(--bg-card); font-size: 11px;";
    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
        <span style="color: var(--text-secondary);">${formatDate(entry.timestamp)}</span>
        ${entry.reason ? `<span style="color: var(--text-ghost); font-style: italic;">${escapeHtml(entry.reason)}</span>` : ""}
      </div>
      <div style="color: var(--text-ghost); font-family: 'SF Mono', 'Menlo', monospace;">
        <code style="font-size: 10px;">${escapeHtml(truncate(entry.old_public_key, 16))}</code>
        <span style="margin: 0 4px;">&#x2192;</span>
        <code style="font-size: 10px;">${escapeHtml(truncate(entry.new_public_key, 16))}</code>
      </div>
    `;
    timeline.appendChild(item);
  }
  successionContent.appendChild(timeline);
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
    renderSuccession(state, hasRelayConfigured, ctrl, successionContent, successionEmpty);
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
