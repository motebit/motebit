---
"@motebit/crypto": patch
---

Fix the `verify()` dispatcher's artifact-type detection: JSON-parse first, only fall back to YAML-frontmatter identity-file detection if the parse fails. Pre-fix `detectArtifactType` checked `artifact.includes("---")` BEFORE `JSON.parse`, which misclassified ~0.03% of stringified JSON receipts as identity files — base64url's alphabet (`A-Za-z0-9-_`) contains `-`, so a random ed25519 signature draws three consecutive `-` about once per 3000 signatures. Statistical CI flake; the structural fix removes the ambiguity entirely (JSON-parseable strings are never YAML frontmatter). Added a deterministic regression test driving `signature: "AAA---BBB---CCC"` so future refactors can't silently regress.
