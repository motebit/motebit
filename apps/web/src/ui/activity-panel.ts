/**
 * Activity panel — sovereignty-visible read view.
 *
 * Sovereignty became signed + audited + event-logged in `d5e66e34`
 * (deletion choke-point). Every privacy-relevant action lands two
 * rows: a `delete_*` / `flush_record` / `set_sensitivity` /
 * `export_all` row in the audit log, and (where applicable) a
 * `DeleteRequested` / `ExportRequested` intent event on the append-
 * only event log. This panel is the first surface that lets the user
 * see them — sibling to Memory / Goals / Skills, opens on `/activity`
 * or via `/activity` slash command.
 *
 * The cross-surface controller lives in `@motebit/panels` per the
 * established sovereign/agents/memory/goals/skills pattern; this
 * file is web's render of it. Mobile + desktop will mount the same
 * controller against their own runtime accessors as a follow-up
 * (panels CLAUDE.md: "the second consumer is when the gate lands").
 */

import {
  createActivityController,
  createRetentionController,
  createSelfTestController,
  selfTestBadgeLabel,
  summarizeRetentionCeilings,
  type ActivityController,
  type ActivityEvent,
  type ActivityKind,
  type ActivityFetchAdapter,
  type RetentionController,
  type RetentionFetchAdapter,
  type RetentionManifest,
  type SelfTestController,
  type SelfTestFetchAdapter,
  type TransparencyManifestSummary,
} from "@motebit/panels";
import { EventType } from "@motebit/sdk";
import { verifyRetentionManifest } from "@motebit/encryption";

import type { WebContext } from "../types";
import { loadSyncUrl } from "../storage";

const DEFAULT_RELAY_URL = "https://relay.motebit.com";

function resolveRelayUrl(): string {
  const configured = loadSyncUrl();
  return (configured ?? DEFAULT_RELAY_URL).replace(/\/$/, "");
}

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const ACTIVITY_ROUTE_PREFIX = "/activity";

const KIND_LABEL: Record<ActivityKind, string> = {
  deletion: "Deletions",
  consent: "Consents",
  export: "Exports",
  trust: "Trust",
  skill: "Skills",
  governance: "Governance",
  other: "Other",
};

const ACTION_LABEL: Record<string, string> = {
  delete_memory: "Deleted memory",
  delete_conversation: "Deleted conversation",
  flush_record: "Flushed record",
  set_sensitivity: "Changed sensitivity",
  export_all: "Exported data",
  delete_requested: "Requested deletion",
  export_requested: "Requested export",
  skill_loaded: "Loaded skill",
  sensitivity_gate_fired: "Blocked egress",
};

