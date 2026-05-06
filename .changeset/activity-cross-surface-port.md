---
"motebit": minor
---

Activity + Retention panels land on desktop and mobile — the sovereignty-visible pair (signed-action timeline + browser-verified operator retention manifest) is now true on every shipping surface. Web shipped at `eb10bac6` / `ac622b64`; desktop and mobile mount the same `@motebit/panels` controllers against their own runtime accessors, with surface-specific render. The cross-surface contract is locked by drift gate `check-panel-controllers` (#33), which now enumerates `activity` and `retention` as additional families alongside `sovereign` / `agents` / `memory` / `goals` — any future surface that ships the panel UI but bypasses the controller fails CI.

Desktop: `apps/desktop/src/ui/activity.ts`, HTML markup + inline CSS, `/activity` slash command, escape-key wiring.

Mobile: `apps/mobile/src/components/ActivityPanel.tsx`, RN Modal + FlatList + chip filter row, `/activity` slash command.

Both surfaces refresh on every panel open: re-fetches `/.well-known/motebit-{transparency,retention}.json`, runs the same hex-pubkey decode + verifier-dispatch flow as web, renders the verification status badge + per-tier retention table above the audit timeline. Operator promise above, signed-action log below — same calm-software pattern, three surfaces, one controller pair.

```ts
// Same shape on every surface — surfaces wire the adapter:
const activityCtrl = createActivityController({
  queryAudit: ({ limit }) => runtime.auditLog.query(motebitId, { limit }),
  queryEvents: ({ eventTypes, limit }) =>
    runtime.events.query({ motebit_id: motebitId, event_types: eventTypes as EventType[], limit }),
});
const retentionCtrl = createRetentionController({
  fetchTransparency: () => fetchJson("/.well-known/motebit-transparency.json"),
  fetchRetentionManifest: () => fetchJson("/.well-known/motebit-retention.json"),
  verifyManifest: async (m, k) => verifyRetentionManifest(m, hexToBytes(k)),
});
```

Surface gap that remains: skill-audit log (web IDB / mobile SQLite / CLI fs) is rendered only by `motebit skills audit` today — the Activity panel doesn't merge it yet. The `ActivityKind` union has `consent` / `trust` / `skill` slots reserved for it; adding a third source to the controller's adapter is the natural follow-up.
