---
"motebit": patch
---

The CLI receipt view now distinguishes signature integrity from identity binding. It previously fed each receipt's own embedded `public_key` into chain verification as if it were a trusted key, then printed "verified locally · chain intact" — a binding claim it could not back (a forged receipt embedding its own key rendered as verified).

`renderReceipt` now verifies against an optional `trustedAnchor` (the embedded fallback still checks signatures with no anchor) and prints one of three honest states: "verified locally · chain intact" only when every node in the chain resolved its key from the trusted anchor; "signature verified · identity not anchored" when the signature is valid but checked against the receipt's own embedded key; and "verification failed" otherwise. Mirrors the render-engine receipt card's binding-aware display.
