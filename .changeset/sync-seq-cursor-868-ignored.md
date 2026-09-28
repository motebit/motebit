---
"@motebit/relay": minor
"@motebit/sync-engine": minor
"@motebit/persistence": minor
"@motebit/browser-persistence": minor
"@motebit/desktop": patch
"@motebit/mobile": patch
---

The event-sync transport cursor is the relay ingest sequence, not a device clock (#868; `spec/memory-delta-v1.md` §3.6). This is the ignored-package half; the published `motebit` half is in the sibling changeset.

- `@motebit/relay`: migration v46 adds `relay_event_seq` (`PRIMARY KEY (motebit_id, seq)`, `event_id UNIQUE`) and `relay_event_seq_counter` (one row per identity, never decremented).
  - An `AFTER INSERT ON events` trigger increments the identity's counter and writes the seq in the same statement as the event, so every writer is stamped.
  - The seq is counted **per identity**, so a cursor reveals nothing about another identity's writes.
  - It is never computed as `MAX + 1`, which would reissue a deleted top seq.
  - The migration backfills held events per identity, in rowid order.
  - `GET /sync/:id/pull?after_seq=<n>[&limit=<m>]` serves seq-ordered pages: `events[].seq`, `after_seq`, `next_seq`, `has_more`, and `latest_seq`, which comes from the counter. Pages hold at most 1000 events. The pages are read by `readEventsAfterSeq`, which takes a `BoundIdentity` bound by the same presenter check as a push.
  - A pull without `after_seq` is served byte for byte as before.
- `@motebit/sync-engine`: new `seq-cursor.ts` (`pullBySeq`, `SeqPullSource`, `SyncSeqCursorStore`, `SkippedSyncEvent`, `HeldEventIdLookup`, `filterUnseen`, `isEncryptedPayload`).
  - A page is processed in a fixed order: dedup by `event_id` on the transport form, before any decryption; then decode each event on its own; then append; only then advance the cursor.
  - An undecryptable event is recorded (`event_id`, `seq`, reason), reported through `onSkippedEvent` (default `console.warn`), and passed. The record is bounded: the newest `SKIPPED_SYNC_EVENTS_KEPT` (1000) rows per cursor key, pruned in the same write, plus a running total (`countSkippedSyncEvents`).
  - A raw path never applies an E2E envelope. It counts it (`SeqPullOutcome.encryptedOnRawPath`, `SyncResult.encryptedOnRawPath`) and writes no row per event. Raw and E2E keep separate cursors (`raw:…` / `e2e:raw:…`).
  - `HttpEventStoreAdapter.pullAfterSeq` sends both cursors in one request.
  - `EncryptedEventStoreAdapter` returns the transport form and exposes `decodeEvent`.
  - `SyncEngine` and the `WebSocketEventStoreAdapter` catch-up both pull by seq. `SyncResult.skipped` is new.
- `@motebit/persistence` (v50), `@motebit/desktop` (v8), `@motebit/mobile` (v28), `@motebit/browser-persistence` (IndexedDB v9): new `sync_seq_cursors`, `sync_skipped_events` and `sync_skipped_totals` tables or stores beside `events`. Each surface's event store gains `getSyncSeqCursor` / `setSyncSeqCursor`, `recordSkippedSyncEvent` (bounded), `countSkippedSyncEvents`, and `getHeldEventIds` (key lookups rather than a scan of the log).
