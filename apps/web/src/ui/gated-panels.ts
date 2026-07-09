// === Gated HUD Panels ===
// Memory panel is functional (IDB-backed via runtime).
// Sync popup is functional (connects to relay via signed tokens).
// Goals panel is functional — binds to the shared `GoalsController` from
// @motebit/panels (uniform with desktop/mobile) over web's in-process goals
// engine. Recurring goals tick in the engine; once goals execute on demand,
// streaming plan progress inline; results surface through the slab.

import type { WebContext } from "../types";
import type { WebSyncStatus } from "../web-app";
import {
  saveSyncUrl,
  loadSyncUrl,
  clearSyncUrl,
  DEFAULT_RELAY_URL,
  normalizeRelayUrl,
} from "../storage";
import type { PlanChunk } from "@motebit/runtime";
import { renderMarkdown, type HireComposeRequest } from "./chat";
import { setEmptyPulse, setEmptyRow } from "./empty-states";
import {
  createAgentsController,
  createMemoryController,
  classifyCertainty,
  formatHardwarePlatform,
  formatNameClaim,
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
  formatCountdownUntil,
  formatTokens,
  resolveFeltConsolidation,
  resolveFeltMemory,
  resolveFeltTrust,
  type AgentsState,
  type DiscoveredAgent,
  type MemoryFetchAdapter,
  type MemoryState,
  type PricingEntry,
  type ScheduledGoal,
  type FeltCoverageAdapter,
  type FeltMemoryNode,
} from "@motebit/panels";
import { computeDecayedConfidence } from "@motebit/memory-graph";
import { deriveAgentSigil } from "@motebit/sdk";
import { sigilToSvg } from "../identity-sigil-svg.js";
import { buildFeltRow } from "./felt-row";
// Run records are a web-daemon-only concept owned by the in-process goals
// engine (web's daemon); the controller's projection state has no `runs`.
import type { GoalRunRecord } from "../goal-engine.js";
import {
  verifiedSettlementSummaryFetch,
  fetchTransparencyAnchor,
  type TransparencyAnchor,
} from "@motebit/state-export-client";

// Relay transparency anchor for verifying the settlement-summary export's
// producer key (the user's own money history → same pinning posture as the
// sovereign balance read, sovereign-panels.ts). Cached per session;
// degrades to anchor-less signature verification on a bootstrap failure.
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

export interface GatedPanelsAPI {
  openMemory(auditNodeIds?: Map<string, string>): void;
  openGoals(): void;
  openAgents(): void;
  closeAll(): void;
}

/**
 * Cross-surface handoffs the panels initiate but do NOT perform. The Agents
 * panel browses the roster; performing a hire belongs to the slab, so the panel
 * raises `onHire` and the slab (chat) composes + acts. Keeping the act out of
 * the panel is the §5 record-vs-act split — see
 * docs/doctrine/agents-as-first-person-trust-graph.md.
 */
