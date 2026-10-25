---
"@motebit/relay": patch
---

`POST /api/v1/allocations/:allocationId/dispute` no longer lets the filer set the dispute's clock (#1153). The evidence deadline was the filer's own signed `filed_at` + 48 h, and nothing bounded `filed_at`, so a filing dated ten years ahead locked the counterparty's escrow or §7.5 hold for ten years. The relay now refuses a `filed_at` more than 15 minutes from its clock (400) and anchors the deadline on its own receive time. It also refuses a dispute of a relay-custody or p2p settlement filed after the 24 h dispute window (409, dispute-v1 §4.5), which used to re-lock funds the worker could already withdraw. Spec: dispute-v1 §4.4 and §4.5 state both rules. The §4.3 terminal-state check for pre-settlement disputes is not in this change.
