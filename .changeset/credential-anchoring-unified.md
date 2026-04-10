---
"@motebit/protocol": minor
"@motebit/sdk": minor
"@motebit/crypto": minor
"create-motebit": minor
"motebit": minor
---

MIT/BSL protocol boundary, credential anchoring, unified Solana anchoring

- **@motebit/crypto** — new package (replaces @motebit/verify). First npm publish. Sign and verify all artifacts with zero runtime deps. New: `computeCredentialLeaf`, `verifyCredentialAnchor` (4-step self-verification).
- **@motebit/protocol** — new types: `CredentialAnchorBatch`, `CredentialAnchorProof`, `ChainAnchorSubmitter`, `CredentialChainAnchor`. Semiring algebra moved to MIT.
- **@motebit/sdk** — re-exports new protocol types.
- **create-motebit** — no API changes.
- **motebit** — sovereign delegation (`--sovereign` flag), credential anchoring admin panel, unified Solana anchoring for settlement + credential streams.

New specs: settlement@1.0, auth-token@1.0, credential-anchor@1.0, delegation@1.0 (4 new, 9 total).
