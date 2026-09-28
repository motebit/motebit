---
"motebit": patch
---

**Sync no longer skips an event another of your devices wrote at the same moment** (#868). The CLI and daemon pulled events "after my own highest clock". Clocks are assigned by each device separately, so an event that another device of the same motebit wrote at an equal or lower clock, after this device's last pull, was never pulled. It stayed missing from this device's log for good.

The pull cursor is now the relay's ingest sequence. The relay stamps every event it stores with `seq`. The client pulls `after_seq`, keeps the largest seq it has applied in its local database (`sync_seq_cursors`, persistence migration v50), and deduplicates by `event_id`. The daemon's socket catch-up uses the same cursor. On a relay that does not serve `seq`, the client falls back to the clock pull exactly as before. The first pull after upgrading starts from seq 0: it downloads the identity's event history once and drops the events it already holds.
