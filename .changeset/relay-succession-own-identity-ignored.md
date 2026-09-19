---
---

Relay: the rotate-key route refuses a key succession presented under a token for any other identity, and records the refusal. The signed succession payload names no `motebit_id`, so the route is what ties a record to an identity; its siblings (`revoke`, `revoke-tokens`) already compared the caller to the path.
