---
"motebit": patch
---

**Sync no longer skips an event another of your devices wrote at the same moment** (#868). The CLI and daemon pulled events "after my own highest clock". Clocks are assigned by each device separately, so an event that another device of the same motebit wrote at an equal or lower clock, after this device's last pull, was never pulled. It stayed missing from this device's log for good.

The pull cursor is now the relay's ingest sequence, counted per identity. The relay stamps every event it stores with `seq`. The client pulls `after_seq`, keeps the largest seq it has processed in its local database (`sync_seq_cursors`, persistence migration v50), and deduplicates by `event_id`. The daemon's socket catch-up uses the same cursor. On a relay that does not serve `seq`, the client falls back to the clock pull exactly as before.

An event the client cannot use no longer blocks anything behind it. That covers an end-to-end-encrypted event arriving on the daemon's unencrypted HTTP path, and an encrypted event it cannot open. The client records the event (`sync_skipped_events`), warns once, and moves past it. It never stores ciphertext in the local log. The first pull after upgrading starts from seq 0. It reads the identity's event history once, looking up each event id in the local database, and skips the events it already holds.
