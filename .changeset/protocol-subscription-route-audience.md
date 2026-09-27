---
"@motebit/protocol": patch
---

`RELAY_ROUTE_AUDIENCES` gains the two subscription owner routes, `POST /api/v1/subscriptions/:motebitId/cancel` and `.../resubscribe`, both requiring `account:checkout` (#846). These routes had no authentication before. The relay now binds them to the caller's own identity, and `relayRouteAudience` resolves the audience a client must mint for them.
