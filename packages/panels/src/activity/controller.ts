// Surface-agnostic state controller for the Activity panel.
//
// Sovereignty became signed + audited + event-logged across every
// surface in commit `d5e66e34` (deletion choke-point). The protocol
// layer now records every privacy-relevant action through two
// stores — `runtime.privacy.audit` (action rows: `delete_memory`,
// `delete_conversation`, `flush_record`, `set_sensitivity`,
// `export_all`, `list_memories`, `inspect_memory`) and
// `runtime.events` (intent events: `DeleteRequested`,
// `ExportRequested`, plus the wider lifecycle stream).
//
// Sovereignty is enforced. This controller makes it visible.
//
// The user-facing question is "what has my motebit done on my behalf,
// and when?" The two stores answer it; the controller projects them
// into one timeline + filter set + search box, so every surface
// renders the same audit-grade view regardless of how its persistence
// layer happens to be implemented.
//
// Render — DOM list on web/desktop, RN FlatList on mobile, terminal
// table in the CLI — stays surface-specific. The controller lifts:
//   1. Two-source merge (audit log + event log) with stable IDs.
//   2. Kind classification (`deletion` / `consent` / `export` /
//      `trust` / `intent` / `other`) so the same filter chip means
//      the same thing on every surface.
//   3. Most-recent-first sort, ties broken by source-of-truth ID
//      so reorders are deterministic across re-fetches.

// ── Source records ────────────────────────────────────────────────────
//
// Structural copies of @motebit/sdk's AuditRecord + EventLogEntry —
// the package can't import @motebit/sdk without leaving Layer 5.
// Surfaces pass through their richer types; controller reads only
// what it projects.

export interface ActivityAuditRecord {
  audit_id: string;
  motebit_id: string;
  timestamp: number;
  action: string;
  target_type: string;
  target_id: string;
  details: Record<string, unknown>;
}

export interface ActivityEventRecord {
  event_id: string;
  motebit_id: string;
  timestamp: number;
  event_type: string;
  payload: Record<string, unknown>;
  tombstoned: boolean;
}

// ── Projected timeline event ──────────────────────────────────────────

export type ActivityKind =
  | "deletion" // delete_memory, delete_conversation, flush_record, DeleteRequested
  | "consent" // set_sensitivity (any change), skill_consent_granted (when sourced)
  | "export" // export_all, ExportRequested
  | "trust" // skill_trust_grant, skill_trust_revoke, skill_remove
  | "skill" // SkillLoaded
  | "governance" // sensitivity_gate_fired — denied egress at the boundary
  | "other";

export interface ActivityEvent {
  /**
   * Stable ID derived from the source record (audit_id, event_id, etc).
   * Surfaces use this as a React key / list-row key.
   */
  id: string;
  /** Epoch milliseconds. */
  at: number;
  kind: ActivityKind;
  /** Where the row originated, for "show source" debugging panels. */
  source: "audit_log" | "event_log";
  /** The raw action / event_type string from the source row. */
  action: string;
  /**
   * Optional target. `target_type` mirrors AuditRecord; for events,
   * payload-derived (e.g. DeleteRequested.payload.target_type).
   */
  target_type?: string;
  target_id?: string;
  details: Record<string, unknown>;
  /**
   * Cert signature when the source row recorded one (`mutable_pruning`
   * for `delete_memory`, `consolidation_flush` for `flush_record`).
   * Surfaces render a "(signed)" tag when present.
   */
  signature?: string | null;
  cert_kind?: string | null;
}

// ── Adapter ───────────────────────────────────────────────────────────

