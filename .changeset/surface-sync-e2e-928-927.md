---
"motebit": patch
---

**`motebit run` no longer pushes your events to the relay unencrypted, and the daemons' sync stays authenticated** (#928, #927). The `run` daemon synced events through a plain HTTP adapter even when it held the identity key, so the relay stored those event payloads in plaintext. It now encrypts them end to end with the same key the REPL uses. Its plan sync is encrypted the same way, and so is the plan leg of the REPL's `/sync`, which also sent plaintext.

The HTTP adapters of `motebit run` and `motebit serve` used to hold one token for the life of the process. They now resolve the token on every request. A configured master or sync token is presented as before. With none configured, a fresh signed device token is minted per request, where these paths previously went unauthenticated. When the identity key cannot be opened, `run` says that its events will sync unencrypted.

**What this changes at the relay.** The daemon's events now reach the relay as end-to-end envelopes, as every other surface's already do. Relay features that read event payloads no longer see this daemon's events. That covers the execution-ledger goal timeline, receipt-replay deduplication and deletion propagation. Restoring those features for E2E events is tracked in a separate issue.
