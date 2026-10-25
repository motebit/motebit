---
"@motebit/sync-engine": patch
---

`WebSocketEventStoreAdapter` reconnects after a refused connection on Node 22 (#1159). Node 22's built-in WebSocket fires `error` on a refused connect and then stays CONNECTING forever, never `close`, and the adapter scheduled reconnects only from `onclose`. An `error` while still CONNECTING is now taken as that close: the close handler runs once, detached first, so a late real `close` cannot run it again. Browsers, Node 24 and the `ws` package already fire `close` and are unaffected.
