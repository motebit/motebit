---
"@motebit/mcp-server": patch
---

Service listings are a maintained invariant, not a boot-time one-shot.

`register()` publishes the service listing; `heartbeat()` only extends the TTL —
and a successful heartbeat also refreshes the timestamp the staleness branch
reads. So on a healthy service the staleness branch never fired, and a listing
lost on the relay side was never republished. Six staging atoms sat live,
heartbeating and fully discoverable but unpriced and undescribed for roughly a
month; archetype conformance went red daily until each machine was restarted by
hand. A full re-registration now runs hourly regardless of heartbeat health,
bounding any listing loss to an hour instead of forever.
