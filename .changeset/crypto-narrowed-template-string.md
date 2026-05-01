---
"@motebit/crypto": patch
---

Internal lint cleanup. Two error-path template literals in `verifyRetentionManifest` and `verifyWitnessOmissionDispute` were flagged by `@typescript-eslint/restrict-template-expressions` after the phase 4b-3 API surface additions tightened TypeScript's narrowing at the call sites — the spec/suite field narrows to `never` after the equality check fails, making the template literal stringification ambiguous. Wrapped both with explicit `String(...)` to satisfy the lint rule.

No behavior change. Template literals already perform `String()` coercion at runtime; the explicit wrap is a typing-clarity fix, not a semantics change.
