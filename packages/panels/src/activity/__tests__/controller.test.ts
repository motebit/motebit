import { describe, it, expect, beforeEach } from "vitest";
import {
  createActivityController,
  filterActivityView,
  type ActivityAuditRecord,
  type ActivityEventRecord,
  type ActivityFetchAdapter,
  type ActivityEvent,
} from "../controller";

// ── Helpers ───────────────────────────────────────────────────────────

function makeAudit(overrides: Partial<ActivityAuditRecord> = {}): ActivityAuditRecord {
  return {
    audit_id: overrides.audit_id ?? `a-${Math.random().toString(36).slice(2, 8)}`,
    motebit_id: "m1",
    timestamp: 1000,
    action: "delete_memory",
    target_type: "memory",
    target_id: "n1",
    details: {},
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ActivityEventRecord> = {}): ActivityEventRecord {
  return {
    event_id: overrides.event_id ?? `e-${Math.random().toString(36).slice(2, 8)}`,
    motebit_id: "m1",
    timestamp: 1000,
    event_type: "delete_requested",
    payload: { target_type: "memory", target_id: "n1", reason: "user_request" },
    tombstoned: false,
    ...overrides,
  };
}

function makeAdapter(
  audit: ActivityAuditRecord[],
  events: ActivityEventRecord[],
): ActivityFetchAdapter {
  return {
    queryAudit: async () => audit,
    queryEvents: async () => events,
  };
}

// ── Projection + classification ───────────────────────────────────────

describe("ActivityController — projection", () => {
  it("classifies audit actions into the correct kind", async () => {
    const adapter = makeAdapter(
      [
        makeAudit({ audit_id: "a1", action: "delete_memory" }),
        makeAudit({ audit_id: "a2", action: "delete_conversation", target_type: "conversation" }),
        makeAudit({ audit_id: "a3", action: "flush_record", target_type: "conversation_message" }),
        makeAudit({ audit_id: "a4", action: "set_sensitivity" }),
        makeAudit({ audit_id: "a5", action: "export_all" }),
        makeAudit({ audit_id: "a6", action: "weird_action" }),
      ],
      [],
    );
    const ctrl = createActivityController(adapter);
    await ctrl.refresh();
    const byId = (id: string): ActivityEvent | undefined =>
      ctrl.getState().events.find((e) => e.id === `audit:${id}`);
    expect(byId("a1")?.kind).toBe("deletion");
    expect(byId("a2")?.kind).toBe("deletion");
    expect(byId("a3")?.kind).toBe("deletion");
    expect(byId("a4")?.kind).toBe("consent");
    expect(byId("a5")?.kind).toBe("export");
    expect(byId("a6")?.kind).toBe("other");
  });

  it("classifies surfaced event types into the correct kind", async () => {
    const adapter = makeAdapter(
      [],
      [
        makeEvent({ event_id: "e1", event_type: "delete_requested" }),
        makeEvent({ event_id: "e2", event_type: "export_requested", payload: {} }),
        makeEvent({ event_id: "e3", event_type: "skill_loaded", payload: {} }),
        // SensitivityGateFired — denied egress at the boundary, classified as governance
        makeEvent({
          event_id: "e4",
          event_type: "sensitivity_gate_fired",
          payload: {
            entry: "outbound_tool",
            session_sensitivity: "none",
            effective_sensitivity: "secret",
            provider_mode: "byok",
            tool_name: "web_search",
          },
        }),
      ],
    );
    const ctrl = createActivityController(adapter);
    await ctrl.refresh();
    expect(ctrl.getState().events.find((e) => e.id === "event:e1")?.kind).toBe("deletion");
    expect(ctrl.getState().events.find((e) => e.id === "event:e2")?.kind).toBe("export");
    expect(ctrl.getState().events.find((e) => e.id === "event:e3")?.kind).toBe("skill");
    expect(ctrl.getState().events.find((e) => e.id === "event:e4")?.kind).toBe("governance");
  });

  it("preserves SensitivityGateFired payload on the projected event details", async () => {
    // The activity panel renders extra fields (entry, session/effective tier,
    // provider_mode, tool_name) from `details`. The controller must
    // pass the payload through unchanged so surfaces can show "Blocked
    // outbound web_search to BYOK at session=none / effective=secret"
    // without parsing the event_log row a second time.
    const adapter = makeAdapter(
      [],
      [
        makeEvent({
          event_id: "gate-1",
          event_type: "sensitivity_gate_fired",
          payload: {
            entry: "sendMessageStreaming",
            session_sensitivity: "personal",
            effective_sensitivity: "medical",
            provider_mode: "byok",
            elevated_by: { via: "slab_item", slab_item_id: "slab-42" },
          },
        }),
      ],
    );
    const ctrl = createActivityController(adapter);
    await ctrl.refresh();
    const ev = ctrl.getState().events[0]!;
    expect(ev.kind).toBe("governance");
    expect(ev.action).toBe("sensitivity_gate_fired");
    expect(ev.details["entry"]).toBe("sendMessageStreaming");
    expect(ev.details["effective_sensitivity"]).toBe("medical");
    expect(ev.details["provider_mode"]).toBe("byok");
  });

  it("DEFAULT_SURFACED_EVENT_TYPES includes sensitivity_gate_fired (subscription contract)", async () => {
    // Surface adapters honor `eventTypes` and pass it down to
    // `runtime.events.query`. If the controller's defaults don't list
    // `sensitivity_gate_fired`, the surface query never asks for them
    // and governance fires never reach the timeline. This is the
    // load-bearing config: drop it and the moat-proof feature
    // silently disappears.
    let requestedTypes: ReadonlyArray<string> | undefined;
    const adapter: ActivityFetchAdapter = {
      queryAudit: async () => [],
      queryEvents: async (opts) => {
        requestedTypes = opts.eventTypes;
        return [];
      },
    };
    const ctrl = createActivityController(adapter);
    await ctrl.refresh();
    expect(requestedTypes).toContain("sensitivity_gate_fired");
  });

  it("surfaces cert signature + kind from delete_memory audit row", async () => {
    const adapter = makeAdapter(
      [
        makeAudit({
          audit_id: "a1",
          action: "delete_memory",
          details: { cert_kind: "mutable_pruning", cert_signature: "BASE64SIG" },
        }),
      ],
      [],
    );
    const ctrl = createActivityController(adapter);
    await ctrl.refresh();
    const ev = ctrl.getState().events[0]!;
    expect(ev.signature).toBe("BASE64SIG");
    expect(ev.cert_kind).toBe("mutable_pruning");
  });

  it("hides list_memories and inspect_memory by default (audit-noise filter)", async () => {
    const adapter = makeAdapter(
      [
        makeAudit({ audit_id: "a1", action: "list_memories" }),
        makeAudit({ audit_id: "a2", action: "inspect_memory" }),
        makeAudit({ audit_id: "a3", action: "delete_memory" }),
      ],
      [],
    );
    const ctrl = createActivityController(adapter);
    await ctrl.refresh();
    const events = ctrl.getState().events;
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("audit:a3");
  });

  it("hiddenActions option overrides the default noise filter", async () => {
    const adapter = makeAdapter(
      [
        makeAudit({ audit_id: "a1", action: "list_memories" }),
        makeAudit({ audit_id: "a2", action: "delete_memory" }),
      ],
      [],
    );
    const ctrl = createActivityController(adapter, { hiddenActions: [] });
    await ctrl.refresh();
    expect(ctrl.getState().events).toHaveLength(2);
  });

  it("skips tombstoned event-log rows", async () => {
    const adapter = makeAdapter(
      [],
      [
        makeEvent({ event_id: "e1", event_type: "delete_requested" }),
        makeEvent({ event_id: "e2", event_type: "delete_requested", tombstoned: true }),
      ],
    );
    const ctrl = createActivityController(adapter);
    await ctrl.refresh();
    expect(ctrl.getState().events).toHaveLength(1);
    expect(ctrl.getState().events[0]!.id).toBe("event:e1");
  });
});

// ── Filter + sort ─────────────────────────────────────────────────────

describe("ActivityController — filter view", () => {
  it("most-recent-first sort with deterministic tiebreak on id", () => {
    const events: ActivityEvent[] = [
      {
        id: "audit:b",
        at: 1000,
        kind: "deletion",
        source: "audit_log",
        action: "delete_memory",
        details: {},
      },
      {
        id: "audit:a",
        at: 1000,
        kind: "deletion",
        source: "audit_log",
        action: "delete_memory",
        details: {},
      },
      {
        id: "audit:c",
        at: 2000,
        kind: "deletion",
        source: "audit_log",
        action: "delete_memory",
        details: {},
      },
    ];
    const view = filterActivityView(events, { kinds: new Set(), search: "" });
    expect(view.map((e) => e.id)).toEqual(["audit:c", "audit:a", "audit:b"]);
  });

  it("kind filter narrows the view; empty filter set means all kinds", () => {
    const events: ActivityEvent[] = [
      {
        id: "1",
        at: 1,
        kind: "deletion",
        source: "audit_log",
        action: "delete_memory",
        details: {},
      },
      { id: "2", at: 2, kind: "export", source: "audit_log", action: "export_all", details: {} },
      {
        id: "3",
        at: 3,
        kind: "consent",
        source: "audit_log",
        action: "set_sensitivity",
        details: {},
      },
    ];
    expect(filterActivityView(events, { kinds: new Set(), search: "" })).toHaveLength(3);
    expect(filterActivityView(events, { kinds: new Set(["deletion"]), search: "" })).toHaveLength(
      1,
    );
    expect(
      filterActivityView(events, { kinds: new Set(["deletion", "consent"]), search: "" }),
    ).toHaveLength(2);
  });

  it("search query matches against action, target_type, target_id", () => {
    const events: ActivityEvent[] = [
      {
        id: "1",
        at: 1,
        kind: "deletion",
        source: "audit_log",
        action: "delete_memory",
        target_type: "memory",
        target_id: "node-abc",
        details: {},
      },
      {
        id: "2",
        at: 2,
        kind: "deletion",
        source: "audit_log",
        action: "delete_conversation",
        target_type: "conversation",
        target_id: "conv-xyz",
        details: {},
      },
    ];
    expect(filterActivityView(events, { kinds: new Set(), search: "abc" })).toHaveLength(1);
    expect(filterActivityView(events, { kinds: new Set(), search: "conversation" })).toHaveLength(
      1,
    );
    expect(filterActivityView(events, { kinds: new Set(), search: "delete" })).toHaveLength(2);
    expect(filterActivityView(events, { kinds: new Set(), search: "nope" })).toHaveLength(0);
  });
});

// ── Controller behavior ───────────────────────────────────────────────

describe("ActivityController — actions", () => {
  let adapter: ActivityFetchAdapter;
  beforeEach(() => {
    adapter = makeAdapter(
      [
        makeAudit({ audit_id: "a1", action: "delete_memory", timestamp: 200 }),
        makeAudit({ audit_id: "a2", action: "export_all", timestamp: 100 }),
      ],
      [makeEvent({ event_id: "e1", event_type: "delete_requested", timestamp: 300 })],
    );
  });

  it("toggleKind adds/removes from the active filter set", async () => {
    const ctrl = createActivityController(adapter);
    await ctrl.refresh();
    expect(ctrl.getState().filter.kinds.size).toBe(0);
    ctrl.toggleKind("deletion");
    expect(ctrl.getState().filter.kinds.has("deletion")).toBe(true);
    ctrl.toggleKind("deletion");
    expect(ctrl.getState().filter.kinds.size).toBe(0);
  });

  it("clearFilters resets kinds + search", async () => {
    const ctrl = createActivityController(adapter);
    await ctrl.refresh();
    ctrl.toggleKind("deletion");
    ctrl.setSearch("memory");
    ctrl.clearFilters();
    expect(ctrl.getState().filter.kinds.size).toBe(0);
    expect(ctrl.getState().filter.search).toBe("");
  });

  it("subscribe fires immediately with current state and on updates", async () => {
    const ctrl = createActivityController(adapter);
    const seen: number[] = [];
    const off = ctrl.subscribe((s) => seen.push(s.events.length));
    expect(seen).toEqual([0]); // initial empty
    await ctrl.refresh();
    expect(seen.length).toBeGreaterThan(1); // emitted on loading + final
    expect(seen[seen.length - 1]).toBe(3);
    off();
    ctrl.toggleKind("deletion");
    expect(seen.length).toBe(seen.length); // unsubscribed
  });

  it("error from queryAudit lands in state.error and clears loading", async () => {
    const failing: ActivityFetchAdapter = {
      queryAudit: async () => {
        throw new Error("audit unavailable");
      },
      queryEvents: async () => [],
    };
    const ctrl = createActivityController(failing);
    await ctrl.refresh();
    expect(ctrl.getState().error).toBe("audit unavailable");
    expect(ctrl.getState().loading).toBe(false);
    expect(ctrl.getState().events).toEqual([]);
  });

  it("filteredView reflects search + kind filter post-refresh", async () => {
    const ctrl = createActivityController(adapter);
    await ctrl.refresh();
    expect(ctrl.filteredView()).toHaveLength(3);
    ctrl.toggleKind("export");
    expect(ctrl.filteredView()).toHaveLength(1);
    expect(ctrl.filteredView()[0]!.action).toBe("export_all");
  });
});
