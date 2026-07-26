---
"motebit": patch
"create-motebit": patch
"@motebit/crypto": patch
"@motebit/crypto-tpm": patch
"@motebit/protocol": patch
---

Internal cleanup: remove no-op type assertions flagged by typescript-eslint 8.65 (`no-unnecessary-type-assertion`), monorepo-wide. Type-level only — no runtime or API change. Where an assertion was masking a real hazard (`no-base-to-string` on unknown payload fields), the site now narrows with a typeof guard instead.
