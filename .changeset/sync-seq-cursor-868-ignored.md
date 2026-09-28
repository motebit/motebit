---
"@motebit/relay": minor
"@motebit/sync-engine": minor
"@motebit/persistence": minor
"@motebit/browser-persistence": minor
"@motebit/desktop": patch
"@motebit/mobile": patch
---

The event-sync transport cursor is the relay ingest sequence, not a device clock (#868; `spec/memory-delta-v1.md` §3.6). This is the ignored-package half; the published `motebit` half is in the sibling changeset.

- `@motebit/relay`: migration v46 adds `relay_event_seq` (`seq INTEGER PRIMARY KEY AUTOINCREMENT`). It is stamped by an `AFTER INSERT ON events` trigger, so the seq is written in the same statement as the event and every writer is stamped. The migration backfills held events in rowid order. `GET /sync/:id/pull?after_seq=<n>` serves seq-ordered pages (`events[].seq`, `after_seq`, `next_seq`, `has_more`, `latest_seq`; at most 1000 per page, `limit` to lower it) through `readEventsAfterSeq`, which takes a `BoundIdentity` bound by the same presenter check as a push. A pull without `after_seq` is served byte for byte as before.
- `@motebit/sync-engine`: new `seq-cursor.ts` (`SeqPullSource`, `SyncSeqCursorStore`, `pullBySeq`, `filterUnseen`, `resolveSeqCursorStore`). `HttpEventStoreAdapter.pullAfterSeq` sends both cursors in one request. `EncryptedEventStoreAdapter` passes it through and decrypts. `SyncEngine` pulls by seq whenever its remote supports it, and so does the `WebSocketEventStoreAdapter` catch-up. The cursor advances only after a page is appended, and only events the store did not already hold reach `onEvent`. A relay whose `latest_seq` falls below the cursor is re-read from 0.
- `@motebit/persistence` (v50), `@motebit/desktop` (v8), `@motebit/mobile` (v28), `@motebit/browser-persistence` (IndexedDB v9): a `sync_seq_cursors` table or store beside `events`, and `getSyncSeqCursor` / `setSyncSeqCursor` on each surface's event store, so the cursor survives a restart.
