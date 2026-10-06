---
"create-motebit": patch
---

Export `preflightRotationFunds` from the rotate module as a test seam, so a shared conformance-vector suite can hold the inlined rotation-funds preflight to the same decisions as `@motebit/encryption`'s `checkRotationFunds`. No behaviour change.
