---
"@motebit/protocol": minor
---

`PaymentVerificationStatus` gains `"unverifiable"` (additive union member, #959).

A P2P settlement leg the recording relay is responsible for but cannot check — the payee has no bound settlement address on that relay, or a pre-#959 record names its own payer as payee — is now reported as `"unverifiable"` instead of being passed as `"verified"` on the fee leg alone. It is never counted as verified and names no party as failing. See `spec/settlement-v1.md` §11.1.

Consumers that switch exhaustively over `PaymentVerificationStatus` need a case for the new member; a consumer that treats "not `failed`" as settled should decide whether `"unverifiable"` belongs there (the reference relay's treasury reconciler counts only `"verified"`).
