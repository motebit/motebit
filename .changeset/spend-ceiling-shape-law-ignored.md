---
"@motebit/wire-schemas": minor
---

SpendCeilingV1 learns its own prose (agency @1.2 review, 2026-07-05): the §3.3 "Requires `window_ms`" clauses are now SHAPE law in both validators — zod `superRefine` + draft-07 `dependencies` injected into the committed `spend-ceiling-v1.json` AND the embedded copies in `standing-delegation-v1.json` — and every numeric carries `maximum: 9007199254740991` (2^53−1) so a delegator-chosen limit can never produce JCS-unfaithful signed bytes. Rule 3 (at-least-one-total-bound) deliberately stays enforcement law: a bare ceiling remains well-formed-but-authorizes-nothing. Spec §3.3 additionally pins "canonical counterparty" as consumer-local runtime law (reference: `canonicalizeCounterparty`), never cross-runtime-comparable interop.