export interface GatedPanelsHooks {
  onHire?: (req: HireComposeRequest) => void;
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const SYNC_STATUS_LABELS: Record<WebSyncStatus, string> = {
  offline: "",
  connecting: "Connecting...",
  connected: "Connected",
  syncing: "Syncing...",
  error: "Connection failed",
  disconnected: "Disconnected",
};

export function initGatedPanels(ctx: WebContext, hooks: GatedPanelsHooks = {}): GatedPanelsAPI {
  // === Memory Panel (functional) ===
  // Fetch + filter + delete live in @motebit/panels MemoryController.
  // This block owns DOM rendering + markdown + the inline delete-confirm UX.
  // Sensitivity floor ["none", "personal"] is passed explicitly — matches
  // CLI export behavior and is now a declared config, not a silent
  // per-surface divergence.
  const memoryPanel = document.getElementById("memory-panel") as HTMLDivElement;
  const memoryBackdrop = document.getElementById("memory-backdrop") as HTMLDivElement;
  const memoryList = document.getElementById("memory-list") as HTMLDivElement;
  const memoryFelt = document.getElementById("memory-felt") as HTMLDivElement;

  const memoryAdapter: MemoryFetchAdapter = {
    listMemories: async () => {
      const runtime = ctx.app.getRuntime();
      if (!runtime) return [];
      const { nodes } = await runtime.memory.exportAll();
      return nodes;
    },
    deleteMemory: async (nodeId) => {
      const runtime = ctx.app.getRuntime();
      if (!runtime) return null;
      // Route through the privacy-layer choke point so user-driven
      // deletion is signed (mutable_pruning cert), audited, and lands
      // a `DeleteRequested` event on the append-only log — the same
      // sovereignty contract every surface honors.
      return await runtime.privacy.deleteMemory(nodeId, "user_request");
    },
    pinMemory: async () => {
      // Web doesn't expose pin today. No-op keeps the interface satisfied.
    },
    getDecayedConfidence: (node) =>
      computeDecayedConfidence(node.confidence, node.half_life, Date.now() - node.created_at),
  };

  const memoryCtrl = createMemoryController(memoryAdapter, {
    sensitivityFilter: ["none", "personal"],
  });

  function renderMemories(state: MemoryState): void {
    const runtime = ctx.app.getRuntime();
    memoryList.innerHTML = "";

    if (!runtime) {
      const row = document.createElement("div");
      setEmptyRow(row, "Runtime not initialized");
      memoryList.appendChild(row);
      return;
    }

    const view = memoryCtrl.filteredView();

    if (view.length === 0) {
      // Structurally empty → breathing pulse; filtered → flat "No matches".
      // Empty nested inside #memory-list (conversations pattern) so it
      // claims the full pane height instead of splitting flex with the
      // list container as a sibling.
      const empty = document.createElement("div");
      if (state.memories.length === 0) {
        setEmptyPulse(empty, "Memories appear here", "as conversations build");
      } else {
        setEmptyRow(empty, "No matches");
      }
      memoryList.appendChild(empty);
      return;
    }

    // The memory resting record (felt-interior §5) — the standing record at the
    // top of the list, derived from the WHOLE graph (state.memories), not the
    // filtered view. A calm summary, never a chart or score.
    if (state.memories.length > 0) {
      const felt = resolveFeltMemory(state.memories as unknown as FeltMemoryNode[]);
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "padding:10px 14px;display:flex;flex-direction:column;gap:3px;border-bottom:1px solid rgba(127,127,127,0.16);";
      const headline = document.createElement("div");
      headline.style.cssText = "font-size:13px;opacity:0.9;";
      headline.textContent = felt.headline;
      wrap.appendChild(headline);
      const shapeLine = [
        ...felt.shape.map((s) => `${s.count} ${s.kind}`),
        ...(felt.fading > 0 ? [`${felt.fading} fading`] : []),
      ].join(" · ");
      if (shapeLine !== "") {
        const shape = document.createElement("div");
        shape.style.cssText = "font-size:11px;opacity:0.55;";
        shape.textContent = shapeLine;
        wrap.appendChild(shape);
      }
      memoryList.appendChild(wrap);
    }

    for (const node of view) {
      const item = document.createElement("div");
      const auditCategory = state.auditFlags.get(node.node_id);
      item.className = "memory-item" + (auditCategory ? ` ${auditCategory}` : "");

      const content = document.createElement("div");
      content.className = "memory-item-content";
      content.innerHTML = renderMarkdown(node.content);
      item.appendChild(content);

      const meta = document.createElement("div");
      meta.className = "memory-item-meta";

      if (auditCategory) {
        const tag = document.createElement("span");
        tag.className = `memory-audit-tag ${auditCategory}`;
        const labels: Record<string, string> = {
          phantom: "phantom",
          conflict: "conflict",
          "near-death": "fading",
        };
        tag.textContent = labels[auditCategory] ?? auditCategory;
        meta.appendChild(tag);
      }

      // Decayed confidence — previously web rendered raw node.confidence,
      // diverging from desktop/mobile. Controller-canonical now.
      const decayed = memoryCtrl.getDecayedConfidence(node);
      const certainty = classifyCertainty(decayed);
      const confidence = document.createElement("span");
      confidence.className = `memory-item-certainty memory-certainty-${certainty}`;
      // Three-state label surfaces the `memory_promoted` state (§5.8) —
      // when the agent's Layer-1 index sees `(absolute)` for a node,
      // the panel renders the same badge here. Percentage stays for
      // the fine-grained numeric reader; the label is the at-a-glance
      // certainty cue.
      confidence.textContent = `${certainty} · ${Math.round(decayed * 100)}%`;
      meta.appendChild(confidence);

      const time = document.createElement("span");
      time.textContent = formatTimeAgo(node.created_at);
      meta.appendChild(time);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "memory-delete-btn";
      deleteBtn.title = "Forget this memory";
      deleteBtn.textContent = "\u00d7";
      let confirmTimer: ReturnType<typeof setTimeout> | null = null;
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (deleteBtn.classList.contains("confirming")) {
          if (confirmTimer != null) clearTimeout(confirmTimer);
          void memoryCtrl.deleteMemory(node.node_id).finally(() => {
            void memoryCtrl.refresh();
          });
        } else {
          deleteBtn.classList.add("confirming");
          deleteBtn.textContent = "Forget?";
          confirmTimer = setTimeout(() => {
            deleteBtn.classList.remove("confirming");
            deleteBtn.textContent = "\u00d7";
          }, 3000);
        }
      });
      meta.appendChild(deleteBtn);

      item.appendChild(meta);
      memoryList.appendChild(item);
    }
  }

  memoryCtrl.subscribe(renderMemories);

  // Felt consolidation — the owner-facing "what I've learned" resting record.
  // The projection, verification, and copy are the SHARED @motebit/panels
  // primitives (same as desktop); only this DOM render is web's. Verified
  // detail only — the evidence union makes an unverified-with-details record
  // unrepresentable; receipt-only cycles show signed counts.
  async function renderFeltConsolidation(): Promise<void> {
    const runtime = ctx.app.getRuntime();
    if (!runtime) {
      memoryFelt.innerHTML = "";
      return;
    }
    const { EventType } = await import("@motebit/sdk");
    const rows = await runtime.events.query({
      motebit_id: runtime.motebitId,
      event_types: [
        EventType.ConsolidationCycleRun,
        EventType.ConsolidationReceiptSigned,
        EventType.ConsolidationReceiptsAnchored,
        EventType.MemoryFormed,
        EventType.MemoryConsolidated,
      ],
    });
    const feltEvents = rows.map((e) => ({
      event_type: e.event_type,
      timestamp: e.timestamp,
      payload: e.payload,
    }));

    // resolveFeltConsolidation is the canonical boundary — projects + verifies
    // internally, returns ONLY render-safe records (unverified candidates never
    // reach this surface). Verify against the owner's OWN local key (fail-closed
    // parity with desktop; succession-chain verification deferred). No key →
    // every cycle degrades to receipt-only.
    let adapter: FeltCoverageAdapter | undefined;
    const ownerPubHex = ctx.app.publicKeyHex;
    if (ownerPubHex) {
      const {
        verifyConsolidationMutationManifest,
        consolidationReceiptDigest,
        consolidationContentDigest,
        hexToBytes,
      } = await import("@motebit/encryption");
      const ownerKey = hexToBytes(ownerPubHex);
      adapter = {
        verifyManifest: (m) => verifyConsolidationMutationManifest(m, ownerKey),
        receiptDigest: (r) => consolidationReceiptDigest(r),
        contentDigest: (c) => consolidationContentDigest(c),
      };
    }
    const records = await resolveFeltConsolidation(feltEvents, adapter);

    memoryFelt.innerHTML = "";
    for (const rec of records) memoryFelt.appendChild(buildFeltRow(rec, formatTimeAgo));
  }

  // buildFeltRow lives in ./felt-row (imports only @motebit/panels + the DOM)
  // so the render regression test can assert evidence-state → DOM without
  // pulling in the whole gated-panels dependency tree. Time formatting is
  // injected (panels rule 6 — formatTimeAgo stays web-local).

  function openMemory(auditNodeIds?: Map<string, string>): void {
    closeAll();
    memoryCtrl.setAuditFlags(auditNodeIds ?? new Map<string, string>());
    memoryPanel.classList.add("open");
    memoryBackdrop.classList.add("open");
    void memoryCtrl.refresh();
    void renderFeltConsolidation();
  }

  function closeMemory(): void {
    memoryPanel.classList.remove("open");
    memoryBackdrop.classList.remove("open");
  }

  document.getElementById("memory-btn")!.addEventListener("click", () => openMemory());
  document.getElementById("memory-close-btn")!.addEventListener("click", closeMemory);
  memoryBackdrop.addEventListener("click", closeMemory);

  // === Goals Panel (functional) ===
  // Runtime register per docs/doctrine/panel-temporal-registers.md —
  // cards-as-commitments, status pulses, axis-native budget envelopes.
  // Each card is a living commitment; click expands per-card detail
  // (last response, next run, raise budget, pause, remove).
  //
  // Layout per docs/doctrine/panel-presentation-modes.md §"Inline >
  // transition > modal-forbidden": single-page, form always visible
  // at the bottom of the panel (Apple Reminders bottom-bar pattern).
  // Cards (or the empty caption) scroll in the area above; the form
  // is perpetual. No register transition, no separate page — the
  // form is light enough to coexist with the list, so the inline
  // affordance is the right shape.
  const goalsPanel = document.getElementById("goals-panel") as HTMLDivElement;
  const goalsBackdrop = document.getElementById("goals-backdrop") as HTMLDivElement;
  const goalList = document.getElementById("goal-list") as HTMLDivElement;
  const goalEmpty = document.getElementById("goal-empty") as HTMLDivElement;
  const goalCommitPrompt = document.getElementById("goal-commit-prompt") as HTMLTextAreaElement;
  const goalCommitCadenceChips = document.getElementById(
    "goal-commit-cadence-chips",
  ) as HTMLDivElement;
  const goalCommitBudgetChips = document.getElementById(
    "goal-commit-budget-chips",
  ) as HTMLDivElement;
  const goalCommitBudgetCustom = document.getElementById(
    "goal-commit-budget-custom",
  ) as HTMLInputElement;
  const goalCommitBudgetField = document.getElementById(
    "goal-commit-budget-field",
  ) as HTMLDivElement;
  const goalCommitBudgetCustomToggle = document.getElementById(
    "goal-commit-budget-custom-toggle",
  ) as HTMLButtonElement;
  const goalCommitBudgetBack = document.getElementById(
    "goal-commit-budget-back",
  ) as HTMLButtonElement;
  const goalCommitSubmit = document.getElementById("goal-commit-submit") as HTMLButtonElement;

  let goalsSubscribed = false;
  // Per-card expansion is renderer-state, not runner-state: lives in
  // this Set so the runtime-register card behaves like Reminders /
  // Focus — tap to reveal the commitment's full body, tap to collapse.
  const expandedGoalIds = new Set<string>();

  function renderPlanChunk(container: HTMLElement, chunk: PlanChunk): void {
    const el = document.createElement("div");
    el.className = "goal-step";
    switch (chunk.type) {
      case "plan_created":
        el.textContent = `Plan: ${chunk.plan.title} (${chunk.plan.total_steps} steps)`;
        break;
      case "step_started":
        el.className = "goal-step running";
        el.textContent = `Running: ${chunk.step.description}`;
        break;
      case "step_completed":
        el.className = "goal-step completed";
        el.textContent = `Done: ${chunk.step.description}`;
        break;
      case "step_failed":
        el.className = "goal-step failed";
        el.textContent = `Failed: ${chunk.step.description}`;
        break;
      case "plan_completed":
        el.className = "goal-step completed";
        el.textContent = "Plan completed";
        break;
      case "plan_failed":
        el.className = "goal-step failed";
        el.textContent = `Plan failed: ${chunk.reason}`;
        break;
      default:
        return;
    }
    container.appendChild(el);
  }

  function cadenceLabel(goal: ScheduledGoal): string {
    switch (goal.interval_ms) {
      case 3_600_000:
        return "hourly";
      case 86_400_000:
        return "daily";
      case 604_800_000:
        return "weekly";
      default:
        return goal.mode === "once" ? "once" : "custom";
    }
  }

  // `formatTokens` (axis-native value formatter) and cadenceLabel differ in
  // role: cadenceLabel is web's lowercase cadence noun ("hourly"/"once"/
  // "custom"), formatTokens is the shared @motebit/panels value formatter.

  // The pulse class drives both color and breathing animation.
  // Recurring + active = breathing at 0.3Hz (Liquescentia rate, so
  // the card is medium-coherent with the slab and the creature);
  // running = faster fire pulse; budget_exhausted = static red with
  // shadow ring; errored = amber breathing (recurring goal whose last
  // run errored, will retry next cadence — visible "degraded but
  // alive" signal); etc.
  function pulseClass(goal: ScheduledGoal, runs: GoalRunRecord[]): string {
    const latestRun = runs.find((r) => r.goal_id === goal.goal_id);
    if (latestRun?.status === "running") return "running";
    if (goal.status === "budget_exhausted") return "budget_exhausted";
    if (goal.status === "paused") return "paused";
    if (goal.status === "completed") return "completed";
    if (goal.status === "failed") return "failed";
    // Recurring goal that's still active but whose last run errored.
    // Without this, an erroring recurring goal renders as green-
    // breathing (healthy) which is dishonest. Amber says "alive,
    // will retry, but you might want to check what happened."
    if (goal.last_error != null && goal.status === "active") return "errored";
    return "active";
  }

  const formatCountdown = formatCountdownUntil;

  function renderGoals(): void {
    const ctrl = ctx.app.getGoalsController?.();
    if (!ctrl) {
      goalList.innerHTML = "";
      goalEmpty.style.display = "";
      return;
    }
    // Goals (the commitment projection) come from the controller — uniform
    // with desktop/mobile. Run records (the "running" pulse) come from the
    // engine directly; the projection controller doesn't carry them.
    const state = ctrl.getState();
    const runs = ctx.app.getGoalsScheduler?.()?.getState().runs ?? [];
    const panelGoals = state.goals
      .slice()
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

    goalList.innerHTML = "";
    if (panelGoals.length === 0) {
      goalEmpty.style.display = "";
      return;
    }
    goalEmpty.style.display = "none";

    const now = Date.now();

    for (const goal of panelGoals) {
      const goalStatus = String(goal.status);
      const isExpanded = expandedGoalIds.has(goal.goal_id);
      // `errored` is a derived visual state: recurring goal whose
      // last run errored but whose status is still active (will
      // retry). Carries an amber border-tint so the attention-need
      // is visible at-a-glance, paired with the amber pulse dot.
      const hasErrored = goal.last_error != null && goal.status === "active";

      const card = document.createElement("div");
      card.className =
        `goal-card ${goalStatus}` +
        (hasErrored ? " errored" : "") +
        (isExpanded ? " expanded" : "");

      // Header row: pulse \u00b7 prompt \u00b7 cadence \u00b7 countdown.
      const headerRow = document.createElement("div");
      headerRow.className = "goal-card-row";

      const pulse = document.createElement("span");
      pulse.className = `goal-pulse ${pulseClass(goal, runs)}`;
      headerRow.appendChild(pulse);

      const promptText = document.createElement("span");
      promptText.className = "goal-card-prompt";
      promptText.textContent = goal.prompt;
      promptText.title = goal.prompt;
      headerRow.appendChild(promptText);

      const cadence = document.createElement("span");
      cadence.className = "goal-card-cadence";
      cadence.textContent = cadenceLabel(goal);
      headerRow.appendChild(cadence);

      if (goal.mode === "recurring" && typeof goal.next_run_at === "number") {
        const countdown = document.createElement("span");
        countdown.className = "goal-card-countdown";
        if (goal.status === "paused") countdown.textContent = "paused";
        else if (goal.status === "budget_exhausted") countdown.textContent = "over cap";
        else countdown.textContent = formatCountdown(goal.next_run_at, now);
        headerRow.appendChild(countdown);
      }

      card.appendChild(headerRow);

      // Receipt-summary row \u2014 the per-fire audit trail surfaced on the
      // commitment card per `docs/doctrine/goal-results.md` \u00a7"The
      // three categories" (Receipt category). Renders when the goal
      // has fired at least once. Format:
      //
      //   ran 5m ago \u00b7 signed     \u2190 successful fire, manifest minted
      //   ran 5m ago              \u2190 successful fire, no manifest
      //   failed 5m ago           \u2190 last fire errored (amber tint)
      //
      // The `\u00b7 signed` chip closes the Phase-3-deferral on this
      // surface \u2014 the Phase 3 doctrine assumed web rendered a Signed
      // indicator alongside the receipt summary; web actually only
      // persisted the manifest. This row makes that attestation
      // visible alongside the existing pulse / budget / countdown
      // signals that already render the receipt category piecemeal.
      if (goal.last_run_at != null) {
        const receipt = document.createElement("div");
        receipt.className = "goal-card-receipt" + (goal.last_error != null ? " errored" : "");
        const seconds = Math.floor((now - goal.last_run_at) / 1000);
        const ago =
          seconds < 60
            ? "just now"
            : seconds < 3600
              ? `${Math.floor(seconds / 60)}m ago`
              : seconds < 86400
                ? `${Math.floor(seconds / 3600)}h ago`
                : `${Math.floor(seconds / 86400)}d ago`;
        const verb = goal.last_error != null ? "failed" : "ran";
        const status = document.createElement("span");
        status.textContent = `${verb} ${ago}`;
        receipt.appendChild(status);
        if (goal.last_manifest_signed === true) {
          const signedMark = document.createElement("span");
          signedMark.className = "goal-card-receipt-signed";
          signedMark.textContent = "signed";
          // Title attribute: the receipt row reads as glanceable
          // verb-and-time; the hover-disclosure names what's
          // attested so the user can map "signed" to motebit's
          // unified-receipt doctrine without a docs trip.
          signedMark.title =
            "Result wrapped as a signed ContentArtifactManifest \u2014 independently verifiable via motebit-verify";
          receipt.appendChild(signedMark);
        }
        card.appendChild(receipt);
      }

      // Budget envelope \u2014 axis-native unit is the headline ("12k / 50k
      // tokens"); cost translation would land as additive disclosure
      // when computable, never as the headline (per panel-temporal-
      // registers.md \u00a7"Bounded commitment is multi-dimensional").
      const cap = goal.budget_tokens;
      if (cap != null) {
        const spent = goal.spent_tokens ?? 0;
        const ratio = cap > 0 ? Math.min(spent / cap, 1.2) : 1;
        const fillPct = Math.min(ratio * 100, 100);
        const fillClass = ratio >= 1 ? "over" : ratio >= 0.8 ? "near" : "";

        const budget = document.createElement("div");
        budget.className = "goal-card-budget";

        const label = document.createElement("div");
        const exhausted = goal.status === "budget_exhausted";
        label.className = `goal-card-budget-label${exhausted ? " exhausted" : ""}`;
        const headline = document.createElement("span");
        headline.textContent = exhausted
          ? "Token budget exhausted"
          : `${formatTokens(spent)} / ${formatTokens(cap)} tokens`;
        label.appendChild(headline);
        if (!exhausted && cap > 0) {
          const ratioSpan = document.createElement("span");
          ratioSpan.textContent = `${Math.round((spent / cap) * 100)}%`;
          label.appendChild(ratioSpan);
        }
        budget.appendChild(label);

        const bar = document.createElement("div");
        bar.className = "goal-card-budget-bar";
        const fill = document.createElement("div");
        fill.className = `goal-card-budget-fill ${fillClass}`.trim();
        fill.style.width = `${fillPct}%`;
        bar.appendChild(fill);
        budget.appendChild(bar);

        card.appendChild(budget);
      }

      // Expanded detail block \u2014 preview + meta + actions + step trace.
      const expand = document.createElement("div");
      expand.className = "goal-card-expand";
      const expandInner = document.createElement("div");
      expandInner.className = "goal-card-expand-inner";

      // Per `docs/doctrine/goal-results.md` §"The three categories":
      // prefer `last_response_full` (the artifact) when present, fall
      // back to `last_response_preview` (the 160-char card-meta
      // truncation) when only the preview is available. The card
      // detail shows a longer preview — first paragraph or ~500 chars
      // — NOT the full content (that's the slab's job in Phase 3).
      // Trim at a sentence boundary if available to avoid mid-word cuts.
      const fullArtifact = goal.last_response_full;
      const shortPreview = goal.last_response_preview;
      if (fullArtifact != null && fullArtifact !== "") {
        const preview = document.createElement("div");
        preview.className = "goal-card-expand-preview";
        const trimmed = fullArtifact.trim();
        // Show first paragraph (up to first double-newline) or first
        // 500 chars, whichever is shorter. Suffix an ellipsis when
        // the artifact has more content the slab will eventually show.
        const paragraphEnd = trimmed.indexOf("\n\n");
        const sliceEnd =
          paragraphEnd > 0 && paragraphEnd < 500 ? paragraphEnd : Math.min(500, trimmed.length);
        const sliced = trimmed.slice(0, sliceEnd);
        const hasMore = sliced.length < trimmed.length;
        preview.textContent = hasMore ? `${sliced}…` : sliced;
        expandInner.appendChild(preview);

        // "View result" — slab navigational anchor per
        // `docs/doctrine/goal-results.md` §"The three categories"
        // Phase 3. The runtime already lands every goal fire as a
        // resting `stream`/`mind` slab item via `projectSlabForTurn`;
        // this affordance opens the slab so the user can read the
        // full artifact in its mind-mode embodiment (and, if they
        // want it persistently visible, pinch it via the existing
        // Rayleigh-Plateau detach mechanic to a scene satellite per
        // `docs/doctrine/motebit-computer.md` §"Three end states").
        // Renders only when the adapter captured the turn id —
        // pre-Phase-3 fires and plan-mode goals (which create N
        // slab items, not one) degrade to no affordance, which is
        // the correct calm-software default. `panel-action-ghost`
        // is the secondary-affordance vocab (per
        // `feedback_panel_shared_vocabulary`); primary
        // `panel-action-pill` stays reserved for "Commit goal".
        if (goal.last_turn_id != null && goal.last_turn_id !== "") {
          const viewBtn = document.createElement("button");
          viewBtn.type = "button";
          viewBtn.className = "panel-action-ghost goal-card-view-result";
          viewBtn.textContent = "View result";
          viewBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            // Calm software: open the slab. The runtime's resting
            // `stream`/`mind` slab item for this fire is already
            // there if the session hasn't replaced it; if it has
            // (e.g., after reload), Phase 4's ContentArtifactManifest
            // signing will reconstruct it lazily — for now, the open
            // gesture is honest about taking the user to "where
            // motebit's outputs live."
            ctx.app.getRenderer().setSlabVisible?.(true);
          });
          expandInner.appendChild(viewBtn);
        }
      } else if (shortPreview != null && shortPreview !== "") {
        // Backward-compat path: adapter didn't carry `responseFull`.
        // Surface the 160-char preview as before.
        const preview = document.createElement("div");
        preview.className = "goal-card-expand-preview";
        preview.textContent = shortPreview;
        expandInner.appendChild(preview);
      } else if (goal.last_error != null && goal.last_error !== "") {
        const errPreview = document.createElement("div");
        errPreview.className = "goal-card-expand-preview";
        errPreview.style.color = "var(--status-error-fg)";
        errPreview.textContent = `Last error: ${goal.last_error}`;
        expandInner.appendChild(errPreview);
      }

      // The "ran Xm ago" / "failed Xm ago" line moved to the
      // collapsed-view receipt-summary row (`.goal-card-receipt`) so
      // the receipt category is glanceable without expanding the
      // card. The expanded-meta block now only surfaces the
      // consecutive-failures counter, which is a deeper-disclosure
      // signal not glanceable enough for the collapsed row.
      const meta = document.createElement("div");
      meta.className = "goal-card-expand-meta";
      if (
        goal.consecutive_failures != null &&
        goal.consecutive_failures > 0 &&
        goal.max_retries != null
      ) {
        const fails = document.createElement("span");
        fails.style.color = "var(--status-warning-fg)";
        fails.textContent = `${goal.consecutive_failures}/${goal.max_retries} failures`;
        meta.appendChild(fails);
      }
      if (meta.children.length > 0) expandInner.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "goal-card-expand-actions";

      if (goal.status === "budget_exhausted" && cap != null) {
        const raiseBtn = document.createElement("button");
        raiseBtn.className = "raise-cap";
        raiseBtn.textContent = `Raise to ${formatTokens(cap * 2)}`;
        raiseBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          void ctrl.setBudgetTokens?.(goal.goal_id, cap * 2);
        });
        actions.appendChild(raiseBtn);
      }

      if (goal.mode === "once" && (goalStatus === "active" || goalStatus === "paused")) {
        const execBtn = document.createElement("button");
        execBtn.textContent = "Execute";
        execBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          void executeGoal(goal.goal_id);
        });
        actions.appendChild(execBtn);
      }

      if (
        goal.mode === "recurring" &&
        goal.status !== "completed" &&
        goal.status !== "failed" &&
        goal.status !== "budget_exhausted"
      ) {
        const paused = goal.status === "paused";
        const toggleBtn = document.createElement("button");
        toggleBtn.textContent = paused ? "Resume" : "Pause";
        toggleBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          // `paused` is the current state; toggling means the new desired
          // enabled state equals the current `paused` value (currently
          // paused → enable; currently active → disable).
          void ctrl.setEnabled(goal.goal_id, paused);
        });
        actions.appendChild(toggleBtn);

        if (!paused) {
          const runBtn = document.createElement("button");
          runBtn.textContent = "Run now";
          runBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            void ctrl.runNow?.(goal.goal_id);
          });
          actions.appendChild(runBtn);
        }
      }

      const removeBtn = document.createElement("button");
      removeBtn.className = "remove";
      removeBtn.textContent = "Remove";
      let confirmTimer: ReturnType<typeof setTimeout> | null = null;
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (removeBtn.classList.contains("confirming")) {
          if (confirmTimer != null) clearTimeout(confirmTimer);
          void ctrl.removeGoal(goal.goal_id);
        } else {
          removeBtn.classList.add("confirming");
          removeBtn.textContent = "Confirm";
          confirmTimer = setTimeout(() => {
            removeBtn.classList.remove("confirming");
            removeBtn.textContent = "Remove";
          }, 3000);
        }
      });
      actions.appendChild(removeBtn);

      expandInner.appendChild(actions);

      const stepsEl = document.createElement("div");
      stepsEl.className = "goal-card-steps";
      stepsEl.id = `goal-steps-${goal.goal_id}`;
      expandInner.appendChild(stepsEl);

      expand.appendChild(expandInner);
      card.appendChild(expand);

      card.addEventListener("click", () => {
        if (expandedGoalIds.has(goal.goal_id)) {
          expandedGoalIds.delete(goal.goal_id);
          card.classList.remove("expanded");
        } else {
          expandedGoalIds.add(goal.goal_id);
          card.classList.add("expanded");
        }
      });

      goalList.appendChild(card);
    }
  }

  async function executeGoal(goalId: string): Promise<void> {
    // Once-goal live plan progress is a web-daemon concern: fire through the
    // engine directly so the onChunk stream renders into the card. The
    // controller's pure-projection runNow carries no chunk stream; the
    // engine's emit → debounced controller.refresh keeps the list in sync.
    const scheduler = ctx.app.getGoalsScheduler?.();
    if (!scheduler) return;
    if (!ctx.app.isProviderConnected) {
      ctx.showToast("Connect an AI provider first");
      return;
    }

    const goalsBtn = document.getElementById("goals-btn");
    goalsBtn?.classList.add("executing");

    // Auto-expand the card so plan chunks land in a visible container.
    expandedGoalIds.add(goalId);
    renderGoals();

    try {
      await scheduler.runNow(goalId, (chunk) => {
        const stepsEl = document.getElementById(`goal-steps-${goalId}`);
        if (!stepsEl) return;
        if (chunk != null && typeof chunk === "object" && "type" in chunk) {
          renderPlanChunk(stepsEl, chunk as PlanChunk);
        }
      });
    } finally {
      goalsBtn?.classList.remove("executing");
    }
  }

  // === Commit-goal modal ===
  // Default selections mirror the chip layout in index.html.
  let commitCadence: "once" | "hourly" | "daily" | "weekly" = "daily";
  // `null` = no cap. `0` from the "No cap" chip also maps to null
  // (the chip's affordance is named for what the user sees, not the
  // numeric value).
  let commitBudgetTokens: number | null = 50_000;

  function selectChip(container: HTMLDivElement, value: string, attr: string): void {
    for (const child of Array.from(container.children)) {
      const btn = child as HTMLElement;
      btn.classList.toggle("selected", btn.getAttribute(attr) === value);
    }
  }

  goalCommitCadenceChips.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const cadence = target.getAttribute("data-cadence");
    if (!cadence) return;
    commitCadence = cadence as typeof commitCadence;
    selectChip(goalCommitCadenceChips, cadence, "data-cadence");
  });

  // Snapshot of the last preset selection so "Back" can restore it
  // when the user cancels out of custom-amount mode. Default matches
  // the chip flagged `selected` in the initial HTML markup.
  let lastPresetBudgetTokens: number | null = 50_000;

  goalCommitBudgetChips.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const raw = target.getAttribute("data-budget");
    if (raw == null) return;
    const n = Number(raw);
    commitBudgetTokens = n > 0 ? n : null;
    lastPresetBudgetTokens = commitBudgetTokens;
    selectChip(goalCommitBudgetChips, raw, "data-budget");
  });

  // Custom-amount mode: swaps the chip row for [← back] + number
  // input. Mutually exclusive with the presets row — never both
  // visible at once. Apple Reminders Date-row pattern.
  goalCommitBudgetCustomToggle.addEventListener("click", () => {
    goalCommitBudgetField.classList.add("is-custom");
    goalCommitBudgetCustom.focus();
  });

  goalCommitBudgetBack.addEventListener("click", () => {
    goalCommitBudgetField.classList.remove("is-custom");
    goalCommitBudgetCustom.value = "";
    // Restore the last preset selection: commit value reverts to
    // whatever chip was last selected (default 50k).
    commitBudgetTokens = lastPresetBudgetTokens;
  });

  goalCommitBudgetCustom.addEventListener("input", () => {
    const raw = goalCommitBudgetCustom.value.trim();
    if (raw === "") {
      // Empty input falls back to the last preset so submitting from
      // an empty custom field still commits a coherent value.
      commitBudgetTokens = lastPresetBudgetTokens;
      return;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      commitBudgetTokens = Math.floor(n);
    }
  });

  function resetCommitForm(): void {
    goalCommitPrompt.value = "";
    goalCommitBudgetCustom.value = "";
    commitCadence = "daily";
    commitBudgetTokens = 50_000;
    lastPresetBudgetTokens = 50_000;
    selectChip(goalCommitCadenceChips, "daily", "data-cadence");
    selectChip(goalCommitBudgetChips, "50000", "data-budget");
    goalCommitBudgetField.classList.remove("is-custom");
  }

  // Cadence chip → interval_ms. The controller's NewGoalInput takes
  // interval_ms (uniform across surfaces — desktop/mobile pass ms too);
  // the cadence vocabulary is a web-panel affordance, mapped at the call
  // site rather than carried into the shared contract.
  const CADENCE_MS: Record<"hourly" | "daily" | "weekly", number> = {
    hourly: 3_600_000,
    daily: 86_400_000,
    weekly: 604_800_000,
  };

  goalCommitSubmit.addEventListener("click", () => {
    const ctrl = ctx.app.getGoalsController?.();
    if (!ctrl) return;
    const prompt = goalCommitPrompt.value.trim();
    if (!prompt) return;
    if (commitCadence === "once") {
      void ctrl.addGoal({
        prompt,
        interval_ms: 0,
        mode: "once",
        budget_tokens: commitBudgetTokens,
      });
    } else {
      void ctrl.addGoal({
        prompt,
        interval_ms: CADENCE_MS[commitCadence],
        mode: "recurring",
        budget_tokens: commitBudgetTokens,
      });
    }
    // Form-always-visible: clear in place after submit; defaults
    // re-seed (Daily cadence, 50k tokens) so consecutive commits
    // require minimum effort. No transition, no dismiss.
    resetCommitForm();
  });

  function openGoals(): void {
    closeAll();
    // Lazy-attach the controller subscription on first open — the
    // controller is constructed during `app.bootstrap()`, which runs AFTER
    // `initGatedPanels`, so an init-time subscription would see null.
    // Also starts a 30s countdown refresh so recurring-goal "in 12m"
    // labels tick down without waiting for a fire event.
    if (!goalsSubscribed) {
      const ctrl = ctx.app.getGoalsController?.();
      if (ctrl) {
        // Re-render on controller emits, but only while the panel is open —
        // background-tick fires emit continuously; rebuilding a closed
        // panel's DOM is wasted work (matches the countdown timer's guard).
        ctrl.subscribe(() => {
          if (goalsPanel.classList.contains("open")) renderGoals();
        });
        // Populate the list once now that the controller exists (the
        // engine loaded goals from localStorage at construction; refresh
        // pulls them into the controller's projection state).
        void ctrl.refresh();
        setInterval(() => {
          if (goalsPanel.classList.contains("open")) renderGoals();
        }, 30_000);
        goalsSubscribed = true;
      }
    }
    renderGoals();
    goalsPanel.classList.add("open");
    goalsBackdrop.classList.add("open");
  }

  function closeGoals(): void {
    goalsPanel.classList.remove("open");
    goalsBackdrop.classList.remove("open");
  }

  document.getElementById("goals-btn")!.addEventListener("click", openGoals);
  document.getElementById("goals-close-btn")!.addEventListener("click", closeGoals);
  goalsBackdrop.addEventListener("click", closeGoals);

  // === Agents Panel (functional) ===
  // Fetching + state live in @motebit/panels AgentsController. This block
  // owns the DOM rendering + the "route discoverAgents through signed sync
  // token" adapter. When web adopts sort/filter, wire discoverSort/
  // discoverFilter to ctrl.setSort / ctrl.setCapabilityFilter — the state
  // is already there.
  const agentsPanel = document.getElementById("agents-panel") as HTMLDivElement;
  const agentsBackdrop = document.getElementById("agents-backdrop") as HTMLDivElement;
  const agentsList = document.getElementById("agents-list") as HTMLDivElement;

  const TRUST_BADGE_CLASS: Record<string, string> = {
    unknown: "unknown",
    first_contact: "first-contact",
    verified: "verified",
    trusted: "trusted",
    blocked: "blocked",
  };

  // Render the hardware-attested badge when the relay forwarded a verified
  // claim. Renders nothing when absent — rows without a claim stay
  // visually unchanged. Badge text is verbatim "hardware-attested" to
  // avoid colliding with skills provenance vocabulary (`spec/skills-v1.md`
  // §7.1). Tooltip carries verifier name + score for "why did motebit
  // prefer that peer".
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

  // Render the observed-latency readout for a peer when stats are
  // present. Same self-attesting-system doctrine probe as the HA badge:
  // every routing-input the runtime/relay computes against MUST be
  // visible to the user. Tooltip carries sample count for confidence.
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

  const agentsAdapter: AgentsFetchAdapter = {
    get syncUrl() {
      return loadSyncUrl();
    },
    get motebitId() {
      return ctx.app.motebitId || null;
    },
    listTrustedAgents: async (): Promise<AgentRecord[]> => {
      const runtime = ctx.app.getRuntime();
      if (!runtime) return [];
      return (await runtime.listTrustedAgents()) as AgentRecord[];
    },
    discoverAgents: async (): Promise<DiscoveredAgent[]> => {
      const syncUrl = loadSyncUrl();
      if (!syncUrl) return [];
      const token = await ctx.app.createSyncToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`${syncUrl}/api/v1/agents/discover`, { headers });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as { agents?: DiscoveredAgent[] };
      return data.agents ?? [];
    },
    // First-person, local-only: writes the petname to this motebit's own trust
    // record via the runtime. Never a relay/global name. Doctrine §3.
    setPetname: async (remoteMotebitId: string, petname: string | undefined): Promise<void> => {
      const runtime = ctx.app.getRuntime();
      if (!runtime) return;
      await runtime.setAgentPetname(remoteMotebitId, petname);
    },
    // The money side of the trust graph (doctrine §6): the caller's own
    // per-peer economic history, verified against the relay's pinned key
    // before it reaches the panel. `account:balance` audience (read-only own
    // financial state). Returns null on no-relay / verification failure —
    // fail-closed, the mark + trust still render.
    listSettlementSummary: async (): Promise<AgentEconomicSummary | null> => {
      const syncUrl = loadSyncUrl();
      const motebitId = ctx.app.motebitId;
      if (!syncUrl || !motebitId) return null;
      const token = await ctx.app.createSyncToken("account:balance");
      const anchor = await settlementAnchor(syncUrl);
      const res = await verifiedSettlementSummaryFetch(syncUrl, motebitId, {
        anchor,
        init: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
      });
      return res.verification.valid ? res.body : null;
    },
  };

  const agentsCtrl = createAgentsController(agentsAdapter);

  // Identity header for an agent row: the key-derived sigil face + the
  // human-readable handle (petname when known, else the short motebit_id),
  // with the full id on `title` for copy/verify. "The face is the key" —
  // doctrine agents-as-first-person-trust-graph §4. The sigil's accessible
  // title is the UUID-safe short id (never user-set petname) so no untrusted
  // text enters the SVG string; the visible petname goes through textContent.
  // `onSetPetname` (Known only) makes the label an inline, local petname editor —
  // a record edit, not creation, so it's inline (no modal; no interior-register
  // rotation). First-person only; the short id stays the authority anchor.
  function renderAgentIdentity(opts: {
    fullId: string;
    petname?: string;
    // First-person trust tier (Known only) → a ring/glow wrapping the mark.
    // Omitted on Discover: that trust would be the relay's claim, not yours.
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
      // Face from the motebit_id — always present, so the same agent shows the
      // SAME mark in Known and Discover (a pubkey isn't reliably client-side).
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
        if (save)
          onSet(input.value); // empty ⇒ clears (controller trims)
        else buildView(); // cancel — restore the label view
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
        // petname headline → keep the verifiable short id beneath it
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
        // no petname → short id headline + a subtle local "name" affordance
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
      // Empty nested inside the list (conversations pattern) so the
      // pulse claims the full pane height; sibling-empty siblings split
      // flex 50/50 and push the pulse below center.
      const empty = document.createElement("div");
      setEmptyPulse(
        empty,
        "Known agents appear here",
        "as your motebit discovers them through delegation",
      );
      agentsList.appendChild(empty);
      return;
    }

    // The trust resting record (felt-interior §6) — the relational register at
    // the top of the Known tab, from the proven graph (state.known) + the
    // verified economic summary. A calm summary, never a score.
    const felt = resolveFeltTrust(state.known, state.economic);
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "padding:10px 14px;display:flex;flex-direction:column;gap:3px;border-bottom:1px solid rgba(127,127,127,0.16);";
    const headline = document.createElement("div");
    headline.style.cssText = "font-size:13px;opacity:0.9;";
    headline.textContent = felt.headline;
    wrap.appendChild(headline);
    const shapeLine = [
      ...felt.shape.map((s) => `${s.count} ${s.kind.replace(/_/g, " ")}`),
      ...(felt.hardwareBacked > 0 ? [`${felt.hardwareBacked} hardware-backed`] : []),
      ...(felt.settledWith > 0 ? [`settled with ${felt.settledWith}`] : []),
    ].join(" · ");
    if (shapeLine !== "") {
      const shape = document.createElement("div");
      shape.style.cssText = "font-size:11px;opacity:0.55;";
      shape.textContent = shapeLine;
      wrap.appendChild(shape);
    }
    agentsList.appendChild(wrap);

    for (const agent of state.known) {
      const item = document.createElement("div");
      // panel-list-card carries glass material + lift; agent-item is
      // preserved for trust-badge / hardware-attestation selector hooks.
      item.className = "panel-list-card agent-item";

      item.appendChild(
        renderAgentIdentity({
          fullId: agent.remote_motebit_id,
          petname: agent.petname,
          trustLevel: agent.trust_level,
          onSetPetname: (pn) => void agentsCtrl.setPetname(agent.remote_motebit_id, pn),
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

      // The money side of the trust graph: net earned/paid with this peer,
      // derived from the relay's signed settlement ledger. Honest-empty —
      // rendered only when there's settled history (never a fabricated $0).
      const money = formatPeerEconomics(economicForPeer(state.economic, agent.remote_motebit_id));
      if (money != null) {
        const moneyEl = document.createElement("span");
        moneyEl.className = "agent-item-money";
        moneyEl.textContent = money;
        meta.appendChild(moneyEl);
      }

      item.appendChild(meta);
      agentsList.appendChild(item);
    }
  }

  // --- Discover tab ---
  const discoverList = document.getElementById("agents-discover-list") as HTMLDivElement;
  const knownPane = document.getElementById("agents-known-pane") as HTMLDivElement;
  const discoverPane = document.getElementById("agents-discover-pane") as HTMLDivElement;
  const tabBtns = Array.from(agentsPanel.querySelectorAll<HTMLButtonElement>(".agents-tab"));

  function switchTab(tab: string): void {
    for (const btn of tabBtns) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    }
    knownPane.style.display = tab === "known" ? "" : "none";
    discoverPane.style.display = tab === "discover" ? "" : "none";
    if (tab === "known") agentsCtrl.setActiveTab("known");
    else if (tab === "discover") {
      agentsCtrl.setActiveTab("discover");
      void agentsCtrl.refreshDiscover();
    }
  }

  for (const btn of tabBtns) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab ?? "known"));
  }

  function renderDiscover(state: AgentsState): void {
    const syncUrl = loadSyncUrl();
    discoverList.innerHTML = "";

    if (!syncUrl) {
      // Universal panel-empty-pulse register. The caption signals
      // setup-needed; the visual register stays uniform with the rest
      // of the panel family. Empty nested inside the list
      // (conversations pattern) so the pulse claims full pane height.
      const empty = document.createElement("div");
      setEmptyPulse(empty, "Discover new agents", "connect a relay in Settings first");
      discoverList.appendChild(empty);
      return;
    }

    if (state.discovered.length === 0) {
      const empty = document.createElement("div");
      if (state.error != null) {
        // Error state — flat row (transient, recoverable).
        setEmptyRow(empty, "Couldn't reach the relay");
      } else {
        setEmptyPulse(empty, "Discover new agents", "as the network grows");
      }
      discoverList.appendChild(empty);
      return;
    }

    for (const agent of state.discovered) {
      const item = document.createElement("div");
      // panel-list-card carries glass material + lift; agent-item is
      // preserved for trust-badge / hardware-attestation selector hooks.
      item.className = "panel-list-card agent-item";

      item.appendChild(renderAgentIdentity({ fullId: agent.motebit_id }));

      // Self-asserted name + description — CLAIMS, never verified handles
      // (trust-graph §3). textContent only; formatNameClaim clamps.
      if (agent.display_name != null && agent.display_name.trim().length > 0) {
        const claim = document.createElement("div");
        claim.className = "agent-name-claim";
        claim.textContent = formatNameClaim(agent.display_name);
        item.appendChild(claim);
      }
      if (agent.description != null && agent.description.trim().length > 0) {
        const desc = document.createElement("div");
        desc.className = "agent-desc";
        desc.textContent = agent.description.trim().slice(0, 200);
        item.appendChild(desc);
      }

      if (agent.capabilities.length > 0) {
        const priceByCapability = new Map<string, PricingEntry>();
        if (Array.isArray(agent.pricing)) {
          for (const p of agent.pricing) priceByCapability.set(p.capability, p);
        }

        const capsRow = document.createElement("div");
        capsRow.className = "agent-caps-row";
        for (const cap of agent.capabilities) {
          const price = priceByCapability.get(cap);
          const priced = price != null && price.unit_cost > 0;
          // A priced capability is hireable: the tag becomes a launch affordance
          // that hands the hire to the slab (panel browses, slab composes +
          // acts). Free capabilities stay informational spans. The tap pins WHO
          // (this agent) + WHAT (this capability) and routes through
          // invokeCapability — never the AI loop (surface-determinism).
          if (priced && hooks.onHire) {
            const priceLabel = `$${price.unit_cost.toFixed(2)}`;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "agent-cap-tag priced agent-cap-hire";
            btn.textContent = `${cap} · ${priceLabel}/${price.per}`;
            btn.title = `Hire ${shortMotebitId(agent.motebit_id)} for ${cap} — ${price.unit_cost} ${price.currency} per ${price.per}`;
            btn.setAttribute("aria-label", `Hire for ${cap}, ${priceLabel} per ${price.per}`);
            btn.addEventListener("click", () => {
              closeAgents();
              hooks.onHire!({
                workerId: agent.motebit_id,
                capability: cap,
                label: shortMotebitId(agent.motebit_id),
                priceLabel,
              });
            });
            capsRow.appendChild(btn);
            continue;
          }
          const tag = document.createElement("span");
          tag.className = "agent-cap-tag";
          if (priced) {
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
      if (agent.trust_level != null && agent.trust_level !== "") {
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

      // Epistemic cue: Discover is the network's claim, not a proven relationship.
      // Any trust shown above is the relay's aggregate opinion, not first-person.
      const prov = document.createElement("div");
      prov.className = "agent-provenance";
      const earned = typeof agent.interaction_count === "number" && agent.interaction_count > 0;
      prov.textContent = earned ? "via relay" : "via relay · no earned trust yet";
      item.appendChild(prov);

      discoverList.appendChild(item);
    }
  }

  agentsCtrl.subscribe((state) => {
    renderKnown(state);
    renderDiscover(state);
  });

  function openAgents(): void {
    closeAll();
    agentsPanel.classList.add("open");
    agentsBackdrop.classList.add("open");
    void agentsCtrl.refreshKnown();
    // Money side of the trust graph — fetched alongside Known, rendered under
    // each peer's mark. Independent + fail-soft (the relay read can fail
    // without disturbing the local Known list).
    void agentsCtrl.refreshEconomic();
  }

  function closeAgents(): void {
    agentsPanel.classList.remove("open");
    agentsBackdrop.classList.remove("open");
  }

  document.getElementById("agents-btn")!.addEventListener("click", openAgents);
  document.getElementById("agents-close-btn")!.addEventListener("click", closeAgents);
  agentsBackdrop.addEventListener("click", closeAgents);

  // === Sync Popup (functional) ===
  const syncStatusEl = document.getElementById("sync-status") as HTMLDivElement;
  const syncPopup = document.getElementById("sync-popup") as HTMLDivElement;
  const syncRelayUrl = document.getElementById("sync-relay-url") as HTMLInputElement;
  const syncConnectBtn = document.getElementById("sync-connect-btn") as HTMLButtonElement;
  const syncDisconnectBtn = document.getElementById("sync-disconnect-btn") as HTMLButtonElement;
  const syncStatusText = document.getElementById("sync-status-text") as HTMLDivElement;

  function updateSyncUI(status: WebSyncStatus): void {
    // Update the HUD indicator class
    syncStatusEl.className = status === "offline" ? "disconnected" : status;

    // Update tooltip
    const label = SYNC_STATUS_LABELS[status] || status;
    syncStatusEl.title = label ? `Sync: ${label}` : "Sync: Not connected";

    // Update popup text
    syncStatusText.textContent = label;

    // Toggle connect/disconnect buttons
    const isActive = status === "connected" || status === "syncing" || status === "connecting";
    syncConnectBtn.style.display = isActive ? "none" : "";
    syncDisconnectBtn.style.display = isActive ? "" : "none";
  }

  syncRelayUrl.value = loadSyncUrl() ?? DEFAULT_RELAY_URL;

  // Subscribe to sync status changes
  ctx.app.onSyncStatusChange(updateSyncUI);

  // Connect button
  syncConnectBtn.addEventListener("click", () => {
    const url = normalizeRelayUrl(syncRelayUrl.value);
    if (!url) {
      syncStatusText.textContent = "Relay URL is required";
      return;
    }
    syncRelayUrl.value = url;
    saveSyncUrl(url);
    syncStatusText.textContent = "Connecting...";
    ctx.app.startSync(url).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      syncStatusText.textContent = `Failed: ${msg}`;
      ctx.showToast(`Sync failed: ${msg}`);
    });
  });

  // Disconnect button
  syncDisconnectBtn.addEventListener("click", () => {
    ctx.app.stopSync();
    clearSyncUrl();
    syncStatusText.textContent = "";
  });

  function toggleSync(): void {
    if (syncPopup.classList.contains("open")) {
      syncPopup.classList.remove("open");
    } else {
      closeAll();
      // Position popup below the sync status indicator
      const rect = syncStatusEl.getBoundingClientRect();
      syncPopup.style.top = `${rect.bottom + 8}px`;
      syncPopup.style.left = `${rect.left + rect.width / 2}px`;
      syncPopup.style.transform = "translateX(-50%)";
      syncPopup.classList.add("open");
    }
  }

  syncStatusEl.addEventListener("click", toggleSync);

  // Close sync popup on outside click
  document.addEventListener("click", (e) => {
    if (
      syncPopup.classList.contains("open") &&
      !syncPopup.contains(e.target as Node) &&
      !syncStatusEl.contains(e.target as Node)
    ) {
      syncPopup.classList.remove("open");
    }
  });

  // === Close All ===
  function closeAll(): void {
    closeMemory();
    closeGoals();
    closeAgents();
    syncPopup.classList.remove("open");
  }

  return { openMemory, openGoals, openAgents, closeAll };
}
