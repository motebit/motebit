---
"@motebit/relay": patch
"@motebit/runtime": patch
"@motebit/planner": minor
"@motebit/web": patch
"@motebit/mobile": patch
"@motebit/desktop": patch
"@motebit/spatial": patch
---

Client/relay token-audience drift (#827). Ignored-package half; the published protocol table and CLI fixes are in `relay-route-audience-table.md`.

- `@motebit/relay`: the `/api/v1/agents/*` middleware resolves a per-agent sub-route's audience from `@motebit/protocol`'s `RELAY_ROUTE_AUDIENCES` by method and path pattern. Its old `includes`/`endsWith` chain ignored both, so `GET /api/v1/agents/roster` (and `/balance`, `/credentials`, … — 13 siblings) was authenticated with the sub-route's audience and served by the `:motebitId` handler. Collaborative proposals and the browser-sandbox grant exchange are carved out of the `/api/v1/*` master-only catch-all, which refused every device token before their own auth ran; the proposals auth moved ahead of the routes (it was registered after them, so it never ran). A conformance test mints every table entry against the in-process relay.
- `@motebit/runtime`: `RelayConfig.mintToken`; the shared `relayFetch` mints the route's audience from the table. `/discover` is a GET (it POSTed to a GET-only route); `/proposals` reads `/api/v1/proposals` (it called a route that never existed).
- `@motebit/planner`: `RelayDelegationAdapter`'s `authToken` is a per-audience factory only — a static token cannot serve both the submit (`task:submit`) and poll (`task:query`) routes, and three surfaces passed their `sync` socket token.
- Surfaces: web pairing mints `device:auth` (it minted `pair`, which no route verifies); web/mobile/desktop panel adapters and mobile `relayFetch` resolve the audience from the table (sweep-config and mobile balance were refused); served-task receipts mint `task:result`; registration/heartbeat/deregister mint `admin:query`; token factories honor the audience they are asked for (mobile, desktop, spatial); checkout and balance polls send a token (web, mobile, desktop).
