---
"motebit": patch
---

**Your events reach the relay: the REPL and `motebit run` no longer skip events when they push** (#914). The sync push cursor used to jump to the newest local event after each sync, whether or not that event had been pushed. An event written while a sync was pulling was never sent, and after a restart only the first batch of unsent events went out. Now the cursor moves only as far as the relay has confirmed. A large backlog goes out over the next syncs, and the cursor is saved on disk, so a restart continues where it stopped. The first sync after upgrading re-sends the local event log once. The relay keeps one copy of each event, and events that earlier versions skipped are delivered.
