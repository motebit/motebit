---
"@motebit/encryption": minor
---

Re-exports the machine roster's primitives from `@motebit/crypto` — `signHostEnrollment`, `signHostRetirement`, `hostEnrollmentId`, `hostRetirementId`, `verifyHostRoster`, `resolveRosterKeyChain` and their result types — so surface-kit's roster controller (part C) consumes them through its existing layer-1 dependency rather than a new direct `@motebit/crypto` edge.