export interface ActivityFetchAdapter {
  /**
   * Audit-log query. Returns user-actions taken on the motebit's
   * behalf. The timestamp window is enforced by the controller — the
   * adapter just hands back raw rows.
   */
  queryAudit(opts: { limit?: number; after?: number }): Promise<ActivityAuditRecord[]>;
  /**
   * Event-log query. Returns intent events
   * (`DeleteRequested`, `ExportRequested`, etc) plus the wider
   * lifecycle stream the surface chooses to display. The controller
   * filters by `event_type` post-fetch — adapter implementations are
   * free to push the predicate down to the underlying store if their
   * persistence supports it, or return everything and let the
   * controller filter in memory.
   */
  queryEvents(opts: {
    eventTypes?: ReadonlyArray<string>;
    limit?: number;
    after?: number;
  }): Promise<ActivityEventRecord[]>;
}

// ── Options ───────────────────────────────────────────────────────────

export interface ActivityControllerOptions {
  /**
   * How many rows to ask each source for per refresh. Default 200.
   * The merged view is bounded by `state.filter.limit` (separately).
   */
  fetchLimit?: number;
  /**
   * Audit actions and event types the surface NEVER wants in the
   * timeline. By default `list_memories` and `inspect_memory` are
   * hidden — they'd dominate every list, and the surface treats
   * "look-at" as not user-action-worthy. Pass `[]` to include them.
   */
  hiddenActions?: ReadonlyArray<string>;
  /**
   * Event types worth surfacing as activity rows. Default focuses on
   * the privacy-relevant set (`DeleteRequested`, `ExportRequested`,
   * `SkillLoaded`); a surface that wants the wider stream can pass
   * its own list.
   */
  surfacedEventTypes?: ReadonlyArray<string>;
}

const DEFAULT_HIDDEN_ACTIONS: ReadonlyArray<string> = ["list_memories", "inspect_memory"];

const DEFAULT_SURFACED_EVENT_TYPES: ReadonlyArray<string> = [
  "delete_requested",
  "export_requested",
  "skill_loaded",
  // SensitivityGateFired — every blocked egress crossing emits one.
  // The audit-trail pivot: the five-boundary sensitivity gate is
  // fail-closed but invisible until a consumer reads the events.
  // Surfacing them in the activity timeline converts internal
  // correctness into user-visible governance proof.
  "sensitivity_gate_fired",
];

const DEFAULT_FETCH_LIMIT = 200;

// ── State ─────────────────────────────────────────────────────────────

export interface ActivityState {
  events: ActivityEvent[];
  filter: {
    kinds: ReadonlySet<ActivityKind>;
    search: string;
  };
  loading: boolean;
  error: string | null;
}

function initialState(): ActivityState {
  return {
    events: [],
    filter: { kinds: new Set(), search: "" },
    loading: false,
    error: null,
  };
}

// ── Projection: AuditRecord → ActivityEvent ──────────────────────────

function classifyAuditAction(action: string): ActivityKind {
  switch (action) {
    case "delete_memory":
    case "delete_conversation":
    case "flush_record":
      return "deletion";
    case "set_sensitivity":
      return "consent";
    case "export_all":
      return "export";
    default:
      return "other";
  }
}

function classifyEventType(eventType: string): ActivityKind {
  // EventType enum values are lowercased + underscore (per
  // @motebit/protocol's EventType — `DeleteRequested = "delete_requested"`).
  switch (eventType) {
    case "delete_requested":
      return "deletion";
    case "export_requested":
      return "export";
    case "skill_loaded":
      return "skill";
    case "sensitivity_gate_fired":
      return "governance";
    default:
      return "other";
  }
}

function projectAudit(record: ActivityAuditRecord): ActivityEvent {
  const certSignature = record.details["cert_signature"];
  const certKind = record.details["cert_kind"];
  return {
    id: `audit:${record.audit_id}`,
    at: record.timestamp,
    kind: classifyAuditAction(record.action),
    source: "audit_log",
    action: record.action,
    target_type: record.target_type,
    target_id: record.target_id,
    details: record.details,
    signature: typeof certSignature === "string" ? certSignature : null,
    cert_kind: typeof certKind === "string" ? certKind : null,
  };
}

