---
"@motebit/runtime": patch
"@motebit/sync-engine": minor
"@motebit/persistence": patch
"@motebit/browser-persistence": patch
"@motebit/desktop": patch
"@motebit/mobile": patch
"@motebit/web": patch
"@motebit/spatial": patch
---

Compaction never deletes an event the relay has not acknowledged (#962). This is the ignored-package half; the published `motebit` half is in the sibling changeset.

- `@motebit/sync-engine`: `pushCompactionFloor(localStore, requested, { syncConfigured? })` returns the smallest of `requested` and every relay stream's acked push cursor. It reads the streams a `SyncEngine` connected over that store in this process, plus every `push:` cursor the store persists. Cursors are grouped by relay stream (new `relayStreamOfPushKey`): mobile's /sync cursor (`push:e2e:raw:`) and its live cursor (`push:relay:`), or a raw CLI cursor beside an E2E one, are one relay, and the highest of them counts, so a stale cursor no longer pins compaction. Distinct relays still take the lowest. With no stream it returns 0 when `syncConfigured`, else `requested`; an unreadable cursor gives 0 (fail closed). `connectRemote` now records its stream and persists a push cursor of 0 when none exists. `SyncSeqCursorStore` gains the optional `listSyncSeqCursorKeys(prefix)`.
- `@motebit/runtime`: `compact()` and the `stop()` compaction share `compactUpTo`, the one place that decides what is deleted, and it applies the floor. New `RuntimeConfig.syncConfigured` (a boolean or a provider, read at compaction time; a provider that throws counts as configured): a host with a relay configured compacts nothing until the relay acknowledges a push, even when no cursor was ever persisted (an enrollment write lost, a process that never connected).
- `@motebit/desktop`, `@motebit/mobile`, `@motebit/web`, `@motebit/spatial`: each passes `syncConfigured` from its relay URL setting; the desktop and mobile stores' cursor listing is tested over real SQLite.
- `@motebit/persistence`, `@motebit/browser-persistence`, `@motebit/desktop` (Tauri), `@motebit/mobile` (Expo): each event store implements `listSyncSeqCursorKeys`.
- Round 3: `SyncEngine.getLastError()` returns why the last cycle failed (a refused push, a stall), or null once one succeeds, because `sync()` never rejects and a refusing relay was silent. `MotebitRuntime.isSyncConfigured()` exposes the host's `syncConfigured` answer as compaction reads it, so each surface's wiring is tested at its construction seam. Desktop's `syncConfigured` is now read at compaction time and includes a relay started later in the session. Web saves the relay URL whenever sync starts, pairing included, and its `syncConfigured` treats unreadable storage as configured (new `isSyncUrlConfigured`).

Stated cost: compaction waits for a relay acknowledgment. A relay that is configured but never reached (offline; spatial's default relay on an install that never connects) or that keeps refusing the push (a revoked device, a bad token) holds compaction, and the local event log grows until a push is acknowledged. Never deleting an unacknowledged event is the invariant; the growth is its price.

Round 4 (harness, tests only, with the seams it drives): every CLI and app entry point's push is held by a behavioural matrix against a real served relay (`every-configured-surface-pushes-962.test.ts`).
