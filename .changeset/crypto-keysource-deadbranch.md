---
"@motebit/crypto": patch
---

Internal: remove an unreachable branch in `verifyReceiptChain`'s key-source resolution. The no-key case now returns from the `else` arm, so `keySource` is definitely-assigned and emitted directly rather than through a conditional spread whose falsy side could never execute. No behavior change — it restores branch coverage that the dead arm had dropped below threshold.
