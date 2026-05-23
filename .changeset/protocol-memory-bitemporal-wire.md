---
"@motebit/protocol": minor
---

Bi-temporal validity wire fields (memory-delta-v1 §3.5): optional `valid_from` / `valid_until` on `MemoryFormedPayload` and `superseded_valid_until` on `MemoryConsolidatedPayload`. Additive — pre-existing memory events replay unchanged. These let a memory's validity interval (already tracked in-store via `MemoryContent.valid_from`/`valid_until`) sync across devices and federation, not just live locally; supersession carries the validity-time at which the superseded belief ended so peers close the same interval.