function projectEvent(record: ActivityEventRecord): ActivityEvent {
  const targetType = record.payload["target_type"];
  const targetId = record.payload["target_id"];
  return {
    id: `event:${record.event_id}`,
    at: record.timestamp,
    kind: classifyEventType(record.event_type),
    source: "event_log",
    action: record.event_type,
    target_type: typeof targetType === "string" ? targetType : undefined,
    target_id: typeof targetId === "string" ? targetId : undefined,
    details: record.payload,
    signature: null,
    cert_kind: null,
  };
}

// ── Derived view (pure, exported for tests + direct surface use) ──────

/**
 * Apply the panel's filters: drop hidden actions, drop kinds outside
 * the active filter set, apply the search query (case-insensitive
 * substring match against action + target_id + target_type).
 *
 * Sort: most-recent-first by timestamp; ties broken by id so the
 * order is deterministic across reloads.
 */
export function filterActivityView(
  events: readonly ActivityEvent[],
  filter: { kinds: ReadonlySet<ActivityKind>; search: string },
): ActivityEvent[] {
  const query = filter.search.trim().toLowerCase();
  const kindFilter = filter.kinds.size > 0 ? filter.kinds : null;

  const filtered: ActivityEvent[] = [];
  for (const e of events) {
    if (kindFilter !== null && !kindFilter.has(e.kind)) continue;
    if (query !== "") {
      const haystack = `${e.action} ${e.target_type ?? ""} ${e.target_id ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    filtered.push(e);
  }
  filtered.sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return filtered;
}

// ── Controller ────────────────────────────────────────────────────────

export interface ActivityController {
  getState(): ActivityState;
  subscribe(listener: (state: ActivityState) => void): () => void;
  refresh(): Promise<void>;
  setSearch(q: string): void;
  /**
   * Toggle a kind in/out of the active filter set. Empty filter set
   * means "show all kinds" (vs "show nothing"); same idiom as the
   * existing memory + skills controllers.
   */
  toggleKind(kind: ActivityKind): void;
  clearFilters(): void;
  /** Filtered + sorted view per the active filter. */
  filteredView(): ActivityEvent[];
  dispose(): void;
}

export function createActivityController(
  adapter: ActivityFetchAdapter,
  options: ActivityControllerOptions = {},
): ActivityController {
  const hiddenActions = new Set(options.hiddenActions ?? DEFAULT_HIDDEN_ACTIONS);
  const surfacedEventTypes = options.surfacedEventTypes ?? DEFAULT_SURFACED_EVENT_TYPES;
  const fetchLimit = options.fetchLimit ?? DEFAULT_FETCH_LIMIT;

  let state = initialState();
  const listeners = new Set<(s: ActivityState) => void>();

  function emit(): void {
    for (const l of listeners) l(state);
  }
  function update(patch: Partial<ActivityState>): void {
    state = { ...state, ...patch };
    emit();
  }

  async function refresh(): Promise<void> {
    update({ loading: true, error: null });
    try {
      const [auditRows, eventRows] = await Promise.all([
        adapter.queryAudit({ limit: fetchLimit }),
        adapter.queryEvents({ eventTypes: surfacedEventTypes, limit: fetchLimit }),
      ]);
      const projected: ActivityEvent[] = [];
      for (const r of auditRows) {
        if (hiddenActions.has(r.action)) continue;
        projected.push(projectAudit(r));
      }
      for (const r of eventRows) {
        if (r.tombstoned) continue;
        projected.push(projectEvent(r));
      }
      update({ events: projected, loading: false, error: null });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({ loading: false, error: message });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    refresh,
    setSearch(q: string) {
      update({ filter: { ...state.filter, search: q } });
    },
    toggleKind(kind: ActivityKind) {
      const next = new Set(state.filter.kinds);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      update({ filter: { ...state.filter, kinds: next } });
    },
    clearFilters() {
      update({ filter: { kinds: new Set(), search: "" } });
    },
    filteredView() {
      return filterActivityView(state.events, state.filter);
    },
    dispose() {
      listeners.clear();
    },
  };
}
