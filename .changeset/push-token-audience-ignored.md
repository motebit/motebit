---
"@motebit/relay": patch
---

`POST`/`DELETE /api/v1/agents/push-token` now expects the `push:register` audience, the one `@motebit/protocol` names for push-notification token registration and the one mobile mints (#825).

The `/api/v1/agents/*` auth middleware had no branch for the route, so it fell through to its `admin:query` default. Every phone's registration was refused with 401 (`audience_mismatch:got=push:register:expected=admin:query`). Production's `relay_push_tokens` held zero rows, so push-wake had never reached a phone. Mobile caches its push token only after a 2xx, so a phone re-registers on its next launch or foreground return once this is deployed. An `admin:query` device token no longer registers push tokens.
