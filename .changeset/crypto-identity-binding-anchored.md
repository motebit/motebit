---
"@motebit/crypto": minor
---

Add `identityLogLeaf` and `verifyIdentityBindingAnchored` — the verifier-side foundation of the anchored binding rung (`docs/doctrine/identity-binding-verification.md`). `identityLogLeaf` is the canonical SHA-256 leaf for the identity-transparency log (the operator's `motebit_id → current key` commitment — the convention the relay producer and verifier must share). `verifyIdentityBindingAnchored` binds only when BOTH hold: the sovereign succession chain places the signing key as time-valid AND the current key is Merkle-included under the supplied anchored root (`IdentityLogInclusionProof`). Confirming the root is the one anchored on-chain remains the caller's cross-check.
