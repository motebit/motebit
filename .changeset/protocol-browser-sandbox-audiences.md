---
"@motebit/protocol": minor
---

Add `BROWSER_SANDBOX_GRANT_AUDIENCE` (`"browser-sandbox-grant"`) and `BROWSER_SANDBOX_AUDIENCE` (`"browser-sandbox"`) constants for the audience-bound signed-token primitive.

These ship the relay-mediated dispatcher-token flow that replaces the v1 shared-bearer model in `services/browser-sandbox`. The first audience binds a motebit's grant request to the relay; the second binds the relay-signed token the motebit attaches to browser-sandbox requests. Single trust anchor (the pinned relay public key) and end-to-end audit attribution via the `mid` claim.

Same canonical-audience pattern as the existing `sync` / `task:submit` / `admin:query` audiences (still string literals at consumer sites; promoting them to typed constants is follow-up work, not a blocker for this migration).

```ts
import { BROWSER_SANDBOX_GRANT_AUDIENCE, BROWSER_SANDBOX_AUDIENCE } from "@motebit/protocol";
```
