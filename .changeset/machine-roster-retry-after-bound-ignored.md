---
"@motebit/surface-kit": patch
"@motebit/web": patch
"@motebit/mobile": patch
"@motebit/desktop": patch
---

Machine roster: a relay's `Retry-After` is bounded (#801 F1). Before this, one 429 with `Retry-After: 999999999` stored a `retry_until` decades out. Every entry point re-reads that value and keeps its maximum, so a surface never presented again.

The rule lives once, in the kit. `MAX_RETRY_AFTER_MS` is 1 hour. `nextPresentationRecord` stores at most `now + MAX_RETRY_AFTER_MS` and drops an out-of-bound stored value instead of carrying it forward. `boundedRetryUntil(record, now)` is the read rule, used by `presentationDue` and by every surface's `remember` (web, mobile, desktop). A stored value beyond `now + MAX_RETRY_AFTER_MS` (written before the bound, or planted) reads as expired: it is dropped, not clamped, because a clamp relative to the time of reading would slide forward with every read.

No published package changes.
