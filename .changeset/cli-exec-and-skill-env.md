---
"motebit": patch
---

Security: `motebit fund` no longer shell-interpolates the relay-supplied checkout URL — it is parsed (HTTPS only; plain HTTP only for loopback dev relays; no credentials) and handed to the platform opener as a single argv element via `execFile`. Approved skill scripts now run with a scrubbed environment (PATH, HOME, locale, terminal and temp variables only) instead of inheriting the operator's full environment, so approving a script no longer discloses API keys, relay tokens or motebit configuration; the approval prompt states this.