function formatTimeAgo(ts: number): string {
  const delta = Date.now() - ts;
  const sec = Math.round(delta / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

function shortenTarget(targetId: string | undefined): string {
  if (targetId === undefined || targetId === "") return "";
  if (targetId.length <= 14) return targetId;
  return `${targetId.slice(0, 8)}…${targetId.slice(-4)}`;
}

export interface ActivityPanelAPI {
  open(): void;
  close(): void;
  openIfRouted(): void;
}

export function initActivityPanel(ctx: WebContext): ActivityPanelAPI {
  const panel = document.getElementById("activity-panel") as HTMLDivElement | null;
  const backdrop = document.getElementById("activity-backdrop") as HTMLDivElement | null;
  const list = document.getElementById("activity-list") as HTMLDivElement | null;
  const filterBar = document.getElementById("activity-filters") as HTMLDivElement | null;
  const searchInput = document.getElementById("activity-search") as HTMLInputElement | null;
  const closeBtn = document.getElementById("activity-close-btn") as HTMLButtonElement | null;
  const countBadge = document.getElementById("activity-count") as HTMLSpanElement | null;
  const retentionBlock = document.getElementById("activity-retention") as HTMLDivElement | null;

  if (
    panel === null ||
    backdrop === null ||
    list === null ||
    filterBar === null ||
    searchInput === null ||
    closeBtn === null ||
    countBadge === null ||
    retentionBlock === null
  ) {
    // Panel HTML missing — surface didn't include the markup. Return a
    // no-op API so the caller still has the same shape.
    return {
      open: () => undefined,
      close: () => undefined,
      openIfRouted: () => undefined,
    };
  }

  let controller: ActivityController | null = null;
  let retentionCtrl: RetentionController | null = null;
  let selfTestCtrl: SelfTestController | null = null;

  function attachSelfTestController(): SelfTestController {
    if (selfTestCtrl !== null) return selfTestCtrl;
    const adapter: SelfTestFetchAdapter = {
      runSelfTest: async () => {
        // Surfaces wire to the WebApp's `runSelfTestNow` — same
        // cmdSelfTest probe the bootstrap path uses, just on demand.
        // The controller catches throws and projects them as `failed`,
        // so the adapter can surface relay errors without try/catch.
        const result = await ctx.app.runSelfTestNow();
        return {
          status: result.status,
          summary: result.summary,
          hint: result.hint,
          httpStatus: result.httpStatus,
          taskId: result.taskId,
        };
      },
    };
    selfTestCtrl = createSelfTestController(adapter);
    selfTestCtrl.subscribe(() => {
      renderRetention();
    });
    return selfTestCtrl;
  }

  function attachRetentionController(): RetentionController {
    if (retentionCtrl !== null) return retentionCtrl;
    const adapter: RetentionFetchAdapter = {
      // Two-fetch coordination: transparency manifest first (carries
      // the operator pubkey), then retention manifest (signed by it).
      // Matches the doctrine pair in operator-transparency.md +
      // retention-policy.md §"Self-attesting transparency".
      fetchTransparency: async (): Promise<TransparencyManifestSummary | null> => {
        const url = `${resolveRelayUrl()}/.well-known/motebit-transparency.json`;
        try {
          const resp = await fetch(url, { headers: { Accept: "application/json" } });
          if (!resp.ok) return null;
          const body = (await resp.json()) as {
            relay_id?: string;
            relay_public_key?: string;
          };
          if (typeof body.relay_id !== "string" || typeof body.relay_public_key !== "string") {
            return null;
          }
          return { relay_id: body.relay_id, relay_public_key: body.relay_public_key };
        } catch {
          return null;
        }
      },
      fetchRetentionManifest: async (): Promise<RetentionManifest | null> => {
        const url = `${resolveRelayUrl()}/.well-known/motebit-retention.json`;
        try {
          const resp = await fetch(url, { headers: { Accept: "application/json" } });
          if (!resp.ok) return null;
          return (await resp.json()) as RetentionManifest;
        } catch {
          return null;
        }
      },
      verifyManifest: async (manifest, operatorPublicKeyHex) => {
        // verifyRetentionManifest validates spec + suite + signature
        // against the canonicalJson(body). The operator's public key
        // is hex-encoded in the transparency manifest.
        const keyBytes = hexToBytes(operatorPublicKeyHex);
        const result = await verifyRetentionManifest(
          manifest as Parameters<typeof verifyRetentionManifest>[0],
          keyBytes,
        );
        return { valid: result.valid, errors: result.errors };
      },
    };
    retentionCtrl = createRetentionController(adapter);
    retentionCtrl.subscribe(() => {
      renderRetention();
    });
    return retentionCtrl;
  }

  function tryAttachController(): ActivityController | null {
    if (controller !== null) return controller;
    const runtime = ctx.app.getRuntime();
    if (runtime === null) return null;
    const adapter: ActivityFetchAdapter = {
      queryAudit: async ({ limit, after }) => {
        // The runtime exposes `auditLog: AuditLogAdapter` — direct
        // pass-through, the controller handles projection + filtering.
        const opts: { limit?: number; after?: number } = {};
        if (limit !== undefined) opts.limit = limit;
        if (after !== undefined) opts.after = after;
        const rows = await runtime.auditLog.query(runtime.motebitId, opts);
        // AuditRecord is structurally compatible with ActivityAuditRecord.
        return rows.map((r) => ({
          audit_id: r.audit_id,
          motebit_id: r.motebit_id,
          timestamp: r.timestamp,
          action: r.action,
          target_type: r.target_type,
          target_id: r.target_id,
          details: r.details,
        }));
      },
      queryEvents: async ({ eventTypes, limit, after }) => {
        // Push the type filter down to the event store — without it
        // the rare intent events (DeleteRequested, ExportRequested)
        // get buried under MemoryFormed / ToolUsed in the limit
        // window. The strings in `eventTypes` match the EventType
        // enum's underlying values (e.g. `"delete_requested"`).
        const filter: {
          motebit_id: string;
          limit?: number;
          after_timestamp?: number;
          event_types?: EventType[];
        } = {
          motebit_id: runtime.motebitId,
        };
        if (limit !== undefined) filter.limit = limit;
        if (after !== undefined) filter.after_timestamp = after;
        if (eventTypes !== undefined && eventTypes.length > 0) {
          filter.event_types = eventTypes as EventType[];
        }
        const rows = await runtime.events.query(filter);
        return rows.map((r) => ({
          event_id: r.event_id,
          motebit_id: r.motebit_id,
          timestamp: r.timestamp,
          event_type: r.event_type,
          payload: r.payload ?? {},
          tombstoned: r.tombstoned,
        }));
      },
    };
    controller = createActivityController(adapter);
    controller.subscribe(() => {
      renderAll();
    });
    return controller;
  }

  function renderRetention(): void {
    const ctrl = retentionCtrl;
    if (ctrl === null) {
      retentionBlock!.innerHTML = `<div class="activity-retention-empty">Operator retention status loading…</div>`;
      return;
    }
    const s = ctrl.getState();
    const operator = s.operatorId ?? "operator";
    const statusClass = `activity-retention-status-${s.verification}`;
    const statusLabel: Record<typeof s.verification, string> = {
      idle: "—",
      loading: "checking",
      verified: "verified",
      invalid: "invalid",
      unreachable: "unreachable",
    };
    const header = `
      <div class="activity-retention-header">
        <span class="activity-retention-operator">${escapeHtml(operator)}</span>
        <span class="activity-retention-status ${statusClass}">${escapeHtml(statusLabel[s.verification])}</span>
      </div>
    `;
    let table = "";
    if (s.manifest !== null) {
      const summary = summarizeRetentionCeilings(s.manifest);
      if (summary.length > 0) {
        const rows = summary.map(
          (e) => `
            <span class="activity-retention-tier">${escapeHtml(e.sensitivity)}</span>
            <span class="activity-retention-days">${e.days === null ? "no expiry" : `${e.days}d`}</span>
          `,
        );
        table = `<div class="activity-retention-table">${rows.join("")}</div>`;
      }
    }
    let errorBlock = "";
    if (s.errors.length > 0 && s.verification !== "verified") {
      errorBlock = `<div class="activity-retention-error">${escapeHtml(s.errors[0]!)}</div>`;
    }

    // Third leg of the sovereignty-visible trifecta: protocol still
    // works. Adversarial-onboarding probe per CLAUDE.md — submits a
    // self-delegation task through the live relay and asserts the
    // sybil-defense + audience-binding boundary holds. Inline below
    // the operator's retention promise; the user clicks once and
    // sees a green/red receipt.
    const stState = selfTestCtrl?.getState() ?? null;
    const stStatusClass =
      stState === null ? "idle" : stState.status === "running" ? "loading" : stState.status;
    const stLabel = stState === null ? "not run" : selfTestBadgeLabel(stState.status);
    const stRunDisabled = stState !== null && stState.status === "running" ? " disabled" : "";
    const stHint =
      stState !== null &&
      stState.status !== "passed" &&
      stState.status !== "idle" &&
      stState.summary !== ""
        ? `<div class="activity-retention-error">${escapeHtml(stState.summary)}</div>`
        : "";
    const selfTestBlock = `
      <div class="activity-self-test">
        <button id="activity-self-test-btn" class="activity-self-test-btn"${stRunDisabled}>Run security self-test</button>
        <span class="activity-retention-status activity-retention-status-${escapeHtml(stStatusClass)}">${escapeHtml(stLabel)}</span>
      </div>
      ${stHint}
    `;

    retentionBlock!.innerHTML = header + table + errorBlock + selfTestBlock;

    // Re-bind the button click after innerHTML rewrite.
    const btn = document.getElementById("activity-self-test-btn") as HTMLButtonElement | null;
    if (btn !== null) {
      btn.addEventListener("click", () => {
        void attachSelfTestController().run();
      });
    }
  }

  function renderFilterBar(): void {
    const ctrl = controller;
    const activeKinds = ctrl?.getState().filter.kinds ?? new Set<ActivityKind>();
    const kinds: ActivityKind[] = [
      "deletion",
      "consent",
      "export",
      "trust",
      "skill",
      "governance",
      "other",
    ];
    const chips = kinds.map((k) => {
      const active = activeKinds.has(k);
      return `<button class="activity-chip${active ? " active" : ""}" data-kind="${k}">${KIND_LABEL[k]}</button>`;
    });
    filterBar!.innerHTML = chips.join("");
    for (const btn of Array.from(
      filterBar!.querySelectorAll<HTMLButtonElement>(".activity-chip"),
    )) {
      btn.addEventListener("click", () => {
        const kind = btn.dataset["kind"] as ActivityKind | undefined;
        if (kind === undefined) return;
        controller?.toggleKind(kind);
      });
    }
  }

  function renderRow(event: ActivityEvent): string {
    const target = shortenTarget(event.target_id);
    const targetText =
      target === "" ? "" : ` <span class="activity-target">${escapeHtml(target)}</span>`;
    const signed =
      event.signature !== null && event.signature !== undefined && event.signature !== ""
        ? ` <span class="activity-signed" title="signed ${escapeHtml(event.cert_kind ?? "")} cert">signed</span>`
        : "";
    const intent =
      event.source === "event_log" ? ' <span class="activity-intent">intent</span>' : "";
    return `
      <div class="activity-row activity-row-${event.kind}">
        <div class="activity-row-line1">
          <span class="activity-action">${escapeHtml(actionLabel(event.action))}</span>${targetText}${signed}${intent}
        </div>
        <div class="activity-row-line2">
          <span class="activity-time">${escapeHtml(formatTimeAgo(event.at))}</span>
        </div>
      </div>
    `;
  }

  function renderAll(): void {
    const ctrl = controller;
    if (ctrl === null) {
      list!.innerHTML = `<div class="activity-empty">Activity is starting up…</div>`;
      countBadge!.textContent = "…";
      return;
    }
    const view = ctrl.filteredView();
    const state = ctrl.getState();
    countBadge!.textContent = String(view.length);
    renderFilterBar();
    if (state.error !== null) {
      list!.innerHTML = `<div class="activity-empty">Failed to load: ${escapeHtml(state.error)}</div>`;
      return;
    }
    if (state.loading && view.length === 0) {
      list!.innerHTML = `<div class="activity-empty">Loading…</div>`;
      return;
    }
    if (view.length === 0) {
      list!.innerHTML = `<div class="activity-empty">${
        state.events.length === 0 ? "No activity recorded yet." : "No activity matches your filter."
      }</div>`;
      return;
    }
    list!.innerHTML = view.map(renderRow).join("");
  }

  function open(): void {
    panel!.classList.add("open");
    backdrop!.classList.add("open");
    if (window.location.pathname !== ACTIVITY_ROUTE_PREFIX) {
      window.history.pushState({ activity: true }, "", ACTIVITY_ROUTE_PREFIX);
    }
    const ctrl = tryAttachController();
    if (ctrl !== null) void ctrl.refresh();
    // Retention summary is independent of the runtime — fetches the
    // operator's signed manifest pair and verifies in the browser. We
    // refresh on every open so a stale verified-at timestamp becomes
    // visible if the manifest rotates between sessions.
    void attachRetentionController().refresh();
    // Self-test controller attaches lazy — we don't auto-run on open
    // (the probe submits a task through the live relay; firing it on
    // every panel open would be noisy + waste relay budget). The
    // user clicks the button when they want to verify.
    attachSelfTestController();
    renderAll();
    renderRetention();
  }

  function close(): void {
    panel!.classList.remove("open");
    backdrop!.classList.remove("open");
    if (window.location.pathname.startsWith(ACTIVITY_ROUTE_PREFIX)) {
      window.history.pushState({}, "", "/");
    }
  }

  function openIfRouted(): void {
    if (window.location.pathname.startsWith(ACTIVITY_ROUTE_PREFIX)) {
      open();
    }
  }

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  searchInput.addEventListener("input", () => {
    controller?.setSearch(searchInput.value);
  });

  document.addEventListener("motebit:open-activity", () => open());

  return { open, close, openIfRouted };
}
