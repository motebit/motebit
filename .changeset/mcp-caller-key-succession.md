---
"@motebit/mcp-server": patch
"@motebit/runtime": patch
---

A caller's rotated-away key no longer authenticates. `wireServerDeps`'s `resolveCallerKey` now checks the relay's identity bundle even when the local trust store holds a key for the caller: if the relay serves a different current key, the stored (retired) key is refused and the successor accepted. Earned trust carries over only across a succession signed by the retired key, or a guardian recovery signed by the guardian the caller's OWN trust record pins (`getAgentTrust`'s `guardian_public_key`) — never a guardian the relay's answer names, which would let a relay serve its own key plus a recovery signed by its own "guardian"; no pinned guardian ⇒ a recovery is unproven (at most `Verified`). No store pins a guardian yet, so today every guardian recovery re-earns trust from `Verified`; an unproven key change authenticates at most as `Verified` on every request; `Blocked` stays blocked. Served identities are cached for 30s.

The trust store never adopts an unproven key: `recordAgentInteraction` (runtime) takes `opts.provenSuccession` and changes a record's stored `public_key` only when it is set (a record with no key still takes the first one), so a key change the relay asserts without a signed succession can no longer inherit the stored level on the next request. `onCallerVerified` passes the flag only for the exact successor key `resolveCallerKey` proved.

Disclosed fail-open, now narrowed: when the relay cannot answer for a known caller (timeout, 404, 5xx, malformed bundle), the stored key is still accepted — capped at `Verified` (never `Trusted`), and refused outright for a caller whose rotation this process has observed. The observation is in memory, so a restart forgets it until the relay is reachable again. Logged once per caller.
