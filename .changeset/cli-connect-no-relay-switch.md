---
"motebit": patch
---

In the `motebit` chat REPL, `/connect <url>` no longer half-switches relays, and it never sends an operator token.

Before, in a session already using relay A, `/connect B` registered this device with B, printed "Interactive delegation enabled" and "Connected to B" while the delegation tool kept submitting to A, sent B the operator token when one was set, and overwrote the saved relay with B, so later relay commands and the next launch could use B with A's pinned key.

Now:

- In a session that is already on a relay, `/connect` sends nothing to any relay and changes nothing (no registration, no saved config, no in-memory relay). Naming another relay prints why it was refused; naming the session's own relay prints that the session is already on it.
- `/connect` refuses, before any request, when an operator token is set by `--sync-token`, `MOTEBIT_API_TOKEN` or `MOTEBIT_SYNC_TOKEN`, and says which one. It is available in a session started with no relay and no operator token, where it works as before and authenticates with device-signed tokens only.
- `/connect /` (a URL that is empty once trimmed) prints the usage line.

Given up: `/connect` on the session's own relay no longer re-reads the agent list or re-sends the device registration, and no longer writes that relay to the saved config; there is no in-session way to save a different relay for the next launch (use `motebit sync enable <url>` or `--sync-url` at launch); and a session with an operator token cannot use `/connect` at all.

Not changed by this release: a relay named at launch is still paired with the one relay key pin this install keeps, and still receives an operator token set in the environment. Until the pin and the credentials are kept per relay, do not use `--grant` or an operator token with a relay other than the one this install registered with.
