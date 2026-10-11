---
"create-motebit": patch
---

`create-motebit rotate` signs its key-succession record through a guarded canonicalizer (the inlined mirror of `@motebit/crypto`'s `canonicalJsonForSigning`): a succession `reason` holding an unpaired UTF-16 surrogate is refused before signing instead of being signed in a form with no UTF-8 encoding (spec/execution-ledger-v1.md §11.4).
