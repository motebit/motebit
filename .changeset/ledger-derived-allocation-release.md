---
"@motebit/relay": patch
---

Allocation payouts release what the ledger holds, never what the row claims.

`amount_locked` is a claim; the `allocation_hold`/`allocation_release` ledger
rows are the fact. Allocation rows also exist on never-debited paths, so
crediting `amount_locked` minted balance the relay never received — as
`allocation_release`, a type carrying neither the dispute-window hold nor the
promotional-grant hold, and therefore immediately withdrawable. Both the
stale-allocation sweep and the retry-exhaustion refund now derive the payout
from `getAllocationHoldRemaining`. The sweep is extracted as
`releaseStaleAllocations` so tests drive the deployed function rather than a
re-implementation of it.
