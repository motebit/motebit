---
"motebit": patch
---

The REPL delegate flow (submit → poll) and `/balance` now ride `@motebit/relay-client`, the typed relay transport. This fixes two live defects in the hand-rolled path: task submission previously sent no `Idempotency-Key` (the relay unconditionally rejects submission without one, HTTP 400), and the poll leg replayed the `task:submit`-audience token against the task-query route (audience mismatch → 403, silently swallowed by the poll loop until a 60s timeout for device-token users). The typed client mints the correct registry audience per leg and requires the idempotency key at the type level. Auth is unchanged: master token preferred, signed device token fallback, bridged through the sdk `CredentialSource` contract.
