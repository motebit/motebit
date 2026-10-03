---
"motebit": patch
---

`motebit delegate`: every 402 on every delegate path now names the remedy that clears it. `--plan` no longer reports a P2P-required refusal as "Insufficient balance" (it says the paid step settles P2P and, since `--plan` cannot pay P2P yet (#887), to send it with `motebit delegate --sovereign`); the relay's paid federated refusal now carries the stable `TASK_P2P_PROOF_REQUIRED` code, so it too points at `--sovereign`; x402 refusals and unknown coded 402s show the relay's own words; and a `--sovereign` 402 never suggests `motebit fund` (that path pays from your Solana wallet). `motebit fund` is suggested only for a genuine insufficient-balance 402 (`INSUFFICIENT_FUNDS`, or a codeless 402 such as the x402 challenge).
