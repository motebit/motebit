---
"motebit": patch
---

Bump `stripe` SDK 17 → 22. The runtime API version stays pinned at
`2025-03-31.basil` (unchanged); the bump aligns the SDK's TypeScript types with
that pinned version, which surfaced two field-location fixes on the relay money
path (see PR for the latent-bug detail): `invoice.subscription` →
`invoice.parent.subscription_details.subscription`, and subscription
`current_period_end` → `items.data[0].current_period_end`.
