---
"motebit": patch
---

In the `motebit` chat REPL, `/connect <url>` no longer half-switches relays, and it never sends an operator token.

Before, in a session already using relay A, `/connect B` registered this device with B, printed "Interactive delegation enabled" and "Connected to B" while the delegation tool kept submitting to A, sent B the operator token when one was set, and overwrote the saved relay with B, so later relay commands and the next launch could use B with A's pinned key.

Now:

- In a session that is already on a relay, `/connect` sends nothing to any relay and changes nothing (no registration, no saved config, no in-memory relay). Naming another relay prints why it was refused; naming the session's own relay prints that the session is already on it.
- `/connect` never sends an operator token. In a session on no relay, when one is set by `--sync-token`, `MOTEBIT_API_TOKEN` or `MOTEBIT_SYNC_TOKEN`, it refuses before any request and names that source. In a session already on a relay the refusal above comes first and names no source. `/connect` is available in a session started with no relay and no operator token, where it works as before and authenticates with device-signed tokens only.
- `/connect /` (a URL that is empty once trimmed) prints the usage line.
- As before, a session that lacks a signing key or a device id is refused before any request; both halves of that check are now under test.

Given up: `/connect` on the session's own relay no longer re-reads the agent list or re-sends the device registration, and no longer writes that relay to the saved config; there is no in-session way to save a different relay for the next launch; and a session with an operator token cannot use `/connect` at all.

Not changed by this change itself: which relay key and which operator token a relay named at launch is paired with. The same release changes both, in their own entries: the relay key is kept per relay URL (`cli-relay-pin-per-relay.md`), and an operator token is sent only to a relay it was bound to with `motebit relay bind-token` (`cli-operator-token-per-relay.md`), so a relay named at launch no longer receives an operator token just because one is set in the environment.
