---
"motebit": patch
---

**Quitting no longer deletes events the relay has not received** (#962). Compaction runs when the REPL or daemon stops, and that happens before sync-on-exit. It used to delete every event below the newest one without checking whether the relay had confirmed them. An event written just before quitting could be deleted before it was pushed, so it never reached your other devices. Compaction now stops at the relay's confirmed push cursor. With more than one relay, it stops at the lowest cursor. If the cursor cannot be read while sync is configured, nothing is compacted. A later process also keeps these events before it reconnects, because the relay stream is saved next to the cursor when sync connects. Without a relay, compaction works as before.
