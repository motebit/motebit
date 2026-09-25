---
"@motebit/relay": patch
---

The sync websocket acts on no frame before the connection is registered. While a query-param token was still being verified, non-auth frames were processed against the motebit named in the path (the only pre-auth guard, `awaitingAuthFrame`, is false on that path), so a socket holding a token signed by any key could write synced conversations and events for any motebit and have them fanned out to its devices before being closed 4003. `finalizeConnection` now sets `registered` (and is idempotent, so a query token and an auth frame verifying together register the socket once), and every non-auth frame is refused until it is set.
