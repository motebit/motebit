---
"@motebit/relay": patch
---

`POST` and `DELETE /api/v1/agents/push-token` now expect the `push:register` audience (#825). That is the audience `@motebit/protocol` names for push-notification token registration, and the one mobile mints.

The `/api/v1/agents/*` auth middleware had no branch for the route, so it fell through to its `admin:query` default. Every phone's registration was refused with 401 (`audience_mismatch:got=push:register:expected=admin:query`). Production's `relay_push_tokens` held zero rows, so push-wake had never reached a phone. Mobile caches its push token only after a 2xx, so a phone re-registers on its next launch or foreground return once this is deployed. An `admin:query` device token no longer registers push tokens.

The branch is limited to those two methods. Any other method on the path keeps the `admin:query` default unchanged: `GET` there is `GET /api/v1/agents/:motebitId` with the id `push-token`, and `PUT` and `PATCH` match no route. `spec/auth-token-v1.md` now names the real route instead of `/api/v1/agents/{id}/push/*`.
