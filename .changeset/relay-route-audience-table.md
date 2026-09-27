---
"@motebit/protocol": minor
"motebit": patch
---

Relay route → audience table (#827). Published half; the relay, runtime, planner and surface fixes are in `relay-route-audience-table-ignored.md`.

- `@motebit/protocol`: new `RELAY_ROUTE_AUDIENCES` (every relay route that accepts a device-signed token, keyed by method and path pattern, with the `TokenAudience` it verifies), `RELAY_PUBLIC_ROUTES` (the routes in the same families that take no token), and `relayRouteAudience(method, path)`, a pure lookup over both. `TokenAudience` closed the vocabulary; nothing said which audience a route verifies, so clients guessed and were refused on every call. The reference relay's agent-route middleware now resolves from this table, and a conformance test proves every entry against the relay.
- `motebit` (CLI): mints the audience each route verifies where it minted another or none — `/deposits` and `migrate`'s balance read (`account:balance`), `delegate`'s candidate discovery (`market:query`) and task polls (`task:query`), the daemon's served-task receipts (`task:result`, minted with the key in hand instead of a master-or-empty bearer), and the `smoke x402` listing read (`market:listing`). `export` reads the balance from `/api/v1/agents/:id/balance` (it read `/agent/:id/budget`, which the relay does not have) and writes `balance.json`. The shared command layer now receives a per-audience `mintToken`.
