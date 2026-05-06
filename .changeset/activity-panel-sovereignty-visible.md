---
"motebit": minor
---

Activity panel — sovereignty-visible read view. The deletion choke-point shipped in `d5e66e34` made every user-driven memory and conversation deletion signed, audited, and event-logged with `DeleteRequested` — but the receipts were invisible. The audit log accumulated `delete_memory` / `delete_conversation` / `flush_record` rows, the event log accumulated `DeleteRequested` and `ExportRequested` intents, and no surface rendered them. This commit closes the visibility half of the sovereignty arc.

Cross-surface controller in `@motebit/panels` (`createActivityController`, `filterActivityView`, `ActivityEvent`, `ActivityKind`) — same Layer 5 BSL pattern as memory/skills/goals/sovereign. Two-source merge (audit log + event log), kind classification, deterministic sort, search + chip filters. Web is the first consumer: `/activity` URL route + `motebit:open-activity` event + slash-command + escape-key wiring. Mobile and desktop will mount the same controller against their own runtime accessors as a follow-up — the panels CLAUDE.md drift-gate idiom ("the second consumer is when the gate lands") applies.

```ts
const ctrl = createActivityController({
  queryAudit: ({ limit }) => runtime.auditLog.query(motebitId, { limit }),
  queryEvents: ({ eventTypes, limit }) =>
    runtime.events.query({
      motebit_id: motebitId,
      event_types: eventTypes as EventType[],
      limit,
    }),
});
await ctrl.refresh();
ctrl.toggleKind("deletion"); // chip filter
ctrl.setSearch("conversation"); // substring on action / target
const view = ctrl.filteredView(); // most-recent-first, deterministic ties
```

15 controller tests covering projection (audit + event), classification, signature surfacing, default noise filter (`list_memories` / `inspect_memory` hidden), tombstone exclusion, sort + tiebreak, kind toggle, search, error paths, subscribe lifecycle.
