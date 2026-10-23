---
"@motebit/crypto": minor
---

Federation signed messages v2 gain the four WORK kinds (`spec/relay-federation-v1.md` §3.5): `discover`, `task-forward`, `task-result` and `settlement-forward` join `FEDERATION_MESSAGE_KINDS` (each with the 300 000 ms window). `signFederationMessage` / `verifyFederationMessage` are unchanged and remain the one producer and one verifier: a work message names its ONE recipient by id and by key, and the verifier compares `recipient_public_key` to its own key before anything else, exactly as for the control kinds. Additive for callers; a consumer that switches exhaustively over `FederationMessageKind` sees four new members.
