---
"@motebit/sync-engine": minor
"@motebit/relay": patch
"@motebit/desktop": patch
"@motebit/web": patch
"@motebit/spatial": patch
---

A device's own events reach the relay: the sync push cursor moves only as far as the relay acknowledged (#914; `spec/memory-delta-v1.md` §3.6, 1.6). This is the ignored-package half; the published `motebit` half is in the sibling changeset.

- `@motebit/sync-engine`:
  - `SyncEngine.sync()` used to push one batch after its push cursor and then set the cursor to the local max clock read after the pull. An event appended while the sync awaited its pull was never pushed, and a backlog larger than `batch_size` — every restart, since the cursor lived in memory — pushed its first batch and skipped the rest, silently.
  - The push cursor (`getCursor().last_version_clock`) now moves only after an acknowledgment, and only past a clock whose every local event was acknowledged or pulled from that relay (`ackedPushCursor`, exported). The local read has no `limit`, because IndexedDB and the in-memory store do not return `limit`-bounded reads in clock order.
  - A sync drains the backlog `batch_size` at a time, up to `MAX_PUSH_BATCHES_PER_SYNC` (50) batches, and continues on the next sync.
  - The push cursor is persisted in the store that already keeps the pull cursor, under a new `push:`-prefixed key (`pushCursorKey`, exported): `push:<seqCursorKey>` for a seq remote, else `push:#<motebit_id>`. There is no schema change and no key rename. The first sync after upgrading has no push cursor yet, so it re-pushes the local log once, bounded per sync; the relay stores each `event_id` once. That re-push also delivers events that earlier versions skipped.
  - Events the engine pulled from a relay are not pushed back to it.
  - A `sync()` called while one is running joins it.
  - The pull side is unchanged: the fallback `after_clock` is still the local max after the last sync.
  - `WebSocketEventStoreAdapter.append` now resolves when the relay's `ack` for the frame carrying the event arrives. It used to resolve on send, or on queue while offline. One push frame is on the wire at a time, and events appended meanwhile go out together in the next frame, which also keeps pushes under the relay's per-socket message limit. A `push refused` error rejects the frame. So does a socket that closes before the ack, or no ack within `pushAckTimeoutMs` (new, default 15 000 ms); in that last case the socket is taken down so a late ack is never credited to the next frame. An event queued while offline stays queued, once per `event_id`, and goes out on the next connection or through `takePendingEvents`; its append rejects at the deadline. `disconnect()` and `takePendingEvents()` reject the appends they strand. The returned promise is marked handled, so a caller that does not await it raises no unhandled rejection.
  - `HttpEventStoreAdapter.append` serializes pushes (one request on the wire per adapter), in call order.
- `@motebit/relay`: tests only. `sync-push-interleaving-914.test.ts` enumerates every ordering of append / sync / append-during-pull / lost push / restart / crash-before-cursor-write (and token refresh on the socket) across the HTTP raw, HTTP E2E and socket E2E doors, against the served relay. It also re-pushes under a signed device token (#846) with E2E envelopes (#928) and checks each event is stored once, first write kept, with no refusal recorded.
- `@motebit/desktop`, `@motebit/web`, `@motebit/spatial`: tests only. The fake relay in `sync-refresh-socket.test.ts` now acks push frames as the real relay does, and the tests wait for the ack.
