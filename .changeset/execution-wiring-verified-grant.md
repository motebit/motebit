---
"@motebit/protocol": minor
---

`TurnContext.verifiedGrant` gains two optional producer-only fields (money-execution Inc 3b): `token_issued_at` — the verified tick token's signed `issued_at`, consumed as the blast-radius replay nonce (one tick meters at most one money action) — and `spend_ceiling` — the verified grant's signed `SpendCeilingV1`, copied verbatim by the sole producer (`verifyGrantForTurn`, gate `check-money-authority`) so the dispatch seam enforces spend against the DELEGATOR'S commitment (spec §3.3 rule 2) without re-holding the grant. Additive: pre-@1.2 producers omit both and the meter denies fail-closed (`nonce_absent`/`ceiling_absent`).
