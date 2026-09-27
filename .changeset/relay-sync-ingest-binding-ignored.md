---
"@motebit/relay": patch
---

Bind every sync push entry to the identity the push authenticated as (#846). A sync push is verified for one identity (the `:motebitId` the token's `mid` is bound to), but each entry carries its own `motebit_id` and the stores filed it there, so a device authenticated as A could write events, conversations, messages, plans and plan steps into B's store. B's devices then pulled those rows as their own, and A's other devices received them in the fan-out.

All eight ingest doors now refuse the whole batch before any write or fan-out when an entry names another identity or names none. The doors are the WebSocket `push`, `push_conversations` and `push_messages` frames and `POST /sync/:motebitId/{push,conversations,messages,plans,plan-steps}`. The refusal is recorded in `relay_auth_events` under the presenter, with reason `sync:foreign_motebit_id`.

The conversation, plan and plan-step upserts also no longer rewrite or replace a row another identity owns. Those rows are keyed by a client-chosen id, so a push under A's own id that named B's id changed B's row. `check-identity-authority-writers` now registers the INSERT into each identity-owned sync table.
