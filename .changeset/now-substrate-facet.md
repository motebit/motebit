---
"@motebit/sdk": minor
---

`SessionStateSnapshot` gains two `[Now]` proprioception fields (#530): `substrate` (the live provider model this motebit thinks through — follows `/model` switches) and `settledDelegations` (the exchange's completed paid delegations, produced by the streaming manager's own ledger). Both runtime-produced, never model-authored.
