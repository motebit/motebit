---
"@motebit/runtime": patch
"@motebit/sync-engine": minor
"@motebit/persistence": patch
"@motebit/browser-persistence": patch
"@motebit/desktop": patch
"@motebit/mobile": patch
---

Compaction never deletes an event the relay has not acknowledged (#962). This is the ignored-package half; the published `motebit` half is in the sibling changeset.

- `@motebit/sync-engine`: `pushCompactionFloor(localStore, requested)` returns the smallest of `requested` and every relay stream's acked push cursor. It reads the streams a `SyncEngine` connected over that store in this process, plus every `push:` cursor the store persists. With no stream it returns `requested`, and an unreadable cursor gives 0 (fail closed). `connectRemote` now records its stream and persists a push cursor of 0 when none exists. `SyncSeqCursorStore` gains the optional `listSyncSeqCursorKeys(prefix)`.
- `@motebit/runtime`: `compact()` and the `stop()` compaction share `compactUpTo`, the one place that decides what is deleted, and it applies the floor.
- `@motebit/persistence`, `@motebit/browser-persistence`, `@motebit/desktop` (Tauri), `@motebit/mobile` (Expo): each event store implements `listSyncSeqCursorKeys`.
