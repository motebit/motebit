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
  type ActivityController,
  type ActivityEvent,
  type ActivityKind,
  type ActivityFetchAdapter,
} from "@motebit/panels";
import { EventType } from "@motebit/sdk";

import type { WebContext } from "../types";

const ACTIVITY_ROUTE_PREFIX = "/activity";

const KIND_LABEL: Record<ActivityKind, string> = {
  deletion: "Deletions",
  consent: "Consents",
  export: "Exports",
  trust: "Trust",
  skill: "Skills",
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

  if (
    panel === null ||
    backdrop === null ||
    list === null ||
    filterBar === null ||
    searchInput === null ||
    closeBtn === null ||
    countBadge === null
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

  function renderFilterBar(): void {
    const ctrl = controller;
    const activeKinds = ctrl?.getState().filter.kinds ?? new Set<ActivityKind>();
    const kinds: ActivityKind[] = ["deletion", "consent", "export", "trust", "skill", "other"];
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
    renderAll();
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
