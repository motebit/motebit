---
"@motebit/mcp-server": patch
---

fix: default log callback to visible console.warn instead of silent no-op

`startServiceServer`'s `log` callback was optional, defaulting to silent
when callers didn't pass one. None of the six reference services wired it,
so registration failures (`"Relay registration failed: 401"`, etc.) and
successes (`"Registered with relay (capabilities: …)"`) were invisible in
every deployed service — classic fail-loudly violation hiding real
operational drift.

Default now routes to `console.warn` with a `[motebit/mcp-server]` prefix.
Callers who want to suppress entirely can pass `() => {}`; callers who want
structured logging can still pass their own function. No breaking change for
anyone who passed a custom `log`; anyone who didn't now sees the previously-
hidden output.

Discovered while diagnosing why only `research` appeared in motebit.com's
Discover tab despite five other services being deployed and healthy. The
registration code was running silently across all six; the failures were
hidden by this default.
