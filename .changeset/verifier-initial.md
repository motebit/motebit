---
"@motebit/verifier": minor
"@motebit/sdk": patch
"@motebit/protocol": patch
"@motebit/crypto": patch
"create-motebit": patch
"motebit": patch
---

Ship `@motebit/verifier` — offline third-party verifier for every signed Motebit artifact (identity files, execution receipts, W3C verifiable credentials, presentations). Exposes `verifyFile` / `verifyArtifact` / `formatHuman` as a library and the `motebit-verify` CLI with POSIX exit codes (0 valid · 1 invalid · 2 usage/IO). Zero network, zero deps beyond `@motebit/crypto`. Joins the fixed public-surface version group.
